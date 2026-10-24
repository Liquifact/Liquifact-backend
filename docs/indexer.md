# Indexer API Contract

> **Scope:** `Liquifact/Liquifact-backend`
> **Last updated:** 2026-07-25
> **Cross-reference:** `src/routes/adminIndexer.js` · `src/services/indexerService.js` · `src/utils/cursorPagination.js` · `src/middleware/stacks.js` · `src/app.js`

---

## Overview

The indexer surface exposes one HTTP route: a cursor-paginated, admin-only read
over the `escrow_events` table, which is populated by the background escrow
indexer job (`src/jobs/escrowIndexer.js`). It lets operators inspect indexed
Soroban / Horizon contract events without querying the database directly.

| Route | Auth | Handler | Service function |
|---|---|---|---|
| `GET /api/admin/indexer/events` | Admin JWT **or** API key | `src/routes/adminIndexer.js` | `listIndexerEvents` (`src/services/indexerService.js`) |

The route is mounted in `src/app.js` via:

```js
mountFeatureRouter(app, '/api/admin/indexer', adminIndexerRoutes);
```

For runnable curl examples and auth variations, see [indexer-examples.md](indexer-examples.md).

Indexer health (staleness of the last processed ledger) is reported separately
through `GET /health` and `GET /health/detailed` (`checkIndexerStaleness` in
`src/services/health.js`); it is not part of this route and is not covered
here.

---

## Route: `GET /api/admin/indexer/events`

Returns a bounded, cursor-paginated list of rows from the `escrow_events`
table, ordered by `observed_at DESC` by default. `event_body` is intentionally
excluded from list rows to keep payloads small.

### Auth

Handled by `adminStack` (`src/middleware/stacks.js`), applied to every route
in the file via `router.use(...adminStack)`:

- If the request carries an `x-api-key` header, it is validated by
  `authenticateApiKey()` (`src/middleware/apiKeyAuth.js`) — any valid,
  non-revoked key is accepted (no required scope).
- Otherwise, the request must carry a valid `Authorization: Bearer <JWT>`
  header, validated by `authenticateToken` (`src/middleware/auth.js`).
