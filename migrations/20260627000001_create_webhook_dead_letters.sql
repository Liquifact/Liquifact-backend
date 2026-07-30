-- Migration: create webhook_dead_letters table
-- Stores webhook deliveries that have exhausted all retry attempts.
-- Rows may be replayed by operators and are marked resolved on success.

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  invoice_id    TEXT        NOT NULL,
  event         TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  webhook_url   TEXT        NOT NULL,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  last_error    TEXT,
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wdl_tenant_resolved
  ON webhook_dead_letters (tenant_id, resolved);

CREATE INDEX IF NOT EXISTS idx_wdl_created_at
  ON webhook_dead_letters (created_at);

COMMIT;
