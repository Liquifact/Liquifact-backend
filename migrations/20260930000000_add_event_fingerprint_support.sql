-- Migration: Add fingerprint support for enhanced event deduplication
-- Purpose: Enable detection of duplicate events even with different event IDs
--          This provides additional protection against data corruption from
--          malicious or corrupted event streams.

-- Add fingerprint column to escrow_events for enhanced duplicate detection
ALTER TABLE escrow_events 
  ADD COLUMN IF NOT EXISTS event_fingerprint TEXT;

-- Create index on fingerprint for efficient duplicate detection
CREATE INDEX IF NOT EXISTS idx_escrow_events_fingerprint 
  ON escrow_events(event_fingerprint) 
  WHERE event_fingerprint IS NOT NULL;

-- Add composite index for invoice_id + ledger_sequence for ordering validation
CREATE INDEX IF NOT EXISTS idx_escrow_events_invoice_ledger_ordering
  ON escrow_events(invoice_id, ledger_sequence, paging_token);

-- Add constraint to prevent duplicate fingerprints (when populated)
-- Note: This is commented out initially to allow gradual rollout
-- ALTER TABLE escrow_events 
--   ADD CONSTRAINT uq_escrow_events_fingerprint 
--   UNIQUE (event_fingerprint) 
--   DEFERRABLE INITIALLY DEFERRED;

-- Update existing events to have fingerprints (optional - can be done in batches)
-- Note: This would need to be implemented as a data migration script
-- UPDATE escrow_events SET event_fingerprint = ... WHERE event_fingerprint IS NULL;