# Escrow-Read Data Retention

> **Source of truth:** `src/services/escrowReadSoftDelete.js`, `src/services/escrowRead.js`, `src/jobs/escrowReadPurge.js`, `src/jobs/escrowIndexer.js`
>
> **Related:** [Escrow-Read API Reference](escrow-read.md) · [Escrow-Read Changelog](changelog-escrow-read.md) · [Runbook: Escrow-Read](runbook-escrow-read.md) · [Data Retention System](retention.md)

## What Escrow-Read Stores

"Escrow-read records" are rows in two durable Postgres tables written by the
indexer (`src/jobs/escrowIndexer.js`) and served by the read service
(`src/services/escrowRead.js`):

### 1. `escrow_event_projection` — the escrow-read record

One row **per invoice** holding the *latest* observed escrow event (migration
`20260427123000_create_escrow_event_index_tables.sql`). This is the record the
soft-delete / restore / purge lifecycle applies to.

| Column | Type | PII | Notes |
|--------|------|-----|-------|
| `invoice_id` | TEXT | | Primary key |
| `latest_event_id` | TEXT | | Latest event reference |
| `latest_event_type` | TEXT | | e.g. `contract_event` |
| `latest_ledger_sequence` | BIGINT | | |
| `latest_paging_token` | TEXT | | |
| `latest_event_body` | TEXT | | JSON: on-chain event payload (status, fundedAmount, etc.) |
| `latest_observed_at` | TIMESTAMP | | |
| `updated_at` | TIMESTAMP | | |
| `deleted_at` | TIMESTAMP | | Soft-delete tombstone (NULL = live) |
| `deleted_by` | TEXT | | Actor (admin subject / API key id) |
| `delete_reason` | TEXT | Potentially | Free-text operator justification, max 500 chars |
| `restored_at` | TIMESTAMP | | Last successful restore (kept for history) |
| `restored_by` | TEXT | | Restore actor |

### 2. `escrow_events` — append-only event log

Every escrow event the indexer observes, keyed by `event_id` (migration
`20260427123000_create_escrow_event_index_tables.sql`). Columns: `event_id`,
`invoice_id`, `event_type`, `ledger_sequence`, `paging_token`, `contract_id`,
`tx_hash`, `event_body`, `observed_at`, `created_at`. Events are **upserted
idempotently** (`ON CONFLICT DO NOTHING`) and are **never soft-deleted or
purged** — the retention lifecycle below applies only to
`escrow_event_projection`.

### 3. `escrow_indexer_state` — indexer cursor

Single-row key/value store tracking the Horizon paging cursor
(`key = 'horizon_cursor'`). Never purged; holds no business data.

### 4. Caches — ephemeral

| Cache | Storage | TTL | Max entries |
|-------|---------|-----|-------------|
| Process-local `escrowReadCache` | In-memory LRU (`src/services/escrowReadCache.js`) | `ESCROW_CACHE_TTL_SECONDS` (default 30 s) | `ESCROW_CACHE_MAX_ENTRIES` (default 500) |
| Redis summary cache | Redis (`src/cache/redis.js`, `REDIS_ESCROW_CACHE_ENABLED=true`) | `REDIS_ESCROW_CACHE_TTL_SECONDS` (default 30 s, clamped 5–300) | — |

