# Escrow-Read API — Runnable Examples

> **Scope:** `Liquifact/Liquifact-backend`
> **Last updated:** 2026-07-27
> **Cross-reference:** `src/app.js` · `src/routes/v1/index.js` · `src/routes/adminEscrow.js` · `src/routes/adminEscrowRead.js`

All examples target `http://localhost:3001`. Replace with your deployment host as needed.

---

## Contents

1. [Setup](#setup)
2. [GET /api/escrow/:invoiceId — Public read (no auth)](#1-get-apiescrowinvoiceid--public-read-no-auth)
3. [GET /v1/escrow/:invoiceId — Authenticated read](#2-get-v1escrowinvoiceid--authenticated-read)
4. [POST /v1/escrow/batch — Batch read](#3-post-v1escrowbatch--batch-read)
5. [GET /api/admin/escrow-read — List configs (admin)](#4-get-apiadminescrow-read--list-configs-admin)
6. [POST /api/admin/escrow-read — Create config (admin)](#5-post-apiadminescrow-read--create-config-admin)
7. [GET /api/admin/escrow-read/audit — Audit log (admin)](#6-get-apiadminescrow-readaudit--audit-log-admin)
8. [PUT /api/admin/escrow-read/:id — Update config (admin)](#7-put-apiadminescrow-readid--update-config-admin)
9. [DELETE /api/admin/escrow-read/:id — Delete config (admin)](#8-delete-apiadminescrow-readid--delete-config-admin)
10. [GET /api/admin/escrow/reads/:invoiceId/deletion-state](#9-get-apiadminescrowreadsinvoiceiddeletion-state)
11. [DELETE /api/admin/escrow/reads/:invoiceId — Soft-delete](#10-delete-apiadminescrowreadsinvoiceid--soft-delete)
12. [POST /api/admin/escrow/reads/:invoiceId/restore — Restore](#11-post-apiadminescrowreadsinvoiceidrestore--restore)
13. [POST /api/admin/escrow/reads/purge — Purge expired records](#12-post-apiadminescrowreadspurge--purge-expired-records)
14. [GET /api/admin/escrow/version — On-chain schema version](#13-get-apiadminescrowversion--on-chain-schema-version)
15. [POST /api/admin/escrow/refresh — Trigger contract list refresh](#14-post-apiadminescrowrefresh--trigger-contract-list-refresh)
16. [Error reference](#error-reference)

---

## Setup

```bash
# Base URL
BASE=http://localhost:3001

# JWT token for authenticated (v1) endpoints
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Admin credentials — use EITHER a JWT or an API key
ADMIN_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
ADMIN_API_KEY="lf_svc_key_001"

# Tenant ID (required for admin routes)
TENANT_ID="tenant-alpha"

# A mapped invoice ID (must exist in ESCROW_ADDR_BY_INVOICE config)
INVOICE_ID="inv_001"
```

### Authentication rules at a glance

| Endpoint group | Auth required | Header(s) |
|---|---|---|
| `GET /api/escrow/:invoiceId` | None | — |
| `GET /v1/escrow/:invoiceId` | Bearer JWT | `Authorization: Bearer <token>` |
| `POST /v1/escrow/batch` | Bearer JWT | `Authorization: Bearer <token>` |
| `GET/POST/PUT/DELETE /api/admin/*` | JWT **or** API key | `Authorization: Bearer <token>` **or** `X-API-Key: <key>` |
| All `/api/admin/*` | Tenant context | `X-Tenant-Id: <tenant-id>` **or** JWT `tenantId` claim |

> **Rate limits:** `GET /v1/escrow/:invoiceId` has a per-IP rate limiter (`escrowReadLimiter`) that runs *before* auth. Hitting the limit returns `429 Too Many Requests`.

---

## 1. GET /api/escrow/:invoiceId — Public read (no auth)

Reads escrow state through the projection → Redis cache → live-RPC fallback chain.
No authentication is required. Derived display fields (`apyPercent`, `fundedPercent`,
`daysToMaturity`) are included.

**Source file:** `src/app.js`

### invoiceId format

- Characters: `A-Z a-z 0-9 _ - . :`
- Length: 1–128 characters

### Success (200)

```bash
curl -i "$BASE/api/escrow/inv_001"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Escrow-Address: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
X-Request-Id: req_abc123
X-Correlation-Id: corr_xyz789
```

```json
{
  "data": {
    "invoiceId": "inv_001",
    "status": "funded",
    "fundedAmount": 7500,
    "legal_hold": false,
    "legalHoldStatus": "not_held",
    "latest_ledger_sequence": 500,
    "latest_event_type": "funded",
    "latest_event_id": "evt_001",
    "latest_paging_token": "paging_abc",
    "latest_observed_at": "2026-07-20T10:00:00.000Z",
    "source": "projection",
    "fromProjection": true,
    "apyPercent": 5.25,
    "fundedPercent": 75.0,
    "daysToMaturity": 42,
    "escrowAddress": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
  },
  "message": "Escrow state read from event projection."
}
```

**`message` values:**

| Value | Meaning |
|---|---|
| `"Escrow state read from event projection."` | Row found in `escrow_event_projection` |
| `"Escrow state read from live Soroban contract."` | Fell back to live RPC read |

### Not found (404)

```bash
curl -i "$BASE/api/escrow/unknown-inv"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": "No escrow contract mapping found for invoice ID 'unknown-inv'"
}
```

### Server error (500)

```bash
curl -i "$BASE/api/escrow/inv_rpc_down"
```

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json
```

```json
{
  "error": "Error fetching escrow state"
}
```

---

## 2. GET /v1/escrow/:invoiceId — Authenticated read

Authenticated, versioned escrow read. The rate limiter (`escrowReadLimiter`) runs before
auth, so an excessive call rate returns `429` even without a valid token.

**Source file:** `src/routes/v1/index.js`

### Success (200)

```bash
curl -i \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/escrow/inv_001"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Escrow-Address: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
```

```json
{
  "data": {
    "invoiceId": "inv_001",
    "status": "funded",
    "fundedAmount": 7500,
    "legal_hold": false,
    "legalHoldStatus": "not_held",
    "latest_ledger_sequence": 500,
    "latest_event_type": "funded",
    "latest_event_id": "evt_001",
    "latest_paging_token": "paging_abc",
    "latest_observed_at": "2026-07-20T10:00:00.000Z",
    "source": "projection",
    "fromProjection": true,
    "apyPercent": 5.25,
    "fundedPercent": 75.0,
    "daysToMaturity": 42,
    "escrowAddress": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
  },
  "message": "Escrow state read from event projection."
}
```

> The response is wrapped by the `createStandardizedApp` envelope middleware. Successful
> responses always carry `data` at the top level.

### Unknown legal-hold state

When the Soroban `get_legal_hold` call fails, `legal_hold` is `true` (fail-closed) and
additional diagnostic fields are included:

```json
{
  "data": {
    "invoiceId": "inv_001",
    "status": "funded",
    "fundedAmount": 7500,
    "legal_hold": true,
    "legalHoldStatus": "unknown",
    "legalHoldReason": "rpc_error",
    "legalHoldErrorCode": "ETIMEDOUT",
    "source": "rpc_stub",
    "fromProjection": false,
    "apyPercent": null,
    "fundedPercent": null,
    "daysToMaturity": null,
    "escrowAddress": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
  },
  "message": "Escrow state read from live Soroban contract."
}
```

### Missing token (401)

```bash
curl -i "$BASE/v1/escrow/inv_001"
```

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{
  "data": null,
  "meta": { "timestamp": "2026-07-27T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "Authentication token is required",
    "code": "UNAUTHORIZED",
    "details": null
  }
}
```

### Invalid invoiceId (400)

```bash
curl -i \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/escrow/bad@invoice!"
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": "Invalid invoiceId parameter",
  "code": "BAD_REQUEST",
  "details": { "invoiceId": ["Invalid invoiceId format"] }
}
```

### No mapping found (404)

```bash
curl -i \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/escrow/unmapped-inv"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "data": null,
  "meta": { "timestamp": "2026-07-27T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "No escrow contract mapping found for invoice ID 'unmapped-inv'",
    "code": "NOT_FOUND",
    "details": null
  }
}
```

### Rate limit exceeded (429)

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 900
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: <epoch>
```

```json
{
  "error": "Too many requests.",
  "message": "Rate limit threshold breached for scope: escrow-read. Please try again later."
}
```

---

## 3. POST /v1/escrow/batch — Batch read

Reads escrow state for up to 100 invoice IDs in a single request. Unmapped or failed
IDs are reported per-item in `errors`; the overall request always returns `200`.

**Source file:** `src/routes/v1/index.js`
**Auth:** Bearer JWT

### Success (200) — mixed results

```bash
curl -i \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"invoiceIds":["inv_001","inv_002","unmapped-inv"]}' \
  "$BASE/v1/escrow/batch"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "data": {
    "results": [
      {
        "invoiceId": "inv_001",
        "status": "funded",
        "fundedAmount": 7500,
        "legal_hold": false,
        "legalHoldStatus": "not_held",
        "source": "projection",
        "fromProjection": true,
        "apyPercent": 5.25,
        "fundedPercent": 75.0,
        "daysToMaturity": 42,
        "escrowAddress": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
      },
      {
        "invoiceId": "inv_002",
        "status": "not_found",
        "fundedAmount": 0,
        "legal_hold": false,
        "legalHoldStatus": "not_held",
        "source": "rpc_stub",
        "fromProjection": false,
        "apyPercent": null,
        "fundedPercent": null,
        "daysToMaturity": null,
        "escrowAddress": "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      }
    ],
    "errors": [
      {
        "invoiceId": "unmapped-inv",
        "error": "No escrow contract mapping found for invoice ID 'unmapped-inv'",
        "code": "NOT_FOUND"
      }
    ]
  },
  "message": "Processed 3 invoice ID(s): 2 succeeded, 1 failed."
}
```

### Validation error — empty array (422)

```bash
curl -i \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"invoiceIds":[]}' \
  "$BASE/v1/escrow/batch"
```

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json
```

```json
{
  "data": null,
  "meta": { "timestamp": "2026-07-27T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "Request body contains invalid or missing fields.",
    "code": "VALIDATION_ERROR",
    "details": null
  }
}
```

### Validation error — over 100 IDs (422)

```bash
curl -i \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"invoiceIds":["id-1","id-2",...]}' \
  "$BASE/v1/escrow/batch"
# invoiceIds array must not exceed 100 items
```

```json
{
  "data": null,
  "meta": { "timestamp": "2026-07-27T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "Request body contains invalid or missing fields.",
    "code": "VALIDATION_ERROR",
    "details": null
  }
}
```

---

## 4. GET /api/admin/escrow-read — List configs (admin)

Lists all in-memory escrow-read configuration overrides.

**Source file:** `src/routes/adminEscrowRead.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### With JWT

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow-read"
```

### With API key

```bash
curl -i \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow-read"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "data": [
    {
      "id": "config-alpha",
      "config": { "cacheTtl": 60 },
      "secretKey": "s3cr3t-k3y"
    },
    {
      "id": "config-beta",
      "config": { "cacheTtl": 120 }
    }
  ]
}
```

Returns an empty array when no configs have been created:

```json
{ "data": [] }
```

### Missing tenant (400)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE/api/admin/escrow-read"
# No X-Tenant-Id header and no tenantId JWT claim
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": "Missing tenant context.",
  "message": "A valid tenant identifier must be supplied via the x-tenant-id header or an authenticated JWT claim."
}
```

---

## 5. POST /api/admin/escrow-read — Create config (admin)

Creates a new escrow-read configuration entry. The `id` must be unique; a duplicate
returns `409 Conflict`.

**Source file:** `src/routes/adminEscrowRead.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Request body schema

| Field | Type | Required | Constraints |
|---|---|---|---|
| `id` | string | Yes | 1–100 chars, trimmed |
| `config` | object | No | `{ cacheTtl: positive integer }` |
| `secretKey` | string | No | 1–256 chars, trimmed |

### Success (201)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "config-alpha",
    "config": { "cacheTtl": 60 },
    "secretKey": "s3cr3t-k3y"
  }' \
  "$BASE/api/admin/escrow-read"
```

```http
HTTP/1.1 201 Created
Content-Type: application/json
```

```json
{
  "data": {
    "id": "config-alpha",
    "config": { "cacheTtl": 60 },
    "secretKey": "s3cr3t-k3y"
  }
}
```

### Minimal body — id only (201)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"id": "config-minimal"}' \
  "$BASE/api/admin/escrow-read"
```

```json
{
  "data": {
    "id": "config-minimal"
  }
}
```

### Duplicate id (409)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"id": "config-alpha"}' \
  "$BASE/api/admin/escrow-read"
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json
```

```json
{
  "error": {
    "code": "409",
    "message": "Already exists"
  }
}
```

### Validation error — missing id (400)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"config": {"cacheTtl": 60}}' \
  "$BASE/api/admin/escrow-read"
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body contains invalid or missing fields.",
    "fieldErrors": { "id": ["Required"] }
  }
}
```

### Validation error — non-integer cacheTtl (400)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"id": "x", "config": {"cacheTtl": 1.5}}' \
  "$BASE/api/admin/escrow-read"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body contains invalid or missing fields.",
    "fieldErrors": { "config.cacheTtl": ["cacheTtl must be an integer"] }
  }
}
```

---

## 6. GET /api/admin/escrow-read/audit — Audit log (admin)

Returns audit log entries for `escrow-read` resource mutations.
Sensitive fields are redacted by the audit service before persistence.

**Source file:** `src/routes/adminEscrowRead.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Query parameters

| Param | Type | Default | Range | Description |
|---|---|---|---|---|
| `limit` | integer | `100` | 1–500 | Max number of log entries to return |

### Success (200)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow-read/audit?limit=10"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "data": [
    {
      "id": "audit-001",
      "timestamp": "2026-07-27T11:00:00.000Z",
      "actor": "usr_admin",
      "action": "escrow-read.create",
      "resourceType": "escrow-read",
      "resourceId": "config-alpha",
      "metadata": { "tenantId": "tenant-alpha" }
    }
  ]
}
```

Returns `{ "data": [] }` when no audit entries exist.

### Validation error — limit out of range (400)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow-read/audit?limit=999"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body contains invalid or missing fields.",
    "fieldErrors": { "limit": ["limit must not exceed 500"] }
  }
}
```

---

## 7. PUT /api/admin/escrow-read/:id — Update config (admin)

Updates an existing escrow-read configuration. At least one of `config` or `secretKey`
must be provided; supplying neither returns `400`.

**Source file:** `src/routes/adminEscrowRead.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Success (200)

```bash
curl -i -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"config": {"cacheTtl": 120}}' \
  "$BASE/api/admin/escrow-read/config-alpha"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "data": {
    "id": "config-alpha",
    "config": { "cacheTtl": 120 },
    "secretKey": "s3cr3t-k3y"
  }
}
```

### Update secretKey only (200)

```bash
curl -i -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"secretKey": "new-secret-value"}' \
  "$BASE/api/admin/escrow-read/config-alpha"
```

```json
{
  "data": {
    "id": "config-alpha",
    "config": { "cacheTtl": 120 },
    "secretKey": "new-secret-value"
  }
}
```

### Validation error — empty body (400)

```bash
curl -i -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$BASE/api/admin/escrow-read/config-alpha"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "At least one field (config or secretKey) must be provided for update"
  }
}
```

### Not found (404)

```bash
curl -i -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"config": {"cacheTtl": 30}}' \
  "$BASE/api/admin/escrow-read/does-not-exist"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": {
    "code": "404",
    "message": "Configuration not found"
  }
}
```

---

## 8. DELETE /api/admin/escrow-read/:id — Delete config (admin)

Permanently removes an escrow-read configuration entry.
Returns `204 No Content` on success (no response body).

**Source file:** `src/routes/adminEscrowRead.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Success (204)

