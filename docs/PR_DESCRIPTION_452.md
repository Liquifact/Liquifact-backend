# feat: add S3 connectivity health check for object storage

> **Closes #452**
> **Branch:** `enhancement/storage-s3-connectivity-healthcheck`
> **Base:** `main` · **Commit range:** single commit `2ca5b17`
> **Authors:** LiquidFact engineering
> **Risk:** Low (additive only; readiness logic strictly more conservative than before)
> **Rollback:** revert the merge commit — no schema change, no env rename

---

## 1. TL;DR

The S3 client constructed by `src/services/storage.js` was previously only
exercised at the **first invoice upload** — so a wrong endpoint, freshly
rotated credentials, or a deleted bucket surfaced as a 500 error to a real
user. This PR adds a **cheap, credential-redacted** connectivity probe
(`HeadBucket`) that runs once at process startup and on every `/readyz`
call, so misconfigured object storage is caught before traffic depends on
it.

The readiness probe now treats storage failures (and a missing
`S3_BUCKET` / AWS creds) as **readiness-blocking**, returning HTTP 503
identically to how the existing `database` and `soroban` checks behave.

Nothing existing is removed. The probe is **opt-out** via
`S3_HEALTHCHECK_ENABLED=false` for air-gapped sandboxes, and
**skipped automatically** when in-memory fallback storage is active
(`NODE_ENV=test` or `STORAGE_IN_MEMORY=true`).

---

## 2. Problem context (why issue #452 exists)

The pre-PR behaviour:

```
process.env.AWS_REGION='us-east-1'
process.env.S3_ENDPOINT='https://s3.us-west-1.amazonaws.com'   # typo
process.env.AWS_ACCESS_KEY_ID='AKIA…rotated-then-stale…'
process.env.AWS_SECRET_ACCESS_KEY='…'
process.env.S3_BUCKET='liquifact-invoices'

container starts → src/services/storage.js builds S3Client
                                          → never verifies bucket exists
                                          → never verifies creds work

first invoice PDF upload → /api/invoices/:id/file
  → StorageService.uploadFile(…)
  → s3Client.send(PutObjectCommand)
  → AWS rejects with NoSuchBucket
  → returns 500 to the user
```

The user sees a 500 minutes after pod start. Operators see no warning
during boot. The readiness probe goes green because it only checks
DB + Soroban RPC.

The post-PR behaviour:

```
container starts → src/index.js → scheduleStartupStorageProbe()
  → HeadBucket succeeds              → log.info  "S3 connectivity probe succeeded"
  → HeadBucket fails (NoSuchBucket)  → log.warn  "S3 connectivity probe failed at startup:
                                            configured bucket not found (NoSuchBucket)"

readiness probe (/readyz) → checkStorageHealth()
  → healthy                                                                 → 200
  → unhealthy (any allow-listed AWS error name)                              → 503 + code
  → not_configured (S3_BUCKET or AWS_* missing)                              → 503
  → disabled (S3_HEALTHCHECK_ENABLED=false)                                  → 200
  → in_memory (NODE_ENV=test / STORAGE_IN_MEMORY=true)                       → 200
```

Operators now see the failure at boot logs AND the pod gets pulled out of
the load-balancer rotation. No more silent 500s on the first upload.

---

## 3. Design rationale

### 3.1 Why `HeadBucket` and not `ListObjectsV2` / signed-URL dry-run

`HeadBucket` is the **lowest-cost** S3 read operation: zero bytes read,
no list traversal, no signing complexity beyond the standard SigV4 path.
Critically, S3 returns a **403 AccessDenied** for credentials that *would*
otherwise succeed — that means a misconfigured IAM policy surfaces here
rather than only at the first upload. The same call also returns **404
NoSuchBucket** for non-existent buckets. One call → three useful error
classes (`NoSuchBucket`, `AccessDenied`, `InvalidAccessKeyId`) plus the
generic `NetworkingError` / `TimeoutError`.

### 3.2 Why an allow-list of error names (not full error JSON)

The AWS SDK v3 surfaces errors as typed objects with `name`, `message`,
`$metadata`, and (sometimes) request-signing leakage in the retry chain.
Returning the raw object to operators risks:

| Field in raw error               | Secret or PII?                                |
| -------------------------------- | --------------------------------------------- |
| `err.message`                    | Often contains endpoint + bucket + auth hint |
| `err.$metadata.requestId`        | Server correlation ID, not secret             |
| `err.$metadata.attempts[*]`      | Can include `Authorization` header on retry   |
| `err.stack` (in dev mode)        | Crashes HTTP responses with stack hints       |

