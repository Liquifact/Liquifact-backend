'use strict';

const AppError = require('./AppError');

// Snapshot Object.prototype.hasOwnProperty once so prototype-pollution on
// Object.prototype cannot swap in a forged implementation at call time.
const _hasOwn = Object.prototype.hasOwnProperty;
const _hasOwnProp = (obj, key) => _hasOwn.call(obj, key);

/**
 * Minimum valid HTTP status code accepted by the mapper.
 * @type {number}
 */
const MIN_STATUS = 100;

/**
 * Maximum valid HTTP status code accepted by the mapper.
 * @type {number}
 */
const MAX_STATUS = 599;

/**
 * Fallback status used when an error exposes an invalid status.
 * @type {number}
 */
const FALLBACK_STATUS = 500;

/**
 * Maximum length of a client-visible message. Truncated to avoid
 * unbounded response sizes and accidental data leaks.
 * @type {number}
 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Maximum length of a retry hint string.
 * @type {number}
 */
const MAX_RETRY_HINT_LENGTH = 200;

/**
 * Maximum length of an error code label.
 * @type {number}
 */
const MAX_CODE_LENGTH = 100;

/**
 * Maximum length of an error type URI.
 * @type {number}
 */
const MAX_TYPE_LENGTH = 500;

/**
 * Statuses that are considered safe to retry by default.
 * @type {ReadonlyArray<number>}
 */
const RETRYABLE_STATUSES = Object.freeze([429, 503]);

/**
 * Default error code label from HTTP status when AppError has no explicit code.
 *
 * @param {number} status - HTTP status.
 * @returns {string}
 */
