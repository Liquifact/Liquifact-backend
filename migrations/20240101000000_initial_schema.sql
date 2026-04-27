-- Initial schema migration for LiquiFact backend
-- Creates core tables for invoice management

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC(18, 7) NOT NULL,
  buyer VARCHAR(255),
  seller VARCHAR(255),
  currency CHAR(3),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tenant_id UUID;