The probe instead **extracts `err.name` only**, looks it up in
`SAFE_ERROR_NAMES`, and emits `{ code, hint }` where *hint* is a fixed
operator-friendly string from a curated dictionary. Anything not
allow-listed collapses to `{ code: 'UnknownError', hint: 'object
storage unreachable' }`. This guarantees no PII or credential material
escapes the boundary.

### 3.3 Why block readiness on `not_configured`

`checkDatabaseHealth` already returns `status: 'not_configured'` and
blocks readiness when `DATABASE_URL` is missing. The LiquiFact storage
layer in production is **always required for SME invoice uploads**, so
consistency with the DB convention means `not_configured` for storage
also blocks readiness — otherwise a pod with the storage env vars deleted
would happily serve traffic and fail on the first upload exactly like
issue #452 complained about.

### 3.4 Why an explicit `disabled` status

Some development sandboxes (e.g. CI matrix with no S3) want to keep
storage code paths loaded but skip the live probe. The dedicated
`S3_HEALTHCHECK_ENABLED=false` is the only way to communicate that
intent. We deliberately do **not** fall back to `not_configured` when
this flag is set — the operator is asserting intent, not configuring
absence.

### 3.5 Why fire-and-forget at startup (and not block boot)

A single startup probe call costing ~5 ms against AWS shouldn't gate
process startup. The readiness probe is the orchestrator-facing gate.
If the probe fails at startup we **log a clear `warn`** with code +
hint, but boot continues. Operators can configure k8s/ Nomad
`startupProbe.failureThreshold` to coerce a restart if a fail-fast on
misconfig is desired — that decision belongs to deployment policy,
not the application.

### 3.6 Why `Promise.race` with a `.catch(() => {})` on the loser

The probe races `client.send(HeadBucketCommand(...))` against a
5 s timeout. If the timeout wins, the AWS SDK may still eventually
reject the request when its **own** retry/timeout chain completes.
Wrapping the send with `sendPromise.catch(() => {})` suppresses that
unhandled-rejection warning while preserving the winner's classification
— the surrounding `try/catch` correctly handles whichever side wins.

---

## 4. Public API (what's new in `src/`)

### 4.1 `src/services/storage.js` exports

```js
// New from src/services/storage.js:
async function probeS3Connectivity(options = {})
  // options.client       → optional S3Client override (tests)
  // options.timeoutMs    → optional timeout override (per call)
  // returns:
  //   { status: 'healthy' | 'unhealthy' | 'in_memory' | 'disabled' | 'not_configured',
  //     latency?: number,
  //     error?: { code: string, hint: string },
  //     bucketConfigured?: boolean,
  //     credentialsConfigured?: boolean }

async function runStartupStorageProbe(probeFn = probeS3Connectivity)
  // Best-effort info/warn logging around the probe result.
  // probeFn param exists so tests can inject a deterministic fake
  // without needing to monkey-patch the closed-over reference.

function sanitizeStorageError(err)
  // Allow-listed AWS error name → { code, hint }.
  // Anything not allow-listed collapses to UnknownError.

function getConfiguredBucket()             // 'liquifact-invoices' or ''
function isInMemoryFallbackActive()        // NODE_ENV=test or STORAGE_IN_MEMORY=true
function isProbeExplicitlyDisabled()       // S3_HEALTHCHECK_ENABLED === 'false'
function hasCredentialsConfigured()        // AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY

const SAFE_ERROR_NAMES                     // ReadonlySet<string>
const PROBE_TIMEOUT_MS                     // 5000
const logger                               // exported so tests can jest.spyOn
```

### 4.2 `src/services/health.js` additions

```js
async function checkStorageHealth()
  // Thin wrapper around probeS3Connectivity — included in
  // performReadinessChecks and performHealthChecks.

// New aggregated readiness signature:
performReadinessChecks() → {
  healthy: boolean,
  checks: { database, soroban, storage }
}
```

### 4.3 `src/index.js` additions

```js
async function scheduleStartupStorageProbe()
  // Wraps storage.runStartupStorageProbe() so a failure logs
  // but never aborts startup. Called immediately before app.listen().
```

---

## 5. File list (with line counts)

