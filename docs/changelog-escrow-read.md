# Escrow-Read API Changelog

Tracks notable, consumer-facing changes to the escrow-read API surface:

- `GET /api/escrow/:invoiceId` — legacy unauthenticated single-invoice read.
- `GET /v1/escrow/:invoiceId` — authenticated single-invoice read (rate-limited, includes derived fields).
- `POST /v1/escrow/batch` — authenticated batched read (up to 100 invoice IDs, per-item failure isolation).
- `DELETE /api/admin/escrow/reads/:invoiceId` — admin soft-delete of a projection record.
- `POST /api/admin/escrow/reads/:invoiceId/restore` — admin restore within the retention window.
- `GET /api/admin/escrow/reads/:invoiceId/deletion-state` — admin inspect tombstone.
- `POST /api/admin/escrow/reads/purge` — admin trigger retention purge.
- `GET /api/admin/escrow/version` — admin contract schema-version endpoint.

See also: [escrow-read.md](./escrow-read.md) for the full API contract and [runbook-escrow-read.md](./runbook-escrow-read.md) for operational detail.

## Policy — keep this current

Any PR that changes any of the above endpoints' request/response shape, status codes, headers, auth requirements, rate-limiting behaviour, or error contract **must** add an entry here in the same PR, written from the perspective of a consumer integrating with the API (not internal implementation detail), linking the commit/PR that made the change.

---

## 2026-07-27 — Service layer extracted; route handlers become thin adapters

