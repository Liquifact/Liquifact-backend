'use strict';

const crypto = require('crypto');
const db = require('../db/knex');
const logger = require('../logger');
const { resolveInvoiceByAddress } = require('../config/escrowMap');
const { escrowReadCache } = require('../services/escrowReadCache');
const { indexerCache } = require('../services/indexerCache');
const { isIndexerEnabled } = require('../services/indexerService');
const {
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerCycleFailuresTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
} = require('../metrics');

const { StrKey } = require('@stellar/stellar-sdk');
const { indexerEventSchema } = require('../schemas/indexerEvent');
const { INVOICE_ID_REGEX } = require('../schemas/validationHelper');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class ValidationError extends Error {
  /**
   * Creates an indexer event validation error.
   * @param {string} message Human-readable failure.
   * @param {string} code Stable error code.
   * @param {object|null} details Validation details.
   */
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

class LeaseLostError extends Error {
  /**
   * Creates an escrow indexer lease fencing error.
   * @param {string} message Human-readable failure.
   * @param {string} code Stable error code.
   * @param {object|null} details Validation details.
   */
  constructor(message, code = 'LEASE_LOST', details = null) {
    super(message);
    this.name = 'LeaseLostError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 100;

// Fencing token lease; expiry is compared with the database clock.
const LEASE_KEY = 'worker_lease';
const DEFAULT_LEASE_DURATION_MS = 30_000;

// Minimum lease renewal buffer to prevent expiry during operations
const LEASE_RENEWAL_BUFFER_MS = 5_000;

// Maximum lease duration to prevent runaway processes
const MAX_LEASE_DURATION_MS = 300_000; // 5 minutes

// State validation configuration
const ENFORCE_STATE_TRANSITIONS = process.env.ESCROW_INDEXER_ENFORCE_STATE_TRANSITIONS !== 'false';
const ENFORCE_BUSINESS_CONSTRAINTS = process.env.ESCROW_INDEXER_ENFORCE_BUSINESS_CONSTRAINTS !== 'false';
const LOG_STATE_VIOLATIONS = process.env.ESCROW_INDEXER_LOG_STATE_VIOLATIONS !== 'false';

// Ordering validation configuration
const MAX_LEDGER_GAP_THRESHOLD = Number(process.env.ESCROW_INDEXER_MAX_LEDGER_GAP || 1000);
const MAX_TIME_REVERSAL_MS = Number(process.env.ESCROW_INDEXER_MAX_TIME_REVERSAL_MS || 60_000);
const STRICT_ORDERING_MODE = process.env.ESCROW_INDEXER_STRICT_ORDERING === 'true';

/**
 * Validates and sanitizes string inputs to prevent injection and overflow attacks.
 * @param {any} value - Value to validate
 * @param {string} fieldName - Name of the field for error reporting
 * @param {number} maxLength - Maximum allowed length
 * @param {boolean} [required=false] - Whether the field is required
 * @returns {string|null} Validated string or null if not required and empty
 * @throws {ValidationError} If validation fails
 */
function validateStringField(value, fieldName, maxLength, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ValidationError(`${fieldName} is required.`, 'REQUIRED_FIELD_MISSING', { field: fieldName });
    }
    return null;
  }
  
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string.`, 'INVALID_TYPE', { 
      field: fieldName, 
      expected: 'string', 
      actual: typeof value 
    });
  }
  
  // Check for potentially malicious patterns
  if (value.includes('\x00') || value.includes('\x08') || value.includes('\x0b')) {
    throw new ValidationError(`${fieldName} contains invalid control characters.`, 'INVALID_CHARACTERS', { field: fieldName });
  }
  
  // Trim and validate length
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${fieldName} exceeds maximum length of ${maxLength} characters.`, 'LENGTH_EXCEEDED', { 
      field: fieldName, 
      maxLength, 
      actualLength: trimmed.length 
    });
  }
  
  if (required && trimmed.length === 0) {
    throw new ValidationError(`${fieldName} cannot be empty.`, 'EMPTY_REQUIRED_FIELD', { field: fieldName });
  }
  
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates numeric fields with safe bounds checking.
 * @param {any} value - Value to validate
 * @param {string} fieldName - Name of the field for error reporting
 * @param {number} [min=SAFE_INTEGER_MIN] - Minimum allowed value
 * @param {number} [max=SAFE_INTEGER_MAX] - Maximum allowed value
 * @param {boolean} [required=false] - Whether the field is required
 * @returns {number|null} Validated number or null if not required and empty
 * @throws {ValidationError} If validation fails
 */
function validateNumericField(value, fieldName, min = SAFE_INTEGER_MIN, max = SAFE_INTEGER_MAX, required = false) {
  if (value === null || value === undefined) {
    if (required) {
      throw new ValidationError(`${fieldName} is required.`, 'REQUIRED_FIELD_MISSING', { field: fieldName });
    }
    return null;
  }
  
  const num = Number(value);
  
  if (!Number.isFinite(num)) {
    throw new ValidationError(`${fieldName} must be a finite number.`, 'INVALID_NUMBER', { 
      field: fieldName, 
      value 
    });
  }
  
  if (!Number.isInteger(num)) {
    throw new ValidationError(`${fieldName} must be an integer.`, 'NOT_INTEGER', { 
      field: fieldName, 
      value: num 
    });
  }
  
  if (num < min || num > max) {
    throw new ValidationError(`${fieldName} must be between ${min} and ${max}.`, 'OUT_OF_RANGE', { 
      field: fieldName, 
      value: num, 
      min, 
      max 
    });
  }
  
  return num;
}

/**
 * Validates JSON object size and structure to prevent DoS attacks.
 * @param {any} value - Value to validate
 * @param {string} fieldName - Name of the field for error reporting
 * @param {number} [maxSize=MAX_EVENT_BODY_SIZE] - Maximum serialized size in bytes
 * @returns {object} Validated object
 * @throws {ValidationError} If validation fails
 */
function validateJsonField(value, fieldName, maxSize = MAX_EVENT_BODY_SIZE) {
  if (value === null || value === undefined) {
    return {};
  }
  
  if (typeof value !== 'object') {
    throw new ValidationError(`${fieldName} must be an object.`, 'INVALID_TYPE', { 
      field: fieldName, 
      expected: 'object', 
      actual: typeof value 
    });
  }
  
  try {
    const serialized = JSON.stringify(value);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    
    if (byteLength > maxSize) {
      throw new ValidationError(`${fieldName} exceeds maximum size of ${maxSize} bytes.`, 'SIZE_EXCEEDED', { 
        field: fieldName, 
        maxSize, 
        actualSize: byteLength 
      });
    }
    
    // Basic structure validation to prevent deeply nested objects
    const depth = getObjectDepth(value);
    if (depth > 10) {
      throw new ValidationError(`${fieldName} is too deeply nested (max depth: 10).`, 'DEPTH_EXCEEDED', { 
        field: fieldName, 
        depth 
      });
    }
    
    return value;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(`${fieldName} contains invalid JSON structure.`, 'INVALID_JSON', { 
      field: fieldName, 
      error: error.message 
    });
  }
}

/**
 * Calculates the nesting depth of an object.
 * @param {any} obj - Object to measure
 * @param {number} [currentDepth=0] - Current recursion depth
 * @returns {number} Maximum nesting depth
 */
function getObjectDepth(obj, currentDepth = 0) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return currentDepth;
  }
  
  let maxDepth = currentDepth;
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object') {
      const depth = getObjectDepth(value, currentDepth + 1);
      maxDepth = Math.max(maxDepth, depth);
    }
  }
  
  return maxDepth;
}

/**
 * @param {number} leaseDurationMs - Requested lease duration in milliseconds
 * @returns {number} Validated and clamped lease duration
 */
function validateLeaseDuration(leaseDurationMs) {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    return DEFAULT_LEASE_DURATION_MS;
  }
  
  // Clamp to safe bounds to prevent resource exhaustion
  return Math.min(Math.max(leaseDurationMs, LEASE_RENEWAL_BUFFER_MS), MAX_LEASE_DURATION_MS);
}

/**
 * Checks if a lease token has sufficient remaining time for operations.
 * @param {object} lease - Lease object with token and expiresAt
 * @param {number} [bufferMs=LEASE_RENEWAL_BUFFER_MS] - Required buffer time
 * @returns {boolean} True if lease has sufficient time remaining
 */
function hasLeaseTimeRemaining(lease, bufferMs = LEASE_RENEWAL_BUFFER_MS) {
  if (!lease || typeof lease.expiresAt !== 'number') {
    return false;
  }
  
  return lease.expiresAt > (Date.now() + bufferMs);
}

/**
 * Maximum number of retry attempts for transient fetch/persist errors.
 * ValidationError and LeaseLostError are never retried.
 *
 * @type {number}
 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Base delay (ms) for the first retry.  Subsequent attempts use exponential
 * backoff: `BASE_RETRY_DELAY_MS * 2^(attempt - 1)` plus a random jitter of up
 * to `BASE_RETRY_DELAY_MS`.
 *
 * @type {number}
 */
const BASE_RETRY_DELAY_MS = 200;

/**
 * Maximum total delay (ms) for any single retry attempt, preventing runaway
 * backoff on deeply-failed retries.
 *
 * @type {number}
 */
const MAX_RETRY_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Transient-error retry helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when an error should NOT be retried.
 *
 * `ValidationError` and `LeaseLostError` are permanent failures: retrying
 * them would produce the same outcome and could violate fencing invariants.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isNonRetryableError(err) {
  return err instanceof ValidationError || err instanceof LeaseLostError;
}

