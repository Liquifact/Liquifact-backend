# Health API contract

Reference for LiquiFact backend health routes: request rules, response shapes,
dependency check statuses, and validation error codes.

Handlers live in [`src/app.js`](../src/app.js). Dependency probes live in
[`src/services/health.js`](../src/services/health.js). Query/body guards live in
[`src/schemas/health.js`](../src/schemas/health.js).

> **Envelope note:** the default exported app is `createStandardizedApp()`, which
> wraps most JSON payloads via [`src/utils/responseHelper.js`](../src/utils/responseHelper.js).
> The shapes below are the **handler payloads** produced by `createApp()` (what
> tests typically assert). When calling the process over HTTP, success responses
> may appear as `{ data, meta, error: null }`. Prefer verifying against a live
> `GET` if your client consumes the standardized envelope.

All four routes share the same middleware chain:

1. `rejectBodyOnGet` — GET/HEAD must not include a parsed body
2. `validateHealthQuery` — query string must be empty (strict Zod object)

No authentication is required.

---

## Route summary

| Method | Path | Purpose | Dependencies checked |
|--------|------|---------|----------------------|
| `GET` | `/health` | Liveness | None (process up) |
| `GET` | `/healthz` | Liveness alias (K8s convention) | None |
| `GET` | `/ready` | Full dependency health | Soroban, DB, KYC, indexer staleness, storage |
| `GET` | `/readyz` | Critical readiness | DB, Soroban, storage, reconciliation |

---

## `GET /health` and `GET /healthz`

Liveness only. Does not probe the database, Soroban RPC, or other upstreams.

### Request

```http
GET /health HTTP/1.1
Host: api.example.com
```

- Query parameters: **none** (unknown keys → `400`)
- Body: **must be absent** on GET/HEAD

### Success — `200 OK`

