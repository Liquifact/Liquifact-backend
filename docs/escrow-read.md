# Escrow-Read API Contract

> **Scope:** `Liquifact/Liquifact-backend`  
> **Last updated:** 2026-07-27  
> **Cross-reference:** `src/services/escrowRead.js` · `src/routes/v1/index.js` · `src/app.js` · `src/services/escrowDerived.js`  
> **Changelog:** [changelog-escrow-read.md](./changelog-escrow-read.md) — consumer-facing changes over time.

---

## Overview

The escrow-read surface exposes two HTTP routes that return on-chain escrow state for a given invoice. Both routes resolve the invoice ID to a Stellar escrow contract address via `resolveEscrowAddress`, then read the escrow state through the projection-first chain in `escrowRead.js`.

| Route | Auth | Handler | Service function |
|---|---|---|---|
| `GET /v1/escrow/:invoiceId` | Bearer JWT required | `src/routes/v1/index.js:168` | `readEscrowState` |
| `GET /api/escrow/:invoiceId` | None | `src/app.js:170` | `getEscrowStateWithProjection` |

All reads follow the **projection-first ordering**:

1. Test adapter (when injected; not available in production)
2. `escrow_event_projection` row written by the indexer
3. Neutral RPC stub (`status: "not_found"`, `fundedAmount: 0`) — never fabricates state

---

## Route 1: `GET /v1/escrow/:invoiceId`

Authenticated endpoint for versioned escrow reads. The `authenticateToken` middleware validates the Bearer JWT before any escrow logic runs.

### Request

| Component | Value |
|---|---|
| Method | `GET` |
| Path | `/v1/escrow/:invoiceId` |
| Auth | `Authorization: Bearer <JWT>` |
| Path param `invoiceId` | Alphanumeric start, followed by alphanumeric, underscores, hyphens, dots, or colons; 1–128 chars |
| Query params | None |
| Request body | None |

### Success response

**Status:** `200 OK`  
**Header:** `X-Escrow-Address: <Stellar contract address>`

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
    "latest_event_id": "evt_v1_1",
    "latest_paging_token": "paging_token_abc",
    "latest_observed_at": "2026-07-25T12:00:00.000Z",
    "source": "projection",
    "fromProjection": true,
    "apyPercent": 5.25,
    "fundedPercent": 75.0,
    "daysToMaturity": 42,
    "escrowAddress": "C_V1_ESCROW_FOR_INV_001"
  },
  "message": "Escrow state read from event projection."
}
```

The envelope is wrapped in the standard response shape (`data`, `meta`, `error`) by the `createStandardizedApp` middleware.

| Field | Type | Description |
|---|---|---|
| `data.invoiceId` | `string` | The validated invoice identifier |
| `data.status` | `string` | On-chain escrow status (e.g. `"funded"`, `"settled"`, `"not_found"`) |
| `data.fundedAmount` | `number` | Amount currently held in escrow; finite non-negative; `0` when unknown |
| `data.legal_hold` | `boolean` | `true` when held or unknown (fail-closed); `false` only when confirmed not held |
| `data.legalHoldStatus` | `"held" \| "not_held" \| "unknown"` | Tri-state legal hold outcome |
| `data.legalHoldReason` | `string` \| absent | Present only when `legalHoldStatus` is `"unknown"` (`"rpc_error"` \| `"adapter_error"`) |
| `data.legalHoldErrorCode` | `string` \| absent | Present only when `legalHoldStatus` is `"unknown"` and the underlying error carries a code |
| `data.funding_token` | `object` \| `null` | Token metadata (`symbol`, `name`, `decimals`); present when `fundingAsset` is configured |
| `data.ledgerCloseTime` | `number` \| absent | Unix epoch seconds from the Soroban response; used for `daysToMaturity` |
| `data.latest_ledger_sequence` | `number` \| `null` | Ledger sequence from the projection row |
| `data.latest_event_type` | `string` | Event type from the projection or `"live_read"` for RPC fallback |
| `data.source` | `"projection" \| "rpc_stub"` | Where the base state was read from |
| `data.fromProjection` | `boolean` | `true` when the projection table was the source |
| `data.apyPercent` | `number` \| `null` | Annual yield rate rounded to 2 dp; `null` when `annualRatePercent` is missing or invalid |
| `data.fundedPercent` | `number` \| `null` | `(fundedAmount / totalAmount) × 100` rounded to 2 dp; `null` when `totalAmount` is missing or zero |
| `data.daysToMaturity` | `number` \| `null` | Whole days until maturity; negative = overdue; `null` when maturity is missing or invalid |
| `data.escrowAddress` | `string` | Resolved Stellar escrow contract address (C... or G...) |
| `message` | `string` | `"Escrow state read from event projection."` or `"Escrow state read from live Soroban contract."` |

### Error responses

| Status | Error code (`error.code`) | Description |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing, malformed, or expired `Authorization` header |
| `400` | `BAD_REQUEST` | `invoiceId` contains invalid characters or is empty (`INVALID_INVOICE_ID` from `readEscrowState`) |
| `404` | `NOT_FOUND` | No escrow contract mapping exists for the given `invoiceId` |
| `500` | `INTERNAL_ERROR` | Upstream RPC failure, DB failure, or unexpected error |

### Error response example

**401 — Missing token**

```json
{
  "data": null,
  "meta": { "timestamp": "2026-07-25T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "Authentication token is required",
    "code": "UNAUTHORIZED",
    "details": null
  }
}
```

**400 — Invalid invoiceId**

```json
{
  "data": null,
  "meta": { "timestamp": "2026-07-25T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ -)",
    "code": "BAD_REQUEST",
    "details": null
  }
}
```

**404 — No escrow mapping**

```json
{
  "data": null,
  "meta": { "timestamp": "2026-07-25T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "No escrow contract mapping found for invoice ID 'unknown-inv'",
    "code": "NOT_FOUND",
    "details": null
  }
}
```

### Request / response example (curl)

```bash
# Success — projection-backed read
curl -s -H "Authorization: Bearer <JWT>" \
  https://api.liquifact.com/v1/escrow/inv_001 \
  -i