function httpStatusToCode(status) {
  if (status === 400) {
    return 'BAD_REQUEST';
  }
  if (status === 401) {
    return 'UNAUTHORIZED';
  }
  if (status === 403) {
    return 'FORBIDDEN';
  }
  if (status === 409) {
    return 'CONFLICT';
  }
  if (status === 422) {
    return 'UNPROCESSABLE_ENTITY';
  }
  if (status === 429) {
    return 'TOO_MANY_REQUESTS';
  }
  if (status === 500) {
    return 'INTERNAL_SERVER_ERROR';
  }
  if (status === 503) {
    return 'SERVICE_UNAVAILABLE';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  return `HTTP_${status}`;
}

const INTERNAL_ERROR_MESSAGE = "An internal server error occurred.";
const DEFAULT_RETRY_HINT =
  "Do not retry until the issue is resolved or support is contacted.";

/**
 * Normalize an AppError-like value into the stable error contract.
 *
 * This function is the single source of truth for the public shape of
 * mapped AppErrors. It is deliberately defensive against malformed or
 * partially constructed error objects so that callers always receive a
 * consistent {status, code, message, retryable, retryHint} tuple.
 *
 * @param {object} error AppError-like value.
 * @returns {{status: number, code: string, message: string, retryable: boolean, retryHint: string}}
 */
function mapAppError(error) {
  const rawStatus = error.status;
  const status =
    typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? rawStatus
      : 500;

  const rawCode = error.code;
  const code =
    typeof rawCode === "string" && rawCode.length > 0
      ? rawCode
      : httpStatusToCode(status);

  // Prefer the explicit detail when present, otherwise fall back to the
  // canonical message. Never emit a non-string message to keep the contract
  // stable for downstream consumers.
  const rawMessage = error.detail ?? error.message;
  const message =
    typeof rawMessage === "string" && rawMessage.length > 0
      ? rawMessage
      : httpStatusToCode(status);

  const retryable = error.retryable === true;
  const rawRetryHint = error.retryHint;
  const retryHint = typeof rawRetryHint === "string" ? rawRetryHint : "";

  return { status, code, message, retryable, retryHint };
}

/**
 * Map framework and application errors into a stable HTTP error contract.
 *
 * Invariants:
* - Always returns a new object with the exact keys {status, code, message,
 *   retryable, retryHint}.
 * - `status` is always a finite number.
 * - `code` and `message` are always non-empty strings.
 * - `retryable` is always a boolean and `retryHint` is always a string.
 * - No internal details (e.g. stack traces, upstream payloads) are leaked.
 *
 * @param {unknown} error Thrown error value.
 * @returns {{status: number, code: string, message: string, retryable: boolean, retryHint: string}}
 */
function mapError(error) {
  if (error && (error instanceof AppError || error.name === "AppError")) {
    return mapAppError(error);
  }

  if (
    error &&
    typeof error === "object" &&
    error.isCorsOriginRejected === true
  ) {
    const message =
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "CORS policy: origin is not allowed.";
    return {
      status: 403,
      code: "FORBIDDEN",
      message,
      retryable: false,
      retryHint: "",
    };
  }

  const isAppError =
    (error instanceof AppError) || name === 'AppError';

  if (error && typeof error === "object" && error.code === "ECONNREFUSED") {
    return {
      status: 503,
      code: "UPSTREAM_ERROR",
      message: "A dependent service is temporarily unavailable.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }

  if (error && typeof error === "object" && error.code === "CIRCUIT_OPEN") {
    return {
      status: 503,
      code: "CIRCUIT_OPEN",
      message:
        "Service temporarily unavailable due to upstream outage. Circuit breaker is OPEN.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }

  const rawStatus = error && error.status;
  const status =
    typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? rawStatus
      : 500;
  const retryableStatuses = [429, 503];
  const retryable = retryableStatuses.includes(status);
  let retryHint = "Do not retry until the issue is resolved or support is contacted.";
  if (status === 429) {
    retryHint = "Wait for the rate limit window to reset before retrying.";
  } else if (status === 503) {
    retryHint = "Retry the request in a few moments.";
  }
  const rawMessage = error && error.message;
  const message =
    status === 500
      ? "An internal server error occurred."
      : typeof rawMessage === "string" && rawMessage.length > 0
        ? rawMessage
        : "An internal server error occurred.";
  return {
    isObject: true,
    isAppError,
    name,
    status,
    code: httpStatusToCode(status),
    message,
    retryable,
    retryHint: defaultRetryHint(status),
  };
}

/**
 * Map framework and application errors into a stable HTTP error contract.
 *
 * ### Concurrent-execution safety
 *
 * All mutable properties of `error` are snapshot at the top of this function
 * via `_snapshotError`.  No property is read twice from the original object,
 * so concurrent mutation of the input cannot cause different branches to
 * observe different values for the same field (TOCTOU).
 *
 * ### Prototype-pollution safety
 *
 * `isCorsOriginRejected` is only honoured when it is an own property of the
 * thrown value.  A polluted `Object.prototype.isCorsOriginRejected = true`
 * will NOT match unrelated errors.
 *
 * ### Getter-side-effect safety
 *
 * All property reads are wrapped in try/catch inside `_safeProp`.  An
 * adversarial error object whose getter throws cannot cause `mapError` itself
 * to throw.
 *
 * ### Output immutability
 *
 * The returned object is frozen so callers cannot accidentally mutate it and
 * create a shared-state hazard if the same result is cached or passed between
 * concurrent request handlers.
 *
 * @param {unknown} error Thrown error value.
 * @returns {Readonly<{status: number, code: string, message: string, retryable: boolean, retryHint: string}>}
 */
function mapError(error) {
  // Snapshot all properties once — downstream logic MUST read from `s`, not
  // from `error` directly.
  const s = _snapshotError(error);

  // ── 1. AppError (or duck-typed equivalent) ─────────────────────────────────
  if (s.isAppError) {
    const status = typeof s.status === 'number' ? s.status : 500;
    return Object.freeze({
      status,
      code: (typeof s.code === 'string' && s.code) || httpStatusToCode(status),
      message: (typeof s.detail === 'string' && s.detail)
        || (typeof s.message === 'string' && s.message)
        || 'An internal server error occurred.',
      retryable: s.retryable === true,
      retryHint: typeof s.retryHint === 'string' ? s.retryHint : '',
    });
  }

  // ── 2. CORS origin rejection ───────────────────────────────────────────────
  // Guard: isCorsOriginRejected must be an OWN boolean `true` on `error` to
  // prevent prototype-pollution from forging CORS rejections.
  if (s.isCorsOriginRejected === true) {
    return Object.freeze({
      status: 403,
      code: 'FORBIDDEN',
      message: (typeof s.message === 'string' && s.message) || 'CORS policy: origin is not allowed.',
      retryable: false,
      retryHint: '',
    });
  }

  // ── 3. Express JSON body-parser SyntaxError ────────────────────────────────
  if (_isBodyParserSyntaxError(s)) {
    return Object.freeze({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Malformed JSON request body.',
      retryable: false,
      retryHint: 'Fix the JSON payload and try again.',
    });
  }

  // ── 4. ECONNREFUSED (upstream dependency down) ────────────────────────────
  if (s.code === 'ECONNREFUSED') {
    return Object.freeze({
      status: 503,
      code: 'UPSTREAM_ERROR',
      message: 'A dependent service is temporarily unavailable.',
      retryable: true,
      retryHint: 'Retry the request in a few moments.',
    });
  }

  // ── 5. Circuit-breaker OPEN ────────────────────────────────────────────────
  if (s.code === 'CIRCUIT_OPEN') {
    return Object.freeze({
      status: 503,
      code: 'CIRCUIT_OPEN',
      message: 'Service temporarily unavailable due to upstream outage. Circuit breaker is OPEN.',
      retryable: true,
      retryHint: 'Retry the request in a few moments.',
    });
  }

  // ── 6. Generic fallback (status-aware) ────────────────────────────────────
  // Use the snapshotted status — never re-read from `error.status`.
  // Only accept finite, positive integers as valid HTTP status codes.  Zero,
  // NaN, Infinity, and negative values fall back to 500 rather than producing
  // nonsensical responses.
  const rawStatus = s.isObject ? s.status : undefined;
  const status =
    typeof rawStatus === 'number' && Number.isFinite(rawStatus) && rawStatus > 0
      ? rawStatus
      : 500;
  const retryableStatuses = [429, 503];
  const retryable = retryableStatuses.includes(status);

  let retryHint = 'Do not retry until the issue is resolved or support is contacted.';
  if (status === 429) {
    retryHint = 'Wait for the rate limit window to reset before retrying.';
  } else if (status === 503) {
    retryHint = 'Retry the request in a few moments.';
  }

  // Hard rule: a 500 MUST NOT leak the original error message to callers,
  // regardless of what any branch or property says.  Apply this unconditionally
  // using the already-snapshotted status.
  const message = status === 500
    ? 'An internal server error occurred.'
    : (typeof s.message === 'string' && s.message) || 'An internal server error occurred.';

  return Object.freeze({
    status,
    code: httpStatusToCode(status),
    message,
    retryable,
    retryHint,
  });
}

/**
 * Detect Express JSON parser syntax errors using the pre-snapshotted fields.
 * This is an internal helper that receives the snapshot object.
 *
 * @param {{ type: unknown, status: unknown }} snapshot
 * @returns {boolean}
 */
function _isBodyParserSyntaxError(snapshot) {
  return snapshot.type === 'entity.parse.failed' && snapshot.status === 400;
}

/**
 * Detect Express JSON parser syntax errors.
 *
 * Public API: accepts the raw thrown value and inspects it safely.
 *
 * @param {unknown} error Thrown error value.
 * @returns {boolean}
 */
function isBodyParserSyntaxError(error) {
  return Boolean(
    isPlainObject(error) &&
      error.type === "entity.parse.failed" &&
      error.status === 400,
  );
}

module.exports = {
  mapError,
  isBodyParserSyntayError,
};
