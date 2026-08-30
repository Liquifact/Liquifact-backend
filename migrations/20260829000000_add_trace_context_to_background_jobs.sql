-- Migration: 20260829000000_add_trace_context_to_background_jobs.sql
-- Purpose: Add trace_context column to support request correlation through queued jobs.
--          Stores validated trace context (requestId, correlationId, tenantId, userId)
--          serialized as JSON. Enables linking async job execution to the original request.

ALTER TABLE background_jobs 
ADD COLUMN IF NOT EXISTS trace_context JSONB;

COMMENT ON COLUMN background_jobs.trace_context IS
  'Validated trace context (requestId, correlationId, tenantId, userId) serialized as JSON. Restored during job processing for log correlation.';
