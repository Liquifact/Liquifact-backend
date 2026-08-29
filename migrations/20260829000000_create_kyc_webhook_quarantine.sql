-- Migration: create kyc_webhook_quarantine table
-- Persists malformed, invalid, or oversized inbound KYC webhook payloads
-- with operator inspection trail, redacted sensitive fields, and tenant isolation.

BEGIN;

CREATE TABLE IF NOT EXISTS kyc_webhook_quarantine (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL DEFAULT 'unknown',
  sme_id        TEXT,
  event         TEXT        NOT NULL DEFAULT 'unknown',
  payload       JSONB       NOT NULL,
  raw_payload   TEXT,
  reason        TEXT        NOT NULL,
  error_code    TEXT        NOT NULL,
  error_details JSONB,
  actor         TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_quarantine_tenant_created_at
  ON kyc_webhook_quarantine (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_quarantine_sme_id
  ON kyc_webhook_quarantine (sme_id);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_quarantine_event
  ON kyc_webhook_quarantine (event);

COMMIT;