# Response
HTTP/1.1 200 OK
X-Escrow-Address: C_V1_ESCROW_FOR_INV_001
Content-Type: application/json

# Body (envelope-wrapped)
{
  "data": {
    "invoiceId": "inv_001",
    "status": "funded",
    "fundedAmount": 7500,
    "legal_hold": false,
    "legalHoldStatus": "not_held",
    "source": "projection",
    "fromProjection": true,
    "escrowAddress": "C_V1_ESCROW_FOR_INV_001",
    "apyPercent": 5.25,
    "fundedPercent": 75.0,
    "daysToMaturity": 42
  },
  "message": "Escrow state read from event projection."
}
```

```bash
# Validation error — invalid invoiceId
curl -s -H "Authorization: Bearer <JWT>" \
  https://api.liquifact.com/v1/escrow/bad@invalid \
  -i

# Response
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": { "timestamp": "2026-07-25T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ -)",
    "code": "BAD_REQUEST",
    "details": null
  }
}
```

```bash
# Not found — no escrow mapping
curl -s -H "Authorization: Bearer <JWT>" \
  https://api.liquifact.com/v1/escrow/unknown-inv \
  -i

# Response
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "data": null,
  "meta": { "timestamp": "2026-07-25T12:00:00.000Z", "version": "0.1.0" },
  "error": {
    "message": "No escrow contract mapping found for invoice ID 'unknown-inv'",
    "code": "NOT_FOUND",
    "details": null
  }
}
```

---

## Route 2: `GET /api/escrow/:invoiceId`

Unauthenticated proxy endpoint. This route is the minimal app path; it uses `getEscrowStateWithProjection` (which adds Redis caching on top of the projection-first chain) instead of `readEscrowState`.

### Request

| Component | Value |
|---|---|
| Method | `GET` |
| Path | `/api/escrow/:invoiceId` |
| Auth | None |
| Path param `invoiceId` | Same validation rules as v1 |
| Query params | None |
| Request body | None |

### Success response

**Status:** `200 OK`  
**Header:** `X-Escrow-Address: <Stellar contract address>`

```json
{
  "data": {
    "invoiceId": "inv_001",
    "status": "funded",
    "fundedAmount": 7500,
    "legal_hold": false,
    "legalHoldStatus": "not_held",
    "latest_ledger_sequence": 500,
    "fromProjection": true,
    "escrowAddress": "C_ESCROW_FOR_INV_001"
  },
  "message": "Escrow state read from event projection."
}
```

> **Note:** This route does **not** include derived fields (`apyPercent`, `fundedPercent`, `daysToMaturity`) in the current `app.js` implementation. The `computeEscrowDerivedFields` call in `app.js` is present but the v1 route passes `ledgerCloseTime` explicitly; the `/api/` route does not.

### Error responses

| Status | Error code | Description |
|---|---|---|
| `404` | `NOT_FOUND` | No escrow contract mapping exists for the given `invoiceId` |
| `500` | `INTERNAL_ERROR` | Upstream RPC failure, DB failure, or unexpected error |

### Request / response example (curl)

```bash
# Success
curl -s https://api.liquifact.com/api/escrow/inv_001 -i

