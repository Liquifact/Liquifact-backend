Webhooks

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

---

## Dead-letter replay

### Overview

When a webhook delivery exhausts all retries the delivery job writes the
failed event to the `webhook_dead_letters` table. Operators can re-attempt
("replay") those deliveries after a merchant endpoint recovers using the admin
API.

### Schema — `webhook_dead_letters`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Row identifier used in all replay/resolve calls |
| `tenant_id` | TEXT | Owning tenant |
| `invoice_id` | TEXT | Related invoice |
| `event` | TEXT | Webhook event type |
| `payload` | JSONB | Original event payload |
| `webhook_url` | TEXT | Destination URL at time of failure |
| `attempts` | INTEGER | Number of delivery attempts before dead-lettering |
| `last_error` | TEXT | Last error message |
| `resolved` | BOOLEAN | `true` once successfully replayed or manually resolved |
| `resolved_at` | TIMESTAMPTZ | When the row was resolved |

Migration: `migrations/20260627000001_create_webhook_dead_letters.sql`

### Replay flow

```
Operator                Admin API              webhooks.js          Merchant
   │                       │                       │                    │
   │ POST /replay/:id       │                       │                    │
   │──────────────────────>│                       │                    │
   │                       │ replayWebhook(id)     │                    │
   │                       │──────────────────────>│                    │
   │                       │                       │ fetch tenant secret│
   │                       │                       │ createSignatureHeader()
   │                       │                       │ POST (fresh sig)──>│
   │                       │                       │<── 2xx ────────────│
   │                       │                       │ resolveDeadLetter()│
   │                       │<── { replayed: [id] } │                    │
   │<── 202 ───────────────│                       │                    │
```

Key properties:
- **Re-signs every replay** — a fresh `t=<timestamp>,v1=<hmac>` signature is
  computed at replay time using the tenant's current webhook secret.
- **Idempotency guard** — replaying an already-resolved row returns `409`.
- **Atomic resolution** — the row is only marked resolved after a `2xx`
  response; a delivery failure leaves it available for a subsequent replay.

### Admin endpoints

All endpoints require either `Authorization: Bearer <admin-jwt>` or
`X-API-Key: <key>`.

Every endpoint is tenant-scoped: results are filtered to the tenant resolved
from the `x-tenant-id` header or the `tenantId` JWT claim. No cross-tenant
data is ever returned.

#### List dead-letter rows (filterable, cursor-paginated)

```
GET /api/admin/webhooks/dead-letters
```

Discovers dead-letter row IDs without querying the database directly.
Results are ordered by `created_at` descending (newest first).

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | 20 | Page size. Range: 1–100. |
| `cursor` | string | – | Opaque cursor from a previous response's `nextCursor`. |
| `event` | string | – | Exact match on the `event` column (e.g. `invoice.approved`). |
| `targetUrl` | string | – | Exact match on the `webhook_url` column. |
| `resolved` | boolean | – | `true` to list resolved rows; `false` for unresolved only. |
| `createdAfter` | ISO 8601 | – | Lower bound on `created_at` (inclusive). |
| `createdBefore` | ISO 8601 | – | Upper bound on `created_at` (exclusive). |

**Example — first page, unresolved only:**

```bash
curl -H "Authorization: Bearer <admin-jwt>" \
     -H "x-tenant-id: t_123" \
     "http://localhost:3001/api/admin/webhooks/dead-letters?resolved=false&limit=20"
```

**Example response (200):**

```json
{
  "data": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "tenant_id": "t_123",
      "invoice_id": "inv_abc",
      "event": "invoice.approved",
      "webhook_url": "https://merchant.example.com/webhook",
      "attempts": 4,
      "last_error": "connect ECONNREFUSED 93.184.216.34:443",
      "resolved": false,
      "resolved_at": null,
      "created_at": "2026-07-20T14:32:00.000Z",
      "payload": "{\"event\":\"invoice.approved\",\"invoiceId\":\"inv_abc\"}"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "<opaque-cursor-string>",
    "timestamp": "2026-07-22T03:00:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Dead-letter rows retrieved successfully."
}
```

**Example — next page using cursor:**

```bash
curl -H "Authorization: Bearer <admin-jwt>" \
     -H "x-tenant-id: t_123" \
     "http://localhost:3001/api/admin/webhooks/dead-letters?resolved=false&limit=20&cursor=<nextCursor>"
```

**Error responses**

| Status | Code | Cause |
|--------|------|-------|
| 400 | `INVALID_PAGINATION` | `limit` outside 1–100 range or non-numeric |
| 400 | `INVALID_FILTER` | `resolved` not `true`/`false`, or `createdAfter`/`createdBefore` not ISO 8601 |
| 400 | `INVALID_CURSOR` | Cursor is malformed or has an invalid HMAC signature |
| 401 | – | Missing or invalid credentials |
| 400 | – | Missing tenant context |

**Security notes**

- HMAC secrets and any field matching a sensitive-key pattern (`secret`,
  `token`, `password`, `apiKey`, `privateKey`, etc.) are stripped from every
  row before it is returned.
- Cursors are HMAC-signed with `CURSOR_SECRET` (or `JWT_SECRET`) and verified
  using constant-time comparison — tampering returns 400 immediately.
- Page size is hard-capped at 100 to limit per-request DB load.

#### Replay a single row

```
POST /api/admin/webhooks/replay/:id
```

Responses:

| Status | Meaning |
|--------|---------|
| 202 | Replayed successfully — `{ "replayed": ["<id>"] }` |
| 401/403 | Missing or invalid credentials |
| 404 | Dead-letter row not found |
| 409 | Row already resolved |
| 502 | Delivery failed — `{ "error": "Replay failed: <msg>" }` |

#### Replay a batch

```
POST /api/admin/webhooks/replay
Content-Type: application/json
```

Body (one of):

```json
{ "ids": ["uuid1", "uuid2"] }
```

```json
{ "tenantId": "t_123", "limit": 50 }
```

`limit` is capped at 200. Response is always `202`:

```json
{
  "replayed": ["uuid1"],
  "failed":   [{ "id": "uuid2", "error": "..." }]
}
```

#### Resolve without re-sending

```
POST /api/admin/webhooks/resolve/:id
```

Marks the row resolved without making a delivery attempt. Useful when the
event is stale and re-delivery is not desired.

| Status | Meaning |
|--------|---------|
| 200 | Resolved — `{ "resolved": "<id>" }` |
| 404 | Row not found |
| 409 | Row already resolved |

### `webhook_replay` job

The `webhookReplayHandler` in `src/jobs/webhookReplay.js` processes
`webhook_replay` jobs enqueued with `{ deadLetterId }` as the payload. It is
registered with the background worker and increments the `webhook_replay_total`
Prometheus counter with the outcome label:

| `outcome` | Meaning |
|-----------|---------|
| `success` | Delivery succeeded and row resolved |
| `failure` | Delivery returned non-2xx or network error |
| `not_found` | Dead-letter row missing |
| `already_resolved` | Row was already resolved before the job ran |

### Metrics

`webhook_replay_total{outcome="..."}` — exported by `GET /metrics`.

### Security

- Only admin-authenticated callers (JWT or API key) can trigger replays.
- The HMAC signature is always recomputed at replay time — stored payloads
  are never re-sent with a stale signature.
- Batch size is hard-capped at 200 to prevent request-amplification abuse.