```json
{
  "status": "ok",
  "service": "liquifact-api",
  "version": "0.1.0",
  "timestamp": "2026-07-25T08:00:00.000Z"
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `status` | string | Always `"ok"` when the process can answer |
| `service` | string | Service name (`liquifact-api`) |
| `version` | string | API version string |
| `timestamp` | string | ISO 8601 response time |

`/healthz` returns the same payload.

---

## `GET /ready`

Full dependency health (`performHealthChecks()`).

### Request

```http
GET /ready HTTP/1.1
Host: api.example.com
```

### Success — `200 OK` (all blocking checks pass)

```json
{
  "ready": true,
  "service": "liquifact-api",
  "timestamp": "2026-07-25T08:00:00.000Z",
  "checks": {
    "soroban": { "status": "healthy", "latency": 42 },
    "database": {
      "status": "healthy",
      "latency": 3,
      "pool": { "used": 1, "free": 9, "pending": 0, "max": 10 }
    },
    "kyc": { "status": "disabled" },
    "indexerStaleness": { "status": "disabled" },
    "storage": { "status": "healthy", "latency": 15 }
  }
}
```

### Not ready — `503 Service Unavailable`

Returned when `performHealthChecks()` reports `healthy: false`, or when the
probe itself throws.

**Unhealthy aggregate (handler path):**

```json
{
  "ready": false,
  "service": "liquifact-api",
  "timestamp": "2026-07-25T08:00:00.000Z",
  "checks": {
    "soroban": { "status": "unhealthy", "latency": 12, "error": "HTTP 503" },
    "database": { "status": "healthy", "latency": 2 },
    "kyc": { "status": "disabled" },
    "indexerStaleness": { "status": "disabled" },
    "storage": { "status": "not_configured", "bucketConfigured": false }
  }
}
```

**Probe exception (handler path):**

```json
{
  "ready": false,
  "service": "liquifact-api",
  "timestamp": "2026-07-25T08:00:00.000Z",
  "error": "Database health check failed."
}
```

### How `/ready` decides `healthy`

From `performHealthChecks()`:

- **Soroban:** `healthy` or `unknown` (missing `SOROBAN_RPC_URL`) is OK
- **KYC:** `healthy` or `disabled` is OK
- **Indexer staleness:** `healthy` or `disabled` is OK
- **Storage:** `not_configured` or `unhealthy` **fails** readiness; `in_memory` /
  `disabled` / `healthy` do not

Database status is included in `checks` but is not part of the boolean gate in
`performHealthChecks()` (DB gating is applied on `/readyz` via
`performReadinessChecks()`).

---

## `GET /readyz`

Critical-dependency readiness (`performReadinessChecks()`): database, Soroban,
storage, escrow reconciliation, and metrics. Omits KYC and indexer staleness.

Also updates the Prometheus `readiness_gauge` (`1` ready, `0.5` degraded, `0`
not ready).

### Request

```http
GET /readyz HTTP/1.1
Host: api.example.com
```

### Success — `200 OK`

```json
{
  "ready": true,
  "service": "liquifact-api",
  "timestamp": "2026-07-25T08:00:00.000Z",
  "checks": {
    "database": { "status": "healthy", "latency": 3 },
    "soroban": { "status": "healthy", "latency": 40 },
    "storage": { "status": "healthy", "latency": 12 },
    "reconciliation": {
      "status": "healthy",
      "lastRun": "2026-07-25T06:00:00.000Z",
      "mismatches": 0,
      "totalDrift": 0,
      "threshold": 1,
      "thresholdBreached": false
    },
    "metrics": { "status": "healthy", "latency": 2 }
  }
}
```

### Not ready — `503 Service Unavailable`

Same outer shape as `/ready` (`ready`, `service`, `timestamp`, `checks` or
`error` on exception).

### How `/readyz` decides `healthy`

- **Database:** `healthy` or `degraded` (pool pressure) → ready; `unhealthy` /
  `not_configured` → not ready
- **Soroban:** `healthy`, `degraded` (slow), or `unknown` → ready; `unhealthy` → not ready
- **Storage:** `healthy`, `in_memory`, or `disabled` → OK; otherwise not ready
- **Reconciliation:** `mismatch_threshold_breached` → not ready; `not_run` and
  `error` are non-blocking (fresh deploys)
- **Metrics:** always non-blocking — `disabled` or `unhealthy` never fails
  readiness (observability, not a request-serving dependency). See
  [`metrics-troubleshooting.md`](./metrics-troubleshooting.md#readiness-sub-check-get-ready-checksmetrics--status-codes)
  for status/error-code details.

---

## Dependency check status values

### Soroban (`checkSorobanHealth`)

| `status` | Meaning |
|----------|---------|
| `healthy` | RPC reachable; latency ≤ `SOROBAN_LATENCY_WARN_MS` (default 200) |
| `degraded` | Reachable; warn < latency ≤ `SOROBAN_LATENCY_FAIL_MS` (default 500) |
| `unhealthy` | Timeout, network error, or non-OK HTTP |
| `unknown` | `SOROBAN_RPC_URL` not set |

Optional fields: `latency` (ms), `error` (safe message).

### Database (`checkDatabaseHealth`)

| `status` | Meaning |
|----------|---------|
| `healthy` | `SELECT 1` OK; pool within bounds |
| `degraded` | Reachable but pool saturated (`pending > 0` or used ≥ saturation ratio) |
| `unhealthy` | Unreachable or pool acquire timeout |
| `not_configured` | `DATABASE_URL` absent |

Optional fields: `latency`, `pool: { used, free, pending, max }`, `error`.
Never exposes connection strings or credentials.

### KYC (`checkKycHealth`) — `/ready` only

| `status` | Meaning |
|----------|---------|
| `healthy` | Provider host reachable |
| `unhealthy` | Probe failed |
| `disabled` | Provider not configured |

### Indexer staleness (`checkIndexerStaleness`) — `/ready` only

| `status` | Meaning |
|----------|---------|
| `healthy` | Cursor advanced within threshold (or gauge unset at startup) |
| `stale` | Cursor older than `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` |
| `disabled` | `ESCROW_INDEXER_ENABLED` is not `"true"` |
| `error` | Lookup failed |

### Storage (`checkStorageHealth`)

| `status` | Meaning |
|----------|---------|
| `healthy` | Bucket reachable |
| `in_memory` | In-memory fallback; probe skipped |
| `disabled` | `S3_HEALTHCHECK_ENABLED=false` |
| `not_configured` | Bucket/credentials missing |
| `unhealthy` | `HeadBucket` (or equivalent) failed |

Errors are sanitized (`error.code` / `error.hint`); credentials and endpoints are
not returned.

### Reconciliation (`checkReconciliationHealth`) — `/readyz` only

| `status` | Meaning |
|----------|---------|
| `healthy` | Recent run, zero mismatches |
| `degraded` | Mismatches below `RECONCILIATION_DRIFT_THRESHOLD` |
| `mismatch_threshold_breached` | Mismatch count ≥ threshold |
| `stale` | Last run older than 25 hours |
| `not_run` | Never executed |
| `error` | Lookup failed |

---

## Validation errors (all health routes)

### Unknown query parameter — `400`

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Query parameters contain invalid or unknown fields.",
  "instance": "/health?foo=1",
  "code": "VALIDATION_ERROR",
  "fieldErrors": {
    "foo": ["Unrecognized key(s) in object: 'foo'"]
  }
}
```

### Body on GET/HEAD — `400`

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "GET/HEAD requests must not include a request body.",
  "instance": "/health",
  "code": "INVALID_BODY_ON_GET",
  "fieldErrors": {
    "body": ["Request body is not allowed on GET/HEAD requests"]
  }
}
```

| Code | When |
|------|------|
| `VALIDATION_ERROR` | Non-empty / unknown query keys |
| `INVALID_BODY_ON_GET` | Parsed body present on GET/HEAD |

These are RFC 7807–style Problem Details payloads from
`src/schemas/health.js` (not the generic API AppError envelope).

---

## Security notes

- Health probes never return connection strings, API keys, stack traces, or
  raw provider credentials.
- Database pool metrics expose only numeric counts.
- Storage errors are reduced to safe codes/hints.
- Prefer `/health`–`/healthz` for liveness and `/readyz` for orchestrator
  readiness; use `/ready` when you need the fuller dependency snapshot
  (including KYC and indexer staleness).