```bash
curl -i -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow-read/config-alpha"
```

```http
HTTP/1.1 204 No Content
```

### Not found (404)

```bash
curl -i -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow-read/does-not-exist"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": {
    "code": "404",
    "message": "Configuration not found"
  }
}
```

---

## 9. GET /api/admin/escrow/reads/:invoiceId/deletion-state

Inspects the soft-delete state of an escrow-read record in the
`escrow_event_projection` table. This is the only read that surfaces tombstoned
records; ordinary escrow reads hide them.

**Source file:** `src/routes/adminEscrow.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Live record (200)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/inv_001/deletion-state"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "invoiceId": "inv_001",
  "deleted": false,
  "deletedAt": null,
  "deletedBy": null,
  "deleteReason": null,
  "purgeAfter": null,
  "restorable": false,
  "retentionDays": 30
}
```

### Soft-deleted record (200)

```json
{
  "invoiceId": "inv_001",
  "deleted": true,
  "deletedAt": "2026-07-25T09:00:00.000Z",
  "deletedBy": "usr_admin",
  "deleteReason": "duplicate entry",
  "purgeAfter": "2026-08-24T09:00:00.000Z",
  "restorable": true,
  "retentionDays": 30
}
```

### Not found (404)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/unknown-inv/deletion-state"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": {
    "code": "404",
    "message": "No escrow-read record found for invoice ID 'unknown-inv'"
  }
}
```

---

## 10. DELETE /api/admin/escrow/reads/:invoiceId — Soft-delete

Tombstones an escrow-read record. The row is retained for the retention window
(`ESCROW_READ_SOFT_DELETE_RETENTION_DAYS`, default 30 days) and excluded from all
default escrow reads. Cache entries (local + Redis) are invalidated immediately.

**Source file:** `src/routes/adminEscrow.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `reason` | string | No | Max 500 chars |

