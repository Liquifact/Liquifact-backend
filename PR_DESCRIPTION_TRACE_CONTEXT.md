# Propagate Trace Context Through Queued Jobs

## Summary

This PR implements trace context propagation through the background job queue system, enabling request correlation across asynchronous boundaries. When a job is enqueued from within a request, the trace context (requestId, correlationId, tenantId, userId) is captured, serialized with the job, and restored during job processing. This ensures logs and metrics from background jobs can be correlated with the originating HTTP request.

## Approach

### 1. Context Capture at Enqueue Time
- Modified `JobQueue.enqueue()` to extract trace context from `AsyncLocalStorage` using `getContext()`
- Added `extractTraceContext()` helper that filters to only `ALLOWED_KEYS` (requestId, correlationId, tenantId, userId)
- Added `validateTraceContext()` helper that validates:
  - Only allowed keys are present
  - Values are non-empty strings
  - Serialized size ≤ 1 KB (MAX_TRACE_CONTEXT_BYTES)
- Invalid or oversized context results in a warning log; job enqueues without trace context

### 2. Job Storage
- Added `traceContext` field to job objects in `JobQueue.enqueue()`
- Updated `jobPersistence.toRow()` to serialize `traceContext` as JSON
- Created database migration `20260829000000_add_trace_context_to_background_jobs.sql` to add `trace_context` JSONB column

### 3. Context Restoration During Processing
- Modified `BackgroundWorker._processJob()` to wrap handler execution in `runWithContext(job.traceContext)`
- Context is restored only for the job's lifetime via AsyncLocalStorage
- Jobs without traceContext execute with empty context (graceful degradation)

### 4. Persistence Layer Updates
- Updated `DurableJobQueue.enqueue()` to persist `trace_context` column
- Updated `DurableJobQueue._rowToJob()` to parse and validate restored trace context
- Updated `jobPersistence.recoverUnackedJobs()` to restore trace context during crash recovery
- All restoration points validate against `ALLOWED_KEYS` to prevent injection

### 5. Security Measures
- **Allowlist enforcement**: Only `ALLOWED_KEYS` (requestId, correlationId, tenantId, userId) are accepted
- **Type validation**: Values must be non-empty strings; other types are filtered
- **Size limit**: Serialized context limited to 1 KB to prevent bloat
- **Validation at all boundaries**: Enqueue, persistence, recovery, and restoration all validate
- **Defensive parsing**: Malformed JSON is caught and logged; job proceeds without context

## Test Coverage

Added comprehensive unit tests in `src/workers/jobWorker.test.js`:

### Enqueue Behavior
- Captures context when ambient context is present
- Enqueues without context when ambient context is absent
- Only includes allowed keys (filters malicious keys)
- Filters out empty/null values

### Worker Processing
- Restores context when job has traceContext
- Processes without context when job has no traceContext
- Context is scoped to job lifetime only (cleared after execution)

### Edge Cases
- Preserves context through retry attempts
- Propagates context to nested jobs enqueued within handlers
- Handles oversized context gracefully (exceeds 1 KB limit)
- Handles non-string values in context
- Handles null/undefined context values

### Persistence Layer
- Serializes traceContext in persistence layer
- Restores traceContext from persistence during recovery
- Handles malformed traceContext during recovery gracefully
- Rejects traceContext with disallowed keys during recovery

## Tradeoffs

### 1. Storage Overhead vs. Correlation Value
**Tradeoff**: Adding `trace_context` column increases storage per job (~100-200 bytes typical).

**Rationale**: The value of end-to-end request correlation outweighs minimal storage cost. The 1 KB size limit prevents abuse while accommodating realistic trace data.

### 2. Validation Strictness vs. Resilience
**Tradeoff**: Invalid trace context causes the job to enqueue without context rather than failing.

**Rationale**: Background jobs should not fail due to trace context issues. The system degrades gracefully—jobs still execute, just without correlation. Warnings are logged for debugging.

### 3. Allowlist vs. Allow-Any
**Tradeoff**: Using a strict allowlist (ALLOWED_KEYS) instead of allowing arbitrary context fields.

**Rationale**: Prevents user-controlled fields from becoming log labels, which could leak sensitive data or enable log injection attacks. The allowlist is extensible if new fields are needed.

### 4. Size Limit vs. Flexibility
**Tradeoff**: 1 KB limit on serialized trace context.

**Rationale**: Prevents oversized context from bloating job records and database. Realistic trace context (4 IDs) is well under this limit. If needed, the constant can be increased.

### 5. AsyncLocalStorage Scope vs. Global State
**Tradeoff**: Context is scoped to job lifetime via AsyncLocalStorage rather than a global variable.

**Rationale**: AsyncLocalStorage is the Node.js-recommended mechanism for async context propagation. It avoids global state pollution and ensures context isolation between concurrent jobs.

## Security Notes

### 1. Log Injection Prevention
- Only `ALLOWED_KEYS` are accepted; user-controlled fields are filtered
- Values must be strings; objects/arrays are rejected
- This prevents newline injection or control characters in log fields

### 2. PII Protection
- Trace context only contains correlation identifiers (requestId, correlationId, tenantId, userId)
- No PII or sensitive data is stored in trace context
- Existing payload sanitization (redaction of secret-like keys) remains unchanged

### 3. Database Injection Prevention
- Trace context is serialized as JSONB and validated before storage
- During recovery, parsed context is re-validated against ALLOWED_KEYS
- Malformed JSON is caught and logged; job proceeds without context

### 4. Denial of Service Protection
- 1 KB size limit prevents oversized context from bloating storage
- Validation fails fast; no expensive operations on invalid data
- Jobs enqueue without context on validation failure (no blocking)

### 5. Tenant Isolation Preservation
- TenantId is part of trace context and propagated through jobs
- Existing tenant isolation mechanisms remain unchanged
- Context restoration does not bypass any authorization checks

## Migration Notes

### Database Migration
- Migration `20260829000000_add_trace_context_to_background_jobs.sql` adds `trace_context` JSONB column
- Column is nullable; existing jobs without trace context work normally
- No data migration required; new jobs will include trace context automatically

### Backward Compatibility
- Jobs without `traceContext` execute normally (empty context)
- Existing job handlers require no changes
- API compatibility is preserved; no breaking changes

## Verification

To verify the implementation:

1. Run unit tests: `npm test -- src/workers/jobWorker.test.js`
2. Run lint: `npm run lint`
3. Run build: `npm run build`
4. Run full test suite: `npm test`

## Related Issues

Closes #[issue-number]
