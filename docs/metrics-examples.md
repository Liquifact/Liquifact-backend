# Metrics API — Request/Response Examples

Runnable `curl` examples for every metrics-related endpoint. Each example includes the exact headers, request body (if any), and a representative response. Copy-paste directly into a terminal with `BASE_URL` set.

> **Base URL**
> ```bash
> export BASE_URL="http://localhost:3001"
> ```

---

## 1. `GET /metrics` — Prometheus Scrape

System-level Prometheus counters, gauges, and histograms.

### Auth

Two modes (mutually exclusive):

| Mode | How to authenticate |
|---|---|
| **Bearer token** | Set `METRICS_BEARER_TOKEN` env var, send `Authorization: Bearer <token>` |
| **Loopback** | Leave `METRICS_BEARER_TOKEN` unset, connect from `127.0.0.1` or `::1` |

### Example — Bearer token auth

```bash
curl -s -D- \
  -H "Authorization: Bearer ${METRICS_BEARER_TOKEN}" \
  "${BASE_URL}/metrics"
```

**Response — 200 OK** (plain text, Prometheus exposition format):

```
# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.
# TYPE process_cpu_user_seconds_total counter
process_cpu_user_seconds_total 0.0312
# HELP liquifact_job_queue_depth Number of pending jobs waiting in queues
# TYPE liquifact_job_queue_depth gauge
liquifact_job_queue_depth 0
# HELP liquifact_job_retry_queue_size Number of jobs waiting in retry queues
# TYPE liquifact_job_retry_queue_size gauge
liquifact_job_retry_queue_size 0
# HELP liquifact_worker_inflight_count Number of jobs currently being processed
# TYPE liquifact_worker_inflight_count gauge
liquifact_worker_inflight_count 0
# HELP body_size_limit_rejections_total Total number of request body-size limit rejections (413 Payload Too Large), labelled by limit type for DoS detection
# TYPE body_size_limit_rejections_total counter
body_size_limit_rejections_total{type="invoice_upload"} 2
...
```

### Example — Loopback (no token configured)

```bash
curl -s -D- http://127.0.0.1:3001/metrics
```

**Response — 200 OK** (same Prometheus text format as above).

### Example — 401 Unauthorized

```bash
curl -s -D- "${BASE_URL}/metrics"
```

**Response — 401 Unauthorized** (when `METRICS_BEARER_TOKEN` is set and no header sent):

```json
{
  "error": "Unauthorized"
}
```

---

## 2. `GET /api/sme/metrics` — SME Dashboard Metrics (Aggregated)

Returns aggregated invoice counts (`open`, `funded`, `settled`, `defaulted`) for the authenticated tenant user.

### Auth

Requires a valid JWT (`Authorization: Bearer <jwt>`) and a tenant context (via `x-tenant-id` header or JWT tenant claim).

### Example — Basic (aggregated counts only)

```bash
curl -s \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "x-tenant-id: tenant_abc" \
  "${BASE_URL}/api/sme/metrics"
```

**Response — 200 OK**:

```json
{
  "data": {
    "open": 12,
    "funded": 5,
    "settled": 23,
    "defaulted": 1
  },
  "meta": {
    "timestamp": "2026-07-27T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "timestamp": "2026-07-27T10:30:00.123Z"
}
```

### Example — Paginated (with `limit`)

Passing `limit` (or `cursor`) triggers pagination metadata and individual invoice rows.

```bash
curl -s \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "x-tenant-id: tenant_abc" \
  "${BASE_URL}/api/sme/metrics?limit=5"
```

**Response — 200 OK**:

```json
{
  "data": {
    "open": 12,
    "funded": 5,
    "settled": 23,
    "defaulted": 1
  },
  "meta": {
    "timestamp": "2026-07-27T10:30:00.000Z",
    "version": "0.1.0",
    "invoices": [
      { "id": "inv_001", "status": "open", "amount": "1500.00", "currency": "USDC" },
      { "id": "inv_002", "status": "funded", "amount": "3200.00", "currency": "USDC" },
      { "id": "inv_003", "status": "settled", "amount": "800.00", "currency": "USDC" },
      { "id": "inv_004", "status": "open", "amount": "4500.00", "currency": "USDC" },
      { "id": "inv_005", "status": "funded", "amount": "1200.00", "currency": "USDC" }
    ],
    "total": 41,
    "limit": 5,
    "hasMore": true,
    "nextCursor: "eyJpZCI6Imludi0wMDUiLCJ0cyI6IjIwMjYtMDctMjdUMTA6MzA6MDAifQ=="
  },
  "error": null,
  "timestamp": "2026-07-27T10:30:00.123Z"
}
```