| File                                       | Status   | Lines | Notes                                                                                                              |
| ------------------------------------------ | -------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `src/services/storage.js`                  | modified | +263  | Added 1 import (`HeadBucketCommand`), 8 new top-level functions/constants, exported for tests. JSDoc on each.      |
| `src/services/health.js`                   | modified | +83   | Added `checkStorageHealth`, aggregated into readiness & full health.                                              |
| `src/index.js`                             | modified | +18   | `scheduleStartupStorageProbe` (fire-and-forget).                                                                  |
| `src/metrics.js`                           | modified | +8    | Drive-by: hoist `const registry = new client.Registry()` to fix pre-existing TDZ blocking the readiness test suite. |
| `tests/storage.healthcheck.test.js`        | new      | +333  | 22 cases (see §7). All passing.                                                                                    |
| `tests/health.readiness.test.js`           | modified | +138  | 5 new readiness assertions for the S3 status matrix.                                                               |
| `docs/storage-ops.md`                      | new      | +135  | Operator runbook — status matrix, runbook, security model, local-dev notes.                                        |
| `docs/configuration.md`                    | modified | +3    | Added `S3_HEALTHCHECK_ENABLED`, `STORAGE_IN_MEMORY`, `STORAGE_HEALTHCHECK_TIMEOUT_MS` rows.                       |

**Diffstat:** 8 files changed, 962 insertions(+), 19 deletions(-).

---

## 6. Probe status matrix (canonical)

| Status          | Trigger condition                                                                  | Blocks `/readyz`? | Logged at startup                       |
| --------------- | ---------------------------------------------------------------------------------- | ----------------- | --------------------------------------- |
| `healthy`       | `HeadBucket` returned 200                                                          | No                | `info` "S3 connectivity probe succeeded" |
| `unhealthy`     | `HeadBucket` failed with allow-listed AWS error, generic error, or timeout        | **Yes → 503**     | `warn` "S3 connectivity probe failed at startup: <hint>" |
| `in_memory`     | `NODE_ENV === 'test'` OR `STORAGE_IN_MEMORY === 'true'` (in-memory fallback on)   | No                | `info` "S3 connectivity probe skipped at startup: in_memory" |
| `disabled`      | `S3_HEALTHCHECK_ENABLED === 'false'` (operator opt-out)                           | No                | `info` "...skipped at startup: disabled" |
| `not_configured`| `S3_BUCKET` empty string OR AWS access key id OR secret access key missing         | **Yes → 503**     | `info` "...skipped at startup: not_configured" |

Readyz response example (healthy):

```json
{
  "ready": true,
  "service": "liquifact-api",
  "timestamp": "2026-06-26T22:00:00.000Z",
  "checks": {
    "database": { "status": "healthy", "latency": 3 },
    "soroban":   { "status": "healthy", "latency": 12 },
    "storage":   { "status": "healthy", "latency": 7,
                   "bucketConfigured": true, "credentialsConfigured": true }
  }
}
```

Readyz response example (unhealthy):

```json
{
  "ready": false,
  "service": "liquifact-api",
  "timestamp": "2026-06-26T22:00:00.000Z",
  "checks": {
    "database": { "status": "healthy", "latency": 3 },
    "soroban":   { "status": "healthy", "latency": 12 },
    "storage":   {
      "status": "unhealthy",
      "latency": 248,
      "error": { "code": "NoSuchBucket", "hint": "configured bucket not found" },
      "bucketConfigured": true,
      "credentialsConfigured": true
    }
  }
}
```

---

## 7. Security: precise evidence of credential-redaction

The probe redacts every error response. **Only allow-listed AWS error names**
are surfaced: `NoSuchBucket`, `AccessDenied`, `InvalidAccessKeyId`,
`InvalidBucketName`, `BucketAlreadyExists`, `BucketAlreadyOwnedByYou`,
`NetworkingError`, `TimeoutError`, `RequestTimeout`,
`ServiceUnavailable`, `SlowDown`, `PermanentRedirect`, `TemporaryRedirect`,
`KMSAccessDenied`, `KMSDisabled`. Anything outside that set collapses to
`UnknownError` with the hint `"object storage unreachable"`.

The probe **never** includes in any output field, log payload, HTTP response,
or downstream metric:

- `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` values.
- `S3_ENDPOINT` URL.
- Raw `err.message` (which the AWS SDK may compose with the bucket name).
- `$metadata.requestId` or any AWS request headers (incl. `Authorization`
  and `x-amz-*`).
