-- Migration: 20260725000000_add_soft_delete_to_escrow_event_projection.sql
-- Purpose: Soft-delete for escrow-read records (issue #31).
--
--          Deleting an `escrow_event_projection` row used to be a hard DELETE:
--          destructive, irreversible, and impossible to audit after the fact.
--          These columns turn the delete into a reversible tombstone:
--
--            deleted_at     — NULL means "live". Non-NULL marks the record as
--                             soft-deleted; default reads exclude it.
--            deleted_by     — actor (admin subject / API key id) who deleted it.
--            delete_reason  — free-text operator justification, for audit.
--            restored_at    — last successful restore, retained after the
--                             tombstone is cleared so the history is visible.
--            restored_by    — actor who restored the record.
--
--          Rows stay recoverable for the retention window
--          (`ESCROW_READ_SOFT_DELETE_RETENTION_DAYS`, default 30 days) and are
--          hard-deleted past it by the maintenance purge job
--          (`src/jobs/escrowReadPurge.js`).

ALTER TABLE escrow_event_projection
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

ALTER TABLE escrow_event_projection
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE escrow_event_projection
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

ALTER TABLE escrow_event_projection
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMP;

ALTER TABLE escrow_event_projection
  ADD COLUMN IF NOT EXISTS restored_by TEXT;

-- Partial index: the purge job only ever scans tombstoned rows ordered by
-- `deleted_at`, so live rows (the overwhelming majority) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_escrow_event_projection_deleted_at
  ON escrow_event_projection (deleted_at)
  WHERE deleted_at IS NOT NULL;