# Validation error
curl -s https://api.liquifact.com/api/escrow/bad@invalid -i

# Not found
curl -s https://api.liquifact.com/api/escrow/unknown-inv -i
```

---

## Error Code Reference

### HTTP status → error code mapping

The application uses RFC 7807 Problem Details for all error responses. The `error.code` field in the response body is derived via `getErrorCode(statusCode)` in `src/app.js` (`src/app.js:getErrorCode`):

| HTTP status | `error.code` | Meaning |
|---|---|---|
| `400` | `BAD_REQUEST` | Malformed request; includes `INVALID_INVOICE_ID` from validation failures |
| `401` | `UNAUTHORIZED` | Missing, malformed, or expired `Authorization` header |
| `404` | `NOT_FOUND` | No escrow contract mapping for the invoice ID |
| `423` | `LOCKED` | Legal hold is active (returned by the funding gate, not the read routes directly) |
| `503` | `SERVICE_UNAVAILABLE` | Legal hold status is unreadable (returned by the funding gate) |
| `500` | `INTERNAL_ERROR` | Unexpected server-side failure |

### Escrow-read-specific error sources

All errors originate in `src/services/escrowRead.js` unless otherwise noted.

| Error source | `status` | `code` | When it fires |
|---|---|---|---|
| `validateInvoiceId` rejects input | 400 | `INVALID_INVOICE_ID` | `invoiceId` is not a string, is empty, or contains characters outside `[A-Za-z0-9._:-]` |
| `resolveEscrowAddress` finds no mapping | — | — | Throws `EscrowNotFoundError`; the route handler catches it and returns 404 |
| `_readBaseStateFromProjection` DB failure | — | — | Logged as `warn`; falls through to RPC stub (does not fail the request) |
| `_fetchBaseEscrowState` RPC stub failure | — | — | The neutral stub never fails; `callSorobanContract` only fails if an injected adapter throws |
| `fetchLegalHoldStatus` RPC failure | — | — | Returns `status: "unknown"` with `reason: "rpc_error"`; does **not** throw |
| `fetchAttestationAppendLog` RPC failure | — | — | Returns `[]` (empty array); does **not** throw |
| `getTokenMetadata` failure | — | — | Logged as `warn`; `funding_token` set to `null`; does **not** fail the request |
| `computeEscrowDerivedFields` | — | — | Returns `null` for any field it cannot compute; does not throw |

### Legal hold error sub-codes

When `legalHoldStatus` is `"unknown"`, the response includes additional diagnostic fields:

| Field | Value | Description |
|---|---|---|
| `legalHoldReason` | `"rpc_error"` | The Soroban `get_legal_hold` call failed (timeout, ECONNREFUSED, etc.) |
| `legalHoldReason` | `"adapter_error"` | A caller-supplied adapter threw an exception |
| `legalHoldReason` | `"service_unavailable"` | The service module is unavailable (gate fallback path) |
| `legalHoldErrorCode` | e.g. `"ETIMEDOUT"`, `"ECONNREFUSED"` | The native error code from the underlying failure, if present |

---

## Service Function Reference

The following functions are exported from `src/services/escrowRead.js` and are available for direct use by downstream consumers (not just the HTTP routes).

### `readEscrowState(invoiceId, options?)`

**Handler:** `GET /v1/escrow/:invoiceId` (v1 route)  
**File:** `src/services/escrowRead.js:406`

Returns the full enriched escrow state including `legal_hold`, `legalHoldStatus`, and optional `funding_token` metadata.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `invoiceId` | `string` | Yes | Validated internally; must match `INVOICE_ID_RE` |
| `options.legalHoldAdapter` | `Function` | No | Test injection for `get_legal_hold` |
| `options.escrowAdapter` | `Function` | No | Test injection for base escrow state |
| `options.fundingAsset` | `string` | No | Funding asset descriptor for token metadata lookup |
| `options.tokenMetaAdapter` | `Function` | No | Test injection for token metadata |
| `options.dbClient` | `Knex` | No | Test injection for DB client |

**Throws:** `Error` with `code: "INVALID_INVOICE_ID"` and `status: 400` when `invoiceId` is invalid.

**Returns:** `Promise<EscrowState>`

```typescript
interface EscrowState {
  invoiceId: string;
  status: string;
  fundedAmount: number;
  legal_hold: boolean;
  legalHoldStatus: 'held' | 'not_held' | 'unknown';
  legalHoldReason?: string;
  legalHoldErrorCode?: string;
  funding_token: object | null;
  ledgerCloseTime?: number;
  source: 'projection' | 'rpc_stub';
  fromProjection: boolean;
  latest_ledger_sequence: number | null;
  latest_event_type: string;
  latest_event_id: string | null;
  latest_paging_token: string | null;
  latest_observed_at: string | null;
}
```

### `readEscrowStateWithAttestations(invoiceId, options?)`

**Handler:** Not currently wired to an HTTP route; used internally and in batch reads  
**File:** `src/services/escrowRead.js:548`

Same as `readEscrowState` but also includes the attestation append log (`attestations` array).

| Parameter | Same as `readEscrowState` |
|---|---|
| `options.attestationAdapter` | `Function` — Test injection for attestation log |

**Returns:** `Promise<EscrowStateWithAttestations>` — adds `attestations: Array<{index: number, digest: string}>` to the base shape.

### `readFundedAmount(invoiceId, options?)`

**Handler:** Not an HTTP route; used by `src/jobs/reconcileEscrow.js`  
**File:** `src/services/escrowRead.js:636`

Focused read that returns only the `fundedAmount` as a finite number.

| Parameter | Same as `readEscrowState` (minus `legalHoldAdapter`, `fundingAsset`, `tokenMetaAdapter`) |
|---|---|

**Returns:** `Promise<number>` — the funded amount; `0` when the projection, adapter, or stub returns no data.

### `getEscrowStateWithProjection(invoiceId, options?)`

**Handler:** `GET /api/escrow/:invoiceId` (legacy / minimal app route)  
**File:** `src/services/escrowRead.js:679`

Adds Redis caching on top of the projection-first chain. This is the route used by the non-v1 `/api/escrow` endpoint.

| Parameter | Same as `readEscrowState` (plus `dbClient`) |
|---|---|

**Note:** This function reads the tri-state legal hold separately (not concurrently with the base state) and appends a `latest_event_type: "live_read"` marker for live reads.

### `validateInvoiceId(invoiceId)`

**Handler:** Called internally by all top-level read functions; not a route  
**File:** `src/services/escrowRead.js:139`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `invoiceId` | `unknown` | Yes | Checked for being a non-empty string matching `INVOICE_ID_RE` |

**Returns:** `{ valid: boolean, reason?: string }`

**Regex:** `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` — aligned with `IDENTIFIER_PATTERN` in `escrowSubmit.js`.

### `fetchLegalHoldStatus(invoiceId, adapter?)`

**Handler:** Not a route; used internally by `readEscrowState` and the legal hold gate  
**File:** `src/services/escrowRead.js:174`

Returns the tri-state legal hold envelope. Never throws — RPC failures resolve to `status: "unknown"`.

**Returns:** `Promise<LegalHoldEnvelope>`

```typescript
interface LegalHoldEnvelope {
  status: 'held' | 'not_held' | 'unknown';
  reason?: 'rpc_error' | 'adapter_error' | 'service_unavailable';
  errorCode?: string;
}
```

### `fetchAttestationAppendLog(invoiceId, adapter?)`

**Handler:** Not a route; used internally by `readEscrowStateWithAttestations`  
**File:** `src/services/escrowRead.js:491`

Returns the attestation append log as an array of `{index, digest}` entries. Returns `[]` on RPC failure.

### `coerceLegalHoldStatus(raw)`

**Handler:** Not a route; canonical boolean → tri-state coercion exported for callers  
**File:** `src/services/escrowRead.js:102`

Treats truthy / numeric 1 / string `'true'` as `held`; everything else as `not_held`. Throws are **not** handled here; callers must route them to `unknown`.

### Constants

| Constant | Value | Description |
|---|---|---|
| `LEGAL_HOLD_STATUS` | `{ HELD: 'held', NOT_HELD: 'not_held', UNKNOWN: 'unknown' }` | Canonical tri-state string constants |
| `LEGAL_HOLD_UNKNOWN_REASONS` | `{ RPC_ERROR: 'rpc_error', ADAPTER_ERROR: 'adapter_error' }` | Reasons for the `unknown` legal hold outcome |

---

## Response Field Glossary

### `source` field

| Value | Meaning |
|---|---|
| `"projection"` | Base state came from the `escrow_event_projection` table |
| `"rpc_stub"` | Base state came from the neutral RPC stub (no projection or cache data) |
| `"live_read"` | Legacy marker set by `getEscrowStateWithProjection` for live RPC reads (not from projection) |

### `legal_hold` (boolean) vs `legalHoldStatus` (tri-state)

The boolean `legal_hold` is **fail-closed**: it is `true` when the status is either `"held"` **or** `"unknown"`. Callers that branch on `if (!state.legal_hold)` will never accidentally fund an invoice whose hold status is unreadable.

The tri-state `legalHoldStatus` gives callers the ability to distinguish a verified hold from an outage when they need finer-grained control.

### Derived fields (`apyPercent`, `fundedPercent`, `daysToMaturity`)

Computation is delegated to `computeEscrowDerivedFields(state, { ledgerCloseTime })` in `src/services/escrowDerived.js`. The `daysToMaturity` computation uses ledger close time when available (as `opts.ledgerCloseTime`), falling back to the server wall clock otherwise. All percent values use `Math.round(x * 100) / 100` (round-half-up at 2 dp).

---

## Soft Delete and Restore (issue #31)

Escrow-read records (`escrow_event_projection` rows) are never hard-deleted by operators. A delete writes a tombstone; the row survives, hidden, until its retention window elapses, and a maintenance task purges it after that.

### Lifecycle

| State | Row condition | Default reads see | Restorable |
|---|---|---|---|
| Live | `deleted_at IS NULL` | The projection state (`source: "projection"`) | n/a |
| Soft-deleted | `deleted_at` set, within window | Neutral `not_found` state (`fundedAmount: 0`) | Yes |
| Window expired | `deleted_at` set, `now - deleted_at >= window` | Neutral `not_found` state | **No** — `410 Gone` |
| Purged | Row removed by the purge job | Neutral `not_found` state | No — `404` |

The retention window is `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` (default **30**, clamped to 1–3650). Restorability is decided by the window alone, never by whether the purge job has run yet — so the API contract does not drift with job scheduling.

### Read exclusion

`_readBaseStateFromProjection` treats a tombstoned row as absent, so `readEscrowState`, `readEscrowStateWithAttestations`, `readFundedAmount`, and `getEscrowStateWithProjection` all fall through to the neutral RPC stub. Both delete and restore invalidate the local and Redis escrow caches, so a cached summary can never keep serving a hidden record.

### Admin endpoints

All four require admin authentication (JWT bearer or API key) via `adminStack`.

| Route | Purpose | Notable statuses |
|---|---|---|
| `DELETE /api/admin/escrow/reads/:invoiceId` | Soft-delete. Optional JSON body `{ "reason": "..." }` (≤ 500 chars) recorded for audit | `404` unknown record · `409` already deleted |
| `POST /api/admin/escrow/reads/:invoiceId/restore` | Restore within the window | `409` not deleted · `410` window expired · `404` purged |
| `GET /api/admin/escrow/reads/:invoiceId/deletion-state` | Inspect the tombstone (the only read that surfaces deleted records) | `404` unknown record |
| `POST /api/admin/escrow/reads/purge` | Run the retention purge on demand | — |

Delete response body:

```json
{
  "invoiceId": "inv_001",
  "deleted": true,
  "deletedAt": "2026-07-25T12:00:00.000Z",
  "deletedBy": "admin-user",
  "deleteReason": "duplicate projection",
  "restoredAt": null,
  "restoredBy": null,
  "purgeAfter": "2026-08-24T12:00:00.000Z",
  "restorable": true,
  "retentionDays": 30
}
```

Re-deleting an already-tombstoned record returns `409` rather than refreshing `deleted_at` — otherwise a retried delete would extend the window on every attempt and a record could evade purge indefinitely.

### Maintenance task

`src/jobs/escrowReadPurge.js` runs `purgeExpiredSoftDeletes` on a schedule (`ESCROW_READ_PURGE_INTERVAL_MS`, default 6 h) through the shared job queue. Each run deletes rows with `deleted_at <= now - window` in batches of `ESCROW_READ_PURGE_BATCH_SIZE`, capped at `ESCROW_READ_PURGE_MAX_BATCHES` per run; a remaining backlog is reported as `maxBatchesReached` and picked up next run. Metrics: `liquifact_escrow_read_purge_rows_deleted_total` and `liquifact_escrow_read_purge_runs_total{status}`.

Schema: `migrations/20260725000000_add_soft_delete_to_escrow_event_projection.sql` adds `deleted_at`, `deleted_by`, `delete_reason`, `restored_at`, `restored_by`, plus a partial index on `deleted_at` so the purge scan never touches live rows.

---

## Cross-Reference Index

| Symbol | File | Line | Used by |
|---|---|---|---|
| `resolveEscrowAddress` | `src/config/escrowMap.js` | — | Both routes |
| `readEscrowState` | `src/services/escrowRead.js` | 406 | `GET /v1/escrow/:invoiceId` |
| `getEscrowStateWithProjection` | `src/services/escrowRead.js` | 679 | `GET /api/escrow/:invoiceId` |
| `computeEscrowDerivedFields` | `src/services/escrowDerived.js` | 350 | Both routes |
| `fetchLegalHoldStatus` | `src/services/escrowRead.js` | 174 | `readEscrowState`, `readEscrowStateWithAttestations`, `getEscrowStateWithProjection` |
| `fetchAttestationAppendLog` | `src/services/escrowRead.js` | 491 | `readEscrowStateWithAttestations` |
| `validateInvoiceId` | `src/services/escrowRead.js` | 139 | All read functions |
| `coerceLegalHoldStatus` | `src/services/escrowRead.js` | 102 | `fetchLegalHoldStatus`, `legalHoldGate` |
| `LEGAL_HOLD_STATUS` | `src/services/escrowRead.js` | 72 | `fetchLegalHoldStatus`, `legalHoldGate` |
| `LEGAL_HOLD_UNKNOWN_REASONS` | `src/services/escrowRead.js` | 84 | `fetchLegalHoldStatus`, `legalHoldGate` |
| `legalHoldGate` | `src/middleware/legalHoldGate.js` | — | Funding routes (not read routes) |
| `createStandardizedApp` | `src/app.js` | — | Wraps all JSON responses in the standard envelope |
| `AppError` | `src/errors/AppError.js` | — | Used by route handlers for structured errors |
| `softDeleteEscrowRead` | `src/services/escrowReadSoftDelete.js` | — | `DELETE /api/admin/escrow/reads/:invoiceId` |
| `restoreEscrowRead` | `src/services/escrowReadSoftDelete.js` | — | `POST /api/admin/escrow/reads/:invoiceId/restore` |
| `purgeExpiredSoftDeletes` | `src/services/escrowReadSoftDelete.js` | — | `src/jobs/escrowReadPurge.js`, `POST /api/admin/escrow/reads/purge` |
| `formatProblemDetails` | `src/utils/problemDetails.js` | — | Canonical RFC 7807 builder used by `AppError` |

---

## Changelog

See [changelog-escrow-read.md](./changelog-escrow-read.md) for a detailed, dated changelog of all consumer-facing escrow-read API changes.

| Date | Change |
|---|---|
| 2026-07-27 | Service layer extracted; route handlers become thin adapters (issue #31) |
| 2026-07-25 | Initial documentation of escrow-read API contract and error codes |
| 2026-07-25 | Added soft-delete, restore, and retention purge for escrow-read records (issue #31) |