`b61f557` (#31). Escrow-read orchestration (input validation, address resolution, state reading, derived-field computation, DTO mapping) was duplicated across three route locations. A new `src/services/escrowReadService.js` consolidates this logic into two public functions:

- `getEscrowRead(invoiceId)` — returns a `{ result, error, code, statusCode }` envelope.
- `getEscrowReadBatch(invoiceIds)` — returns a `{ results, errors, statusCode }` envelope.

Route handlers (`GET /api/escrow/:invoiceId`, `GET /v1/escrow/:invoiceId`, `POST /v1/escrow/batch`) now delegate to the service. No change to the request/response contract: all existing status codes, error messages, headers, and response shapes are identical.

Additionally, DTO schemas and pure mapping functions were added to `src/schemas/escrowRead.js` (`mapToEscrowStateDto`, `mapToEscrowReadResponseDto`, `escrowStateDtoSchema`, `escrowReadResponseDtoSchema`, etc.) and a Stellar contract-address validation rule (`C`-prefix check) was added to `escrowReadResponseDtoSchema`. Consumers sending malformed `escrowAddress` values in test data should now pass schema validation; previously any string was accepted.

---

## 2026-07-25 — Soft-delete, restore, and retention purge for escrow-read records

`PR_DESCRIPTION_31.md` (issue #31). Four new admin-only endpoints (all require JWT bearer or API key):

| Route | Behaviour | Notable statuses |
|---|---|---|
| `DELETE /api/admin/escrow/reads/:invoiceId` | Writes a tombstone (`deleted_at`, `deleted_by`, optional `reason`). The record disappears from every default read path. | `404` unknown record · `409` already deleted |
| `POST /api/admin/escrow/reads/:invoiceId/restore` | Clears the tombstone. Record becomes visible again. | `409` not deleted · `410` window expired · `404` purged |
| `GET /api/admin/escrow/reads/:invoiceId/deletion-state` | Returns tombstone metadata; the only read that surfaces deleted records. | `404` unknown record |
| `POST /api/admin/escrow/reads/purge` | Runs the retention purge on demand (also runs on a 6 h schedule via `src/jobs/escrowReadPurge.js`). | — |

The retention window defaults to 30 days (`ESCROW_READ_SOFT_DELETE_RETENTION_DAYS`, clamped 1–3650). Restorability is decided by the window alone, not by whether the purge job has run yet — so the API contract does not drift with job scheduling. A tombstoned record read by any consumer endpoint returns the neutral `not_found` / `fundedAmount: 0` state.

---

## 2026-07-24 — Tri-state legal hold with fail-closed semantics

`PR_DESCRIPTION_424.md` (issue #424). The `legal_hold` field on escrow-state responses is now **fail-closed**: it is `true` when the on-chain hold status is either `held` **or** `unknown`. Previously an unreadable legal-hold read (RPC timeout, circuit-breaker open, adapter throw) silently collapsed to `false`, which could cause funding to proceed against an actually-held invoice during a Soroban outage.

Changes visible in the response payload:

- New field `legalHoldStatus`: `"held"` | `"not_held"` | `"unknown"` — the full tri-state outcome.
- New fields `legalHoldReason` and `legalHoldErrorCode` — present only when `legalHoldStatus` is `"unknown"`, so operators can distinguish a real RPC failure from an unsupported adapter shape without re-reading service logs.
- The legacy boolean `legal_hold` continues to exist but is now `true` for both `held` and `unknown` (fail-closed).

Route handlers and the funding gate also changed: an `unknown` legal-hold status now results in `503 Service Unavailable` from the gate (via `src/middleware/legalHoldGate.js`) rather than silently allowing the funding request. Consumers that only read escrow state (not fund) are unaffected.

---

## 2026-07-21 — Rate limiting on v1 escrow-read endpoint

`PR_DESCRIPTION_429.md` (related; issue #429). `GET /v1/escrow/:invoiceId` now applies the `escrowReadLimiter` (IP-based, configurable via `ESCROW_READ_RATE_LIMIT_*` env vars) **before** authentication — so abuse is gated before any JWT processing. Previously the v1 route had no rate limiting. Consumers receiving `429 Too Many Requests` should retry with exponential backoff; see [rate-limit-ops.md](./rate-limit-ops.md).

---

## 2026-07-18 — Batch escrow-read endpoint

New endpoint `POST /v1/escrow/batch` (authenticated, max 100 invoice IDs per request). Reads escrow state for multiple invoices in a single call with per-item failure isolation: an unmapped invoice ID or a failed on-chain read is reported in `errors` rather than failing the whole batch. Response shape:

```json
{
  "data": {
    "results": [{ "invoiceId": "INV-001", "status": "funded", ... }],
    "errors": [{ "invoiceId": "INV-002", "error": "...", "code": "NOT_FOUND" }]
  },
  "message": "Processed 2 invoice ID(s): 1 succeeded, 1 failed."
}
```

The batch uses configurable concurrency (`SOROBAN_BATCH_CONCURRENCY`, default 5) and per-invoice timeout (`SOROBAN_BATCH_TIMEOUT_MS`, default 5000 ms) to prevent RPC flooding.

---

## 2026-07-15 — Projection-first read ordering with indexer persistence

The escrow-read chain switched from always calling the Soroban RPC stub to a **projection-first** ordering:

1. `escrow_event_projection` row (written by the indexer job `src/jobs/escrowIndexer.js`)
2. Neutral RPC stub (never fabricates state)

Response shape changes:
- New field `source`: `"projection"` | `"rpc_stub"` — indicates where the base state was read from.
- New field `fromProjection`: `boolean` — `true` when the projection table was the source.
- New fields `latest_ledger_sequence`, `latest_event_type`, `latest_event_id`, `latest_paging_token`, `latest_observed_at` — metadata from the projection row.
- `latest_event_type` is set to `"live_read"` when the RPC fallback is used (instead of a projection).
- `ledgerCloseTime` — forwarded from the Soroban response so `daysToMaturity` can be computed against ledger time rather than the server wall clock.
- `funding_token` — token metadata (`symbol`, `name`, `decimals`) present when `fundingAsset` is configured.

The legacy `/api/escrow/:invoiceId` route also gained Redis caching (`getEscrowStateWithProjection`) on top of the projection chain.

---

## 2026-07-12 — Derived display fields on v1 response

`GET /v1/escrow/:invoiceId` response now includes three derived display fields computed by `computeEscrowDerivedFields` in `src/services/escrowDerived.js`:

| Field | Type | Description |
|---|---|---|
| `apyPercent` | `number` \| `null` | Annual yield rate, rounded to 2 dp. `null` when `annualRatePercent` is missing or invalid. |
| `fundedPercent` | `number` \| `null` | `(fundedAmount / totalAmount) × 100`, rounded to 2 dp. `null` when totalAmount is zero or missing. |
| `daysToMaturity` | `number` \| `null` | Whole days until maturity; negative means overdue. Computed against `ledgerCloseTime` when available, falling back to wall clock; `null` when maturity date is missing or out of bounds. |

These fields were previously absent from the response. Consumers that branched on field absence now receive explicit `null` values instead. The legacy `/api/escrow/:invoiceId` route does **not** include derived fields.

---

## 2026-07-10 — Escrow-read metrics instrumentation

`GET /v1/escrow/:invoiceId` and `GET /api/escrow/:invoiceId` now emit Prometheus metrics and structured logs via `recordEscrowRead` in `src/services/escrowReadMetrics.js`:

| Metric | Type | Labels |
|---|---|---|
| `escrow_read_requests_total` | Counter | `endpoint` (`legacy` \| `v1`), `status` (`success` \| `client_error` \| `server_error`) |
| `escrow_read_request_duration_seconds` | Histogram | `endpoint`, `status` |
| `escrow_read_errors_total` | Counter | `endpoint`, `error_cause` (`not_found` \| `bad_request` \| `auth` \| `internal` \| ...) |

No change to the request/response contract — flagged here because consumers running their own alerting can now scrape these directly.

---

## 2026-07-08 — Invoice ID validation on v1 route

`GET /v1/escrow/:invoiceId` input validation is now enforced before any escrow logic runs. `invoiceId` must:

- Be a non-empty string.
- Start with an alphanumeric character.
- Contain only alphanumeric characters, underscores, hyphens, dots, or colons.
- Be 1–128 characters long.

Invalid IDs now return `400 BAD_REQUEST` with an `INVALID_INVOICE_ID` error code. Previously, invalid IDs could reach the service layer and produce a less specific error.

---

## 2026-07-05 — Admin escrow-read config CRUD

New admin endpoints in `src/routes/adminEscrowRead.js` (all require admin auth):

- `GET /api/admin/escrow-read` — list configured overrides.
- `POST /api/admin/escrow-read` — create a new override config (`id`, optional `config.cacheTtl`, optional `secretKey`).
- `PUT /api/admin/escrow-read/:id` — update an existing config.
- `DELETE /api/admin/escrow-read/:id` — remove a config override.
- `GET /api/admin/escrow-read/audit?limit=N` — list audit log entries for config changes.

---

## 2026-07-01 — Contract schema-version endpoint

`PR_DESCRIPTION_598.md` (issue #598). New admin endpoint `GET /api/admin/escrow/version` that returns the on-chain `SCHEMA_VERSION` from the deployed LiquifactEscrow contract via Soroban RPC, enabling operators to detect version drift between the deployed wasm and the local registry.

---

## 2026-06-28 — Initial escrow-read API contract

- `GET /api/escrow/:invoiceId` (legacy, unauthenticated) — returns escrow state with basic fields (`invoiceId`, `status`, `fundedAmount`).
- `GET /v1/escrow/:invoiceId` (authenticated) — returns escrow state with the same base fields plus `escrowAddress` in the `X-Escrow-Address` response header.
- Address resolution via `resolveEscrowAddress` (`src/config/escrowMap.js` — `ESCROW_ADDR_BY_INVOICE` env var).
- Neutral RPC stub for on-chain reads (production placeholder returning `status: "not_found"`, `fundedAmount: 0`).
- `X-Escrow-Address` header set on all success responses.
- Starting point for this changelog's history.

---

Entries above are backfilled from PR description documents in `docs/PR_DESCRIPTION_*.md` and `git log` against `src/services/escrowRead*.js`, `src/services/escrowBatchRead.js`, `src/services/escrowDerived.js`, `src/config/escrowMap.js`, `src/routes/v1/index.js`, `src/routes/adminEscrow*.js`, `src/app.js`, `src/schemas/escrowRead.js`, `src/jobs/escrowIndexer.js`, and `src/jobs/escrowReadPurge.js`. Commit hashes are abbreviated; run `git log <hash>` in this repository for full detail.