/**
 * Executes `fn` up to `maxAttempts` times, retrying on transient errors with
 * capped exponential backoff and jitter.
 *
 * Non-retryable errors (`ValidationError`, `LeaseLostError`) are re-thrown
 * immediately without consuming retry budget.
 *
 * @param {Function} fn              - Async function to execute.
 * @param {object}   [opts]          - Options.
 * @param {number}   [opts.maxAttempts=MAX_RETRY_ATTEMPTS]   - Total attempts.
 * @param {number}   [opts.baseDelayMs=BASE_RETRY_DELAY_MS]  - Base backoff ms.
 * @param {number}   [opts.maxDelayMs=MAX_RETRY_DELAY_MS]    - Backoff ceiling ms.
 * @param {object}   [opts.log]      - Logger for retry warnings.
 * @param {string}   [opts.context]  - Human-readable label for log messages.
 * @returns {Promise<{ result: *, retried: number }>} The function's result and
 *   the number of retry attempts used (0 on first-attempt success).
 * @throws The last error when all attempts are exhausted.
 */
async function withRetry(fn, {
  maxAttempts = MAX_RETRY_ATTEMPTS,
  baseDelayMs = BASE_RETRY_DELAY_MS,
  maxDelayMs = MAX_RETRY_DELAY_MS,
  log = logger,
  context = 'operation',
} = {}) {
  let lastError;
  let retried = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, retried };
    } catch (err) {
      // Non-retryable: propagate immediately.
      if (isNonRetryableError(err)) {
        throw err;
      }

      lastError = err;

      if (attempt < maxAttempts) {
        retried += 1;
        // Capped exponential backoff with uniform jitter.
        const exponential = baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.random() * baseDelayMs;
        const delay = Math.min(exponential + jitter, maxDelayMs);

        log.warn(
          {
            err,
            context,
            attempt,
            maxAttempts,
            retryDelayMs: Math.round(delay),
          },
          `Transient error in ${context}; retrying (attempt ${attempt}/${maxAttempts}).`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Stellar address / tx-hash validators
// ---------------------------------------------------------------------------

/**
 * Validates a Stellar contract ID using StrKey encoding rules (starts with 'C',
 * correct length, and valid checksum).
 *
 * @param {string} contractId - The contract ID to validate.
 * @returns {boolean} True if the contract ID is valid.
 */
function isValidStellarContractId(contractId) {
  if (typeof contractId !== 'string') {
    return false;
  }
  const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
  if (!CONTRACT_ID_RE.test(contractId)) {
    return false;
  }
  try {
    return StrKey.isValidContract(contractId);
  } catch (_err) {
    return false;
  }
}

/**
 * Validates a transaction hash (exactly 64 hexadecimal characters,
 * case-insensitive, no prefixes).
 *
 * @param {string} txHash - The transaction hash to validate.
 * @returns {boolean} True if the transaction hash is valid.
 */
function isValidTxHash(txHash) {
  if (typeof txHash !== 'string') {
    return false;
  }
  const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
  return TX_HASH_RE.test(txHash);
}

/**
 * Attempts to derive a usable invoice ID from a Horizon/Soroban contract event
 * record, in priority order:
 *
 *   1. An explicit `invoice_id` / `invoiceId` field on the record.
 *   2. The LiquifactEscrow event payload — the `value` body or a `topic`/
 *      `topics` array entry explicitly labelled with an invoice field. Bare topic
 *      symbols (e.g. the event-name symbol) are not treated as invoice IDs.
 *   3. Reverse lookup of the emitting contract address through escrowMap.
 *
 * The derived value is validated against INVOICE_ID_REGEX; anything that does
 * not match (including the bare contract address) yields null so the caller can
 * skip the event rather than mis-key the projection by contract address.
 *
 * @param {object} record - Raw Horizon contract event record.
 * @param {(address: string) => (string|null)} [reverseLookup] - Address->invoiceId resolver.
 * @returns {string|null} A valid invoice ID, or null if none can be resolved.
 */
function deriveInvoiceId(record, reverseLookup = resolveInvoiceByAddress) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const isValid = (candidate) => {
    if (candidate === null || candidate === undefined) {
      return null;
    }
    const value = String(candidate).trim();
    return INVOICE_ID_REGEX.test(value) ? value : null;
  };

  // 1. Explicit field on the record.
  const explicit = isValid(record.invoice_id) || isValid(record.invoiceId);
  if (explicit) {
    return explicit;
  }

  // 2. LiquifactEscrow event payload: value body and topics.
  const body = record.value;
  if (body && typeof body === 'object') {
    const fromBody = isValid(body.invoice_id) || isValid(body.invoiceId);
    if (fromBody) {
      return fromBody;
    }
  }

  const topics = Array.isArray(record.topics)
    ? record.topics
    : Array.isArray(record.topic)
      ? record.topic
      : [];
  for (const topic of topics) {
    if (topic && typeof topic === 'object') {
      // Only trust explicitly-labelled invoice fields in a topic entry. The
      // first topic in a LiquifactEscrow event is the event-name symbol, so
      // we must not treat arbitrary symbol/string values as an invoice id.
      const fromTopic = isValid(topic.invoice_id) || isValid(topic.invoiceId);
      if (fromTopic) {
        return fromTopic;
      }
    }
  }

  // 3. Reverse lookup by contract address.
  if (record.contract_id && typeof reverseLookup === 'function') {
    const resolved = reverseLookup(String(record.contract_id));
    if (resolved === String(record.contract_id) || isValidStellarContractId(resolved)) {
      return null;
    }
    const fromMap = isValid(resolved);
    if (fromMap) {
      return fromMap;
    }
  }

  return null;
}

/**
 * Validates and normalizes a raw escrow event into the canonical shape used by
 * the indexer's persistence and projection logic.
 *
 * Rejects unknown fields, wrong types, and out-of-range values with a
 * structured {@link ValidationError} that carries a machine-readable error
 * code and field-level details.
 *
 * @param {object} rawEvent - Raw event payload to validate and normalize.
 * @returns {object} The normalized event with validated required fields and
 *   defaults applied for optional fields.
 * @throws {ValidationError} If the payload is not an object, contains unknown
 *   fields, has wrong types, or field values are out of bounds.
 */
function normalizeEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    throw new ValidationError('Event payload must be an object.', 'INVALID_PAYLOAD');
  }

  // Use schema validation first for basic structure
  const result = indexerEventSchema.safeParse(rawEvent);

  if (!result.success) {
    const { parseValidationErrors } = require('../schemas/indexerEvent');
    const fieldErrors = parseValidationErrors(result.error);
    throw new ValidationError(
      'Event payload contains invalid or out-of-range fields.',
      'VALIDATION_ERROR',
      fieldErrors,
    );
  }

  const data = result.data;
  
  // Apply additional comprehensive validation with boundary checks
  try {
    const normalizedEvent = {
      eventId: validateStringField(data.eventId, 'eventId', MAX_EVENT_ID_LENGTH, true),
      invoiceId: validateStringField(data.invoiceId, 'invoiceId', MAX_INVOICE_ID_LENGTH, true),
      eventType: validateStringField(data.eventType, 'eventType', MAX_EVENT_TYPE_LENGTH, true),
      ledgerSequence: validateNumericField(data.ledgerSequence, 'ledgerSequence', MIN_LEDGER_SEQUENCE, MAX_LEDGER_SEQUENCE, true),
      pagingToken: validateStringField(data.pagingToken || '', 'pagingToken', MAX_PAGING_TOKEN_LENGTH, false) || '',
      contractId: validateStringField(data.contractId, 'contractId', MAX_CONTRACT_ID_LENGTH, false),
      txHash: validateStringField(data.txHash, 'txHash', MAX_TX_HASH_LENGTH, false),
      eventBody: validateJsonField(data.eventBody, 'eventBody'),
      observedAt: data.observedAt || new Date().toISOString(),
    };
    
    // Additional business logic validation
    if (normalizedEvent.contractId && !isValidStellarContractId(normalizedEvent.contractId)) {
      throw new ValidationError('Invalid Stellar contract ID format.', 'INVALID_CONTRACT_ID', {
        contractId: normalizedEvent.contractId
      });
    }
    
    if (normalizedEvent.txHash && !isValidTxHash(normalizedEvent.txHash)) {
      throw new ValidationError('Invalid transaction hash format.', 'INVALID_TX_HASH', {
        txHash: normalizedEvent.txHash
      });
    }
    
    // Validate observedAt is a valid ISO string
    if (normalizedEvent.observedAt) {
      const date = new Date(normalizedEvent.observedAt);
      if (isNaN(date.getTime())) {
        throw new ValidationError('Invalid observedAt timestamp format.', 'INVALID_TIMESTAMP', {
          observedAt: normalizedEvent.observedAt
        });
      }
      
      // Prevent events with timestamps too far in the future (clock skew protection)
      const maxFutureMs = 5 * 60 * 1000; // 5 minutes
      if (date.getTime() > Date.now() + maxFutureMs) {
        throw new ValidationError('Event timestamp is too far in the future.', 'FUTURE_TIMESTAMP', {
          observedAt: normalizedEvent.observedAt,
          maxAllowedSkew: maxFutureMs
        });
      }
    }
    
    return normalizedEvent;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    // Wrap unexpected errors
    throw new ValidationError(`Event validation failed: ${error.message}`, 'VALIDATION_ERROR', {
      originalError: error.message
    });
  }
}

/**
 * Simple circuit breaker to prevent cascading failures during high error rates.
 */
class CircuitBreaker {
  constructor({ failureThreshold = 5, timeoutMs = 60_000, resetTimeoutMs = 30_000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.timeoutMs = timeoutMs;
    this.resetTimeoutMs = resetTimeoutMs;
    this.reset();
  }
  
  reset() {
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.nextAttempt = 0;
  }
  
  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.reset();
  }
  