### Success (200)

```bash
curl -i -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"reason": "stale test data"}' \
  "$BASE/api/admin/escrow/reads/inv_001"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "invoiceId": "inv_001",
  "deleted": true,
  "deletedAt": "2026-07-27T12:00:00.000Z",
  "deletedBy": "usr_admin",
  "deleteReason": "stale test data",
  "purgeAfter": "2026-08-26T12:00:00.000Z",
  "restorable": true,
  "retentionDays": 30
}
```

### No reason supplied (200)

```bash
curl -i -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/inv_001"
```

```json
{
  "invoiceId": "inv_001",
  "deleted": true,
  "deletedAt": "2026-07-27T12:00:00.000Z",
  "deletedBy": "usr_admin",
  "deleteReason": null,
  "purgeAfter": "2026-08-26T12:00:00.000Z",
  "restorable": true,
  "retentionDays": 30
}
```

### Already deleted (409)

```bash
curl -i -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/inv_001"
# Record is already tombstoned
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json
```

```json
{
  "error": {
    "code": "409",
    "message": "Record is already soft-deleted"
  }
}
```

### Reason too long (400)

```bash
curl -i -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"reason": "<501+ character string>"}' \
  "$BASE/api/admin/escrow/reads/inv_001"
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": {
    "code": "400",
    "message": "reason must be at most 500 characters"
  }
}
```

