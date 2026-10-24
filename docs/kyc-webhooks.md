# KYC Webhooks API

Reference for the KYC webhook ingestion and listing endpoints, including request/response shapes, error codes, and metrics.

## Base URL

All paths are relative to the application base (e.g. `http://localhost:3001`).

---

## POST /api/kyc/webhook

Ingest a KYC webhook payload from the external provider. The raw JSON body is verified using HMAC-SHA256 before processing.

### Request

**Content-Type:** `application/json`  
**Body:** Raw JSON (parsed from `express.raw()` for signature verification)

| Field | Accepted Names | Type | Required | Description |
|-------|---------------|------|----------|-------------|
| SME ID | `smeId`, `sme_id` | string | yes | Unique SME identifier |
| Status | `status`, `kycStatus`, `kyc_status` | string | yes | Provider status string (mapped via `PROVIDER_STATUS_MAP`) |
| Provider Record ID | `recordId`, `providerRecordId`, `provider_record_id` | string | no | External provider's record reference |
| Verified At | `verifiedAt`, `verified_at` | string (ISO 8601) | no | Timestamp of verification |
| Tenant ID | `tenantId`, `tenant_id` | string | no | Tenant scope (validated against `x-tenant-id` header if present) |

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `X-Signature` | yes | `t=<timestamp>,v1=<hmac-sha256>` — verified against `KYC_PROVIDER_SECRET` |
| `x-tenant-id` | no | Tenant scope identifier (validated against `tenantId` in body when both present) |

**Provider status mapping** (see `src/services/kycService.js` `PROVIDER_STATUS_MAP`):

| Provider Status | Mapped Internal Status |
|----------------|----------------------|
| `pending`, `in_review`, `reviewing`, `queued`, `submitted` | `pending` |
| `verified`, `approved`, `pass`, `success` | `verified` |
| `rejected`, `denied`, `declined`, `failed` | `rejected` |
| `exempted`, `exempt`, `waived` | `exempted` |
| Anything else | `unknown` (rejected — fail-closed) |

### Response — 200 (Success)

```json
{
  "success": true,
  "smeId": "sme_abc123",
  "status": "verified"
}
```

### Request Example

```bash
curl -X POST http://localhost:3001/api/kyc/webhook \
  -H "Content-Type: application/json" \
  -H "X-Signature: t=1700000000,v1=abc123def456..." \
  -H "x-tenant-id: t_123" \
  -d '{
    "smeId": "sme_abc123",
    "status": "approved",
    "providerRecordId": "prov_rec_42",
    "verifiedAt": "2026-07-28T12:00:00.000Z",
    "tenantId": "t_123"
  }'
```

### Error Responses

| Status | Error Message | Cause | Notes |
|--------|---------------|-------|-------|
| 400 | `Invalid JSON payload` | `invalid_payload` | Body is not valid JSON |
| 400 | `Missing or invalid smeId` | `missing_sme_id` | `smeId`/`sme_id` is missing or not a string |
| 400 | `Missing or invalid status` | `missing_status` | `status`/`kycStatus`/`kyc_status` is missing or not a string |
| 400 | `Unknown provider status: <value>` | `unknown_status` | Status not in `PROVIDER_STATUS_MAP` (fail-closed) |
| 400 | `Missing tenant context.` | — | `tenantId` provided in body but no `x-tenant-id` header |
| 401 | `Missing X-Signature header` | `missing_signature` | No `X-Signature` header present |
| 401 | `Invalid webhook signature` | `invalid_signature` | HMAC verification failed or timestamp outside tolerance |
| 403 | `Tenant scope mismatch.` | — | `tenantId` in body does not match `x-tenant-id` header |
| 500 | `<persistence error message>` | `persistence_error` | Database write failure |
| 503 | `KYC webhook ingestion is not configured` | `missing_secret` | `KYC_PROVIDER_SECRET` is not set |

---

## GET /api/kyc/webhooks

Cursor-paginated listing of KYC records from the `kyc_records` table.

### Query Parameters

| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `limit` | integer | 20 | 1–100 | Page size |
| `cursor` | string | — | opaque | Cursor from a previous response's `nextCursor` |
| `status` | string | — | — | Filter by status value (e.g. `verified`, `rejected`) |