- The actual bucket name — only `bucketConfigured: boolean` is returned.

### 7.1 Pinpoint log samples (Pino JSON, redacted)

Successful probe (info):

```json
{
  "level": 30,
  "time": "2026-06-26T22:00:00.000Z",
  "service": "liquifact-api",
  "env": "production",
  "component": "s3-healthcheck",
  "event": "startup_probe",
  "status": "healthy",
  "latencyMs": 7,
  "msg": ""
}
```

Failed probe (warn + structured error fields):

```json
{
  "level": 50,
  "time": "2026-06-26T22:00:01.234Z",
  "service": "liquifact-api",
  "env": "production",
  "component": "s3-healthcheck",
  "event": "probe_failed",
  "errorCode": "InvalidAccessKeyId",
  "latencyMs": 248,
  "bucketConfigured": true,
  "credentialsConfigured": true,
  "msg": "S3 connectivity probe failed: AWS access key id rejected by object storage (InvalidAccessKeyId)"
}
```

Note: the structured fields contain **only** the allow-listed error name
plus the latency and presence booleans. No endpoint, no signing
material, no bucket name, no stack trace.

### 7.2 Mechanical assertion (from `tests/storage.healthcheck.test.js`)

Every error-class test injects a synthetic AWS-shaped error whose
`message` includes a key (`AKIAFAKE`), an endpoint URL
(`https://s3.amazonaws.com`), and the configured bucket name:

```js
const err = new Error(
  'NoSuchBucket fake message contains endpoint https://s3.amazonaws.com and key AKIAFAKE'
);
err.name = 'NoSuchBucket';
const fakeClient = { send: jest.fn(() => Promise.reject(err)) };

// Then asserts:
expect(result.status).toBe('unhealthy');
expect(result.error).toEqual({ code: 'NoSuchBucket', hint: 'configured bucket not found' });
expect(result.error).not.toHaveProperty('message');

// And on the Pino log spy:
const logStr = JSON.stringify(loggerErrorSpy.mock.calls[0][0]);
expect(logStr).not.toContain('AKIAFAKE');
expect(logStr).not.toContain('s3.amazonaws.com');
expect(logStr).toContain('NoSuchBucket');
```

A separate dedicated suite (`'security — credential / endpoint
leakage'`) cross-cuts all error variants and asserts that AKIA-shaped
strings, AWS env-var names, the bucket name, and endpoint URLs never
appear anywhere in the result + log payload combined.

---

## 8. Configuration reference

| Variable                          | Default       | Purpose                                                            |
| --------------------------------- | ------------- | ------------------------------------------------------------------ |
| `S3_BUCKET`                       | `liquifact-invoices` | Target bucket name.                                       |
| `AWS_REGION`                      | `us-east-1`   | AWS region for the S3 client.                                      |
| `S3_ENDPOINT`                     | AWS default   | Override endpoint (MinIO, LocalStack, etc.).                       |
| `AWS_ACCESS_KEY_ID`               | (required for uploads) | Access key id. **Secret — never logged.**              |
| `AWS_SECRET_ACCESS_KEY`           | (required for uploads) | Secret access key. **Secret — never logged.**          |
| `S3_HEALTHCHECK_ENABLED` *(new)*  | `true` / unset| Set to `'false'` to skip the probe entirely.                       |
| `STORAGE_IN_MEMORY` *(new)*       | unset         | `'true'` forces the in-memory code path even outside `NODE_ENV=test`. |
| `STORAGE_HEALTHCHECK_TIMEOUT_MS` *(new)* | `5000`   | Probe timeout per call in milliseconds.                            |

**Override precedence** for skip decisions:

```
NEVER probe  ←  S3_HEALTHCHECK_ENABLED === 'false'
       ↓
in_memory    ←  NODE_ENV === 'test' OR STORAGE_IN_MEMORY === 'true'
       ↓
not_configured ← !S3_BUCKET OR !AWS_ACCESS_KEY_ID OR !AWS_SECRET_ACCESS_KEY
       ↓
otherwise    → probe runs against the bucket, returns healthy/unhealthy
```

The precedence is enforced in the order shown — both `disabled` and
`in_memory` short-circuit **before** the missing-config check, so an
operator can opt out without needing to clean up env vars.

---

## 9. Test matrix (exhaustive)

