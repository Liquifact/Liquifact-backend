# Signed webhook delivery contract

This document is the operational contract for outgoing Liquifact webhooks.
It covers the guarantees implemented by `src/services/webhooks.js` and the
retry utility it uses. A receiver should be able to verify a delivery without
knowing which worker sent it, and an operator should be able to diagnose or
replay a failed delivery without reconstructing the original payload.

## Contract summary

| Area | Guarantee |
| --- | --- |
| Signature | HMAC-SHA256 over `<unix-seconds>.<raw-body>` |
| Header | `X-Signature: t=<timestamp>,v1=<hex digest>` |
| Body bytes | The receiver verifies the exact bytes it received |
| Freshness | Five-minute timestamp tolerance by default |
| Payload order | Object keys are recursively canonicalized before serialization |
| Payload bound | 128 KiB default for normal webhook payloads |
| Retryable delivery | 5xx responses and transient network/timeout errors |
| Retry limit | Three retries by default, eleven total maximum through utility cap |
| Backoff | Exponential with a bounded 20% jitter spread |
| Failure record | Durable dead-letter row with payload, endpoint, attempts, and reason |
| Replay | Admin-controlled re-sign and resend, capped and concurrency-fenced |

The values controlled by environment variables are still bounded in code. A
deployment may choose a smaller limit for its provider, but must not use an
unbounded retry count or an unbounded request body.

## Receiver verification

The sender computes the digest from the timestamp and the raw serialized body:

```text
signed_payload = timestamp + "." + raw_body
signature = HMAC-SHA256(webhook_secret, signed_payload)
X-Signature = "t=" + timestamp + ",v1=" + hex(signature)
```

The receiver should:

1. capture the request body before JSON parsing;
2. parse `t` and `v1` from `X-Signature`;
3. reject malformed or excessively long headers;
4. reject timestamps outside the configured tolerance;
5. compute HMAC-SHA256 over the captured bytes and timestamp;
6. compare digests with a constant-time comparison;
7. only then parse and process the JSON payload.

Do not reserialize a parsed object before verification. Whitespace, escaping,
number formatting, and key order are all part of the signed bytes. A receiver
that needs to keep a copy should store the verified raw body alongside its
parsed representation.

### Example verification pseudocode

```text
header = request.headers["x-signature"]
(timestamp, received) = parse(header)
if abs(now_seconds - timestamp) > tolerance:
    reject("stale webhook")
expected = hmac_sha256(secret, timestamp + "." + request.raw_body)
if !constant_time_equal(expected, received):
    reject("invalid webhook signature")
accept(request.raw_body)
```

The `v1` marker is a version slot. Receivers should preserve the marker when
logging and should be prepared for a future version to use another digest or
key rotation protocol. Never log the secret or the complete authorization
material in a normal application log.

## Canonical payloads

Liquifact recursively sorts object keys before JSON serialization. Arrays keep
their original order because array position is semantic. Primitive values and
`null` are unchanged. Canonicalization makes signatures reproducible for the
same logical payload and prevents accidental differences between worker paths.

Canonicalization is not a substitute for raw-body verification. The signed
body is the final serialized string, including all separators and escaping.
The canonicalizer also does not define a schema: producers and receivers must
still version event fields and reject unknown or invalid business values where
appropriate.

## Delivery lifecycle

```text
event -> canonical payload -> size guard -> sign -> POST
                                      |             |
                                      |             +-- 2xx: audit success
                                      |
                                      +-- 4xx/permanent: dead letter
                                      +-- 5xx/timeout: bounded retry
                                                       |
                                                       +-- recovered: audit success
                                                       +-- exhausted: dead letter
```

Normal event delivery loads the invoice and tenant settings, builds the
canonical payload, enforces the maximum byte size, signs the body, and sends a
POST with `Content-Type: application/json` and `X-Signature`. The worker records
each retry attempt in the audit stream. A successful response clears any job
fence and records the final status.

The delivery path treats a successful HTTP response as a response with a 2xx
status. A non-2xx response becomes an error with its status attached, so the
retry predicate can distinguish transient server failures from permanent
client failures.

## Retry rules

Retries are intended for failures where the receiver did not successfully
process the request or where the result is safe to deliver again. The standard
predicate retries:

- HTTP 5xx responses;
- connection reset/refused errors;
- DNS lookup failures;
- timeout and abort errors.

It does not retry payload-too-large, fence-expired, authentication, validation,
or other permanent errors. Provider-specific code should remain close to the
transport adapter so a permanent response is not accidentally reclassified as
transient.

The retry utility uses a total-attempt model: `maxRetries: 3` means one initial
attempt plus three retries. The retry count is capped at ten retries and delay
values are capped by the utility. Exponential delay is jittered by roughly
plus or minus twenty percent to avoid synchronized worker waves. Configure the
base and maximum delay with care; a large retry budget increases provider load
while a small budget moves more work to the dead-letter queue.

An operation that times out may have been accepted by the receiver. Consumers
must therefore include a stable event or delivery identifier in the payload or
use a receiver-side deduplication key. Never assume a timeout proves that no
side effect occurred.

## Dead-letter records

When delivery exhausts its retry budget, Liquifact stores a row in
`webhook_dead_letters` containing:

- tenant ID and related invoice ID;
- event name;
- the serialized payload;
- destination URL;
- number of attempts;
- the last error reason;
- replay count, resolution state, and timestamps.

