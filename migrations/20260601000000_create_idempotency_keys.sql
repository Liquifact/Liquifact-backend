-- Create idempotency_keys table for safe retry of funding operations
-- Migration: 20260601000000_create_idempotency_keys.sql

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key VARCHAR(128) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Index for fast key lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_key
    ON idempotency_keys (idempotency_key);

-- Index for cleanup of expired keys
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
    ON idempotency_keys (expires_at);

-- Auto-update updated_at on row change
CREATE TRIGGER update_idempotency_keys_updated_at
    BEFORE UPDATE ON idempotency_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE idempotency_keys IS
    'Stores idempotency key → response mappings for funding submissions. Keys expire after TTL.';
COMMENT ON COLUMN idempotency_keys.request_fingerprint IS
    'SHA-256 hash of the request body for conflict detection';