  onFailure() {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
    }
  }
  
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttempt: this.nextAttempt
    };
  }
}
/**
 * @param {import('knex').Knex} knex - Knex instance
 * @param {object} options - Transaction options
 * @param {number} [options.timeoutMs=30000] - Transaction timeout in milliseconds
 * @param {string} [options.isolationLevel='read committed'] - Transaction isolation level
 * @returns {Function} Transaction runner function
 */
function createSafeTransactionRunner(knex, options = {}) {
  const { 
    timeoutMs = 30_000, 
    isolationLevel = 'read committed' 
  } = options;
  
  return async (handler) => {
    return knex.transaction(async (trx) => {
      // Set transaction timeout to prevent long-running transactions
      if (timeoutMs > 0) {
        await trx.raw('SET statement_timeout = ?', [timeoutMs]);
      }
      
      // Set isolation level for consistency
      if (isolationLevel) {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL ' + isolationLevel.toUpperCase());
      }
      
      try {
        const result = await handler(trx);
        return result;
      } catch (error) {
        // Transaction will automatically rollback on error
        throw error;
      }
    });
  };
}
/**
 * Builds a Knex-backed escrow event store providing cursor, event, and
 * projection persistence operations.
 *
 * @param {import('knex').Knex} knex - Configured Knex instance.
 * @returns {object} Store with loadCursor, saveCursor, findProjection,
 *   upsertEvent, and upsertProjection methods.
 */
function createKnexEscrowEventStore(knex) {
  /**
   * Verifies that the given fencing token still holds a live lease, using the
   * database clock so workers with skewed local clocks cannot steal or extend
   * a lease incorrectly.
   *
   * @param {object|null} trx - Optional transaction to run the check within.
   * @param {string} token - Fencing token expected to hold the lease.
   * @returns {Promise<object>} Parsed lease value when the token is valid.
   * @throws {LeaseLostError} When the lease is missing, stale, or expired.
   */
  async function assertLease(trx, token) {
    if (!token || typeof token !== 'string') {
      throw new LeaseLostError('Invalid lease token provided.', 'INVALID_TOKEN');
    }

    const row = await (trx || knex)('escrow_indexer_state')
      .where({ key: LEASE_KEY })
      .whereRaw("value::jsonb ->> 'token' = ?", [token])
      .whereRaw("(value::jsonb ->> 'expiresAt')::bigint > EXTRACT (EPOCH FROM NOW()) * 1000")
      .first();
    
    if (!row) {
      throw new LeaseLostError('Escrow indexer lease is missing, stale, or expired.', 'LEASE_LOST');
    }
    
    const lease = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    
    // Double-check lease expiry against local clock as additional safety
    if (!hasLeaseTimeRemaining(lease)) {
      throw new LeaseLostError('Escrow indexer lease has insufficient time remaining.', 'LEASE_EXPIRED');
    }
    
    return lease;
  }

  return {
    async acquireLease({ leaseDurationMs = DEFAULT_LEASE_DURATION_MS } = {}) {
      const validatedDuration = validateLeaseDuration(leaseDurationMs);
      const token = crypto.randomUUID();
      
      // Use advisory lock to prevent race conditions in lease acquisition
      const result = await knex.raw(
        `SELECT pg_advisory_xact_lock(hashtext(?));
         INSERT INTO escrow_indexer_state (key, value, updated_at)
         VALUES (?, jsonb_build_object('token', ?, 'expiresAt', EXTRACT(EPOCH FROM NOW()) * 1000 + ?)::text, NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = NOW()
           WHERE escrow_indexer_state.value IS NULL
              OR COALESCE((escrow_indexer_state.value::jsonb ->> 'expiresAt')::bigint, 0) <= EXTRACT (EPOCH FROM NOW()) * 1000
         RETURNING value`,
        [LEASE_KEY, LEASE_KEY, token, validatedDuration],
      );
      
      if (!result.rows || result.rows.length === 0) {
        return null;
      }
      
      const lease = typeof result.rows[0].value === 'string'
        ? JSON.parse(result.rows[0].value)
        : result.rows[0].value;
      
      // Validate the returned lease matches our token (prevents race condition artifacts)  
      if (lease.token !== token) {
        return null;
      }
      
      return lease;
    },

    async renewLease(token, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
      if (!token || typeof token !== 'string') {
        return null;
      }
      
      const validatedDuration = validateLeaseDuration(leaseDurationMs);
      
      const result = await knex.raw(
        `UPDATD escrow_indexer_state
         SET value = jsonb_build_object(
               'token', value::jsonb ->> 'token',
               'expiresAt', EXTRACT (EPOCH FROM NOW()) * 1000 + ?
             )::text,
             updated_at = NOW()
         WHERE key = ?
           AND value::jsonb ->> 'token' = ?
           AND COALESCE((value::jsonb ->> 'expiresAt')::bigint, 0) > EXTRACT (EPOCH FROM NOW()) * 1000
         RETURNING value`,
        [validatedDuration, LEASE_KEY, token],
      );
      
      if (!result.rows || result.rows.length === 0) {
        return null;
      }
      
      const lease = typeof result.rows[0].value === 'string'
        ? JSON.parse(result.rows[0].value)
        : result.rows[0].value;
      
      // Validate lease integrity after renewal
      if (lease.token !== token) {
        throw new LeaseLostError('Lease token mismatch after renewal.', 'TOKEN_MISMATCH');
      }
      
      return lease;
    },

    async completeLease(token) {
      if (!token || typeof token !== 'string') {
        return false;
      }
      
      const deleted = await knex('escrow_indexer_state')
        .where({ key: LEASE_KEY })
        .whereRaw("value::jsonb ->> 'token' = ?", [token])
        .del();
      return deleted > 0;
    },

    assertLease,

    async loadCursor() {
      const row = await knex('escrow_indexer_state')
        .where({ key: 'horizon_cursor' })
        .first();
      return row ? row.value : null;
    },

    async saveCursor(cursor, fenceToken) {
      if (cursor !== null && typeof cursor !== 'string') {
        throw new Error('Cursor must be a string value or null.');
      }

      const writeCursor = async (trx) => {
        // Assert the lease inside the same transaction as the write. Asserting
        // and then writing in separate statements is a TOCTOU race: a worker
        // whose lease expires between the two could still advance the cursor
        // after another worker has taken over.
        if (fenceToken) {
          await assertLease(trx, fenceToken);
        }

        // Load current cursor for ordering validation inside the same
        // transaction as the lease assertion and cursor write.
        const q = trx || knex;
        const currentRow = await q('escrow_indexer_state')
          .where({ key: 'horizon_cursor' })
          .first();
        const currentCursor = currentRow ? currentRow.value : null;

        // Validate cursor ordering to prevent rollbacks.
        const orderingCheck = validateCursorOrdering(currentCursor, cursor);

        if (!orderingCheck.isValid) {
          throw new Error(
            `Cursor rollback prevented: ${orderingCheck.reason}. ` +
            `Current: ${orderingCheck.currentCursor}, Proposed: ${orderingCheck.proposedCursor}`
          );
        }

        // Only save if the cursor is actually advancing. An unchanged cursor
        // is already persisted and is therefore safely idempotent.
        if (orderingCheck.action === 'advance') {
          await q('escrow_indexer_state')
            .insert({ key: 'horizon_cursor', value: cursor, updated_at: q.fn.now() })
            .onConflict('key')
            .merge({ value: cursor, updated_at: q.fn.now() });
        }
      };

      if (fenceToken && typeof knex.transaction === 'function') {
        await knex.transaction(writeCursor);
      } else {
        await writeCursor(null);
      }
    },

    async findProjection(invoiceId) {
      return knex('escrow_event_projection').where({ invoice_id: invoiceId }).first();
    },

    async findEventById(eventId) {
      if (!eventId || typeof eventId !== 'string') {
        return null;
      }
      
      return knex('escrow_events').where({ event_id: eventId }).first();
    },

    async findEventByFingerprint(fingerprint) {
      if (!fingerprint || typeof fingerprint !== 'string') {
        return null;
      }
      
      // Note: This requires adding a fingerprint column to escrow_events table
      // For now, we'll check existing events by critical field combinations
      return null; // TODO: Implement after adding fingerprint column
    },

    async findProjectionWithinTrx(trx, invoiceId) {
      if (!invoiceId || typeof invoiceId !== 'string') {
        throw new Error('Invalid invoiceId provided to findProjectionWithinTrx.');
      }
      
      // Use FOR UPDATE to prevent concurrent modifications to the same invoice projection
      return trx('escrow_event_projection')
        .where({ invoice_id: invoiceId })
        .forUpdate()
        .first();
    },

    async upsertEvent(trx, event) {
      if (!event || typeof event !== 'object') {
        throw new Error('Invalid event object provided to upsertEvent.');
      }
      
      // Validate required fields
      const requiredFields = ['eventId', 'invoiceId', 'eventType', 'ledgerSequence'];
      for (const field of requiredFields) {
        if (!event[field]) {
          throw new Error(`Missing required field '${field}' in event.`);
        }
      }
      
      try {
        await trx('escrow_events')
          .insert({
            event_id: event.eventId,
            invoice_id: event.invoiceId,
            event_type: event.eventType,
            ledger_sequence: event.ledgerSequence,
            paging_token: event.pagingToken || null,
            contract_id: event.contractId,
            tx_hash: event.txHash,
            event_body: JSON.stringify(event.eventBody || {}),
            observed_at: event.observedAt,
          })
          .onConflict('event_id')
          .ignore();
      } catch (error) {
        // Wrap database errors with additional context
        throw new Error(`Failed to upsert event ${event.eventId}: ${error.message}`);
      }
    },

    async upsertProjection(trx, event) {
      if (!event || typeof event !== 'object') {
        throw new Error('Invalid event object provided to upsertProjection.');
      }
      
      // Validate required fields for projection update
      const requiredFields = ['eventId', 'invoiceId', 'eventType', 'ledgerSequence'];
      for (const field of requiredFields) {
        if (!event[field]) {
          throw new Error(`Missing required field '${field}' for projection update.`);
        }
      }
      
      // Additional validation for projection-specific fields
      if (typeof event.ledgerSequence !== 'number' || event.ledgerSequence <= 0) {
        throw new Error(`Invalid ledgerSequence for projection: ${event.ledgerSequence}`);
      }
      
      try {
        await trx('escrow_event_projection')
          .insert({
            invoice_id: event.invoiceId,
            latest_event_id: event.eventId,
            latest_event_type: event.eventType,
            latest_ledger_sequence: event.ledgerSequence,
            latest_paging_token: event.pagingToken || null,
            latest_event_body: JSON.stringify(event.eventBody || {}),
            latest_observed_at: event.observedAt,
            updated_at: trx.fn.now(),
          })
          .onConflict('invoice_id')
          .merge({
            latest_event_id: event.eventId,
            latest_event_type: event.eventType,
            latest_ledger_sequence: event.ledgerSequence,
            latest_paging_token: event.pagingToken || null,
            latest_event_body: JSON.stringify(event.eventBody || {}),
            latest_observed_at: event.observedAt,
            updated_at: trx.fn.now(),
          });
      } catch (error) {
        // Wrap database errors with additional context
        throw new Error(`Failed to upsert projection for invoice ${event.invoiceId}: ${error.message}`);
      }
    },
  };
}

