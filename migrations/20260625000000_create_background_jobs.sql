-- Migration: 20260625000000_create_background_jobs.sql
-- Purpose: Persistent backing store for the in-memory job queue.
--          Enabled only when JOB_QUEUE_PERSISTENCE_ENABLED=true.
--          Jobs in PENDING or PROCESSING state that survive a crash are
--          requeued on the next startup (at-least-once delivery).

CREATE TABLE IF NOT EXISTS background_jobs (
  id            VARCHAR(32)  PRIMARY KEY,            -- crypto-random "job-<hex16>" id
  type          VARCHAR(128) NOT NULL,
  payload       JSONB        NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed','retrying')),
  priority      INTEGER      NOT NULL DEFAULT 0,
  delay_ms      BIGINT       NOT NULL DEFAULT 0,     -- absolute epoch-ms for delayed/retry jobs
  created_at    BIGINT       NOT NULL,               -- epoch-ms
  started_at    BIGINT,
  completed_at  BIGINT,
  attempts      INTEGER      NOT NULL DEFAULT 0,
  last_error    TEXT,
  acked_at      BIGINT                               -- set when ack() is called; prevents replay
);

-- Fast lookup for recovery: only rows that need requeuing
CREATE INDEX IF NOT EXISTS idx_background_jobs_recovery
  ON background_jobs (status)
  WHERE status IN ('pending', 'processing', 'retrying');

-- Cleanup index: remove completed/failed rows older than a retention window
CREATE INDEX IF NOT EXISTS idx_background_jobs_completed_at
  ON background_jobs (completed_at)
  WHERE completed_at IS NOT NULL;

COMMENT ON TABLE background_jobs IS
  'Durable backing for the in-memory JobQueue. Enabled via JOB_QUEUE_PERSISTENCE_ENABLED=true.';
COMMENT ON COLUMN background_jobs.delay_ms IS
  'Absolute epoch-ms timestamp after which the job may be dequeued (0 = immediate).';
COMMENT ON COLUMN background_jobs.acked_at IS
  'Non-null once ack() has been called. Used to prevent replay on crash recovery.';
