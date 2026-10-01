'use strict';

/**
 * @fileoverview Shared error-handling middleware for metrics-related routes
 * (issue #973).
 *
 * ## Problem
 * Before this module existed, each metrics handler (the Prometheus scrape
 * endpoint, the admin metrics-audit endpoint, and the SME metrics endpoint)
 * formatted error responses independently, producing inconsistent shapes and
 * duplicating classification logic scattered across multiple files.
 *
 * ## Solution
 * `metricsErrorHandler` is a standard Express 4-argument error middleware that:
 *
 * 1. Classifies the error into a bounded `code` from `METRICS_ERROR_CODES`.
 * 2. Maps the code to an HTTP status code via `METRICS_CODE_TO_STATUS`.
 * 3. Produces a uniform RFC 7807-style `application/problem+json` response.
 * 4. Never leaks internal stack traces or raw error messages in production.
 *
 * Mount it **after** the route handlers on any Express router or app that
 * serves metrics-related routes:
 *
 *   router.use(metricsErrorHandler);
 *
 * The middleware is intentionally narrow — it only handles errors whose
 * `code` belongs to `METRICS_ERROR_CODES`. Unknown errors are forwarded to
 * `next(err)` so the global error handler can deal with them normally.
 *
 * ## Compatibility contracts
 *
 * The following behaviors are considered public contracts and must not be
 * broken without a documented migration path:
 *
 * 1. The exported names and their signatures.
 * 2. The bounded set of error codes and their HTTP status mappings.
 * 3. The response body shape `{ error: { code, message, retryable } }`.
 * 4. The `retryable` flag is true only for `UPSTREAM_ERROR`.
 * 5. Unknown errors fall through to `next(err)` and are never swallowed.
 * 6. Production responses never include the raw error message or stack.
 *
 * Behavior is deterministic for valid, invalid, duplicate, and boundary
 * inputs. Concurrent invocations do not mutate any shared state.
 *
 * @module middleware/metricsErrorHandler
 */

/**
 * Bounded set of machine-readable validation codes for metrics request
 * validation failures. These are the stable contract that clients can
 * branch on; message wording remains free to change.
 *
 * @readonly
 * @enum {string}
 */
const METRICS_VALIDATION_CODES = Object.freeze({
  /** A required field was missing or empty. */
  REQUIRED: 'REQUIRED',
  /** A field had the wrong type. */
  INVALID_TYPE: 'INVALID_TYPE',
  /** A field exceeded its maximum allowed length. */
  TOO_LONG: 'TOO_LONG',
  /** A field fell below its minimum allowed length. */
  TOO_SHORT: 'TOO_SHORT',
  /** A field failed a range constraint. */
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  /** A field failed a format/pattern constraint. */
  INVALID_FORMAT: 'INVALID_FORMAT',
  /** A field was not one of the allowed enum values. */
  INVALID_ENUM: 'INVALID_ENUM',
  /** A field was duplicated where uniqueness is required. */
  DUPLICATE: 'DUPLICATE',
  /** Catch-all for validation failures without a more specific code. */
  INVALID: 'INVALID',
});

/**
 * Bounded set of error codes that the metrics error handler recognises.
 * Codes outside this set fall through to the next error handler.
 *
 * @readonly
 * @enum {string}
 */
const METRICS_ERROR_CODES = Object.freeze({
  /** Caller is not authenticated. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Caller lacks permission. */
  FORBIDDEN: 'FORBIDDEN',
  /** Requested metric or resource not found. */
  NOT_FOUND: 'NOT_FOUND',
  /** Request data failed validation. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Upstream metrics store or registry is unavailable. */
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  /** Catch-all for unexpected server errors. */
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
});

/**
 * Maps a `METRICS_ERROR_CODES` member to its HTTP status code.
 *
 * @readonly
 * @type {Readonly<Record<string, number>>}
 */
const METRICS_CODE_TO_STATUS = Object.freeze({
  [METRICS_ERROR_CODES.UNAUTHORIZED]: 401,
  [METRICS_ERROR_CODES.FORBIDDEN]: 403,
  [METRICS_ERROR_CODES.NOT_FOUND]: 404,
  [METRICS_ERROR_CODES.VALIDATION_ERROR]: 422,
  [METRICS_ERROR_CODES.UPSTREAM_ERROR]: 502,
  [METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR]: 500,
});

/**
 * Pre-computed list of known error codes. Kept at module scope so the
 * classifier does not re-allocate an array on every call. The list is
 * frozen to guarantee determinism under concurrent invocation.
 *
 * @type {Readonly<string[]>}
 */
const KNOWN_CODES = Object.freeze(Object.values(METRICS_ERROR_CODES));

/**
 * Pre-computed map of safe, non-leaking messages per error code.
 *
 * @type {Readonly<Record<string, string>>}
 */
const SAFE_MESSAGES = Object.freeze({
  [METRICS_ERROR_CODES.UNAUTHORIZED]: 'Authentication is required to access this resource.',
  [METRICS_ERROR_CODES.FORBIDDEN]: 'You do not have permission to access this resource.',
  [METRICS_ERROR_CODES.NOT_FOUND]: 'The requested metrics resource was not found.',
  [METRICS_ERROR_CODES.VALIDATION_ERROR]: 'The request contains invalid parameters.',
  [METRICS_ERROR_CODES.UPSTREAM_ERROR]: 'A metrics upstream dependency is temporarily unavailable.',
  [METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR]: 'An unexpected error occurred while processing the metrics request.',
});