/**
 * Defines valid state transitions for escrow events.
 * This ensures that state changes follow valid business logic.
 */
const VALID_STATE_TRANSITIONS = {
  // Initial states (can be created from nothing)
  'initial': ['escrow_created', 'contract_deployed', 'invoice_created'],
  
  // From escrow_created
  'escrow_created': ['escrow_funded', 'escrow_cancelled', 'escrow_updated'],
  
  // From escrow_funded  
  'escrow_funded': ['escrow_released', 'escrow_disputed', 'escrow_cancelled', 'escrow_updated'],
  
  // From escrow_released (terminal state)
  'escrow_released': ['escrow_finalized'],
  
  // From escrow_disputed
  'escrow_disputed': ['escrow_resolved', 'escrow_cancelled'],
  
  // From escrow_resolved  
  'escrow_resolved': ['escrow_released', 'escrow_disputed'],
  
  // From escrow_cancelled (mostly terminal)
  'escrow_cancelled': ['escrow_created'], // Allow recreation
  
  // From escrow_finalized (terminal state)
  'escrow_finalized': [], // No transitions allowed
  
  // Generic updates allowed from most states
  'escrow_updated': ['escrow_updated', 'escrow_funded', 'escrow_released', 'escrow_cancelled'],
  
  // Contract events
  'contract_deployed': ['escrow_created', 'contract_updated'],
  'contract_updated': ['contract_updated', 'escrow_created'],
  
  // Invoice events
  'invoice_created': ['invoice_updated', 'escrow_created'],
  'invoice_updated': ['invoice_updated', 'escrow_created', 'invoice_cancelled'],
  'invoice_cancelled': ['invoice_created'], // Allow recreation
};

/**
 * Validates that a state transition is allowed according to business rules.
 * @param {string|null} fromState - Current state (event type)
 * @param {string} toState - Proposed new state (event type)
 * @returns {object} Validation result
 */
function validateStateTransition(fromState, toState) {
  if (!toState || typeof toState !== 'string') {
    return {
      isValid: false,
      reason: 'invalid_to_state',
      fromState,
      toState
    };
  }
  
  // Handle initial state (no previous state)
  if (!fromState) {
    const initialStates = VALID_STATE_TRANSITIONS['initial'] || [];
    if (initialStates.includes(toState)) {
      return {
        isValid: true,
        reason: 'initial_state_allowed',
        fromState: null,
        toState
      };
    } else {
      return {
        isValid: false,
        reason: 'invalid_initial_state',
        fromState: null,
        toState,
        allowedInitialStates: initialStates
      };
    }
  }
  
  // Check if transition is allowed
  const allowedTransitions = VALID_STATE_TRANSITIONS[fromState] || [];
  if (allowedTransitions.includes(toState)) {
    return {
      isValid: true,
      reason: 'valid_transition',
      fromState,
      toState
    };
  }
  
  // Allow self-transitions (idempotent updates)
  if (fromState === toState) {
    return {
      isValid: true,
      reason: 'idempotent_transition',
      fromState,
      toState
    };
  }
  
  return {
    isValid: false,
    reason: 'invalid_transition',
    fromState,
    toState,
    allowedTransitions
  };
}

/**
 * Validates business-specific constraints on event data.
 * @param {object} event - Normalized event to validate
 * @param {object|null} currentProjection - Current projection state
 * @returns {object} Validation result with business rule checks
 */
function validateBusinessConstraints(event, currentProjection) {
  const violations = [];
  
  // Validate event type against whitelist
  const allowedEventTypes = [
    'escrow_created', 'escrow_funded', 'escrow_released', 'escrow_cancelled',
    'escrow_disputed', 'escrow_resolved', 'escrow_finalized', 'escrow_updated',
    'contract_deployed', 'contract_updated',
    'invoice_created', 'invoice_updated', 'invoice_cancelled'
  ];
  
  if (!allowedEventTypes.includes(event.eventType)) {
    violations.push({
      type: 'unknown_event_type',
      eventType: event.eventType,
      allowedTypes: allowedEventTypes
    });
  }
  
  // Validate required fields based on event type
  const requiredFieldsByEventType = {
    'escrow_created': ['contractId'],
    'escrow_funded': ['contractId'],
    'escrow_released': ['contractId'],
    'contract_deployed': ['contractId'],
    'invoice_created': ['invoiceId'],
  };
  
  const requiredFields = requiredFieldsByEventType[event.eventType] || [];
  for (const field of requiredFields) {
    if (!event[field]) {
      violations.push({
        type: 'missing_required_field',
        eventType: event.eventType,
        missingField: field
      });
    }
  }
  
  // Validate event body contains expected fields for certain event types
  if (event.eventType === 'escrow_funded' && event.eventBody) {
    if (!event.eventBody.amount && !event.eventBody.value) {
      violations.push({
        type: 'missing_amount_field',
        eventType: event.eventType,
        eventBody: event.eventBody
      });
    }
  }
  
  // Validate contract address consistency
  if (currentProjection && currentProjection.latest_contract_id && event.contractId) {
    if (currentProjection.latest_contract_id !== event.contractId) {
      violations.push({
        type: 'contract_id_mismatch',
        currentContractId: currentProjection.latest_contract_id,
        incomingContractId: event.contractId
      });
    }
  }
  
  // Validate ledger sequence progression (no major gaps in critical operations)
  if (currentProjection && event.eventType === 'escrow_released') {
    const currentLedger = Number(currentProjection.latest_ledger_sequence || 0);
    const gap = event.ledgerSequence - currentLedger;
    
    // Large gaps in critical operations might indicate missing events
    if (gap > 100) { // Configurable threshold
      violations.push({
        type: 'suspicious_ledger_gap_in_critical_operation',
        eventType: event.eventType,
        ledgerGap: gap,
        currentLedger,
        incomingLedger: event.ledgerSequence
      });
    }
  }
  
  return {
    isValid: violations.length === 0,
    violations
  };
}

/**
 * Comprehensive state validation that combines transition rules and business constraints.
 * @param {object} event - Normalized event to validate
 * @param {object|null} currentProjection - Current projection state
 * @returns {object} Complete validation result
 */
function validateStateTransitionAndConstraints(event, currentProjection) {
  const currentState = currentProjection ? currentProjection.latest_event_type : null;
  const newState = event.eventType;
  
  // Validate state transition
  const transitionValidation = validateStateTransition(currentState, newState);
  
  // Validate business constraints
  const constraintValidation = validateBusinessConstraints(event, currentProjection);
  
  // Combine results
  const allViolations = [
    ...(transitionValidation.isValid ? [] : [{ 
      type: 'invalid_state_transition', 
      ...transitionValidation 
    }]),
    ...constraintValidation.violations
  ];
  
  return {
    isValid: allViolations.length === 0,
    violations: allViolations,
    transitionValidation,
    constraintValidation
  };
}

/**
 * @param {string|null} currentCursor - Current stored cursor
 * @param {string|null} proposedCursor - Proposed new cursor
 * @returns {object} Validation result with ordering status
 */
function validateCursorOrdering(currentCursor, proposedCursor) {
  // Allow initial cursor setting
  if (!currentCursor && proposedCursor) {
    return { isValid: true, action: 'advance', reason: 'initial_cursor' };
  }
  
  // Allow null proposed cursor (no events case)
  if (!proposedCursor) {
    return { isValid: true, action: 'unchanged', reason: 'no_new_cursor' };
  }
  
  // Both cursors present - validate ordering
  if (currentCursor && proposedCursor) {
    // For Horizon paging tokens, lexicographic comparison generally works
    // but we need to handle numeric prefixes properly
    const comparison = comparePagingTokens(currentCursor, proposedCursor);
    
    if (comparison < 0) {
      return { isValid: true, action: 'advance', reason: 'cursor_advanced' };
    } else if (comparison === 0) {
      return { isValid: true, action: 'unchanged', reason: 'cursor_equal' };
    } else {
      return { 
        isValid: false, 
        action: 'reject', 
        reason: 'cursor_rollback_prevented',
        currentCursor,
        proposedCursor
      };
    }
  }
  
  return { isValid: true, action: 'unchanged', reason: 'no_change_needed' };
}

/**
 * Compares two Horizon paging tokens for ordering.
 * @param {string} token1 - First token
 * @param {string} token2 - Second token  
 * @returns {number} -1 if token1 < token2, 0 if equal, 1 if token1 > token2
 */