**Sort order:** `updated_at DESC, sme_id DESC`

### Response — 200

```json
{
  "data": [
    {
      "smeId": "sme_abc123",
      "status": "verified",
      "recordId": "prov_rec_42",
      "verifiedAt": "2026-07-28T12:00:00.000Z",
      "updatedAt": "2026-07-28T12:05:00.000Z"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": false,
    "nextCursor": null
  }
}
```

### Request Example

```bash
curl "http://localhost:3001/api/kyc/webhooks?status=verified&limit=10"
```

```bash
curl "http://localhost:3001/api/kyc/webhooks?cursor=<nextCursor>&limit=20"
```

### Error Responses

| Status | Error Code | Cause |
|--------|-----------|-------|
| 400 | `INVALID_PAGINATION` | `limit` is not an integer between 1 and 100 |
| 400 | `INVALID_CURSOR` | Cursor is malformed, has an invalid HMAC, or has expired |

---

## Admin Endpoints

All admin webhook endpoints are mounted at `/api/admin/webhooks` and require authentication (JWT Bearer or `X-API-Key`). Results are always scoped to `req.tenantId`.

These endpoints are documented in full in [docs/webhooks.md](./webhooks.md) (see "Dead-letter replay" section). Below is a summary.

### GET /api/admin/webhooks/dead-letters

Filterable, cursor-paginated listing of dead-letter rows.

**Query parameters:** `limit` (1–100), `cursor`, `event`, `targetUrl`, `resolved` (`true`/`false`), `createdAfter`, `createdBefore`

**Response 200:**
```json
{
  "data": [ { "id": "uuid", "tenant_id": "t_123", "invoice_id": "inv_abc", "event": "escrow_funded", "webhook_url": "https://...", "attempts": 4, "last_error": "connect ECONNREFUSED", "resolved": false, "resolved_at": null, "created_at": "2026-07-20T14:32:00.000Z", "payload": "{\"event\":\"escrow_funded\",...}" } ],
  "meta": { "limit": 20, "hasMore": true, "nextCursor": "<opaque>", "timestamp": "...", "version": "0.1.0" },
  "error": null,
  "message": "Dead-letter rows retrieved successfully."
}
```

### POST /api/admin/webhooks/replay/:id

Replay a single dead-letter delivery by UUID.

| Status | Response |
|--------|----------|
| 202 | `{ "replayed": ["<id>"] }` |
| 404 | `{ "error": "Dead-letter row not found: <id>" }` |
| 409 | `{ "error": "Dead-letter row already resolved: <id>" }` |
| 502 | `{ "error": "Replay failed: <message>" }` |

### POST /api/admin/webhooks/replay

Batch replay. Body: `{ "ids": ["uuid1", ...] }` or `{ "tenantId": "t_123", "limit": 50 }` (max 200).

**Response 202:**
```json
{
  "replayed": ["uuid1"],
  "failed": [{ "id": "uuid2", "error": "..." }]
}
```

### POST /api/admin/webhooks/resolve/:id

Mark a dead-letter row resolved without re-sending.

| Status | Response |
|--------|----------|
| 200 | `{ "resolved": "<id>" }` |
| 404 | `{ "error": "Dead-letter row not found: <id>" }` |
| 409 | `{ "error": "Dead-letter row already resolved: <id>" }` |

---

## Error Codes Reference

### KYC Webhook Ingestion (`POST /api/kyc/webhook`)

| errorCode (metric label) | HTTP Status | Description |
|--------------------------|-------------|-------------|
| `missing_secret` | 503 | `KYC_PROVIDER_SECRET` env var not configured |
| `missing_signature` | 401 | `X-Signature` header absent |
| `invalid_signature` | 401 | HMAC mismatch or timestamp outside 5-minute tolerance |
| `invalid_payload` | 400 | Raw body is not valid JSON |
| `missing_sme_id` | 400 | `smeId`/`sme_id` field missing or not a string |
| `missing_status` | 400 | `status`/`kycStatus`/`kyc_status` field missing or not a string |
| `unknown_status` | 400 | Provider status not found in `PROVIDER_STATUS_MAP` |
| `persistence_error` | 500 | Database upsert failed |
| `internal` | 4xx/5xx | Unclassified error (fallback label) |
| `none` | 2xx | Success (no error) |