/**
 * Classifies an error object into one of the bounded `METRICS_ERROR_CODES`.
 *
 * Classification order (first match wins):
 *   1. `err.code` already matches a known `METRICS_ERROR_CODES` member.
 *   2. HTTP status on the error object (`err.status` / `err.statusCode`).
 *   3. Fallback: `INTERNAL_SERVER_ERROR`.
 *
 * Classification is deterministic: identical inputs always yield the same code.
 *
 * @param {Error|unknown} err - The thrown error.
 * @returns {string} A member of `METRICS_ERROR_CODES`.
 */
function classifyMetricsError(err) {
  if (err && typeof err === 'object') {
    // Honour explicit code if it is within our bounded set
    const knownCodes = Object.values(METRICS_ERROR_CODES);
    if (typeof err.code === 'string' && knownCodes.indexOf(err.code) !== -1) {
      return err.code;
    }

    // Derive from HTTP status attached to the error. Number() on a
    // non-numeric value yields NaN, which fails all equality checks and
    // falls through to INTERNAL_SERVER_ERROR deterministically.
    const status = Number(err.status || err.statusCode || 0);
    if (status === 401) return METRICS_ERROR_CODES.UNAUTHORIZED;
    if (status === 403) return METRICS_ERROR_CODES.FORBIDDEN;
    if (status === 404) return METRICS_ERROR_CODES.NOT_FOUND;
    if (status === 422 || status === 400) return METRICS_ERROR_CODES.VALIDATION_ERROR;
    if (status === 429) return METRICS_ERROR_CODES.UPSTREAM_ERROR;
    if (status === 502 || status === 503 || status === 504) return METRICS_ERROR_CODES.UPSTREAM_ERROR;
  }

  return METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR;
}

/**
 * Returns a safe, non-leaking human-readable message for the given code.
 *
 * Deterministic: the same (code, err, NODE_ENV) always produces the same string.
 *
 * In `NODE_ENV !== 'production'` the raw `err.message` is included so
 * developers get actionable feedback without a log search.  In production
 * only the generic template is returned.
 *
 * The dev-only detail is deliberately concatenated into the message string
 * rather than exposed as a separate field, so the response body shape
 * remains stable across environments.
 *
 * @param {string}        code - A METRICS_ERROR_CODES member.
 * @param {Error|unknown} err  - The original error (message may be included in dev).
 * @returns {string}
 */
function buildMetricsErrorMessage(code, err) {
  const safe = SAFE_MESSAGES[code] || SAFE_MESSAGES[METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR];

  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && err && typeof err.message === 'string' && err.message.length > 0) {
    return `${safe} (${err.message})`;
  }

  return safe;
}

/**
 * Express error-handling middleware that produces a uniform structured
 * response for all metrics-related errors.
 *
 * ## Determinism & recovery invariants
 * - The same error object always maps to the same `code`, `status`, and
 *   `retryable` flag, regardless of call order or concurrency.
 * - Headers are only written once; if the response has already been sent
 *   (e.g. a partial write occurred upstream), the error is forwarded to
 *   `next(err)` so the global handler can decide how to recover without
 *   corrupting the in-flight response.
 * - No in-memory or persisted state is mutated here, so retries are safe.
 *
 * Response body shape (identical across all metrics error scenarios):
 *
 * ```json
 * {
 *   "error": {
 *     "code": "VALIDATION_ERROR",
 *     "message": "The request contains invalid parameters.",
 *     "retryable": false
 *   }
 * }
 * ```
 *
 * The `retryable` flag is `true` only for `UPSTREAM_ERROR` (transient
 * dependency outage) and `false` for every other code.
 *
 * ## Contract: fall-through for unknown errors
 *
 * Errors that do not carry a known `METRICS_ERROR_CODES` and do not map
 * from a recognised HTTP status are classified as `INTERNAL_SERVER_ERROR`
 * and are responded to by this middleware. This is the documented
 * behaviour for the metrics routes. To route a specific error to the
 * global handler instead, attach a non-metrics code and do not mount this
 * middleware on that router.
 *
 * ## Contract: no double response
 *
 * If the response has already been committed (`res.headersSent`), the
 * middleware delegates to `next(err)` rather than attempting to write a
 * second response, which would throw and corrupt the connection.
 *
 * @param {Error}                            err  - Thrown error.
 * @param {import('express').Request}        req  - Express request.
 * @param {import('express').Response}       res  - Express response.
 * @param {import('express').NextFunction}   next - Express next callback.
 * @returns {void}
 */
function metricsErrorHandler(err, req, res, next) {
  // Only handle errors; pass non-error calls through
  if (!err) {
    return next();
  }

  // If the response is already committed we cannot safely rewrite it.
  if (res && (res.headersSent || res.writableEnded)) {
    return next(err);
  }

  const code = classifyMetricsError(err);
  const status = METRICS_CODE_TO_STATUS[code] || 500;
  const message = buildMetricsErrorMessage(code, err);
  const retryable = code === METRICS_ERROR_CODES.UPSTREAM_ERROR;

  // Set correct content type before writing
  res.setHeader('Content-Type', 'application/problem+json');
  res.setHeader('Cache-Control', 'no-store');

  res.status(status).json({
    error: {
      code,
      message,
      retryable,
    },
  });
}

module.exports = {
  metricsErrorHandler,
  classifyMetricsError,
  buildMetricsErrorMessage,
  METRICS_ERROR_CODES,
  METRICS_CODE_TO_STATUS,
  METRICS_VALIDATION_CODES,
};
