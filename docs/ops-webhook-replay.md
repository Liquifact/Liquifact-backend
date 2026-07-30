# Webhook Dead-Letter Triage, Replay, and Resolution

Operator runbook for diagnosing and resolving failed webhook deliveries in the
LiquiFact backend. This document covers the full path from delivery failure to
the `webhook_dead_letters` table, replay mechanics, authentication requirements,
Prometheus metrics, and a triage decision table.

---

## Architecture Overview

```
invoiceStateMachine.executeTransition()
        │
        ▼
enqueueWebhookDelivery()          ← looks up tenant webhook_url / webhook_secret
        │
        ▼
BackgroundWorker  →  webhookDelivery job
        │  (up to WEBHOOK_MAX_RETRIES + 1 total attempts)
        │
        ├── 2xx  →  webhook_delivery_success_total.inc()  →  done
        │
        └── exhausted  →  webhook_dead_letters INSERT
                              │
                              ▼
                       webhook_delivery_dead_letter_total.inc()
                              │
                         Operator triage
                              │
              ┌───────────────┴─────────────────┐
              ▼                                 ▼
   POST /replay/:id                  POST /resolve/:id
      (re-send)                      (mark done, no re-send)
              │
              ▼
      webhookReplayHandler
              │
       replayWebhook(id)
              │
        ┌─────┴──────┐
        ▼             ▼
      2xx           non-2xx / error
   resolveDeadLetter()   throw
   outcome=success   outcome=failure / not_found / already_resolved
```

---

## Dead-Letter Lifecycle

### 1 — Delivery failure

A `webhook_delivery` job handler in `src/jobs/webhookDelivery.js`:
- Signs the payload with a fresh `t=<ts>,v1=<hmac>` header on each attempt.
- Retries on network errors (`ECONNRESET`, `ETIMEDOUT`, etc.) and HTTP 5xx using
  exponential backoff controlled by `WEBHOOK_BASE_DELAY` / `WEBHOOK_MAX_DELAY`.
- Does **not** retry HTTP 4xx — those are treated as permanent failures.
- After exhausting `WEBHOOK_MAX_RETRIES` (default 3) the handler calls
  `writeDeadLetter()` which inserts a row into `webhook_dead_letters` and
  increments `webhook_delivery_dead_letter_total`.

### 2 — Dead-letter record

The `webhook_dead_letters` table (migration
`migrations/20260627000001_create_webhook_dead_letters.sql`) stores one row
per exhausted delivery:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Row identifier used in all replay/resolve calls |
| `tenant_id` | TEXT | Owning tenant |
| `invoice_id` | TEXT | Related invoice |
| `event` | TEXT | Webhook event type (e.g. `invoice.pending_to_approved`) |
| `payload` | JSONB | Original signed event payload |
| `webhook_url` | TEXT | Destination URL at time of failure |
| `attempts` | INTEGER | Delivery attempts before dead-lettering |
| `last_error` | TEXT | Error message from the final attempt |
| `resolved` | BOOLEAN | `true` once replayed successfully or manually resolved |
| `resolved_at` | TIMESTAMPTZ | Timestamp of resolution |
| `created_at` | TIMESTAMPTZ | When the row was created |
| `updated_at` | TIMESTAMPTZ | Last update timestamp |

Indexes:
- `(tenant_id, resolved)` — efficient operator queries for unresolved rows per tenant.
- `(created_at)` — pagination and age-based triage.

### 3 — Replay job

The `webhook_replay` background job (`src/jobs/webhookReplay.js`) processes
replays enqueued programmatically with `{ deadLetterId }` as the payload.

`webhookReplayHandler` calls `replayWebhook(deadLetterId)` from
`src/services/webhooks.js`, which:

1. Fetches the dead-letter row by `id`. Throws `NOT_FOUND` if absent.
2. Checks `resolved`. Throws `ALREADY_RESOLVED` if already done.
3. Fetches the tenant's current `webhook_secret` from `tenants.settings`.
4. Re-signs the stored payload with a **fresh** `t=<now>,v1=<hmac>` header.
5. POSTs to `webhook_url` with a 5-second abort timeout.
6. On `2xx`: calls `resolveDeadLetter()` to set `resolved = true` and
   `resolved_at = now`, then increments `webhook_replay_total{outcome="success"}`.
7. On non-`2xx` or network error: increments
   `webhook_replay_total{outcome="failure"}` and re-throws so the worker can
   apply exponential backoff for a subsequent retry.

#### Outcome codes

| `outcome` label | Trigger |
|-----------------|---------|
| `success` | Delivery returned 2xx; row is now resolved |
| `failure` | Delivery returned non-2xx or network/timeout error |
| `not_found` | Dead-letter row does not exist (e.g. already purged) |
| `already_resolved` | Row was resolved between job enqueue and execution |

---

## Authentication Requirements

All admin webhook endpoints check for **one** of the following credentials on
every request:

| Method | Header | Notes |
|--------|--------|-------|
| JWT Bearer | `Authorization: Bearer <admin-jwt>` | Standard JWT issued by the auth service |
| API key | `X-API-Key: <key>` | Service-to-service key from `API_KEYS` env var |

Requests missing both credentials receive **401 Unauthorized**.
Invalid credentials (wrong token or revoked/unrecognised API key) also receive **401**.

The auth check is implemented by `adminAuth()` in `src/routes/adminWebhooks.js`:
- If `x-api-key` header is present → `apiKeyAuth` middleware.
- Otherwise → `authenticateToken` JWT middleware.

### Endpoint summary

| Endpoint | Auth required | Purpose |
|----------|---------------|---------|
| `POST /api/admin/webhooks/replay/:id` | JWT or API key | Replay a single dead-letter row |
| `POST /api/admin/webhooks/replay` | JWT or API key | Batch replay by id list or tenant filter |
| `POST /api/admin/webhooks/resolve/:id` | JWT or API key | Mark a row resolved without re-sending |

---

## Admin Endpoint Reference

### Replay a single row

```http
POST /api/admin/webhooks/replay/:id
Authorization: Bearer <admin-jwt>
```

| Status | Meaning |
|--------|---------|
| `202` | Replayed — `{ "replayed": ["<id>"] }` |
| `401` | Missing or invalid credentials |
| `404` | Dead-letter row not found |
| `409` | Row already resolved (idempotency guard) |
| `502` | Delivery attempt failed — `{ "error": "Replay failed: <msg>" }` |

Example:

```bash
curl -X POST https://api.example.com/api/admin/webhooks/replay/d1a2b3c4-... \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Replay a batch

```http
POST /api/admin/webhooks/replay
Authorization: Bearer <admin-jwt>
Content-Type: application/json
```

Body — explicit id list:

```json
{ "ids": ["d1a2b3c4-...", "e5f6a7b8-..."] }
```

Body — all unresolved rows for a tenant (with optional page limit):

```json
{ "tenantId": "t_123", "limit": 50 }
```

`limit` is capped at `200` to prevent request-amplification abuse.

Response (always `202`):

```json
{
  "replayed": ["d1a2b3c4-..."],
  "failed":   [{ "id": "e5f6a7b8-...", "error": "Webhook replay responded with 503" }]
}
```

### Resolve without re-sending

```http
POST /api/admin/webhooks/resolve/:id
Authorization: Bearer <admin-jwt>
```

Marks the row `resolved = true` without making a delivery attempt. Use this
when re-delivery is not desired (stale event, downstream permanently gone, etc.).

| Status | Meaning |
|--------|---------|
| `200` | Resolved — `{ "resolved": "<id>" }` |
| `404` | Row not found |
| `409` | Row already resolved |

---

## Prometheus Metrics

### `webhook_replay_total`

Counter exported by `GET /metrics`. Labelled by `outcome`.

| `outcome` | Meaning | Alert priority |
|-----------|---------|----------------|
| `success` | Replay delivered; row resolved | Informational |
| `failure` | Delivery returned non-2xx or network error | High — replay not resolving |
| `not_found` | Row missing before replay ran | Medium — possible race or data issue |
| `already_resolved` | Row was already resolved | Low — expected on concurrent replays |

### Related counters

| Metric | Description |
|--------|-------------|
| `webhook_delivery_attempts_total` | Total delivery attempts including retries |
| `webhook_delivery_success_total` | Successful first-attempt or retry deliveries |
| `webhook_delivery_dead_letter_total` | Deliveries moved to dead-letter table |

### Recommended alerting

```promql
# Replay failure rate — indicates systematic endpoint problems
rate(webhook_replay_total{outcome="failure"}[15m]) > 0

# Dead-letter accumulation — new failures arriving faster than replays succeed
rate(webhook_delivery_dead_letter_total[15m])
  > rate(webhook_replay_total{outcome="success"}[15m])

# Sustained replay failures over 1 hour — escalation signal
increase(webhook_replay_total{outcome="failure"}[1h]) > 10