### Example — Paginated (next page using cursor)

```bash
curl -s \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "x-tenant-id: tenant_abc" \
  "${BASE_URL}/api/sme/metrics?cursor=eyJpZCI6Imludi0wMDUiLCJ0cyI6IjIwMjYtMDctMjdUMTA6MzA6MDAifQ==&limit=5"
```

**Response — 200 OK**: Same shape, next page of invoices. When on the last page, `hasMore` is `false` and `nextCursor` is `null`.

### Example — 400 Bad Request (invalid cursor)

```bash
curl -s \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "x-tenant-id: tenant_abc" \
  "${BASE_URL}/api/sme/metrics?cursor=tampered_value"
```

**Response — 400 Bad Request**:

```json
{
  "error": {
    "message": "Invalid or expired cursor."
  }
}
```

### Example — 400 Bad Request (missing tenant)

```bash
curl -s \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  "${BASE_URL}/api/sme/metrics"
```

**Response — 400 Bad Request**:

```json
{
  "error": "Bad Request",
  "message": "Missing tenant context"
}
```

---

## 3. `POST /api/sme/metrics/bulk` — Bulk SME Metrics

Accepts up to 25 `(tenantId, userId)` pairs and returns per-item invoice counts. Each item is processed independently — one failure does not abort the batch.

### Auth

Same as single metrics: JWT + tenant scope. Each `tenantId` in the request body must match the caller's tenant; cross-tenant pairs are rejected per-item.

### Example — Successful batch

```bash
curl -s -X POST \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_abc" \
  -d '{
    "operations": [
      { "tenantId": "tenant_abc", "userId": "user_001" },
      { "tenantId": "tenant_abc", "userId": "user_002" },
      { "tenantId": "tenant_abc", "userId": "user_003" }
    ]
  }' \
  "${BASE_URL}/api/sme/metrics/bulk"
```

**Response — 200 OK**:

```json
{
  "results": [
    {
      "tenantId": "tenant_abc",
      "userId": "user_001",
      "status": "success",
      "data": { "open": 4, "funded": 2, "settled": 8, "defaulted": 0 },
      "error": null
    },
    {
      "tenantId": "tenant_abc",
      "userId": "user_002",
      "status": "success",
      "data": { "open": 1, "funded": 0, "settled": 15, "defaulted": 2 },
      "error": null
    },
    {
      "tenantId": "tenant_abc",
      "userId": "user_003",
      "status": "success",
      "data": { "open": 7, "funded": 3, "settled": 0, "defaulted": 0 },
      "error": null
    }
  ],
  "meta": {
    "total": 3,
    "succeeded": 3,
    "failed": 0,
    "timestamp": "2026-07-27T10:35:00.000Z"
  }
}
```

### Example — Mixed success/failure (cross-tenant rejection)

```bash
curl -s -X POST \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_abc" \
  -d '{
    "operations": [
      { "tenantId": "tenant_abc", "userId": "user_001" },
      { "tenantId": "tenant_xyz", "userId": "user_999" }
    ]
  }' \
  "${BASE_URL}/api/sme/metrics/bulk"
```

**Response — 200 OK** (note: HTTP 200, but `meta.failed > 0`):

```json
{
  "results": [
    {
      "tenantId": "tenant_abc",
      "userId": "user_001",
      "status": "success",
      "data": { "open": 4, "funded": 2, "settled": 8, "defaulted": 0 },
      "error": null
    },
    {
      "tenantId": "tenant_xyz",
      "userId": "user_999",
      "status": "error",
      "data": null,
      "error": "Cross-tenant access denied"
    }
  ],
  "meta": {
    "total": 2,
    "succeeded": 1,
    "failed": 1,
    "timestamp": "2026-07-27T10:35:00.000Z"
  }
}
```

