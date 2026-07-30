-- Migration: 20260802000000_create_runtime_config_table.sql
-- Purpose: Runtime configuration persistence with soft-delete support (issue #31).
--
--          Previously, runtime config writes validated the payload and applied
--          side effects (CORS reload) but never persisted the record. That made
--          every config change ephemeral: a process restart would reset all
--          sections.
--
--          This table stores every config write so it survives restarts, and
--          provides soft-delete columns so delete is reversible (tombstone
--          model) with a configurable retention window after which the
--          maintenance purge job hard-deletes expired rows.
--
-- Soft-delete columns (same model as escrow_event_projection):
--
--   deleted_at     — NULL means "live". Non-NULL marks soft-deleted.
--   deleted_by     — actor who deleted the record.
--   delete_reason  — free-text operator justification.
--   restored_at    — last successful restore timestamp.
--   restored_by    — actor who restored the record.

CREATE TABLE IF NOT EXISTS runtime_config (
  id            TEXT        NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  section       TEXT        NOT NULL,
  config        TEXT        NOT NULL DEFAULT '{}',
  tenant_id     TEXT        NOT NULL DEFAULT '',
  created_at    TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Soft-delete columns
  deleted_at    TEXT,
  deleted_by    TEXT,
  delete_reason TEXT,
  restored_at   TEXT,
  restored_by   TEXT
);

-- Index for listing configs by section and tenant (the common read path).
CREATE INDEX IF NOT EXISTS idx_runtime_config_section_tenant
  ON runtime_config (section, tenant_id);

-- Partial index: the purge job only scans tombstoned rows ordered by
-- deleted_at, so live rows (the overwhelming majority) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_runtime_config_deleted_at
  ON runtime_config (deleted_at)
  WHERE deleted_at IS NOT NULL;