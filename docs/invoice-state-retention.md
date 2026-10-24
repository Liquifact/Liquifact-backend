# Invoice-State Data Retention

> **Source of truth:** `src/services/invoiceStateSoftDelete.js`, `src/jobs/invoiceStatePurge.js`, `src/jobs/retentionPurge.js`

## What Invoice-State Stores

An "invoice-state record" is a row in the tenant-scoped `invoices` table. The table stores invoice lifecycle data including:

| Column | Type | PII | Notes |
|--------|------|-----|-------|
| `id` | UUID | | Primary key |
| `invoice_number` | VARCHAR(50) | | Unique per tenant |
| `amount` | DECIMAL(15,2) | | |
| `currency` | VARCHAR(3) | | |
| `customer_name` | VARCHAR(255) | **Yes** | |
| `customer_email` | VARCHAR(255) | **Yes** | |
| `customer_tax_id` | VARCHAR(50) | **Yes** | |
| `due_date` | DATE | | |
| `issue_date` | DATE | | |
| `status` | VARCHAR(50) | | State machine value |
| `sme_id` | UUID | | Seller reference |
| `buyer_id` | UUID | | Buyer reference |
| `description` | TEXT | Potentially | Free text, may contain PII |
| `metadata` | JSONB | Potentially | Free-form, may contain PII |
| `tenant_id` | UUID | | Multi-tenant isolation |
| `created_at` | TIMESTAMPTZ | | |
| `updated_at` | TIMESTAMPTZ | | |
| `deleted_at` | TIMESTAMPTZ | | Soft-delete tombstone |
| `deleted_by` | TEXT | | Soft-delete actor |
| `delete_reason` | TEXT | | Soft-delete justification |
| `restored_at` | TIMESTAMP | | Restore timestamp |
| `restored_by` | TEXT | | Restore actor |
| `version` | INTEGER | | Optimistic locking |

**PII fields:** `customer_name`, `customer_email`, `customer_tax_id` are explicitly tracked as PII. The `description` and `metadata` columns may also contain PII but are not automatically purged.

## Retention Windows

### Soft-Delete Retention (Tombstone Lifecycle)

Invoice records pass through three phases:

1. **Live** — `deleted_at IS NULL`. Served by every default read path.
2. **Tombstoned** — `deleted_at` set. Excluded from normal reads; restorable.
3. **Purged** — Row physically removed after the retention window expires.

The retention window is controlled by `INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS`:

| Property | Value |
|----------|-------|
| Default | 30 days |
| Minimum | 1 day |
| Maximum | 3650 days (~10 years) |
| Env var | `INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS` |

The window is evaluated against `deleted_at`, not against purge job timing. Restore is refused once the window has elapsed even if the purge job has not yet run.

### PII Retention

PII fields (`customer_name`, `customer_email`, `customer_tax_id`) are subject to a separate retention policy system:

| Property | Value |
|----------|-------|
| Default | 7 years (2555 days) |
| Mechanism | Per-tenant `retention_policies` table |
| Env var (batch) | `RETENTION_BATCH_SIZE` (default 100) |

PII is set to `NULL` (not hard-deleted) after the retention window. Invoices under active legal hold are exempted.

## Purge Behavior

### Soft-Delete Purge

Run by `src/jobs/invoiceStatePurge.js`:

| Property | Default | Env Var |
|----------|---------|---------|
| Interval | 6 hours | `INVOICE_STATE_PURGE_INTERVAL_MS` |
| Batch size | 500 rows | `INVOICE_STATE_PURGE_BATCH_SIZE` |
| Max batches per run | 100 | `INVOICE_STATE_PURGE_MAX_BATCHES` |
| Max rows per run | 50,000 | batchSize × maxBatches |

- Runs automatically at startup via `startPurgeWorker()` in `src/index.js`.
- Uses the shared `JobQueue` / `BackgroundWorker` infrastructure with `maxConcurrency: 1`.
- Emits Prometheus counters: `liquifact_invoice_state_purge_rows_deleted_total`, `liquifact_invoice_state_purge_runs_total`.
- Can be triggered manually via `POST /api/admin/invoices/purge`.
- Cache coherence: invalidates the `marketplace:` cache prefix after each purge.

### PII Retention Purge

Run by `src/jobs/retentionPurge.js`:

| Property | Default |
|----------|---------|
| Batch size | 100 invoices |
| Concurrency | 1 (serialised) |
| Auto-start | **No** — must be invoked manually or scheduled externally |

- The API route returns **501 Not Implemented**; there is no recurring cron trigger wired at boot.
- Respects legal holds: invoices under active hold are excluded.
- Captures salted SHA-256 hashes of before-state in `retention_audit_log` for forensic audit without storing clear-text PII.

## Audit Trail

### Soft-Delete Events

Every soft-delete, restore, and purge operation is logged via the application logger and recorded in the `invoices` table columns (`deleted_by`, `delete_reason`, `restored_at`, `restored_by`).

### PII Retention Events

Tracked in the `retention_audit_log` table:

| Column | Description |
|--------|-------------|
| `tenant_id` | Tenant scope |
| `invoice_id` | Affected invoice |
| `operation` | `pii_purged` or `dry_run` |
| `pii_fields` | Fields purged |
| `old_values` | Salted SHA-256 hashes of prior values (never clear-text) |
| `performed_by` | Actor who initiated the operation |

## Cache Coherence

Every mutation that affects the visible state of invoice records (soft-delete, restore, purge) invalidates the `marketplace:` cache prefix through the shared metrics cache store. This prevents stale listings from surfacing tombstoned or missing records.

## Related Documentation

- [Invoice-State API Reference](invoice-state.md)
- [Data Retention System](retention.md)
- [Metrics Retention](metrics-retention.md)
- [Runbook: Invoice-State](runbook-invoice-state.md)