### Example — 400 Bad Request (empty operations)

```bash
curl -s -X POST \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_abc" \
  -d '{ "operations": [] }' \
  "${BASE_URL}/api/sme/metrics/bulk"
```

**Response — 400 Bad Request**:

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "fieldErrors": {
    "operations": ["operations must contain at least one item"]
  }
}
```

### Example — 400 Bad Request (missing required fields)

```bash
curl -s -X POST \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_abc" \
  -d '{ "operations": [{ "tenantId": "tenant_abc" }] }' \
  "${BASE_URL}/api/sme/metrics/bulk"
```

**Response — 400 Bad Request**:

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "fieldErrors": {
    "operations.0.userId": ["userId is required"]
  }
}
```

### Example — 401 Unauthorized

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_abc" \
  -d '{ "operations": [{ "tenantId": "tenant_abc", "userId": "user_001" }] }' \
  "${BASE_URL}/api/sme/metrics/bulk"
```

**Response — 401 Unauthorized**:

```json
{
  "error": "Unauthorized"
}
```

---

## 4. `GET /api/admin/metrics/audit` — Metrics Audit Log

Retrieves the in-memory audit log of metrics mutations. Admin-only endpoint.

### Auth

Requires admin stack authentication (JWT or API key with admin scope).

### Example — Basic

```bash
curl -s \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  "${BASE_URL}/api/admin/metrics/audit"
```

**Response — 200 OK**:

```json
{
  "data": [
    {
      "metricName": "escrow_indexer_events_processed_total",
      "action": "UPDATE",
      "actorId": "indexer-cycle-42",
      "timestamp": "2026-07-27T10:00:00.000Z"
    },
    {
      "metricName": "liquifact_job_queue_depth",
      "action": "UPDATE",
      "actorId": "refresh-metrics",
      "timestamp": "2026-07-27T10:00:05.000Z"
    }
  ],
  "meta": {
    "total": 156,
    "limit": 100,
    "offset": 0,
    "returned": 2
  },
  "filters": {
    "metricName": null,
    "action": null,
    "actorId": null
  }
}
```

### Example — Filtered by metric name

```bash
curl -s \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  "${BASE_URL}/api/admin/metrics/audit?metricName=escrow_indexer_events_processed_total&limit=10"
```

**Response — 200 OK**:

```json
{
  "data": [
    {
      "metricName": "escrow_indexer_events_processed_total",
      "action": "UPDATE",
      "actorId": "indexer-cycle-42",
      "timestamp": "2026-07-27T10:00:00.000Z"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 10,
    "offset": 0,
    "returned": 1
  },
  "filters": {
    "metricName": "escrow_indexer_events_processed_total",
    "action": null,
    "actorId": null
  }
}
```

### Example — Filtered by action

```bash
curl -s \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  "${BASE_URL}/api/admin/metrics/audit?action=CREATE&limit=5"
```

**Response — 200 OK**:

```json
{
  "data": [],
  "meta": {
    "total": 0,
    "limit": 5,
    "offset": 0,
    "returned": 0
  },
  "filters": {
    "metricName": null,
    "action": "CREATE",
    "actorId": null
  }
}
```

---

## 5. `GET /api/health/checks` — Dependency Health Checks

Returns a paginated snapshot of all named upstream dependency health checks.

### Auth

No explicit auth required (internal service mesh).

### Example — First page

```bash
curl -s "${BASE_URL}/api/health/checks?limit=3"
```

**Response — 200 OK**:

```json
{
  "data": [
    {
      "id": "chk_001",
      "name": "soroban_rpc",
      "status": "healthy",
      "latencyMs": 45,
      "timestamp": "2026-07-27T10:30:00.000Z"
    },
    {
      "id": "chk_002",
      "name": "database",
      "status": "healthy",
      "latencyMs": 12,
      "timestamp": "2026-07-27T10:30:00.000Z"
    },
    {
      "id": "chk_003",
      "name": "kyc_provider",
      "status": "degraded",
      "latencyMs": 1200,
      "timestamp": "2026-07-27T10:30:00.000Z"
    }
  ],
  "meta": {
    "limit": 3,
    "hasMore": true,
    "nextCursor": "eyJpZCI6ImNoa18wMDMiLCJ0cyI6IjIwMjYtMDctMjdUMTA6MzA6MDAifQ==",
    "total": 6
  },
  "message": "Health checks retrieved successfully."
}
```

### Example — Next page using cursor

```bash
curl -s "${BASE_URL}/api/health/checks?cursor=eyJpZCI6ImNoa18wMDMiLCJ0cyI6IjIwMjYtMDctMjdUMTA6MzA6MDAifQ==&limit=3"
```

**Response — 200 OK**: Next 3 checks (or fewer on the last page). When on the last page, `hasMore` is `false` and `nextCursor` is `null`.

### Example — 400 Bad Request (invalid cursor)

```bash
curl -s "${BASE_URL}/api/health/checks?cursor=tampered"
```

**Response — 400 Bad Request**:

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Invalid or malformed cursor.",
  "fieldErrors": {
    "cursor": "HMAC verification failed"
  }
}
```

---

## 6. `POST /api/health/reports` — Submit Health Report (Idempotent)

Accepts an external service health report. Requires an `Idempotency-Key` header.

### Auth

No explicit auth required (internal service mesh). Idempotency enforced via header.

### Example — New submission

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: report_20260727_103000_soroban" \
  -d '{
    "serviceName": "soroban-rpc",
    "status": "healthy",
    "message": "All RPC endpoints responding within SLA",
    "metadata": { "endpoints": 3, "avgLatencyMs": 45 },
    "reportedAt": "2026-07-27T10:30:00.000Z"
  }' \
  "${BASE_URL}/api/health/reports"