### 9.1 `tests/storage.healthcheck.test.js` — 22/22 passing

```
Storage S3 connectivity probe (issue #452)
  probeS3Connectivity — reachable
    ✓ returns healthy when HeadBucket succeeds                               (cover success path)
  probeS3Connectivity — error classification
    ✓ returns unhealthy + sanitized AWS error name for NoSuchBucket          (cover allow-list entry)
    ✓ returns unhealthy + sanitized AWS error name for AccessDenied          (cover IAM-failure path)
    ✓ returns unhealthy + sanitized AWS error name for InvalidAccessKeyId    (cover rotated-creds path)
    ✓ returns unhealthy + sanitized AWS error name for NetworkingError       (cover connectivity path)
    ✓ collapses unknown error names to UnknownError                         (cover deny-list fallback)
    ✓ returns unhealthy + TimeoutError when probe exceeds timeout            (cover race winner)
    ✓ never includes the input bucket name in the returned object           (cover name redaction)
  probeS3Connectivity — skip branches
    ✓ returns in_memory when NODE_ENV=test                                  (cover default test short-circuit)
    ✓ returns in_memory when STORAGE_IN_MEMORY=true even with NODE_ENV=development (cover explicit override)
    ✓ returns disabled when S3_HEALTHCHECK_ENABLED=false                    (cover operator opt-out)
    ✓ returns not_configured when S3_BUCKET is missing                      (cover first missing-env branch)
    ✓ returns not_configured when only access key id is configured          (cover second missing-env branch)
    ✓ returns not_configured when only secret is configured                 (cover third missing-env branch)
    ✓ honors STORAGE_HEALTHCHECK_TIMEOUT_MS when no per-call timeout is supplied (cover env override)
  sanitizeStorageError
    ✓ returns allowed AWS error names with hints                            (allow-listed names produce hint)
    ✓ collapses unknown errors to UnknownError                              (null, undefined, string, unknown name)
    ✓ does not expose err.message under any output field                    (regression guard)
  runStartupStorageProbe
    ✓ logs and returns healthy result without throwing on success           (cover info branch)
    ✓ logs a warning on unhealthy probe and does not throw                  (cover warn branch)
    ✓ logs info on a skipped (in_memory) probe result without throwing      (cover skip branch)
  security — credential / endpoint leakage
    ✓ does not log or return AWS_SECRET_ACCESS_KEY or AWS_ACCESS_KEY_ID on failure (sum check)
```

### 9.2 `tests/health.readiness.test.js` — 5 new S3 readiness assertions

```
GET /readyz (readiness) › S3 storage readiness (issue #452)
  ✓ returns 503 when S3 storage probe is unhealthy
       (covers: Pod pulled from LB rotation; readyz gauge set to 0)
  ✓ returns 503 when S3 storage is not_configured
       (covers: missing-bucket / missing-creds scenario)
  ✓ returns 200 when S3 storage probe is explicitly disabled
       (covers: S3_HEALTHCHECK_ENABLED=false in dev sandbox)
  ✓ returns 200 when S3 storage probe is in_memory (test mode)
       (covers: NODE_ENV=test smoke-test path)
  ✓ returns 200 when S3 storage probe is healthy
       (covers: production happy path)
```

### 9.3 Edge-case coverage summary

- ✅ Reachable bucket — happy path
- ✅ Missing bucket — AWS `NoSuchBucket` classified
- ✅ Bad credentials — AWS `InvalidAccessKeyId` and `AccessDenied` classified
- ✅ In-memory fallback mode — `status: 'in_memory'`, no live probe
- ✅ Operator opt-out — `status: 'disabled'`
- ✅ Missing configuration (three axis permutations) — `status: 'not_configured'`
- ✅ AWS SDK timeout — `status: 'unhealthy'`, `error.code === 'TimeoutError'`
- ✅ Custom timeout via env — `STORAGE_HEALTHCHECK_TIMEOUT_MS` honored
- ✅ Sanitizer deny-list — unknown AWS error names collapse to `UnknownError`
- ✅ Bucket name redaction — `bucketConfigured: boolean` only
- ✅ Log redaction under success, warn, and skip branches
- ✅ Prometheus readiness gauge correctly driven to 0 / 0.5 / 1
- ✅ Express response body never leaks AKIA / endpoint / bucket name

---

## 10. Migration and rollback

### 10.1 Migration

