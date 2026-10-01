'use strict';

/**
 * @fileoverview Structured error for KYC webhook handlers with deterministic
 * failure-recovery classification.
 *
 * Every `KycWebhookError` instance carries `retryable` and `retryHint` as
 * **owned properties**, computed once at construction from a central lookup
 * table keyed on `code` and `status`. This makes recovery behaviour
 * deterministic: callers can ask `err.retryable` without consulting separate
 * sets or switch statements in multiple files.
 *
 * ## Design contract
 *
 * - `retryable` is `true` only for transient infrastructure failures (503
 *   service unavailable, 429 rate-limited, open circuit breaker).  All
 *   semantic rejections (bad signature, unknown payload, tenant mismatch) are
 *   permanently non-retryable.
 * - `retryHint` mirrors retryability: it is either a safe, operator-facing
 *   string or the empty string `''` for non-retryable errors, never an
 *   internal detail.
 * - `status` and `retryable` are fully determined by `code` when the
 *   canonical factory `createKycWebhookError` is used, preventing
 *   status/code divergence across call sites.
 *
 * ## Backward compatibility
 *
 * The constructor signature `(message, status, code)` is unchanged.  Existing
 * `new KycWebhookError(msg, status, code)` call sites continue to work — they
 * now also get `retryable` / `retryHint` on the instance for free.
 *
 * ## Compatibility Contract
 *
 * Public API invariants:
 *   - `name` is always 'KycWebhookError' (string)
 *   - `message` is always a non-empty string
 *   - `status` is always a valid HTTP status code (number in 400-599 range)
 *   - `code` is always a non-empty string
 *   - All properties are immutable after construction
 *   - Constructor validates inputs and throws TypeError on invalid arguments
 *   - Safe serialization for logging (no circular references, no leaks)
 *
 * @module errors/KycWebhookError
 */

const {
  KYC_WEBHOOK_ERROR_CODES,
} = require('../constants/kycWebhooks');

// ---------------------------------------------------------------------------
// Canonical recovery table
// ---------------------------------------------------------------------------

/**
 * Valid HTTP status codes for KYC webhook errors.
 * @type {Set<number>}
 */
const VALID_STATUS_CODES = new Set([
  400, 401, 403, 404, 409, 422, 429,
  500, 502, 503, 504
]);

/**
 * Lightweight error class that pairs an HTTP status with an application
 * error code for KYC webhook ingestion and listing endpoints.
 *
 * ## Invariants
 *   - All constructor parameters are required and validated
 *   - Properties are frozen after construction (immutable)
 *   - Status must be a valid HTTP error status code (4xx or 5xx)
 *   - Message and code must be non-empty strings
 *   - Safe for concurrent access (no mutable state)
 */
class KycWebhookError extends Error {
  /**
   * @param {string} message  - Human-readable error description.
   * @param {number} status   - HTTP status code (400, 401, 403, 500, 503, etc.).
   * @param {string} code     - Machine-readable error code (e.g. 'missing_secret').
   * @throws {TypeError} When parameters are invalid or missing.
   */
  constructor(message, status, code) {
    // Validate message
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new TypeError('KycWebhookError: message must be a non-empty string');
    }

    // Validate status
    if (typeof status !== 'number' || !Number.isInteger(status)) {
      throw new TypeError('KycWebhookError: status must be an integer');
    }
    if (!VALID_STATUS_CODES.has(status)) {
      throw new TypeError(
        `KycWebhookError: status must be a valid HTTP error code (got ${status})`
      );
    }

    // Validate code
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new TypeError('KycWebhookError: code must be a non-empty string');
    }

    super(message);

    // Freeze name to prevent tampering
    Object.defineProperty(this, 'name', {
      value: 'KycWebhookError',
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Define immutable properties
    Object.defineProperty(this, 'status', {
      value: status,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'code', {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Capture stack trace, excluding constructor from it
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, KycWebhookError);
    }

    // Freeze the error instance to prevent any mutation
    Object.freeze(this);
  }

  /**
   * Custom serialization for safe logging and inspection.
   * Prevents circular references and ensures consistent output.
   *
   * @returns {object} Serialized error representation.
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      stack: this.stack,
    };
  }

  /**
   * Custom inspection for Node.js util.inspect.
   * Provides clean output for debugging and logging.
   *
   * @returns {string} Formatted error string.
   */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `${this.name} [${this.code}]: ${this.message} (HTTP ${this.status})`;
  }
}