function comparePagingTokens(token1, token2) {
  if (token1 === token2) {
    return 0;
  }
  
  // Try to parse as ledger-index format (e.g., "12345-1")
  const parseToken = (token) => {
    const parts = token.split('-');
    if (parts.length === 2) {
      const ledger = parseInt(parts[0], 10);
      const index = parseInt(parts[1], 10);
      if (!isNaN(ledger) && !isNaN(index)) {
        return { ledger, index, isParsed: true };
      }
    }
    return { token, isParsed: false };
  };
  
  const parsed1 = parseToken(token1);
  const parsed2 = parseToken(token2);
  
  // If both are parseable as ledger-index format
  if (parsed1.isParsed && parsed2.isParsed) {
    if (parsed1.ledger !== parsed2.ledger) {
      return parsed1.ledger < parsed2.ledger ? -1 : 1;
    }
    if (parsed1.index !== parsed2.index) {
      return parsed1.index < parsed2.index ? -1 : 1;
    }
    return 0;
  }
  
  // Fall back to lexicographic comparison for other token formats
  return token1 < token2 ? -1 : (token1 > token2 ? 1 : 0);
}

/**
 * Validates event ordering within a batch to detect sequence violations.
 * @param {Array} events - Array of normalized events
 * @returns {object} Validation result with any ordering violations
 */
function validateEventOrdering(events) {
  if (!Array.isArray(events) || events.length <= 1) {
    return { isValid: true, violations: [] };
  }
  
  const violations = [];
  
  for (let i = 1; i < events.length; i++) {
    const prevEvent = events[i - 1];
    const currEvent = events[i];
    
    // Check ledger sequence ordering
    if (currEvent.ledgerSequence < prevEvent.ledgerSequence) {
      violations.push({
        type: 'ledger_sequence_rollback',
        eventIndex: i,
        currentLedger: currEvent.ledgerSequence,
        previousLedger: prevEvent.ledgerSequence,
        currentEventId: currEvent.eventId,
        previousEventId: prevEvent.eventId
      });
    }
    
    // For events in the same ledger, check paging token ordering
    if (currEvent.ledgerSequence === prevEvent.ledgerSequence) {
      const tokenComparison = comparePagingTokens(prevEvent.pagingToken, currEvent.pagingToken);
      if (tokenComparison > 0) {
        violations.push({
          type: 'paging_token_rollback',
          eventIndex: i,
          ledgerSequence: currEvent.ledgerSequence,
          currentToken: currEvent.pagingToken,
          previousToken: prevEvent.pagingToken,
          currentEventId: currEvent.eventId,
          previousEventId: prevEvent.eventId
        });
      }
    }
  }
  
  return { 
    isValid: violations.length === 0,
    violations
  };
}

/**
 * Validates overall projection integrity and detects corruption.
 * @param {object} projection - Projection record to validate
 * @returns {object} Integrity validation result
 */
function validateProjectionIntegrity(projection) {
  if (!projection || typeof projection !== 'object') {
    return { isValid: false, reason: 'missing_or_invalid_projection' };
  }
  
  const violations = [];
  
  // Check required fields are present
  const requiredFields = [
    'invoice_id', 'latest_event_id', 'latest_event_type', 
    'latest_ledger_sequence', 'latest_observed_at'
  ];
  
  for (const field of requiredFields) {
    if (!projection[field]) {
      violations.push({
        type: 'missing_required_projection_field',
        field,
        projection
      });
    }
  }
  
  // Validate ledger sequence is reasonable
  if (projection.latest_ledger_sequence) {
    const ledger = Number(projection.latest_ledger_sequence);
    if (ledger <= 0 || ledger > MAX_LEDGER_SEQUENCE) {
      violations.push({
        type: 'invalid_ledger_sequence_range',
        ledgerSequence: ledger,
        validRange: [1, MAX_LEDGER_SEQUENCE]
      });
    }
  }
  
  // Validate timestamp is reasonable
  if (projection.latest_observed_at) {
    try {
      const timestamp = new Date(projection.latest_observed_at);
      if (isNaN(timestamp.getTime())) {
        violations.push({
          type: 'invalid_timestamp_format',
          timestamp: projection.latest_observed_at
        });
      } else {
        // Check for reasonable timestamp bounds
        const now = Date.now();
        const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
        const oneHourFuture = now + (60 * 60 * 1000);
        
        if (timestamp.getTime() < oneYearAgo || timestamp.getTime() > oneHourFuture) {
          violations.push({
            type: 'timestamp_out_of_reasonable_bounds',
            timestamp: projection.latest_observed_at,
            timestampMs: timestamp.getTime(),
            reasonableBounds: [new Date(oneYearAgo).toISOString(), new Date(oneHourFuture).toISOString()]
          });
        }
      }
    } catch (error) {
      violations.push({
        type: 'timestamp_parsing_error',
        timestamp: projection.latest_observed_at,
        error: error.message
      });
    }
  }
  
  // Validate event body is parseable JSON
  if (projection.latest_event_body) {
    try {
      const eventBody = typeof projection.latest_event_body === 'string' 
        ? JSON.parse(projection.latest_event_body)
        : projection.latest_event_body;
        
      if (typeof eventBody !== 'object') {
        violations.push({
          type: 'event_body_not_object',
          eventBody: projection.latest_event_body
        });
      }
    } catch (error) {
      violations.push({
        type: 'event_body_json_parse_error',
        eventBody: projection.latest_event_body,
        error: error.message
      });
    }
  }
  
  return {
    isValid: violations.length === 0,
    violations
  };
}

/**
 * Enhanced event deduplication and consistency check.
 */
function validateEventConsistency(event, existingEvent) {
  if (!existingEvent) {
    return { isConsistent: true, action: 'insert' };
  }
  
  // Check if the duplicate event has identical content
  const criticalFields = [
    'invoiceId', 'eventType', 'ledgerSequence', 
    'contractId', 'txHash', 'pagingToken'
  ];
  
  const inconsistencies = [];
  
  for (const field of criticalFields) {
    const newValue = event[field];
    const existingValue = existingEvent[field === 'eventType' ? 'event_type' : 
                                      field === 'invoiceId' ? 'invoice_id' :
                                      field === 'ledgerSequence' ? 'ledger_sequence' :
                                      field === 'contractId' ? 'contract_id' :
                                      field === 'txHash' ? 'tx_hash' :
                                      field === 'pagingToken' ? 'paging_token' : field];
    
    if (String(newValue || '') !== String(existingValue || '')) {
      inconsistencies.push({ field, newValue, existingValue });
    }
  }
  
  if (inconsistencies.length > 0) {
    return { 
      isConsistent: false, 
      action: 'reject', 
      inconsistencies,
      message: `Event ${event.eventId} has inconsistent data with existing record`
    };
  }
  
  return { isConsistent: true, action: 'ignore' };
}

/**
 * Generates a deterministic fingerprint for an event to detect duplicates 
 * even with different eventIds.
 * @param {object} event - Normalized event
 * @returns {string} SHA-256 hash of critical event fields
 */
function generateEventFingerprint(event) {
  const crypto = require('crypto');
  
  // Include fields that should be unique per real event
  const fingerprintData = {
    invoiceId: event.invoiceId,
    ledgerSequence: event.ledgerSequence,
    pagingToken: event.pagingToken || '',
    contractId: event.contractId || '',
    txHash: event.txHash || '',
    // Include a subset of eventBody for additional uniqueness
    eventBodyHash: event.eventBody ? 
      crypto.createHash('sha256').update(JSON.stringify(event.eventBody)).digest('hex').substring(0, 16) :
      ''
  };
  
  const fingerprintStr = JSON.stringify(fingerprintData, Object.keys(fingerprintData).sort());
  return crypto.createHash('sha256').update(fingerprintStr).digest('hex');
}

/**
 * Decides whether an incoming event should replace the current per-invoice
 * projection, ordering by ledger sequence and breaking ties on paging token.
 *
 * @param {object|null} currentProjection - Existing projection row, or null.
 * @param {object} event - Incoming normalized event.
 * @returns {boolean} True if the incoming event is newer and should replace.
 */
/**
 * Enhanced projection replacement logic with additional safety checks and ordering validation.
 * @param {object|null} currentProjection - Existing projection row, or null.
 * @param {object} event - Incoming normalized event.
 * @returns {boolean} True if the incoming event is newer and should replace.
 */
function shouldReplaceProjection(currentProjection, event) {
  if (!currentProjection) {
    return true;
  }

  // Validate input parameters
  if (!event || typeof event.ledgerSequence !== 'number') {
    return false;
  }

  const currentLedger = Number(currentProjection.latest_ledger_sequence || 0);
  const incomingLedger = event.ledgerSequence;
  
  // Ledger sequence comparison
  if (incomingLedger > currentLedger) {
    return true;
  }
  if (incomingLedger < currentLedger) {
    return false;
  }

  // Ledger sequences are equal - use paging token as tiebreaker
  const currentToken = String(currentProjection.latest_paging_token || '');
  const incomingToken = String(event.pagingToken || '');
  
  // For equal ledger sequences, use proper paging token comparison
  const tokenComparison = comparePagingTokens(currentToken, incomingToken);
  return tokenComparison < 0; // Replace if incoming token is greater
}

/**
 * Validates projection consistency and detects potential ordering violations.
 * @param {object|null} currentProjection - Current projection state
 * @param {object} event - New event to apply
 * @returns {object} Validation result with consistency check
 */