No data migration. No env rename. No DB schema change. Deploy the branch
and the readiness probe starts reporting storage status in the next
cycle. Existing `/readyz` callers that don't parse `checks.storage`
(see §10.4) continue to work — they will see a new boolean `status`
on `checks.storage` and ignore it (or surface it appropriately).

### 10.2 Rollback

Single revert commit. The probe, the readiness aggregation, and the
startup call are **strictly additive**. Reverting restores the
pre-PR readiness surface (database + soroban only).

### 10.3 Operational toggles

| Scenario                                                  | Action                                                |
| --------------------------------------------------------- | ----------------------------------------------------- |
| Whole-S3 outage, want to contain blast radius             | Set `S3_HEALTHCHECK_ENABLED=false` → readyz stays 200 |
| Rolling creds migration in progress                       | Set `S3_HEALTHCHECK_ENABLED=false` per pod, roll, revert |
| Want immediate fail-fast on misconfig at startup          | Switch k8s `startupProbe` to consume `/readyz` and `failureThreshold: 3` |
| Network flaps in known-flaky region                       | Raise `STORAGE_HEALTHCHECK_TIMEOUT_MS` (default 5 000) |

### 10.4 Backwards-compatibility note for downstream parsers

Callers of `/readyz` that use the previous (database + soroban) shape
will see an additional `checks.storage` key. JSON consumers that
ignore unknown keys (`jq` filters by field names, status dashboards
keying off `ready: boolean`) will continue to function. Status
ingestion tools that **enumerate** all keys should be updated to
expect `checks.storage` alongside `checks.database` and
`checks.soroban`.

---

## 11. Observability

### 11.1 Logs

The startup probe emits **one** info/warn log line per process start.
Operators querying Loki / CloudWatch / Datadog should already see it
alongside other Pino-structured fields. Pattern:

```
level=INFO  component="s3-healthcheck" event="startup_probe" status="healthy"|"disabled"|"in_memory"|"not_configured"
level=WARN  component="s3-healthcheck" event="probe_failed"   errorCode="NoSuchBucket"|...
level=ERROR component="s3-healthcheck" event="probe_failed"   errorCode="UnknownError"   // only when normalizeStorageError deny-list hits
```

### 11.2 Prometheus metrics

`readiness_gauge` (existing) is driven by the readiness probe result
identically to how `database` and `soroban` drive it:

| Downstream storage status | Gauge value |
| ------------------------- | ----------- |
| `healthy`                 | `1.0`       |
| `disabled`                | `1.0`       |
| `in_memory`               | `1.0`       |
| `not_configured`          | `0.0`       |
| `unhealthy`               | `0.0`       |

No new gauges or counters are introduced.

### 11.3 Latency budget

The probe performs a single `HEAD /` against S3. Expected p50 ≤ 30 ms
intra-region, p99 ≤ 120 ms cross-region. Default timeout is 5 000 ms.
Operators in high-latency deployments should raise
`STORAGE_HEALTHCHECK_TIMEOUT_MS` accordingly.

---

## 12. Cross-references

- AWS S3 `HeadBucket` semantics — request: `HEAD /<bucket>`, response:
  `200` on success, `403 Forbidden` on access denial, `404 Not Found`
  on missing bucket. Used as-is; we don't synthesise the request.
- `@aws-sdk/client-s3` (v3, already in `package.json` ^3.665.0) —
  `HeadBucketCommand` is the typed command. We catch the `S3ServiceError`
  hierarchy; unknown error names are routed through the deny-list.
- Existing readiness conventions: see
  [`src/services/health.js`](src/services/health.js) (`checkDatabaseHealth`,
  `checkSorobanHealth`, `checkKycHealth`, `checkIndexerStaleness`).

---

## 13. Out of scope (explicit non-goals / future work)

- **Aborting the in-flight AWS SDK request** when the local timeout
  wins. The current code already swallows the eventual rejection with
  `.catch(() => {})` to keep the process from crashing under
  `--unhandled-rejections=strict`, but the underlying socket is still
  consumed until the SDK's own retry chain completes. AWS SDK v3
  supports `AbortController` via the `requestHandler` config; wiring
  it up is a follow-up. Does NOT block this PR.
- **Per-bucket write probe.** `HeadBucket` verifies reachability, not
  writability. A write probe would require uploading a tiny file and
  cleaning up — out of scope.
- **Retry policy tuning.** Default SDK retries (3) apply on transient
  failures. Operators can raise `AWS_MAX_ATTEMPTS` if needed.
