Webhooks
========

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

This document describes the webhook system for LiquiFact escrow events.

## Overview

Webhooks are emitted to merchant-configured URLs when escrow events occur. The webhooks are signed with HMAC-SHA256 for security.

## Events

### escrow_funded

Emitted when an escrow is funded.

**Payload:**
```json
{
  "event": "escrow_funded",
  "timestamp": "2023-10-01T12:00:00.000Z",
  "invoiceId": "inv_123",
  "fundedAmount": 1000
}
```

### escrow_settled

Emitted when an escrow is settled.

**Payload:**
```json
{
  "event": "escrow_settled",
  "timestamp": "2023-10-01T12:00:00.000Z",
  "invoiceId": "inv_123",
  "fundedAmount": 1000
}
```

## Configuration

Webhooks are configured per tenant in the `tenants.settings` JSONB field:

```json
{
  "webhook_url": "https://merchant.example.com/webhooks",
  "webhook_secret": "your-secret-key"
}
```

## Security

Each webhook request includes an `X-Signature` header containing a timestamped HMAC-SHA256 signature using the configured secret.

### Signature Format

The signature header uses the format `X-Signature: t=<timestamp>,v1=<signature>` where:
- `t` is a Unix timestamp (seconds) of when the webhook was signed
- `v1` is the signature version identifier
- Both are required for proper verification

### Signature Construction

1. Generate a Unix timestamp (seconds since epoch).
2. Create the signed payload string: `"<timestamp>.<raw_json_body>"` (e.g., `"1704110400.{...}"`)
3. Compute HMAC-SHA256 of the signed payload using your webhook secret.
4. Include in the request header: `X-Signature: t=<timestamp>,v1=<hex_signature>`

### Verifying Webhook Signatures (Receiver)

To verify a webhook signature on the receiver side:

**Security Best Practices:**
1. **Use constant-time comparison** - Use `crypto.timingSafeEqual()` or equivalent to prevent timing attacks when comparing signatures.
2. **Validate the timestamp** - Reject webhooks with timestamps older than 5 minutes (recommended tolerance window) to prevent replay attacks.
3. **Keep the secret secure** - Never log or expose your webhook secret. Store it in environment variables or a secure secrets manager.
4. **Parse carefully** - Extract `t=` and `v1=` parameters from the signature header before verification.

**Verification Steps (Node.js example):**
```javascript
const crypto = require('crypto');

function verifyWebhook(rawBody, signatureHeader, secret, toleranceMs = 5 * 60 * 1000) {
  const parts = signatureHeader.split(',');
  let timestamp = null;
  let signature = null;

  for (const part of parts) {
    if (part.startsWith('t=')) {
      timestamp = parseInt(part.slice(2), 10);
    } else if (part.startsWith('v1=')) {
      signature = part.slice(3);
    }
  }

  if (!timestamp || !signature) {
    throw new Error('Invalid signature header format');
  }

  // Check for replay attacks
  const now = Date.now();
  if (Math.abs(now - timestamp * 1000) > toleranceMs) {
    throw new Error('Timestamp outside tolerance window');
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // Use constant-time comparison
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    throw new Error('Invalid signature');
  }

  return true;
}
```

**Replay Protection:**
The timestamp in the signature allows receivers to detect and reject replayed webhooks. We recommend a tolerance window of 5 minutes (300,000 ms), which can be configured. Any webhook with a timestamp outside this window should be rejected.

**Idempotency Recommendation:**
While signatures prevent tampering and replay, consider implementing idempotency on the receiver side to handle duplicate legitimate webhook deliveries gracefully. The `invoiceId` in the payload can be used as an idempotency key.

## Delivery

- Webhooks are sent via HTTP POST using Node.js native `fetch`.
- Timeout: 5 seconds (implemented via `AbortController`).
- Non-2xx responses are treated as failures and logged.
- Failures are logged but not retried (retries to be implemented in follow-up).

## Testing

Use invoice IDs `funded_invoice` and `settled_invoice` to trigger webhooks when reading escrow state.