# not_found rate spike — possible data integrity issue
increase(webhook_replay_total{outcome="not_found"}[1h]) > 5
```

Add these rules to `docs/prometheus-rules.yml` alongside the existing alert set.

---

## Triage Table

Use this table to decide the correct action for each dead-letter row.

| Scenario | `last_error` / context | Action | Rationale |
|----------|----------------------|--------|-----------|
| Merchant endpoint was temporarily down and has since recovered | `ECONNREFUSED`, `ETIMEDOUT`, HTTP 5xx | **Replay** — `POST /replay/:id` | Endpoint is back; re-sending the event is correct |
| Batch outage affecting multiple tenants | Many unresolved rows, same time window | **Batch replay** — `POST /replay` with `tenantId` filter | Efficient; processes oldest rows first |
| Webhook URL permanently changed (merchant migrated endpoint) | Any network/5xx error | **Update tenant config → Replay** | Fix `webhook_url` in `tenants.settings` first, then replay so the delivery reaches the correct URL |
| Event is stale; merchant has already processed it via polling | Any error, but state is already correct downstream | **Resolve without replay** — `POST /resolve/:id` | Prevents duplicate processing; use when re-delivery causes side effects |
| Merchant's endpoint returns HTTP 4xx (e.g. 404, 401) | HTTP 4xx in `last_error` | **Investigate → Resolve or Reconfigure** | 4xx is a permanent failure; replaying without fixing the endpoint is pointless. Fix credentials/URL first, then replay — or resolve if not needed |
| `webhook_secret` missing or rotated for tenant | `No webhook secret configured for tenant` | **Reconfigure secret → Replay** | Set `webhook_secret` in `tenants.settings`, then replay |
| Dead-letter row shows `already_resolved = true` | Row already resolved | **No action** | Idempotency guard; row has already been handled |
| Replay returns `502` repeatedly | HTTP 5xx / network from replay attempt | **Escalate** — page on-call | Endpoint not recovering; may need merchant contact or deeper infra investigation |
| Large accumulation of unresolved rows (> 500 per tenant) | Bulk outage | **Escalate → Batch replay with rate limiting** | Process in batches of ≤ 200; monitor `webhook_replay_total{outcome="failure"}` for continued failures |
| Dead-letter row not found (`404` on replay) | Row purged or ID typo | **Escalate** — check retention policy | If event still matters, re-enqueue delivery manually; if not, no action |

### Decision flowchart

```
Is the merchant endpoint healthy and reachable?
  ├── Yes → Replay (POST /replay/:id or batch)
  └── No
        ├── Recoverable outage (ETA known) → Wait, then replay
        ├── Permanent URL/credential change → Fix config, then replay
        └── Endpoint gone / event stale → Resolve without replay
                                               (POST /resolve/:id)

Is the replay attempt returning 502 repeatedly?
  └── Yes → Escalate to on-call; do not loop
```

---

## Operational Runbook

### 1 — List unresolved dead letters for a tenant

```bash
# Direct DB query (read-only)
psql "$DATABASE_URL" -c "
  SELECT id, invoice_id, event, attempts, last_error, created_at
  FROM webhook_dead_letters
  WHERE tenant_id = 't_123' AND resolved = false
  ORDER BY created_at ASC
  LIMIT 50;
"
```

### 2 — Single replay

```bash
curl -s -X POST \
  https://api.example.com/api/admin/webhooks/replay/d1a2b3c4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

Expected success response:

```json
{ "replayed": ["d1a2b3c4-e5f6-7890-abcd-ef1234567890"] }
```

### 3 — Batch replay for a tenant

```bash
curl -s -X POST \
  https://api.example.com/api/admin/webhooks/replay \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "tenantId": "t_123", "limit": 100 }' | jq
```

For tenants with more than 100 unresolved rows, repeat until
`"replayed"` is empty or the `"failed"` list stabilises.

### 4 — Resolve a stale event without re-sending

```bash
curl -s -X POST \
  https://api.example.com/api/admin/webhooks/resolve/d1a2b3c4-... \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

### 5 — Monitor replay progress

```promql
# Watch live in Grafana or via /metrics scrape
rate(webhook_replay_total{outcome="success"}[5m])
rate(webhook_replay_total{outcome="failure"}[5m])
```

---

## Security Notes

- Only admin-authenticated callers (JWT or API key) can trigger replays or
  resolutions. Unauthenticated requests receive `401` with no detail.
- The HMAC signature is always **recomputed at replay time** using the tenant's
  current secret. Stored payloads are never re-sent with a stale or cached
  signature.
- Batch replay is hard-capped at `200` rows per request to prevent
  request-amplification abuse.
- Full webhook URLs and secrets are never written to application logs at `info`
  level.
- Dead-letter rows contain the original payload but not the secret used to sign
  it; the secret is always fetched fresh from `tenants.settings` at replay time.

---

## Related Files

| File | Purpose |
|------|---------|
| `src/jobs/webhookReplay.js` | `webhook_replay` job handler |
| `src/jobs/webhookDelivery.js` | `webhook_delivery` job handler (dead-letters on exhaustion) |
| `src/routes/adminWebhooks.js` | Admin replay/resolve HTTP endpoints |
| `src/services/webhooks.js` | `replayWebhook`, `resolveDeadLetter`, `writeDeadLetter` |
| `src/metrics.js` | `webhookReplayTotal` counter definition |
| `migrations/20260627000001_create_webhook_dead_letters.sql` | Table schema |
| `tests/webhooks.retry.test.js` | Test suite for dead-letter replay |
| `docs/webhooks.md` | Outbound delivery reference (signatures, payload shape) |