### KYC Records Listing (`GET /api/kyc/webhooks`)

| Error Code | HTTP Status | Description |
|-----------|-------------|-------------|
| `INVALID_PAGINATION` | 400 | `limit` not an integer or outside 1–100 |
| `INVALID_CURSOR` | 400 | Cursor HMAC invalid, malformed, or expired |

### Admin Dead-Letter Endpoints

| Error Code | HTTP Status | Endpoints | Description |
|-----------|-------------|-----------|-------------|
| `INVALID_PAGINATION` | 400 | `GET /dead-letters` | `limit` not an integer or outside 1–100 |
| `INVALID_FILTER` | 400 | `GET /dead-letters` | `resolved` not `true`/`false`, or date not ISO 8601 |
| `INVALID_CURSOR` | 400 | `GET /dead-letters` | Cursor HMAC invalid, malformed, or expired |
| — | 404 | `POST /replay/:id`, `POST /resolve/:id` | Dead-letter row not found |
| — | 409 | `POST /replay/:id`, `POST /resolve/:id` | Row already resolved |
| — | 502 | `POST /replay/:id` | Delivery attempt failed |

---

## Metrics

All KYC webhook metrics are exported via `GET /metrics`.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `kyc_webhook_request_duration_seconds` | Histogram | `status_class` (`2xx`, `4xx`, `5xx`) | Request duration buckets |
| `kyc_webhook_requests_total` | Counter | `status_class` (`2xx`, `4xx`, `5xx`) | Total request count |
| `kyc_webhook_errors_total` | Counter | `cause` (see error codes above) | Error count by cause |
| `webhook_replay_total` | Counter | `outcome` (`success`, `failure`, `not_found`, `already_resolved`) | Admin replay outcomes |

---

## Data Model

### `kyc_records` table

| Column | Type | Description |
|--------|------|-------------|
| `sme_id` | VARCHAR(128) PK | SME identifier |
| `status` | VARCHAR(32) | One of: `pending`, `verified`, `rejected`, `exempted` |
| `provider_record_id` | VARCHAR(256) | External provider record reference (nullable) |
| `verified_at` | TIMESTAMP | When verification occurred (nullable) |
| `updated_at` | TIMESTAMP | Last updated timestamp |

Indexed on `status`.

### `webhook_dead_letters` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Row identifier |
| `tenant_id` | TEXT | Owning tenant |
| `invoice_id` | TEXT | Related invoice |
| `event` | TEXT | Webhook event type (e.g. `escrow_funded`) |
| `payload` | JSONB | Original event payload |
| `webhook_url` | TEXT | Destination URL |
| `attempts` | INTEGER | Delivery attempts before dead-lettering |
| `last_error` | TEXT | Last error message |
| `resolved` | BOOLEAN | Whether the row has been resolved |
| `resolved_at` | TIMESTAMPTZ | When resolved (nullable) |
| `created_at` | TIMESTAMPTZ | Row creation time |
| `updated_at` | TIMESTAMPTZ | Last update time |

Indexed on `(tenant_id, resolved)` and `(created_at)`.

---

## Source Reference

| Component | File |
|-----------|------|
| KYC webhook route handler | `src/routes/kyc.js` |
| Admin webhook route handler | `src/routes/adminWebhooks.js` |
| KYC service (status mapping, persistence) | `src/services/kycService.js` |
| Webhook service (signing, replay, dead-letter) | `src/services/webhooks.js` |
| Cursor pagination utility | `src/utils/cursorPagination.js` |
| Response envelope helper | `src/utils/responseHelper.js` |
| KYC webhook metrics | `src/metrics.js` (lines 1217–1306) |
| KYC records migration | `src/db/migrations/20260425_add_kyc_status.js` |
| Dead-letter migration | `migrations/20260627000001_create_webhook_dead_letters.sql` |
| Configuration schema | `src/config/index.js` (lines 44–59) |
