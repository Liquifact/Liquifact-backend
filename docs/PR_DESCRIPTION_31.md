# feat(escrow-read): add soft-delete and restore

> **Issue:** #31 — Soft-delete for escrow-read
> **Branch:** `feature/escrow-read-31-softdelete`
> **Scope:** `Liquifact/Liquifact-backend`

---

## Why

Deleting an escrow-read record (an `escrow_event_projection` row) was a hard `DELETE`: destructive, irreversible, and unauditable. The projection is the only off-chain copy of the latest observed escrow event, so an operator mistake meant waiting for a full re-index to recover the invoice's state.

Deletes now write a tombstone. The record disappears from every read, stays recoverable for a retention window, and is hard-deleted only by a maintenance task once that window has elapsed.

## What changed

### Schema — `migrations/20260725000000_add_soft_delete_to_escrow_event_projection.sql`

Adds `deleted_at`, `deleted_by`, `delete_reason`, `restored_at`, `restored_by` to `escrow_event_projection`, plus a **partial** index on `deleted_at WHERE deleted_at IS NOT NULL` — the purge job scans only tombstones, so live rows (the overwhelming majority) stay out of the index.

### Service — `src/services/escrowReadSoftDelete.js` (new)

| Function | Behaviour |
|---|---|
| `softDeleteEscrowRead` | Stamps the tombstone with actor + reason. `404` unknown record, `409` already deleted |
| `restoreEscrowRead` | Clears the tombstone. `409` not deleted, `410` window expired, `404` purged |
| `getEscrowReadDeletionState` | The only read that surfaces tombstoned records (for operators) |
| `purgeExpiredSoftDeletes` | Batch-bounded hard delete of records past the window |

Design decisions worth a reviewer's attention:

- **Restorability depends on the window, not the job.** A record whose window has elapsed is refused with `410` even while its row is still physically present, so the API contract never drifts with purge-job scheduling.
- **Re-deleting is refused, not re-applied.** Refreshing `deleted_at` on a retried delete would extend the window every time and let a record evade purge indefinitely.
- **Both mutations are guarded updates** (`whereNull('deleted_at')` / `whereNotNull('deleted_at')`), so a lost write race reports the conflict instead of double-applying.
- **Caches are invalidated on delete, restore, and purge.** Without that, a cached summary would keep serving a record that was just hidden.
- **An unparseable `deleted_at` counts as expired**, never as an unbounded restore window.

### Read exclusion — `src/services/escrowRead.js`

`_readBaseStateFromProjection` treats a tombstoned row as absent, so `readEscrowState`, `readEscrowStateWithAttestations`, `readFundedAmount`, and `getEscrowStateWithProjection` all fall through to the neutral `not_found` state. An `includeDeleted` option exists for the paths that legitimately need the tombstone.

### Admin API — `src/routes/adminEscrow.js`

All admin-authenticated (JWT or API key) via the existing `adminStack`, with service errors mapped onto RFC 7807 problems.

| Route | Purpose |
|---|---|
| `DELETE /api/admin/escrow/reads/:invoiceId` | Soft-delete; optional `{ "reason": "…" }` (≤ 500 chars) recorded for audit |
| `POST /api/admin/escrow/reads/:invoiceId/restore` | Restore within the window |
| `GET /api/admin/escrow/reads/:invoiceId/deletion-state` | Inspect the tombstone |
| `POST /api/admin/escrow/reads/purge` | Run the retention purge on demand |

### Maintenance task — `src/jobs/escrowReadPurge.js` (new)

Runs the purge on a schedule (default every 6 h) through the shared job queue, with `liquifact_escrow_read_purge_rows_deleted_total` and `liquifact_escrow_read_purge_runs_total{status}` counters and a manual trigger.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` | `30` (clamped 1–3650) | Restore window |
| `ESCROW_READ_PURGE_BATCH_SIZE` | `500` | Rows per purge batch |
| `ESCROW_READ_PURGE_MAX_BATCHES` | `100` | Batch cap per run |
| `ESCROW_READ_PURGE_INTERVAL_MS` | `21600000` (6 h) | Purge cadence |

Invalid values fall back to the default rather than throwing — a typo must not silently shorten the window or block startup. Documented in `docs/configuration.md`, `.env.example`, and `docs/escrow-read.md`.

---

## Included fix: `src/metrics.js` (separate commit)

`src/metrics.js` on `main` exported `recordMetricsEndpointOutcome`, `metricsRequestsTotal`, `metricsRequestErrorsTotal`, and the entire persistence-metrics block **without ever defining them**, so `require('../metrics')` threw a `ReferenceError`. Since `src/services/cacheStore.js` requires it, this broke every escrow-read code path and **113 of 178 test suites failed to load on `main`**. `classifyApiKeyOutcome` / `classifyApiKeyErrorCause` were defined but never exported, leaving `apiKeyAuth` with undefined callbacks.

Commit `08f0748` restores the definitions (bounded label values only) and exports the API-key helpers, matching the contracts already asserted by `tests/metrics.test.js` and `tests/persistenceMetrics.test.js`. It is out of the issue's scope but the soft-delete work is untestable without it, so it is isolated in its own commit for easy review or extraction.

---

## Test output

New suites — `tests/escrow.softDelete.test.js` (59 tests) and `tests/adminEscrow.softDelete.route.test.js` (19 tests):

```
$ npx jest tests/escrow.softDelete.test.js tests/adminEscrow.softDelete.route.test.js \
    --runInBand --forceExit --coverage \
    --collectCoverageFrom='src/services/escrowReadSoftDelete.js' \
    --collectCoverageFrom='src/jobs/escrowReadPurge.js'

