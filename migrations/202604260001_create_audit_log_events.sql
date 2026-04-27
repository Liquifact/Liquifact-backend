-- Append-only audit ledger for admin actions and webhook deliveries.
CREATE TABLE IF NOT EXISTS audit_log_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL CHECK (event_type IN ('admin_action', 'webhook_delivery')),
  action VARCHAR(128) NOT NULL,
  actor_type VARCHAR(64) NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  target_type VARCHAR(128),
  target_id VARCHAR(255),
  request_id VARCHAR(128),
  route TEXT,
  method VARCHAR(16),
  status_code INTEGER,
  ip_address VARCHAR(64),
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_events_event_type_created_at
  ON audit_log_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_events_actor
  ON audit_log_events (actor_type, actor_id, created_at DESC);