The payload is stored as the serialized body so replay can preserve the exact
content that was originally sent. If the implementation receives an object in
a direct administrative call, it serializes it before storage. Treat this row
as sensitive: it can contain invoice data and a destination URL. Access should
remain behind authenticated administrative routes and normal database access
controls.

A dead-letter row is not an acknowledgement that the provider rejected the
business event. It means Liquifact could not establish a successful delivery
within the configured bounded attempts. Operators should inspect the receiver
and the last error before replaying.

## Replay safety

Replay reads an unresolved row, rejects rows at the replay cap, and atomically
claims the row before sending. The claim prevents two administrators or jobs
from concurrently replaying the same row. Replay signs the stored body with
the current tenant secret, posts it to the stored endpoint, and resolves the
row only after a successful response.

If replay fails, the claim is released and the last error is updated. An
operator can retry later after fixing the receiver. If the tenant secret has
rotated, replay uses the current configured secret; the receiver must support
that rotation window or the operator must coordinate the change with it.

The replay cap is an abuse and storm-control boundary. It is not a substitute
for investigating a permanently broken endpoint. Repeated replay failures
should result in endpoint correction, receiver-side deduplication review, or a
manually documented resolution.

## Payload and configuration limits

Normal webhook payloads default to 128 KiB. Configuration webhooks have a
smaller dedicated bound. The byte count is UTF-8 bytes, not JavaScript string
length. A payload that exceeds its limit is rejected before any network call
and is not retried.

Recommended deployment checks:

- set `WEBHOOK_MAX_PAYLOAD_BYTES` to a provider-supported value;
- set `WEBHOOK_TIMEOUT_MS` below the worker shutdown/drain deadline;
- set `WEBHOOK_MAX_RETRIES` to a finite value appropriate for the event;
- set `WEBHOOK_BASE_DELAY` and `WEBHOOK_MAX_DELAY` to avoid a retry storm;
- monitor dead-letter growth after changing any limit;
- keep webhook secrets in the secret manager, not source or repository files.

The utility applies hard caps even if an environment value is accidentally
large. Invalid or missing provider settings should fail closed and be visible
in logs/health checks rather than silently sending unsigned data.

## Observability

The delivery path emits structured logs for successful delivery, retry audit
events, dead-letter persistence failures, replay outcomes, and fence changes.
Useful low-cardinality dimensions include tenant, event family, HTTP status,
and outcome. Avoid URL query strings, invoice payloads, secrets, and arbitrary
provider error text in metric labels.

At minimum, dashboards should show:

| Signal | Meaning | Action |
| --- | --- | --- |
| retry count | transient delivery pressure | inspect provider latency/status |
| dead-letter count | bounded delivery exhausted | inspect endpoint and replay |
| payload-too-large count | contract/config mismatch | reduce payload or raise reviewed limit |
| signature failures at receiver | secret/body mismatch | inspect raw-body handling and rotation |
| replay failures | unresolved receiver problem | stop replaying and fix endpoint |
| fence expirations | worker lease exceeded | inspect queue latency and timeout |

Audit events should include attempt number, status code where available, and
the destination as metadata subject to existing redaction policy. The complete
payload belongs in the dead-letter store, not in normal logs.

## Incident runbooks

### Provider returns 5xx

1. Check provider status and delivery latency.
2. Confirm retry and timeout values are bounded and unchanged.
3. Inspect dead-letter growth and the last error distribution.
4. Wait for recovery or coordinate with the provider.
5. Replay a small sample and confirm receiver-side deduplication.
6. Replay the remaining rows in controlled batches.

### Receiver reports invalid signatures

1. Confirm the receiver uses the raw request body.
2. Compare the received timestamp and body length, without logging secrets.
3. Confirm both systems use the same tenant secret and `v1` marker.
4. Check clock skew and the five-minute tolerance.
5. Test one fresh delivery before replaying old rows.

### Dead-letter rows keep growing

1. Group by endpoint, event, and last error category.
2. Check for 4xx contract failures versus 5xx availability failures.
3. Disable or correct the endpoint if it is rejecting every delivery.
4. Preserve rows until the business owner approves resolution.
5. Replay only after the receiver is healthy and deduplication is confirmed.

## Review checklist

- [ ] The receiver verifies the raw body before JSON parsing.
- [ ] The receiver uses constant-time digest comparison.
- [ ] The timestamp tolerance and clock synchronization are documented.
- [ ] The endpoint stores/deduplicates a stable event identifier.
- [ ] Retry classification distinguishes 5xx/transient failures from 4xx/permanent failures.
- [ ] Retry count, base delay, maximum delay, and payload bytes are bounded.
- [ ] A failure stores the serialized payload and last reason.
- [ ] Replay is authenticated, capped, and concurrency-safe.
- [ ] Replay resolves only after a successful response.
- [ ] Metrics and logs use low-cardinality, redacted fields.
- [ ] Tests cover success, tampering, stale signatures, retry recovery, exhaustion, and replay data.

The issue-specific contract tests in
`tests/webhooks.issue1178.contract.test.js` are intentionally deterministic:
they cover the cryptographic input, freshness guard, canonicalization,
permanent/transient retry behavior, retry caps, and dead-letter fields. Keep
them green when changing the delivery or replay implementation.
