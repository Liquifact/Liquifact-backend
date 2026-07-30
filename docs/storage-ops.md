# Object Storage Operations

This document describes how the LiquiFact API talks to **AWS S3** (or an
S3-compatible service such as MinIO) for invoice PDF/JPEG uploads and how to
diagnose misconfiguration before it breaks production traffic.

## Why we probe object storage

`src/services/storage.js` constructs a shared `s3Client` from environment
variables (`AWS_REGION`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`). Until issue **#452** was fixed, this
client was only ever exercised at request time — the first invoice PDF
upload from a real user. A wrong endpoint, rotated credentials that have
not yet propagated, or a manually-deleted bucket surfaced as a 500 error
to the user.

The connectivity probe (`probeS3Connectivity`, see
[`src/services/storage.js`](../src/services/storage.js)) issues a single
`HeadBucket` request against the configured bucket and classifies the
result. It is invoked at startup and on every readiness probe.

## Probe lifecycle

1. **Process startup** — `src/index.js` calls `runStartupStorageProbe()`
   immediately before `app.listen(...)`. The result is **logged** (info on
   healthy or skipped statuses, warn on unhealthy) but **never** blocks
   startup. Bootting the API is preferable to dying on a transient S3
   blip; orchestrators rely on readiness for routing decisions.
2. **Readiness probe** — `GET /readyz` runs `checkStorageHealth()` on every
   call, in parallel with database and Soroban RPC checks. A misconfigured
   bucket takes the pod out of the load-balancer rotation immediately.
3. **Full health probe** — `GET /ready` includes the storage probe result
   alongside the rest of the dependency checks.

## Probe status matrix

| Status           | Meaning                                                                | Blocks readiness? | Operator action                                                  |
| ---------------- | ---------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `healthy`        | `HeadBucket` returned 200. Bucket exists, credentials work.           | No                | None.                                                             |
| `unhealthy`      | `HeadBucket` failed. Error code is an allow-listed AWS error class.    | **Yes (`/readyz` returns 503)** | Check credentials, bucket name, and S3 endpoint. See [Runbook](#runbook). |
| `in_memory`      | In-memory fallback active (`NODE_ENV === 'test'` or `STORAGE_IN_MEMORY === 'true'`). Probe skipped. | No | None — only used in tests / offline sandboxes. |
| `disabled`       | `S3_HEALTHCHECK_ENABLED === 'false'`. Probe skipped by configuration. | No                | Confirm the disabled-by-design environment is intentional.       |
| `not_configured` | `S3_BUCKET` or AWS credentials are missing.                           | **Yes**           | Set `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.    |

`in_memory` and `disabled` are the only **non-blocking** statuses besides
`healthy`. Production readyz will return `503` for any other state.

## Configuration

| Variable                  | Purpose                                                                  | Default       |
| ------------------------- | ------------------------------------------------------------------------ | ------------- |
| `S3_BUCKET`               | Target bucket name.                                                      | `liquifact-invoices` |
| `AWS_REGION`              | AWS region for the S3 client.                                            | `us-east-1`   |
| `S3_ENDPOINT`             | Override endpoint (MinIO, LocalStack, etc.).                             | AWS S3 default |
| `AWS_ACCESS_KEY_ID`       | Access key id. **Secret** — never logged.                                | (required for uploads) |
| `AWS_SECRET_ACCESS_KEY`   | Secret access key. **Secret** — never logged.                            | (required for uploads) |
| `S3_HEALTHCHECK_ENABLED`  | Set to `'false'` to skip the probe entirely. Useful in air-gapped sandboxes. | enabled |
| `STORAGE_IN_MEMORY`       | Set to `'true'` to force the in-memory code path even outside tests.     | unset         |
| `STORAGE_HEALTHCHECK_TIMEOUT_MS` | Probe timeout in milliseconds.                                    | `5000`        |

## Security: what is (and is not) logged

The probe redacts every error response. **Only the AWS error name** (drawn
from an allow-list in [`src/services/storage.js`](../src/services/storage.js))
surfaces in logs and the readiness response. The allow-list includes:

- `NoSuchBucket`, `NoSuchKey`
- `AccessDenied`, `InvalidAccessKeyId`, `InvalidBucketName`
- `NetworkingError`, `TimeoutError`, `RequestTimeout`
- `ServiceUnavailable`, `SlowDown`
- `KMSAccessDenied`, `KMSDisabled`

Anything outside the allow-list collapses to a generic `UnknownError` with
the hint `"object storage unreachable"`.

The probe **never** includes in any output field, log payload, or HTTP
response:

- The `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` values.
- The `S3_ENDPOINT` URL.
- The raw `err.message` (which may include endpoint fragments).
- The `$metadata.requestId` or AWS request headers.
- The AWS signed request headers (`Authorization`, `x-amz-*`).

The probe also surfaces only a `bucketConfigured: boolean` flag — not the
actual bucket name — in its return value, to avoid leaking internal bucket
identifiers into `/readyz` responses surfaced to load balancers.

## Runbook

### `/readyz` returns `503` with `checks.storage.status === "unhealthy"`

1. Inspect the `checks.storage.error.code` field — it is the AWS error
   class. Common pairs:
   - `NoSuchBucket` → bucket name in `S3_BUCKET` does not exist.
   - `AccessDenied` → IAM policy does not allow `s3:ListBucket` /
     `s3:GetObject` on the bucket.
   - `InvalidAccessKeyId` → the credentials have been rotated and the
     deployment has stale keys.
2. Verify locally with `aws s3api head-bucket --bucket $S3_BUCKET`.
3. If the bucket exists locally but not in production, the `S3_ENDPOINT`
   or `AWS_REGION` is misconfigured.

### `/readyz` returns `503` with `checks.storage.status === "not_configured"`

`S3_BUCKET`, `AWS_ACCESS_KEY_ID`, or `AWS_SECRET_ACCESS_KEY` is missing or
empty in the deployment environment. The probe refuses to issue unsigned
requests because the AWS SDK can be overly verbose in debug logs when the
signature is malformed.

### Probe times out

The default 5 000 ms timeout may be too tight for a region with high
network latency. Raise `STORAGE_HEALTHCHECK_TIMEOUT_MS` and redeploy. If
the probe still times out, the S3 endpoint is unreachable from the cluster
— inspect network policy and VPC routing.

## Local development

The probe is a no-op under `NODE_ENV === 'test'` so unit tests can mock the
storage service freely. For manual local debugging, set
`S3_HEALTHCHECK_ENABLED=false` when running without a real bucket, or set
`STORAGE_IN_MEMORY=true` to make `uploadFileInMemory` skip the network even
outside tests.

## Related code

- [`src/services/storage.js`](../src/services/storage.js) — probe and
  service implementation.
- [`src/services/health.js`](../src/services/health.js) — readiness and
  full-health aggregation; defines `checkStorageHealth`.
- [`src/index.js`](../src/index.js) — startup probe call.
- [`tests/storage.healthcheck.test.js`](../tests/storage.healthcheck.test.js) —
  unit tests covering reachable / missing / bad credentials / in-memory /
  disabled / not-configured paths.