function validateProjectionConsistency(currentProjection, event) {
  if (!currentProjection) {
    return { isValid: true, action: 'create', reason: 'no_existing_projection' };
  }
  
  if (!event || typeof event !== 'object') {
    return { isValid: false, action: 'reject', reason: 'invalid_event_object' };
  }
  
  const currentLedger = Number(currentProjection.latest_ledger_sequence || 0);
  const incomingLedger = event.ledgerSequence;
  
  // Check for significant ledger sequence gaps that might indicate missing events
  if (incomingLedger > currentLedger + MAX_LEDGER_GAP_THRESHOLD) {
    return {
      isValid: false,
      action: 'reject',
      reason: 'large_ledger_gap',
      gap: incomingLedger - currentLedger,
      currentLedger,
      incomingLedger
    };
  }
  
  // Check for reasonable time progression
  if (currentProjection.latest_observed_at && event.observedAt) {
    const currentTime = new Date(currentProjection.latest_observed_at).getTime();
    const incomingTime = new Date(event.observedAt).getTime();
    
    // Allow for some clock skew but detect major time reversals
    if (incomingTime < currentTime - MAX_TIME_REVERSAL_MS) {
      return {
        isValid: false,
        action: 'reject', 
        reason: 'significant_time_reversal',
        currentTime: currentProjection.latest_observed_at,
        incomingTime: event.observedAt,
        reversalMs: currentTime - incomingTime
      };
    }
  }
  
  // Validate event belongs to the same invoice
  if (event.invoiceId !== currentProjection.invoice_id) {
    return {
      isValid: false,
      action: 'reject',
      reason: 'invoice_id_mismatch',
      currentInvoiceId: currentProjection.invoice_id,
      incomingInvoiceId: event.invoiceId
    };
  }
  
  const shouldReplace = shouldReplaceProjection(currentProjection, event);
  
  return {
    isValid: true,
    action: shouldReplace ? 'update' : 'ignore',
    reason: shouldReplace ? 'newer_event' : 'older_or_equal_event',
    shouldReplace
  };
}

/**
 * Classifies a per-event persistence failure as permanent (skippable) or
 * transient (must abort the cycle).
 *
 * Invariant: only structured validation failures are permanent. A malformed
 * payload can never become valid on retry, so it is skipped and the cursor may
 * advance past it. Every other error (database, transaction, network, cache) is
 * transient and must abort the cycle **before** the cursor advances — otherwise
 * the unpersisted event is silently lost.
 *
 * @param {Error} error - Error thrown while persisting a single event.
 * @returns {boolean} True when the event may be skipped without aborting.
 */
function isSkippableEventError(error) {
  return Boolean(error) && (error instanceof ValidationError || error.name === 'ValidationError');
}

/**
 * Persists a single escrow event idempotently and updates the per-invoice
 * projection if the event is newer than the current one.
 *
 * All operations are performed within a single transaction to ensure atomicity
 * and prevent race conditions between projection reads and writes.
 *
 * @param {object} deps - Dependencies.
 * @param {object} deps.store - Event store implementation.
 * @param {Function} deps.transactionRunner - Runs a callback within a transaction.
 * @param {string} [deps.fenceToken] - Lease fencing token required for fenced writes.
 * @param {object} rawEvent - Raw event to normalize and persist.
 * @returns {Promise<object>} Resolves with normalized event when written.
 * @throws {ValidationError} When event validation fails.
 * @throws {LeaseLostError} When lease validation fails.
 */
async function persistEscrowEvent({ store, transactionRunner, fenceToken }, rawEvent) {
  const event = normalizeEvent(rawEvent);
  const eventFingerprint = generateEventFingerprint(event);

  let persistedEvent = null;
  
  await transactionRunner(async (trx) => {
    // Validate lease within transaction to prevent TOCTOU issues
    if (fenceToken && typeof store.assertLease === 'function') {
      await store.assertLease(trx, fenceToken);
    }
    
    // Check for existing event with same ID for consistency validation
    let existingEvent = null;
    if (typeof store.findEventById === 'function') {
      try {
        existingEvent = await store.findEventById(event.eventId);
      } catch (error) {
        // Log but don't fail on duplicate check errors
        logger.warn({ err: error, eventId: event.eventId }, 'Failed to check for duplicate event');
      }
    }
    
    // Validate consistency if event already exists
    if (existingEvent) {
      const consistencyCheck = validateEventConsistency(event, existingEvent);
      
      if (!consistencyCheck.isConsistent) {
        throw new ValidationError(
          consistencyCheck.message,
          'INCONSISTENT_DUPLICATE',
          { 
            eventId: event.eventId,
            inconsistencies: consistencyCheck.inconsistencies
          }
        );
      }
      
      // Event is consistent duplicate - safe to continue with projection check
      if (consistencyCheck.action === 'ignore') {
        logger.debug({ eventId: event.eventId }, 'Ignoring consistent duplicate event');
      }
    }
    
    // Insert event idempotently
    await store.upsertEvent(trx, event);
    
    // Read current projection within the same transaction to prevent race conditions
    const currentProjection = typeof store.findProjectionWithinTrx === 'function'
      ? await store.findProjectionWithinTrx(trx, event.invoiceId)
      : await store.findProjection(event.invoiceId);
    
    // Validate projection integrity if it exists
    if (currentProjection) {
      const integrityCheck = validateProjectionIntegrity(currentProjection);
      if (!integrityCheck.isValid) {
        throw new ValidationError(
          `Existing projection integrity violation detected for invoice ${event.invoiceId}`,
          'PROJECTION_INTEGRITY_ERROR',
          {
            invoiceId: event.invoiceId,
            violations: integrityCheck.violations
          }
        );
      }
    }
    
    // Validate state transitions and business constraints
    const stateValidation = validateStateTransitionAndConstraints(event, currentProjection);
    if (!stateValidation.isValid) {
      if (LOG_STATE_VIOLATIONS) {
        logger.warn(
          {
            eventId: event.eventId,
            invoiceId: event.invoiceId,
            violations: stateValidation.violations,
            transitionDetails: stateValidation.transitionValidation
          },
          'State transition or business constraint violation detected'
        );
      }
      
      // Only enforce if configured to do so
      if (ENFORCE_STATE_TRANSITIONS || ENFORCE_BUSINESS_CONSTRAINTS) {
        // Check which type of violation this is
        const hasTransitionViolation = stateValidation.violations.some(v => v.type === 'invalid_state_transition');
        const hasConstraintViolation = stateValidation.violations.some(v => v.type !== 'invalid_state_transition');
        
        const shouldEnforce = (
          (hasTransitionViolation && ENFORCE_STATE_TRANSITIONS) ||
          (hasConstraintViolation && ENFORCE_BUSINESS_CONSTRAINTS)
        );
        
        if (shouldEnforce) {
          throw new ValidationError(
            `State transition or business constraint violation for event ${event.eventId}`,
            'STATE_VALIDATION_ERROR',
            {
              eventId: event.eventId,
              invoiceId: event.invoiceId,
              violations: stateValidation.violations,
              transitionDetails: stateValidation.transitionValidation
            }
          );
        }
      }
    }
    
    // Validate projection consistency before updating
    const projectionValidation = validateProjectionConsistency(currentProjection, event);
    
    if (!projectionValidation.isValid) {
      throw new ValidationError(
        `Projection consistency violation: ${projectionValidation.reason}`,
        'PROJECTION_CONSISTENCY_ERROR',
        {
          invoiceId: event.invoiceId,
          eventId: event.eventId,
          validation: projectionValidation
        }
      );
    }
    
    // Only update projection if validation indicates we should
    if (projectionValidation.action === 'update' || projectionValidation.action === 'create') {
      await store.upsertProjection(trx, event);
    }
    
    persistedEvent = event;
  });

  // Invalidation only occurs after successful transaction commit
  // Projection writes supersede any process-local response cached for this invoice.
  escrowReadCache.invalidate(persistedEvent.invoiceId);

  // Invalidate the indexer listing cache so stale total counts and pages are dropped.
  // Only invalidates when the indexer feature flag is enabled, avoiding unnecessary
  // cache churn when the indexer surface is disabled.
  if (isIndexerEnabled()) {
    indexerCache.invalidateAll();
  }

  return persistedEvent;
}

/* istanbul ignore next -- network/Horizon integration tested separately; unit tests inject fetchEscrowEvents via DI. */
/**
 * Fetches escrow contract events from Horizon, resolving each to an invoice ID
 * and skipping records that cannot be resolved.
 *
 * @param {object} params - Fetch parameters.
 * @param {string} params.baseUrl - Horizon base URL.
 * @param {string|null} params.cursor - Paging cursor to resume from.
 * @param {number} params.limit - Maximum number of records to request.
 * @returns {Promise<{events: object[], nextCursor: string|null}>} Resolved
 *   events and the next paging cursor.
 */
