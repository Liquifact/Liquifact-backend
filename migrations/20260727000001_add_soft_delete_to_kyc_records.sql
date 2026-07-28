-- Add soft-delete columns to kyc_records so webhook records can be marked
-- deleted (not purged) and excluded from default reads, with a retention
-- window that allows administrative restore.
--
-- See kycWebhookSoftDelete.js for the service layer.
ALTER TABLE kyc_records
  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMP,
  ADD COLUMN IF NOT EXISTS deleted_by   TEXT,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT,
  ADD COLUMN IF NOT EXISTS restored_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS restored_by  TEXT;

CREATE INDEX IF NOT EXISTS idx_kyc_records_deleted_at
  ON kyc_records (deleted_at)
  WHERE deleted_at IS NOT NULL;