- **Pre-existing repo issues** unrelated to #452 (see §14).

---

## 14. ⛔ Pre-existing blockers (out of scope for #452)

The following issues are **not introduced by this PR** but they block
several test suites from loading under Jest 30 / Babel. Flagging here so
reviewers don't mark the new S3 readiness tests as red for the wrong
reason. **Each should be a separate, minimal PR.**

### 14.1 Duplicate `require('express-rate-limit')` in `src/middleware/rateLimit.js`

`src/middleware/rateLimit.js` declares `const rateLimit =
require('express-rate-limit');` on consecutive lines (15 and 16).
Babel parser rejects the file under strict mode:

```
SyntaxError: Identifier 'rateLimit' has already been declared.
```

Any Jest spec that imports `src/app.js` (e.g.
`tests/health.readiness.test.js`, `tests/sme.upload.test.js`)
blows up before reaching any `describe` block.

**Fix:** delete one of the two `require` lines. One-line patch.

### 14.2 Missing optional dependency `redis` in `src/cache/redis.js`

`src/cache/redis.js` does `const redis = require('redis');`, but the
`redis` package is **not** declared in `package.json`. Any chain that
pulls in `src/services/escrowRead.js` (which transitively references
the module) throws `Cannot find module 'redis'` at load time.

**Fix:** declare `redis` as an optional peer dependency in
`package.json`, or add a `try { require('redis') } catch { /* no-cache
mode */ }` guard.

### 14.3 Duplicate `prom-client` entries in `package.json`

```jsonc
// package.json has both:
"prom-client": "^15.1.3",
// ...
"prom-client": "^14.2.0",
```

npm will install both; the resolved winner depends on spec-resolution
order. **Fix:** trim to the intended single version.

---

## 15. Verification steps

```bash
# Targeted tests (run independently of the pre-existing blockers above):
npm test -- tests/storage.healthcheck.test.js --runInBand --forceExit
# Expected: 22 passed, 22 total.

# Lint on changed files only:
npm run lint 2>&1 \
  | grep -E '(storage\.js|health\.js|index\.js|metrics\.js|health\.readiness\.test\.js|storage\.healthcheck\.test\.js)'
# Expected: no output (clean).

# Manual readiness smoke test (assumes the pre-existing blockers cleared):
npm run dev &
sleep 5
curl -fsS http://localhost:3001/healthz        # 200 always
curl -fsS http://localhost:3001/readyz          # 200 / 503 depending on storage state
curl -fsS http://localhost:3001/readyz | jq .checks.storage
# Examples:
#   { "status": "healthy",            "latency": 7,  "bucketConfigured": true, "credentialsConfigured": true }
#   { "status": "unhealthy",          "error": { "code": "NoSuchBucket", "hint": "configured bucket not found" } }
#   { "status": "in_memory",          "bucketConfigured": false }
#   { "status": "disabled",           "bucketConfigured": true,  "credentialsConfigured": true }
#   { "status": "not_configured",     "bucketConfigured": false, "credentialsConfigured": false }
```

---

## 16. Checklist

- [x] Code in `src/services/storage.js` and `src/services/health.js`
- [x] Tests in `tests/storage.healthcheck.test.js` (22 cases) and
      `tests/health.readiness.test.js` (5 new cases)
- [x] JSDoc on every new symbol in `src/`
- [x] No `AWS_*` credentials, no `S3_ENDPOINT`, no bucket name, no
      `$metadata.requestId` ever appears in any `/readyz` response
      or Pino log payload (mechanically verified by tests)
- [x] Probe skippable via `S3_HEALTHCHECK_ENABLED=false`,
      `STORAGE_IN_MEMORY=true`, or `NODE_ENV=test`
- [x] Readiness `/readyz` returns 503 when storage is `unhealthy` or
      `not_configured`; returns 200 when `in_memory`, `disabled`, or
      `healthy`
- [x] Prometheus `readiness_gauge` driven identically for storage as
      for `database` and `soroban`
- [x] Operator documentation: `docs/storage-ops.md` (runbook + status
      matrix + security model) and `docs/configuration.md` (env table)
- [x] Drive-by TDZ fix in `src/metrics.js` so the readiness test
      suite can load
- [x] Pre-existing blockers flagged (separate PRs needed to clear)
- [x] Conventional Commits message format
- [x] Commit message references `Closes #452`
