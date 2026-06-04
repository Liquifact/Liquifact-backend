Webhooks

Retry policy
------------

- Retries are performed only for network/timeouts or 5xx HTTP responses.
- 4xx responses are considered permanent failures and are not retried.
- Configurable via environment variables:
  - `WEBHOOK_MAX_RETRIES` (default 3) — number of retry attempts (total attempts = retries + 1)
  - `WEBHOOK_BASE_DELAY` (default 500ms) — initial backoff base
  - `WEBHOOK_MAX_DELAY` (default 10000ms) — maximum backoff delay
  - `WEBHOOK_TIMEOUT_MS` (default 5000ms) — per-request timeout
- Backoff is exponential with jitter; bounds are enforced to prevent unbounded delays.

Dead-letter queue
-----------------

- Exhausted deliveries are persisted to the `webhook_dead_letters` table for later inspection and replay.
- Stored fields include `tenant_id`, `invoice_id`, `event`, `payload`, `last_error`, `attempts`, and `created_at`.

Observability
-------------

- Each delivery attempt is recorded as an `webhook_delivery` audit event (via `auditLogStore.appendAuditEvent`) with redaction applied to sensitive fields.
- A Prometheus counter `webhook_delivery_failures_total` is incremented when a delivery is exhausted and written to the dead-letter queue.

Security notes
--------------

- Webhook payloads are signed using HMAC-SHA256. The signature header is `X-Signature` and follows the format `t=<timestamp>,v1=<signature>`.
- Secrets are never logged directly; audit events use redaction rules.
- Replay of dead-lettered events should be performed in a controlled, authenticated process to avoid leaking secrets.
# Webhooks
# LiquiFact Webhooks

LiquiFact backend emits webhooks to notify tenant systems about important escrow events.

## Event Types

Currently, the following events are supported:
- `escrow_funded`: Emitted when an escrow account reaches its required funding balance.
- `escrow_settled`: Emitted when an escrow transaction is finalized and settled on the Stellar network.

## Security & Signatures

All webhooks include an `X-Signature` header to verify authenticity and integrity. LiquiFact uses HMAC-SHA256 to generate the signature over the deterministic JSON payload string.

### Idempotency
Webhook delivery is at-least-once. Your receiving endpoint should gracefully handle duplicate webhook events by verifying the `invoiceId` or a database record state.

### Verifying Signatures

The signature is constructed using a timestamp to prevent replay attacks. The header looks like:
`t=<timestamp>,v1=<signature>`

**Steps to Verify**:
1. Split the `X-Signature` header by `,` to extract `t` (timestamp) and `v1` (signature).
2. Read the raw HTTP request body as a string. **Do not serialize an already parsed JSON object**, as serialization key orders or whitespace might differ from the exact bytes sent by LiquiFact.
3. Prevent replay attacks: compare the timestamp `t` to your current time and reject events outside of your tolerance window (e.g., 5 minutes).
4. Compute the expected signature:
   `expected_signature = HMAC_SHA256(secret, t + "." + raw_body)`
5. Use a constant-time comparison to check if your expected signature matches the `v1` signature.

### Secret Management
Webhook secrets are configured per tenant. Store this secret securely. The backend will not emit webhooks if the secret is not configured or is empty.

### Code Example (Node.js)

```javascript
const crypto = require('crypto');

function verifyWebhook(secret, rawBody, signatureHeader) {
  const parts = signatureHeader.split(',');
  const t = parts.find(p => p.startsWith('t=')).slice(2);
  const v1 = parts.find(p => p.startsWith('v1=')).slice(3);

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(v1, 'hex')
  );

  return isValid;
}
```
