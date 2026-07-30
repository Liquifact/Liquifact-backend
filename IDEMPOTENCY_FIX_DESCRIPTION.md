# Idempotency Response Persistence Reliability Fix

## Issue
#428 - Make idempotency response persistence reliable so storage failures do not break replays

## Problem Statement
The original implementation in `src/middleware/idempotency.js` stored the buffered response in a fire-and-forget `.catch()` after the response had been sent. If that write failed, the key row existed (or was partial) but the cached response body was missing, so a later replay of the same idempotency key returned a 500 (or a mismatch) instead of the original response — defeating the whole point of idempotency.

## Solution

### 1. State Machine for Idempotency Keys

Defined explicit states for idempotency keys in the `idempotency_keys` table:

| State | Status Value | Behavior on Replay |
|-------|--------------|-------------------|
| COMPLETED | response_status > 0 | Returns cached response with original status code |
| IN_PROGRESS | response_status IS NULL | Re-executes the handler safely (original response being built) |
| FAILED_STORAGE | response_status = -1 | Re-executes the handler to recover from storage failure |
| CONFLICT | (no key match, different fingerprint) | Returns 409 Conflict |

### 2. Reliable Response Persistence

**Before**: Response storage happened in a fire-and-forget `.catch()` that silently swallowed errors.

**After**: 
- Implemented bounded retry logic with exponential backoff (initial: 100ms, max: 2000ms)
- Maximum 5 retry attempts before giving up
- On final failure, the key is marked with `response_status = -1` sentinel value
- Handler re-execution occurs on replay when `response_status <= 0`

### 3. Metrics

Added `idempotency_storage_failure_total` counter to `src/metrics.js`:
- Tracks storage failures after all retries exhausted
- Labeled by `keyPrefix` (first 8 characters) for operational visibility
- Does not expose full keys in metrics to maintain security

## Files Changed

### `src/middleware/idempotency.js`
- Added `MAX_RETRY_ATTEMPTS`, `INITIAL_BACKOFF_MS`, `MAX_BACKOFF_MS` constants
- Added `sleep()` helper for async delays
- Added `calculateBackoff()` for exponential backoff with jitter
- Added `persistResponse()` function with retry logic and failure marking
- Updated middleware to re-execute handler on incomplete key state
- Added JSDoc documentation for state machine and functions

### `src/metrics.js`
- Fixed pre-existing duplicate registry declaration
- Removed orphaned code block (missing function context)
- Added `refreshMetrics()`, `registerJobQueue()`, `registerWorker()` functions
- Added `idempotencyStorageFailureTotal` counter

### `tests/idempotency.test.js`
- New test suite: "Idempotency Middleware - Normal Operation"
- New test suite: "Idempotency Middleware - Storage Failure Scenarios"
- New test suite: "Idempotency Middleware - Concurrent Replay"
- New test suite: "Idempotency Middleware - Security Validation"
- Tests simulate storage failures and assert safe replay behavior

## Test Coverage

The test suites cover:
1. **Validation Tests**: Missing headers, invalid key format
2. **Normal Operation**: First call execution, duplicate replay, conflict detection
3. **Storage Failure**: Failed persistence, retry recovery, incomplete state handling
4. **Concurrent Access**: Race condition handling for same key
5. **Security**: No cross-key data leakage

## Security Considerations

- Keys validated against strict `IDEMPOTENCY_KEY_PATTERN` before any DB access
- Request body hashed (SHA-256) before storage — no raw payload persisted
- Cached bodies keyed by `idempotency_key` only — no tenant/request leakage
- Metric labels use key prefix only (first 8 chars) — full keys never exposed

## Migration Notes

No database migration required. The `response_status = -1` sentinel value:
- Works with existing schema (response_status is INTEGER, can store -1)
- Indicates a known failed state that was never successful
- Triggers safe re-execution on replay rather than returning broken cached data

## Commits
```
feat: make idempotency response persistence reliable with defined replay states

- Add retry-with-backoff for response storage (max 5 attempts)
- Mark keys with response_status=-1 when storage fails
- Re-execute handler on replay when key has incomplete response
- Add idempotency_storage_failure_total metric
- Add comprehensive tests for storage failure scenarios
```

Closes #428