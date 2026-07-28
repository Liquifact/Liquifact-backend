-- Migration: 20260801000000_add_soft_delete_columns_to_invoices.sql
-- Purpose: Soft-delete for invoice-state records (issue #866).
--
--          Deleting an `invoices` row was previously a tombstone of a single
--          `deleted_at` column with no actor / reason capture and no path to
--          recovery once the row was hidden from reads. These columns add the
--          audit / restore metadata that the new soft-delete, restore, and
--          retention-purge flows require, mirroring the surface that already
--          exists for `escrow_event_projection` (see
--          `migrations/20260725000000_add_soft_delete_to_escrow_event_projection.sql`):
--
--            deleted_by     — actor (admin subject / API key id) who deleted it.
--            delete_reason  — free-text operator justification, for audit.
--            restored_at    — last successful restore, retained after the
--                             tombstone is cleared so the history is visible.
--            restored_by    — actor who restored the record.
--
--          The existing `deleted_at` column (created in
--          `migrations/20240425000000_create_invoices_table.sql`) is left
--          untouched. Rows stay recoverable for the retention window
--          (`INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS`, default 30 days) and
--          are hard-deleted past it by the maintenance purge job
--          (`src/jobs/invoiceStatePurge.js`).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMP;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS restored_by TEXT;
