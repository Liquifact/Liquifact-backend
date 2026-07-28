-- Create table to persist exhausted KYC webhook deliveries (dead-letter queue).
-- KYC events are scoped to an SME (not an invoice), so this table uses sme_id
-- rather than invoice_id as the primary correlation identifier.
CREATE TABLE IF NOT EXISTS kyc_webhook_dead_letters (
  id           BIGSERIAL    PRIMARY KEY,
  tenant_id    VARCHAR(255) NOT NULL,
  sme_id       VARCHAR(255) NOT NULL,
  event        VARCHAR(128) NOT NULL,
  payload      JSONB        NOT NULL,
  last_error   TEXT,
  attempts     INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_dead_letters_tenant_created_at
  ON kyc_webhook_dead_letters (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_dead_letters_sme_id
  ON kyc_webhook_dead_letters (sme_id);