---

## 11. POST /api/admin/escrow/reads/:invoiceId/restore — Restore

Clears the tombstone so the record is served by default reads again. Only possible
while the retention window is open; once elapsed the endpoint returns `410 Gone`
even if the purge job has not yet run.

**Source file:** `src/routes/adminEscrow.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Success (200)

```bash
curl -i -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/inv_001/restore"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "invoiceId": "inv_001",
  "deleted": false,
  "deletedAt": null,
  "deletedBy": null,
  "deleteReason": null,
  "purgeAfter": null,
  "restorable": false,
  "retentionDays": 30
}
```

### Not soft-deleted (409)

```bash
curl -i -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/inv_001/restore"
# Record was never tombstoned
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json
```

```json
{
  "error": {
    "code": "409",
    "message": "Record is not soft-deleted"
  }
}
```

### Retention window expired (410)

```http
HTTP/1.1 410 Gone
Content-Type: application/json
```

```json
{
  "error": {
    "code": "410",
    "message": "Retention window expired; record can no longer be restored"
  }
}
```

### Not found (404)

```bash
curl -i -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/unknown-inv/restore"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": {
    "code": "404",
    "message": "No escrow-read record found for invoice ID 'unknown-inv'"
  }
}
```

---

## 12. POST /api/admin/escrow/reads/purge — Purge expired records

Hard-deletes soft-deleted records whose retention window has elapsed. The same work
runs on a schedule via `src/jobs/escrowReadPurge.js`; this endpoint exists for
runbook-driven maintenance. Records still within their retention window are never
touched.

**Source file:** `src/routes/adminEscrow.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Success (200)