- After auth, `extractTenant` (`src/middleware/tenant.js`) resolves
  `req.tenantId` from `x-tenant-id` or the JWT's `tenantId` claim. Note the
  service layer does **not** filter `escrow_events` by tenant — see
  [Security notes](#security-notes).

### Request

| Component | Value |
|---|---|
| Method | `GET` |
| Path | `/api/admin/indexer/events` |
| Auth | `Authorization: Bearer <JWT>` **or** `X-API-Key: <key>` |
| Path params | None |
| Request body | None |

#### Query parameters

Only the parameters below are accepted. Any other query key is rejected with
a `400` (see `_unknown` in [Validation errors](#validation-errors)).

| Param | Type | Required | Constraint | Notes |
|---|---|---|---|---|
| `invoiceId` | string | No | `^[a-zA-Z0-9_-]{1,128}$` | Exact-match filter on `invoice_id` |
| `eventType` | string | No | Non-empty, ≤128 chars | Exact-match filter on `event_type` |
| `contractId` | string | No | `^C[A-Z2-7]{55}$` (Stellar contract address) | Exact-match filter on `contract_id` |
| `sortBy` | string | No | One of `observed_at`, `ledger_sequence` | Default `observed_at`. Must stay constant across cursor pages |
| `order` | string | No | `asc` or `desc` (case-insensitive) | Default `desc` |
| `cursor` | string | No | Non-empty, ≤2048 chars | Opaque, HMAC-signed. When present, `page` is ignored |
| `page` | integer | No | ≥1 | Offset mode only; ignored when `cursor` is supplied |
| `limit` | integer | No | 1–100 | Default 20. Applies to both pagination modes |

#### Pagination modes

| Mode | Parameters | Behavior |
|---|---|---|
| Cursor (recommended) | `cursor` + `limit` | Keyset pagination; stable under concurrent inserts. Use `nextCursor` from the previous response |
| Offset (legacy) | `page` + `limit` | Backward-compatible; may drift on busy datasets |

Cursors are opaque, base64url-encoded, HMAC-signed strings produced by
`encodeCursor`/`decodeCursor` (`src/utils/cursorPagination.js`). A cursor
encodes `{ sortField, sortValue, id, iat }`; the `id` (`event_id`) is used as
a tiebreaker when the sort column has duplicate values. Cursors are bound to
the `sortBy` field that produced them — switching `sortBy` mid-pagination
requires starting over without a `cursor`.

### Success response

**Status:** `200 OK`

Response envelope (`src/utils/responseHelper.js` `success()`):

```json
{
  "data": [
    {
      "event_id": "evt_9f21ac",
      "invoice_id": "inv_001",
      "event_type": "escrow_created",
      "ledger_sequence": 100,
      "paging_token": "100-1",
      "contract_id": null,
      "tx_hash": null,
      "observed_at": "2026-01-01T00:00:00.000Z",
      "created_at": "2026-01-01T00:00:01.000Z"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 20,
    "hasMore": false,
    "nextCursor": null,
    "timestamp": "2026-07-25T12:00:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Indexer events retrieved successfully."
}
```

In **offset mode** (`page` supplied, no `cursor`), `meta` additionally
includes `page` and `totalPages`:

```json
"meta": {
  "total": 42,
  "page": 2,
  "limit": 20,
  "totalPages": 3,
  "hasMore": true,
  "nextCursor": "eyJzb3J0RmllbGQiOi...",
  "timestamp": "2026-07-25T12:00:00.000Z",
  "version": "0.1.0"
}
```

#### Data row fields

| Field | Type | Notes |
|---|---|---|
| `event_id` | string | Primary tiebreaker for keyset pagination |
| `invoice_id` | string | |
| `event_type` | string | e.g. `escrow_created`, `funded` |
| `ledger_sequence` | integer | Stellar ledger sequence the event was observed at |
| `paging_token` | string \| null | Horizon paging token, when available |
| `contract_id` | string \| null | Stellar escrow contract address |
| `tx_hash` | string \| null | Transaction hash, when available |
| `observed_at` | string (ISO 8601) | When the indexer observed the event |
| `created_at` | string (ISO 8601) | When the row was written |

`event_body` is never included in this response; it is intentionally
excluded from list rows to keep payloads small.

### Example request/response

```
curl -H "Authorization: Bearer <admin-jwt>" \
     "http://localhost:3001/api/admin/indexer/events?invoiceId=inv_001&sortBy=observed_at&order=desc&limit=20"
```

```json
{
  "data": [
    {
      "event_id": "evt_9f21ac",
      "invoice_id": "inv_001",
      "event_type": "escrow_created",
      "ledger_sequence": 100,
      "paging_token": "100-1",
      "contract_id": null,
      "tx_hash": null,
      "observed_at": "2026-01-01T00:00:00.000Z",
      "created_at": "2026-01-01T00:00:01.000Z"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 20,
    "hasMore": false,
    "nextCursor": null,
    "timestamp": "2026-07-25T12:00:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Indexer events retrieved successfully."
}
```

### Error codes

Two distinct error shapes are returned by this route, depending on where the
failure occurs. **This is a real inconsistency in the current code** and is
documented as-is so integrators can handle both.

#### Validation errors (400) — route-level shape

Query-parameter validation failures and cursor errors are built directly in
`src/routes/adminIndexer.js` via `responseHelper.error()`, which does **not**
go through the centralized `errorHandler` and therefore has no
`correlation_id`, `retryable`, or `retry_hint` fields:

```json
{
  "data": null,
  "meta": {
    "timestamp": "2026-07-25T12:00:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Query parameters contain invalid values.",
    "code": "VALIDATION_ERROR",
    "details": {
      "sortBy": "sortBy must be one of: observed_at, ledger_sequence"
    }
  }
}
```

| Status | Trigger | `error.details` key |
|---|---|---|
| 400 | Unknown query parameter | `_unknown` |
| 400 | Invalid `invoiceId` (fails regex) | `invoiceId` |
| 400 | Invalid `eventType` (empty or >128 chars) | `eventType` |
| 400 | Invalid `contractId` (not a valid Stellar contract address) | `contractId` |
| 400 | Invalid `sortBy` (not `observed_at`/`ledger_sequence`) | `sortBy` |
| 400 | Invalid `order` (not `asc`/`desc`) | `order` |
| 400 | Invalid `cursor` (empty or >2048 chars) | `cursor` |
| 400 | Invalid `page` (not an integer ≥1) | `page` |
| 400 | Invalid `limit` (not an integer 1–100) | `limit` |
| 400 | Malformed or tampered `cursor` (`CursorError` from `decodeCursor`) | `cursor` (message from `CursorError`) |

#### Auth errors (401 / 403) — middleware-level shapes

Auth failures happen in middleware **before** the route body runs, and each
middleware has its own response shape:

- **JWT path** (`authenticateToken`, no `x-api-key` header) throws an
  `AppError` that is caught by the centralized `errorHandler`
  (`src/middleware/errorHandler.js`), producing:

  ```json
  {
    "error": {
      "code": "UNAUTHORIZED",
      "message": "Authentication token is required",
      "correlation_id": "req_...",
      "retryable": false,
      "retry_hint": "Do not retry until the issue is resolved or support is contacted."
    }
  }
  ```

  Status is `401` for a missing/malformed/invalid/expired token. `message`
  varies (`"Authentication token is required"`, `"Invalid Authorization
  header format. Expected \"Bearer <token>\""`, `"Token has expired"`, etc.).

- **API key path** (`authenticateApiKey()`, `x-api-key` header present)
  responds directly, **without** the standard envelope or `errorHandler`:

  ```json
  { "error": "API key is required. Provide it via the X-API-Key header." }
  ```

  | Status | Trigger | Body `error` string |
  |---|---|---|
  | 401 | `x-api-key` header empty/missing after all | `"API key is required. Provide it via the X-API-Key header."` |
  | 401 | Key not found in registry | `"Invalid API key."` |
  | 401 | Key found but revoked | `"API key has been revoked."` |
  | 403 | Key valid but missing a required scope (not applicable to this route — `adminStack` requires no scope) | `"Insufficient permissions. Required scope: \"<scope>\"."` |

#### Unexpected errors (500)

Any other thrown error (e.g. a database failure) is caught by `next(error)`
and mapped by the centralized `errorHandler`/`mapError` to:

```json
{
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "An internal server error occurred.",
    "correlation_id": "req_...",
    "retryable": false,
    "retry_hint": "Do not retry until the issue is resolved or support is contacted."
  }
}
```

### Security notes

- `escrow_events` is treated as admin-level data and is **not** filtered by
  `req.tenantId` — `extractTenant` runs for consistency with other admin
  routes, but `listIndexerEvents` applies no tenant predicate.
- Filters (`invoiceId`, `eventType`, `contractId`) are applied identically to
  both the count query and the data query, so `meta.total` always matches the
  active filter set.
- Cursors are HMAC-signed (`CURSOR_SECRET` or `JWT_SECRET`); any tampering is
  rejected with a `400`, not silently ignored.
- A cursor's `sortField` is validated against the request's `sortBy` before
  the query is built; a mismatch is rejected with a `400`.
- API keys are compared using a constant-time, SHA-256-hashed comparison
  (`timingSafeStringEqual`) to prevent timing-based enumeration; failed API
  key attempts are logged with `outcome` context but never log the key value.