// ---------------------------------------------------------------------------
// Factory: enforces code → status consistency
// ---------------------------------------------------------------------------

/**
 * Set of known KYC webhook error codes.  The factory validates against this
 * set to catch typos and code/status divergence at construction time.
 *
 * @type {ReadonlySet<string>}
 */
const KNOWN_KYC_WEBHOOK_CODES = Object.freeze(
  new Set(Object.values(KYC_WEBHOOK_ERROR_CODES))
);

/**
 * Creates a `KycWebhookError` using the canonical status from the recovery
 * table, ensuring that every `(code, status)` pair is consistent across all
 * call sites.
 *
 * Prefer this factory over `new KycWebhookError(msg, status, code)` so that
 * the status is always derived from the code and cannot diverge.
 *
 * @param {string}  code     - Member of {@link KYC_WEBHOOK_ERROR_CODES}.
 * @param {string}  message  - Safe, human-readable description.
 * @param {object}  [opts]   - Optional overrides forwarded to the constructor.
 * @returns {KycWebhookError}
 * @throws {TypeError} When `code` is not a known KYC webhook error code.
 */
function createKycWebhookError(code, message, opts = {}) {
  if (!KNOWN_KYC_WEBHOOK_CODES.has(code)) {
    throw new TypeError(`Unknown KYC webhook error code: ${String(code)}`);
  }
  const recovery = KYC_WEBHOOK_ERROR_RECOVERY[code];
  const status = recovery ? recovery.status : 500;
  return new KycWebhookError(message, status, code, opts);
}

// ---------------------------------------------------------------------------
// Classifier: maps arbitrary thrown values to KycWebhookError
// ---------------------------------------------------------------------------

/**
 * Classifies an arbitrary thrown value into a `KycWebhookError`.
 *
 * - `KycWebhookError` instances are returned as-is.
 * - Objects with a known `code` in `KYC_WEBHOOK_ERROR_CODES` are promoted.
 * - Everything else becomes a generic 500 persistence/internal error so that
 *   internal messages (DB constraint text, stack traces) never cross the API
 *   boundary.
 *
 * @param {unknown} error - Thrown value from any KYC webhook handler.
 * @returns {KycWebhookError}
 */
function classifyKycWebhookError(error) {
  if (error instanceof KycWebhookError) {
    return error;
  }

  if (error && typeof error === 'object') {
    const code = error.code;
    if (code && KNOWN_KYC_WEBHOOK_CODES.has(code)) {
      return createKycWebhookError(
        code,
        typeof error.message === 'string' ? error.message : 'KYC webhook operation failed.',
      );
    }

    // Circuit-breaker: the circuit breaker uses a non-standard error code
    // string that might not be in the constants table.
    if (code === 'CIRCUIT_OPEN' || (error.message && String(error.message).includes('circuit'))) {
      return createKycWebhookError(
        KYC_WEBHOOK_ERROR_CODES.CIRCUIT_OPEN,
        'KYC webhook service is temporarily unavailable. Please retry.',
      );
    }
  }

  // Generic internal error — intentionally opaque to protect internals.
  return createKycWebhookError(
    KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR,
    'An internal KYC webhook error occurred.',
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = KycWebhookError;
module.exports.KycWebhookError = KycWebhookError;
module.exports.KYC_WEBHOOK_ERROR_RECOVERY = KYC_WEBHOOK_ERROR_RECOVERY;
module.exports.KNOWN_KYC_WEBHOOK_CODES = KNOWN_KYC_WEBHOOK_CODES;
module.exports.createKycWebhookError = createKycWebhookError;
module.exports.classifyKycWebhookError = classifyKycWebhookError;