```bash
curl -i -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/reads/purge"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "purged": 12,
  "batches": 1,
  "cutoff": "2026-06-27T12:00:00.000Z",
  "retentionDays": 30,
  "maxBatchesReached": false
}
```

| Field | Type | Description |
|---|---|---|
| `purged` | integer | Total records hard-deleted |
| `batches` | integer | Number of delete batches executed |
| `cutoff` | ISO 8601 | Records with `deletedAt` before this timestamp were eligible |
| `retentionDays` | integer | Retention window used (`ESCROW_READ_SOFT_DELETE_RETENTION_DAYS`) |
| `maxBatchesReached` | boolean | `true` when the batch cap was hit before all eligible rows were processed |

### Nothing to purge (200)

```json
{
  "purged": 0,
  "batches": 0,
  "cutoff": "2026-06-27T12:00:00.000Z",
  "retentionDays": 30,
  "maxBatchesReached": false
}
```

---

## 13. GET /api/admin/escrow/version — On-chain schema version

Returns the current `SCHEMA_VERSION` from the LiquifactEscrow Soroban contract and
compares it against the known registry version.

**Source file:** `src/routes/adminEscrow.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Success (200)

```bash
curl -i \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/version"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "onChainVersion": "2",
  "knownVersion": "2",
  "status": "match"
}
```

| Field | Type | Description |
|---|---|---|
| `onChainVersion` | string | Version read directly from the Soroban contract |
| `knownVersion` | string | Version recorded in the local `src/config/escrowVersions.js` registry |
| `status` | `"match"` \| `"mismatch"` \| `"unknown"` | Comparison outcome |

### Version mismatch (200)

```json
{
  "onChainVersion": "3",
  "knownVersion": "2",
  "status": "mismatch"
}
```

> A `mismatch` means the deployed contract has a schema version the backend registry
> does not recognise. Review `docs/wasm-ops.md` and update `src/config/escrowVersions.js`.

### Invalid contract ID (400)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": {
    "code": "400",
    "message": "Contract address is not a valid Stellar StrKey"
  }
}
```

