-- Persist maturity-reminder deliveries that exhausted SMTP retries.
-- payload_metadata is intentionally restricted to non-PII operational fields.
BEGIN;

CREATE TABLE IF NOT EXISTS maturity_reminder_dead_letters (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           TEXT        NOT NULL UNIQUE,
  invoice_id       TEXT        NOT NULL,
  reason           TEXT        NOT NULL,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  payload_metadata JSONB       NOT NULL DEFAULT '{}'::JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mrdl_created_at
  ON maturity_reminder_dead_letters (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mrdl_reason_created_at
  ON maturity_reminder_dead_letters (reason, created_at DESC);

COMMIT;