Caches hold escrow-state snapshots only, are TTL-bounded, and contain no
customer PII. They are invalidated on every soft-delete, restore, and purge
(see [Cache Coherence](#cache-coherence)).

## Retention Windows

### Soft-Delete Retention (Tombstone Lifecycle)

Escrow-read records pass through three phases:

1. **Live** — `deleted_at IS NULL`. Served by every default read path.
2. **Tombstoned** — `deleted_at` set. Excluded from all default reads, which
   return the neutral `not_found` / `fundedAmount: 0` state. Restorable.
3. **Purged** — row physically removed once `deleted_at + window < now`.

The retention window is controlled by `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS`:

| Property | Value |
|----------|-------|
| Default | 30 days |
| Minimum | 1 day |
| Maximum | 3650 days (~10 years) |
| Env var | `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` |

The window is evaluated against `deleted_at`, **not** against purge-job timing:
restore is refused with `410 Gone` once the window has elapsed even if the
purge job has not yet run, so "restorable" never depends on job scheduling.

Re-deleting an already-tombstoned record throws `409 Conflict` rather than
refreshing `deleted_at` — refreshing would extend the window on every retry and
let a record evade purge indefinitely.

## Purge Behavior

Run by `src/jobs/escrowReadPurge.js` → `purgeExpiredSoftDeletes()` in
`src/services/escrowReadSoftDelete.js`:

| Property | Default | Env Var |
|----------|---------|---------|
| Interval | 6 hours | `ESCROW_READ_PURGE_INTERVAL_MS` (min 1 min) |
| Batch size | 500 rows | `ESCROW_READ_PURGE_BATCH_SIZE` (max 10000) |
| Max batches per run | 100 | `ESCROW_READ_PURGE_MAX_BATCHES` (max 1000) |
| Max rows per run | 50,000 | batchSize × maxBatches |

How it works:

- Selects only rows with `deleted_at <= now - retention` (tombstoned only; live
  rows can never be purged and freshly deleted rows always keep their full
  window).
- Deletes in batches of `batchSize`, ordered by `deleted_at` ascending, capped
  at `maxBatches` per run; a remaining backlog is reported via
  `maxBatchesReached` and picked up on the next run.
- Work is serialised (`maxConcurrency: 1`) to avoid contending on the same rows.
- Emits Prometheus counters: `liquifact_escrow_read_purge_rows_deleted_total`,
  `liquifact_escrow_read_purge_runs_total{status}`.
- Purged invoices are removed from the read caches.

### Triggers

| Trigger | Mechanism | Notes |
|---------|-----------|-------|
| **Scheduled** | `startPurgeWorker()` in `src/jobs/escrowReadPurge.js` | Recurring 6 h (default) timer. **Not wired at boot** in `src/index.js` — the boot path currently starts the idempotency and invoice-state purge workers only. Operators must call `startPurgeWorker()` (or invoke it via an external scheduler) to enable the scheduled cadence. |
| **On demand** | `POST /api/admin/escrow/reads/purge` | Runs `purgeExpiredSoftDeletes()` synchronously. Returns `{ purged, batches, cutoff, retentionDays, maxBatchesReached }`. |

### Related admin surface

- `DELETE /api/admin/escrow/reads/:invoiceId` — soft-delete a record (records
  `deleted_by` / `delete_reason`, bounded to 500 chars).
- `POST /api/admin/escrow/reads/:invoiceId/restore` — restore within the window;
  `410 Gone` once the window elapses.
- `GET /api/admin/escrow/reads/:invoiceId/deletion-state` — inspect tombstone
  state including `purgeAfter` and `restorable`.

## PII Handling

- **No customer PII is stored by escrow-read.** The projection and event log
  store on-chain escrow event data (contract events, tx hashes, ledger
  sequences, funded amounts) keyed by `invoice_id` — not customer names,
  emails, tax IDs, or other personal data. There is no PII-purge step for
  escrow-read, because there is no PII to purge.
- `delete_reason` is free-text operator input (capped at 500 characters) and
  *may* contain sensitive notes. It is written to the projection and is
  hard-deleted with the row at purge time. It is exposed only to **admins**
  (as `deleteReason` in the soft-delete and deletion-state responses); public
  escrow-read endpoints never surface it.
- `deleted_by` / `restored_by` record admin actors (JWT subject or API-key
  client id) for auditability.
- Caches hold state snapshots only and are TTL-bounded; no PII is cached.
- Logs emitted by soft-delete, restore, and purge include invoice IDs and
  counts and never include event bodies. The service-level soft-delete log in
  `src/services/escrowReadSoftDelete.js` does include the delete `reason`;
  restore and purge logs do not.

## Audit Trail

- Every soft-delete / restore is recorded in the projection columns
  (`deleted_by`, `delete_reason`, `restored_at`, `restored_by`) and logged via
  the application logger (`escrowReadSoftDelete: ...`, `Admin soft-deleted
  escrow-read record`, `Admin restored escrow-read record`).
- Purge runs log the purge summary (purged count, batches, cutoff) at
  info level when rows were removed, and expose the same summary through the
  admin purge endpoint and Prometheus counters.
- Note: unlike the general retention system, soft-delete events are **not**
  written to `retention_audit_log` / `audit_log_events` — the audit trail for
  escrow-read lives in the projection columns and structured logs.

## Cache Coherence

Every mutation that changes visible state — soft-delete, restore, and purge —
invalidates both the process-local `escrowReadCache` and the Redis summary
cache for the affected invoice via `invalidateEscrowReadCache()`. Without this,
a cached summary would keep serving a record that was just tombstoned (or keep
hiding one that was just restored).

## Configuration Summary

| Variable / Config Field | Default | Affects |
|-------------------------|---------|---------|
| `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` | 30 (clamped 1–3650) | Restore/retention window |
| `ESCROW_READ_PURGE_INTERVAL_MS` | 21600000 (6 h) | Purge cadence (min 60000) |
| `ESCROW_READ_PURGE_BATCH_SIZE` | 500 (max 10000) | Rows per purge batch |
| `ESCROW_READ_PURGE_MAX_BATCHES` | 100 (max 1000) | Batch cap per run |
| `ESCROW_CACHE_TTL_SECONDS` | 30 | In-memory escrow cache TTL |
| `ESCROW_CACHE_MAX_ENTRIES` | 500 | In-memory escrow cache max entries |
| `REDIS_ESCROW_CACHE_ENABLED` | false | Enable Redis summary cache |
| `REDIS_ESCROW_CACHE_TTL_SECONDS` | 30 (clamped 5–300) | Redis cache TTL |

## Related Documentation

- [Escrow-Read API Reference](escrow-read.md)
- [Escrow-Read Changelog](changelog-escrow-read.md)
- [Runbook: Escrow-Read](runbook-escrow-read.md)
- [Data Retention System](retention.md)
- [Invoice-State Data Retention](invoice-state-retention.md)
- [Metrics Data Retention](metrics-retention.md)