--------------------------|---------|----------|---------|---------|-------------------
File                      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
--------------------------|---------|----------|---------|---------|-------------------
All files                 |   99.42 |    94.87 |     100 |   99.42 |
 jobs                     |   97.87 |    78.57 |     100 |   97.82 |
  escrowReadPurge.js      |   97.87 |    78.57 |     100 |   97.82 | 56
 services                 |     100 |    97.08 |     100 |     100 |
  escrowReadSoftDelete.js |     100 |    97.08 |     100 |     100 | 216-217,510
--------------------------|---------|----------|---------|---------|-------------------

Test Suites: 2 passed, 2 total
Tests:       78 passed, 78 total
Snapshots:   0 total
Time:        4.949 s
```

Coverage thresholds for both new modules are enforced in `package.json` (95% statements/lines/functions).

### Edge cases covered

- **delete hides** — soft-deleted record returns the neutral `not_found` state from `readEscrowState`, `readEscrowStateWithAttestations`, and `readFundedAmount`; caches invalidated
- **restore within window** — tombstone cleared, record served again, including the final millisecond of the window
- **expiry purges** — `410` on restore after the window, purge removes the row, restore then `404`s; live and still-in-window records untouched
- batching: multi-batch drain, short final batch, `maxBatches` cap with `maxBatchesReached`
- conflicts: re-delete, restore of a live record, and lost-update races on both mutations
- config parsing: defaults, valid overrides, fractional/negative/non-numeric input, clamping
- timestamp coercion: ISO strings, `Date` (Postgres driver shape), epoch ms, unparseable values
- routes: auth required, `reason` type/length validation, actor attribution, full error→status mapping, purge response shape

### Repository-wide suite

`npm test` on this branch: **97 suites passed, 82 failed** (3456 passed / 373 failed tests).
`npm test` on the same tree **without** these changes: **64 suites passed, 113 failed** (1994 passed / 248 failed).

A per-suite diff shows **zero regressions**: every suite failing on this branch was already failing on `main`, and 31 suites that previously could not even load now run. The single suite that differed (`tests/shutdown.test.js`) fails identically on `main` when run in isolation — it is order-dependent, not caused by this change.

The remaining failures are pre-existing breakage of the same kind as the metrics bug — modules that define functions without exporting them (`setSharedWorker`, `validateOriginEntry`, `validateFundingRequest`, `getNetworkPassphrase`, …) — plus a merge-conflict marker left in `tests/idempotency.test.js`. They are unrelated to this issue and out of scope here.

### Lint and build

```
$ npx eslint src/services/escrowReadSoftDelete.js src/jobs/escrowReadPurge.js \
    src/routes/adminEscrow.js src/services/escrowRead.js src/metrics.js \
    tests/escrow.softDelete.test.js tests/adminEscrow.softDelete.route.test.js
(no output — clean)
```

`npm run lint` across the whole repo reports 58 pre-existing errors in untouched files (unused vars, missing JSDoc, and the conflict marker in `tests/idempotency.test.js`); none are in files this PR touches.

`npm run build` fails identically before and after this branch with `tsconfig.build.json(3,3): error TS5103: Invalid value for '--ignoreDeprecations'` — a pre-existing `tsconfig` problem, not introduced here.

---

## Migration and rollout

1. Apply `npm run db:migrate` — the migration is additive (`ADD COLUMN IF NOT EXISTS`) and safe to run against a live table.
2. No behaviour changes for existing reads: every row starts with `deleted_at IS NULL`.
3. Optionally set `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS`; start the purge worker via `startPurgeWorker()` where the other maintenance workers are started.

Rollback: revert the code; the added columns are nullable and inert.