### Soroban RPC failure (502)

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json
```

```json
{
  "error": {
    "code": "502",
    "message": "Soroban RPC read failed."
  }
}
```

---

## 14. POST /api/admin/escrow/refresh — Trigger contract list refresh

Manually triggers the Soroban contract list refresh job. The same refresh runs on a
schedule; this endpoint is for runbook-driven or on-demand execution.

**Source file:** `src/routes/adminEscrow.js`
**Auth:** Bearer JWT **or** `X-API-Key` + `X-Tenant-Id`

### Success (202)

```bash
curl -i -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  "$BASE/api/admin/escrow/refresh"
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
```

```json
{
  "message": "Contract list refresh triggered."
}
```

The response body may include additional result fields from `runContractListRefresh()`,
spread alongside `message`.

### Invalid contract address (400)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": {
    "code": "400",
    "message": "Contract address is not a valid Stellar StrKey"
  }
}
```

### Soroban RPC failure (502)

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json
```

```json
{
  "error": {
    "code": "502",
    "message": "Soroban RPC read failed. Retry after confirming RPC health."
  }
}
```

---

## Error reference

### Common HTTP status codes across escrow-read endpoints

| Status | Condition | Notes |
|---|---|---|
| `400` | Invalid request body or path param | Returned with `fieldErrors` when Zod validation fails |
| `401` | Missing or invalid `Authorization` header | JWT expired, malformed, or absent |
| `403` | Forbidden | Returned when the `Origin` header is blocked by CORS policy |
| `404` | No escrow mapping or no projection row | Check `ESCROW_ADDR_BY_INVOICE` config for public routes |
| `409` | Conflict | Duplicate config ID (POST), or wrong soft-delete state (DELETE/restore) |
| `410` | Gone | Retention window expired; record can no longer be restored |
| `422` | Unprocessable entity | Zod validation failure on batch or invoice schemas |
| `429` | Rate limit exceeded | Per-IP limit on `/v1/escrow/:invoiceId`; back off and retry |
| `500` | Internal server error | Unexpected failure; check server logs and correlation ID |
| `502` | Bad gateway | Soroban RPC unreachable or returned an error |

### Standard error envelope (v1 and admin routes)

```json
{
  "data": null,
  "meta": {
    "timestamp": "2026-07-27T12:00:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "<human-readable description>",
    "code": "<error code>",
    "details": null
  }
}
```

The `X-Correlation-Id` and `X-Request-Id` response headers are always present. Include
both when filing a support ticket or correlating with server-side logs.

### Legal-hold tri-state

| `legalHoldStatus` | `legal_hold` | Meaning |
|---|---|---|
| `"held"` | `true` | Invoice is under a confirmed legal hold |
| `"not_held"` | `false` | Confirmed: no legal hold active |
| `"unknown"` | `true` | Hold status unreadable (fail-closed); check `legalHoldReason` |

When `legalHoldStatus` is `"unknown"` the response includes:

```json
{
  "legalHoldReason": "rpc_error",
  "legalHoldErrorCode": "ETIMEDOUT"
}
```

| `legalHoldReason` | Description |
|---|---|
| `"rpc_error"` | `get_legal_hold` Soroban call failed |
| `"adapter_error"` | Caller-supplied adapter threw |
| `"service_unavailable"` | Service module unavailable |
