-- Create table to persist exhausted webhook deliveries (dead-letter queue)
CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(255) NOT NULL,
  invoice_id VARCHAR(255) NOT NULL,
  event VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_tenant_created_at
  ON webhook_dead_letters (tenant_id, created_at DESC);
