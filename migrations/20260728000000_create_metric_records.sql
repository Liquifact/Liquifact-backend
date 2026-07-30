-- Migration: 20260728000000_create_metric_records.sql
-- Purpose: Soft-delete for metric records (issue #31).
--
--          The `metric_records` table stores individual metric data points.
--          Previously, deleting a metric record was a hard DELETE — destructive,
--          irreversible, and impossible to audit. These columns turn the delete
--          into a reversible tombstone:
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
--          (`METRICS_SOFT_DELETE_RETENTION_DAYS`, default 30 days) and are
--          hard-deleted past it by the maintenance purge job
--          (`src/jobs/metricsPurge.js`).

CREATE TABLE IF NOT EXISTS metric_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name   TEXT NOT NULL,
  metric_type   TEXT NOT NULL DEFAULT 'gauge',
  metric_value  DOUBLE PRECISION NOT NULL,
  labels        JSONB NOT NULL DEFAULT '{}',
  recorded_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMP,
  deleted_by    TEXT,
  delete_reason TEXT,
  restored_at   TIMESTAMP,
  restored_by   TEXT
);

-- Partial index: the purge job only ever scans tombstoned rows ordered by
-- `deleted_at`, so live rows (the overwhelming majority) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_metric_records_deleted_at
  ON metric_records (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_metric_records_metric_name
  ON metric_records (metric_name);