async function fetchEscrowEventsFromHorizon({ baseUrl, cursor, limit }) {
  // Validate input parameters with strict bounds
  const validatedBaseUrl = validateStringField(baseUrl, 'baseUrl', 2048, true);
  const validatedCursor = validateStringField(cursor, 'cursor', MAX_PAGING_TOKEN_LENGTH, false);
  const validatedLimit = validateNumericField(limit, 'limit', 1, MAX_BATCH_SIZE, true);
  
  // Validate URL format
  let endpoint;
  try {
    endpoint = new URL('/events', validatedBaseUrl);
  } catch (error) {
    throw new Error(`Invalid Horizon base URL: ${validatedBaseUrl}`);
  }
  
  endpoint.searchParams.set('order', 'asc');
  endpoint.searchParams.set('limit', String(validatedLimit));
  if (validatedCursor) {
    endpoint.searchParams.set('cursor', validatedCursor);
  }

  const response = await fetch(endpoint, {
    headers: { 
      Accept: 'application/json',
      'User-Agent': 'LiquifactIndexer/1.0'
    },
    // Add timeout to prevent hanging requests
    signal: AbortSignal.timeout(30_000), // 30 second timeout
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Horizon events request failed (${response.status}): ${text}`);
  }
  
  // Validate response size to prevent DoS
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > 10 * 1024 * 1024) { // 10MB limit
    throw new Error('Horizon response too large');
  }

  const payload = await response.json();
  
  // Validate response structure
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid Horizon response format');
  }
  
  const records = payload && payload._embedded && Array.isArray(payload._embedded.records)
    ? payload._embedded.records
    : [];
  
  // Validate record count doesn't exceed requested limit
  if (records.length > validatedLimit) {
    throw new Error(`Horizon returned more records (${records.length}) than requested (${validatedLimit})`);
  }

  const events = records
    .map((record) => {
      try {
        // Validate record structure
        if (!record || typeof record !== 'object') {
          return null;
        }
        
        const invoiceId = deriveInvoiceId(record);
        if (!invoiceId) {
          return null;
        }
        
        // Validate critical fields before creating event
        const eventId = validateStringField(record.id, 'record.id', MAX_EVENT_ID_LENGTH, false);
        const pagingToken = validateStringField(record.paging_token, 'record.paging_token', MAX_PAGING_TOKEN_LENGTH, false);
        const ledgerSequence = validateNumericField(record.ledger, 'record.ledger', MIN_LEDGER_SEQUENCE, MAX_LEDGER_SEQUENCE, false);
        
        return {
          eventId: eventId || '',
          invoiceId,
          eventType: record.type || 'contract_event',
          ledgerSequence: ledgerSequence || 0,
          pagingToken: pagingToken || '',
          contractId: record.contract_id || null,
          txHash: record.tx_hash || null,
          eventBody: validateJsonField(record, 'record'),
          observedAt: new Date().toISOString(),
        };
      } catch (error) {
        // Log individual record errors but continue processing
        logger.warn({ err: error, recordId: record && record.id }, 'Failed to process Horizon record');
        return null;
      }
    })
    .filter((event) => event !== null);

  const nextCursor = records.length > 0
    ? validateStringField(records[records.length - 1].paging_token, 'nextCursor', MAX_PAGING_TOKEN_LENGTH, false) || validatedCursor || null
    : validatedCursor || null;

  return { events, nextCursor };
}

/**
 * Runs one indexing cycle: fetches events, persists valid ones, skips invalid
 * ones, and advances the cursor when it changes.
 *
 * Concurrency invariants:
 * - Only one worker may run a cycle at a time, enforced by the store lease.
 *   When the lease is held elsewhere the cycle is a no-op and resolves `null`.
 * - The cursor only advances after every event in the batch has either been
 *   persisted or permanently rejected as invalid. A transient persistence
 *   failure aborts the cycle with the cursor unchanged, so the batch is safely
 *   retried (event writes are idempotent via `event_id`).
 * - Cursor writes are fenced by the lease token, so a worker whose lease
 *   expired cannot regress the checkpoint.
 *
 * ## Deterministic failure recovery
 *
 * ### Transient-error retry
 * Both the Horizon fetch and individual event persistence calls are wrapped in
 * {@link withRetry}.  Transient errors (network timeouts, DB connection resets)
 * are retried up to `MAX_RETRY_ATTEMPTS` times with capped exponential backoff
 * and jitter.  `ValidationError` and `LeaseLostError` are never retried —
 * they are permanent failures that do not benefit from a second attempt.
 *
 * ### Partial-batch checkpoint
 * If a transient error exhausts all retries mid-batch, the cursor is advanced
 * to the paging token of the **last successfully processed event** before the
 * error is re-thrown.  This prevents the next cycle from re-processing already-
 * persisted events, making progress even on a partially-completed batch.
 *
 * ### Observability
 * - Retry attempts are logged at WARN with attempt count, delay, and context.
 * - Partial checkpoints are logged at WARN with the saved cursor value.
 * - The returned summary includes `retriedEvents` and `partialCursorSaved`.
 *
 * @param {object} deps - Cycle dependencies.
 * @param {object} deps.store - Event store implementation.
 * @param {Function} deps.fetchEscrowEvents - Fetches a batch of events.
 * @param {Function} deps.transactionRunner - Runs a callback within a transaction.
 * @param {object} [deps.log] - Logger with warn/info/error.
 * @param {number} [deps.batchSize] - Max events to fetch per cycle.
 * @param {number} [deps.leaseDurationMs] - Lease duration in milliseconds.
 * @param {number} [deps.maxRetryAttempts] - Override for retry budget per operation.
 * @param {number} [deps.baseRetryDelayMs] - Override for retry base delay.
 * @returns {Promise<object|null>} Summary with processed/skipped/retriedEvents/
 *   partialCursorSaved counts and cursorBefore/cursorAfter, or null if lease
 *   was not acquired.
 *
 */
async function runEscrowIndexerCycle({
  store,
  fetchEscrowEvents,
  transactionRunner,
  log = logger,
  batchSize = DEFAULT_BATCH_SIZE,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  maxRetryAttempts = MAX_RETRY_ATTEMPTS,
  baseRetryDelayMs = BASE_RETRY_DELAY_MS,
}) {
  // Validate input parameters with boundary checks
  if (!store || typeof store !== 'object') {
    throw new Error('Store must be a valid object with required methods.');
  }
  
  if (!fetchEscrowEvents || typeof fetchEscrowEvents !== 'function') {
    throw new Error('fetchEscrowEvents must be a function.');
  }
  
  if (!transactionRunner || typeof transactionRunner !== 'function') {
    throw new Error('transactionRunner must be a function.');
  }
  
  // Validate and bound batch size to prevent memory exhaustion
  const validatedBatchSize = validateNumericField(batchSize, 'batchSize', 1, MAX_BATCH_SIZE, false) || DEFAULT_BATCH_SIZE;
  const validatedLeaseDuration = validateLeaseDuration(leaseDurationMs);
  
  let lease = null;
  
  try {
    // Acquire lease with enhanced race condition protection
    if (typeof store.acquireLease === 'function') {
      lease = await store.acquireLease({ leaseDurationMs: validatedLeaseDuration });
      
      if (!lease) {
        log.info({}, 'Escrow indexer cycle skipped; lease is held by another worker.');
        return null;
      }
      
      // Validate lease immediately after acquisition
      if (!hasLeaseTimeRemaining(lease)) {
        log.warn({ leaseToken: lease.token }, 'Acquired lease has insufficient time remaining.');
        await store.completeLease(lease.token).catch(() => {});
        return null;
      }
      
      log.info(
        { leaseToken: lease.token, expiresAt: new Date(lease.expiresAt).toISOString() },
        'Escrow indexer lease acquired.'
      );
    }

    const cursor = await store.loadCursor();

    // ── Fetch with retry ───────────────────────────────────────────────────
    const { result: fetchResult, retried: fetchRetried } = await withRetry(
      () => fetchEscrowEvents({ cursor, limit: batchSize }),
      {
        maxAttempts: maxRetryAttempts,
        baseDelayMs: baseRetryDelayMs,
        log,
        context: 'fetchEscrowEvents',
      }
    );

    if (fetchRetried > 0) {
      log.info(
        { fetchRetried, cursor },
        `Escrow indexer fetch succeeded after ${fetchRetried} retr${fetchRetried === 1 ? 'y' : 'ies'}.`
      );
    }

    const { events, nextCursor } = fetchResult;

    let processed = 0;
    let skipped = 0;
    let retriedEvents = 0;
    // Tracks the paging token of the last successfully persisted event so we
    // can checkpoint the cursor on a partial-batch failure.
    let lastSuccessfulPagingToken = null;
    let partialCursorSaved = false;

    for (const rawEvent of events) {
      try {
        // ── Lease renewal ──────────────────────────────────────────────────
        if (lease && typeof store.renewLease === 'function') {
          const renewed = await store.renewLease(lease.token, leaseDurationMs);
          if (!renewed) {
            throw new LeaseLostError('Escrow indexer lease expired before renewal.', 'LEASE_EXPIRED');
          }
          lease.expiresAt = renewed.expiresAt;
          log.info(
            { leaseToken: lease.token, expiresAt: new Date(lease.expiresAt).toISOString() },
            'Escrow indexer lease renewed.'
          );
        }

        // ── Persist with retry ─────────────────────────────────────────────
        const { retried: persistRetried } = await withRetry(
          () => persistEscrowEvent(
            { store, transactionRunner, fenceToken: lease && lease.token },
            rawEvent
          ),
          {
            maxAttempts: maxRetryAttempts,
            baseDelayMs: baseRetryDelayMs,
            log,
            context: `persistEscrowEvent(eventId=${rawEvent && rawEvent.eventId})`,
          }
        );

        if (persistRetried > 0) {
          retriedEvents += 1;
          log.info(
            { eventId: rawEvent && rawEvent.eventId, persistRetried },
            `Escrow event persisted after ${persistRetried} retr${persistRetried === 1 ? 'y' : 'ies'}.`
          );
        }

        processed += 1;
        // Advance the partial-checkpoint cursor to this event's paging token.
        if (rawEvent && rawEvent.pagingToken) {
          lastSuccessfulPagingToken = rawEvent.pagingToken;
        }
      } catch (error) {
        if (error instanceof LeaseLostError) {
          log.error(
            { err: error, eventId: rawEvent && rawEvent.eventId },
            'Escrow indexer lease lost; aborting cycle.'
          );
          // ── Partial-batch checkpoint ─────────────────────────────────────
          // Save progress up to the last successful event so the next cycle
          // resumes from where we left off rather than re-scanning from the
          // beginning of the batch.
          if (lastSuccessfulPagingToken && lastSuccessfulPagingToken !== cursor) {
            try {
              // No fenceToken here — the lease is already gone.
              await store.saveCursor(lastSuccessfulPagingToken);
              partialCursorSaved = true;
              log.warn(
                { partialCursor: lastSuccessfulPagingToken },
                'Escrow indexer saved partial-batch checkpoint cursor before LeaseLost abort.'
              );
            } catch (saveErr) {
              log.error(
                { err: saveErr, partialCursor: lastSuccessfulPagingToken },
                'Escrow indexer failed to save partial-batch checkpoint cursor.'
              );
            }
          }
          throw error;
        }

        if (!isSkippableEventError(error)) {
          // A transient persistence failure has exhausted its retry budget.
          // Save progress up to the last successfully persisted event so the
          // next cycle does not re-process already-completed events, but never
          // advance past the event that failed.
          if (lastSuccessfulPagingToken && lastSuccessfulPagingToken !== cursor) {
            try {
              await store.saveCursor(lastSuccessfulPagingToken, lease && lease.token);
              partialCursorSaved = true;
              log.warn(
                {
                  partialCursor: lastSuccessfulPagingToken,
                  eventId: rawEvent && rawEvent.eventId,
                },
                'Escrow indexer saved partial-batch checkpoint cursor after transient persistence failure.'
              );
            } catch (saveErr) {
              log.error(
                {
                  err: saveErr,
                  partialCursor: lastSuccessfulPagingToken,
                  eventId: rawEvent && rawEvent.eventId,
                },
                'Escrow indexer failed to save partial-batch checkpoint cursor.'
              );
            }
          }

          // Fail closed. Never count an unpersisted event as skipped or advance
          // the cursor past it. Re-throw so the next cycle can retry it.
          log.error(
            { err: error, eventId: rawEvent && rawEvent.eventId },
            'Escrow indexer aborted; event could not be persisted, cursor will not advance past the failed event.'
          );
          throw error;
        }

        // ValidationError represents a permanently invalid event. It is safe
        // to skip because retrying cannot make the malformed payload valid.
        skipped += 1;
        log.warn(
          { err: error, eventId: rawEvent && rawEvent.eventId, code: error.code },
          'Skipping invalid escrow event.'
        );
      }
    }

    // Only advance cursor if we have processed all events successfully and still hold lease
    if (nextCursor && nextCursor !== cursor) {
      if (lease && typeof store.assertLease === 'function') {
        await store.assertLease(null, lease.token);
      }
      
      // Validate cursor advancement before saving
      const cursorValidation = validateCursorOrdering(cursor, nextCursor);
      if (!cursorValidation.isValid) {
        log.error(
          { 
            currentCursor: cursor,
            proposedCursor: nextCursor,
            reason: cursorValidation.reason
          },
          'Cursor advancement validation failed'
        );
        throw new Error(`Invalid cursor advancement: ${cursorValidation.reason}`);
      }
      
      await store.saveCursor(nextCursor, lease && lease.token);
    }

    return {
      processed,
      skipped,
      retriedEvents,
      partialCursorSaved,
      cursorBefore: cursor,
      cursorAfter: nextCursor || cursor || null,
      leaseToken: lease && lease.token,
    };
  } catch (error) {
    // Always clean up lease on failure to prevent blocking other workers
    if (lease && typeof store.completeLease === 'function') {
      try {
        await store.completeLease(lease.token);
        log.info({ leaseToken: lease.token }, 'Escrow indexer lease cleaned up after failure.');
      } catch (cleanupError) {
        log.error({ err: cleanupError, leaseToken: lease.token }, 'Failed to clean up lease after cycle failure.');
      }
    }
    throw error;
  } finally {
    // Complete lease on successful cycle completion
    if (lease && typeof store.completeLease === 'function') {
      try {
        await store.completeLease(lease.token);
        log.info({ leaseToken: lease.token }, 'Escrow indexer lease completed.');
      } catch (completionError) {
        log.warn({ err: completionError, leaseToken: lease.token }, 'Error completing lease.');
      }
    }
  }
}

/**
 * Creates an escrow indexer with start/stop polling control and a re-entrancy
 * guarded runCycle.
 *
 * @param {object} [options] - Indexer options (store, fetchEscrowEvents,
 *   transactionRunner, pollIntervalMs, log).
 * @returns {{start: Function, stop: Function, runCycle: Function}} Indexer handle.
 */
function createEscrowIndexer(options = {}) {
  // Validate options object
  if (options !== null && typeof options !== 'object') {
    throw new Error('Options must be an object or null.');
  }
  
  /* istanbul ignore next -- default DB-backed wiring exercised in integration tests; unit tests inject store via DI. */
  const store = options.store || createKnexEscrowEventStore(options.db || db);
  
  const horizonBaseUrl = validateStringField(
    options.horizonBaseUrl || process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    'horizonBaseUrl',
    2048, // Max URL length
    true
  );
  
  // Validate URL format
  try {
    new URL(horizonBaseUrl);
  } catch (error) {
    throw new Error(`Invalid Horizon base URL: ${horizonBaseUrl}`);
  }
  
  const fetchEscrowEvents =
    options.fetchEscrowEvents ||
    /* istanbul ignore next -- default Horizon fetch exercised in integration tests; unit tests inject fetchEscrowEvents via DI. */
    ((params) => fetchEscrowEventsFromHorizon({
      baseUrl: horizonBaseUrl,
      cursor: params.cursor,
      limit: params.limit,
    }));
  const transactionRunner =
    options.transactionRunner ||
    /* istanbul ignore next -- default transaction runner exercised with knex; unit tests inject transactionRunner via DI. */
    createSafeTransactionRunner(options.db || db, {
      timeoutMs: validateNumericField(
        Number(process.env.ESCROW_INDEXER_TX_TIMEOUT_MS || 30_000),
        'transactionTimeout',
        1000,
        300_000, // Max 5 minutes
        false
      ) || 30_000,
      isolationLevel: validateStringField(
        process.env.ESCROW_INDEXER_TX_ISOLATION || 'read committed',
        'isolationLevel',
        50,
        false
      ) || 'read committed'
    });
    
  const pollIntervalMs = validateNumericField(
    Number(options.pollIntervalMs || process.env.ESCROW_INDEXER_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    'pollIntervalMs',
    1000, // Min 1 second
    300_000, // Max 5 minutes
    false
  ) || DEFAULT_POLL_INTERVAL_MS;
  
  const leaseDurationMs = validateNumericField(
    Number(options.leaseDurationMs ||
    process.env.ESCROW_INDEXER_LEASE_DURATION_MS ||
    DEFAULT_LEASE_DURATION_MS),
    'leaseDurationMs',
    LEASE_RENEWAL_BUFFER_MS,
    MAX_LEASE_DURATION_MS,
    false
  ) || DEFAULT_LEASE_DURATION_MS;

  let timer = null;
  let running = false;

  const runCycle = async () => {
    if (running) {
      return null;
    }
    running = true;
    try {
      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
        log: options.log || logger,
        batchSize: Number(process.env.ESCROW_INDEXER_BATCH_SIZE || DEFAULT_BATCH_SIZE),
        leaseDurationMs,
      });

      if (!summary) {
        // The lease is held by another worker. Under concurrent execution this
        // is a normal, expected outcome, so it must not be recorded as a cycle
        // failure or have its (absent) counters dereferenced.
        return null;
      }

      (options.log || logger).info(summary, 'Escrow indexer cycle completed.');

      // Emit metrics
      try {
        // Validate processed count
        if (!Number.isInteger(summary.processed) || summary.processed < 0) {
          (options.log || logger).error(
            { processed: summary.processed },
            'Invalid processed count; incrementing cycle failures'
          );
          escrowIndexerCycleFailuresTotal.inc();
        } else {
          escrowIndexerEventsProcessedTotal.inc(summary.processed);
        }

        // Validate skipped count
        if (!Number.isInteger(summary.skipped) || summary.skipped < 0) {
          (options.log || logger).error(
            { skipped: summary.skipped },
            'Invalid skipped count; incrementing cycle failures'
          );
          escrowIndexerCycleFailuresTotal.inc();
        } else {
          escrowIndexerEventsSkippedTotal.inc(summary.skipped);
        }

        // Update last-advance gauge if cursor advanced
        if (summary.cursorAfter !== summary.cursorBefore) {
          escrowIndexerLastCursorAdvanceTimestampSeconds.set(Math.floor(Date.now() / 1000));
        }
      } catch (metricsError) {
        (options.log || logger).error({ err: metricsError }, 'Error emitting indexer metrics');
        escrowIndexerCycleFailuresTotal.inc();
      }

      return summary;
    } catch (error) {
      (options.log || logger).error({ err: error }, 'Escrow indexer cycle failed.');
      escrowIndexerCycleFailuresTotal.inc();
      return null;
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer) {
      return;
    }
    runCycle().catch(() => {});
    timer = setInterval(() => {
      runCycle().catch(() => {});
    }, pollIntervalMs);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, runCycle };
}

module.exports = {
  createEscrowIndexer,
  createKnexEscrowEventStore,
  createSafeTransactionRunner,
  CircuitBreaker,
  deriveInvoiceId,
  fetchEscrowEventsFromHorizon,
  normalizeEvent,
  persistEscrowEvent,
  runEscrowIndexerCycle,
  shouldReplaceProjection,
  isSkippableEventError,
  validateEventConsistency,
  validateProjectionConsistency,
  validateProjectionIntegrity,
  validateStateTransition,
  validateBusinessConstraints,
  validateStateTransitionAndConstraints,
  validateCursorOrdering,
  validateEventOrdering,
  comparePagingTokens,
  generateEventFingerprint,
  validateStringField,
  validateNumericField,
  validateJsonField,
  isValidStellarContractId,
  isValidTxHash,
  ValidationError,
  LeaseLostError,
  // Exported for testing
  withRetry,
  isNonRetryableError,
  MAX_RETRY_ATTEMPTS,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
};