```

**Response — 201 Created**:

```json
{
  "data": {
    "reportId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "serviceName": "soroban-rpc",
    "status": "healthy",
    "message": "All RPC endpoints responding within SLA",
    "metadata": { "endpoints": 3, "avgLatencyMs": 45 },
    "reportedAt": "2026-07-27T10:30:00.000Z",
    "acceptedAt": "2026-07-27T10:30:00.123Z"
  },
  "message": "Health report for 'soroban-rpc' accepted."
}
```

### Example — Retry with same key + same body (cached replay)

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: report_20260727_103000_soroban" \
  -d '{
    "serviceName": "soroban-rpc",
    "status": "healthy",
    "message": "All RPC endpoints responding within SLA",
    "metadata": { "endpoints": 3, "avgLatencyMs": 45 },
    "reportedAt": "2026-07-27T10:30:00.000Z"
  }' \
  "${BASE_URL}/api/health/reports"
```

**Response — 201 Created** (same cached response replayed).

### Example — Retry with same key + different body (conflict)

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: report_20260727_103000_soroban" \
  -d '{
    "serviceName": "soroban-rpc",
    "status": "unhealthy",
    "message": "RPC timeout"
  }' \
  "${BASE_URL}/api/health/reports"
```

**Response — 409 Conflict**:

```json
{
  "type": "https://liquifact.io/problems/idempotency-conflict",
  "title": "Idempotency Conflict",
  "status": 409,
  "detail": "The idempotency key has already been used with a different request body."
}
```

### Example — 400 Bad Request (missing Idempotency-Key)

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{ "serviceName": "db", "status": "healthy" }' \
  "${BASE_URL}/api/health/reports"
```

**Response — 400 Bad Request**:

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Missing or invalid Idempotency-Key header."
}
```

### Example — 400 Bad Request (missing required field)

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: report_20260727_110000_db" \
  -d '{ "serviceName": "database" }' \
  "${BASE_URL}/api/health/reports"
```

**Response — 400 Bad Request**:

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Health report payload contains invalid or missing fields.",
  "instance": "/api/health/reports",
  "fieldErrors": {
    "status": ["Required"]
  }
}
```

---

## Quick Reference

| Endpoint | Method | Auth | Content-Type |
|---|---|---|---|
| `/metrics` | GET | Bearer token or loopback | — |
| `/api/sme/metrics` | GET | JWT + tenant | — |
| `/api/sme/metrics/bulk` | POST | JWT + tenant | `application/json` |
| `/api/admin/metrics/audit` | GET | Admin JWT/API key | — |
| `/api/health/checks` | GET | None (internal) | — |
| `/api/health/reports` | POST | None (internal) | `application/json` |
