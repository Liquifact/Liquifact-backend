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
 * @module middleware/metricsErrorHandler
 */

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
 * Classifies an error object into one of the bounded `METRICS_ERROR_CODES`.
 *
 * Classification order (first match wins):
 *   1. `err.code` already matches a known `METRICS_ERROR_CODES` member.
 *   2. HTTP status on the error object (`err.status` / `err.statusCode`).
 *   3. Fallback: `INTERNAL_SERVER_ERROR`.
 *
 * @param {Error|unknown} err - The thrown error.
 * @returns {string} A member of `METRICS_ERROR_CODES`.
 */
function classifyMetricsError(err) {
  if (err && typeof err === 'object') {
    // Honour explicit code if it is within our bounded set
    const knownCodes = Object.values(METRICS_ERROR_CODES);
    if (typeof err.code === 'string' && knownCodes.includes(err.code)) {
      return err.code;
    }

    // Derive from HTTP status attached to the error
    const status = Number(err.status || err.statusCode || 0);
    if (status === 401) return METRICS_ERROR_CODES.UNAUTHORIZED;
    if (status === 403) return METRICS_ERROR_CODES.FORBIDDEN;
    if (status === 404) return METRICS_ERROR_CODES.NOT_FOUND;
    if (status === 422 || status === 400) return METRICS_ERROR_CODES.VALIDATION_ERROR;
    if (status === 502 || status === 503 || status === 504) return METRICS_ERROR_CODES.UPSTREAM_ERROR;
  }

  return METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR;
}

/**
 * Returns a safe, non-leaking human-readable message for the given code.
 *
 * In `NODE_ENV !== 'production'` the raw `err.message` is included so
 * developers get actionable feedback without a log search.  In production
 * only the generic template is returned.
 *
 * @param {string}        code - A `METRICS_ERROR_CODES` member.
 * @param {Error|unknown} err  - The original error (message may be included in dev).
 * @returns {string}
 */
function buildMetricsErrorMessage(code, err) {
  const SAFE_MESSAGES = {
    [METRICS_ERROR_CODES.UNAUTHORIZED]: 'Authentication is required to access this resource.',
    [METRICS_ERROR_CODES.FORBIDDEN]: 'You do not have permission to access this resource.',
    [METRICS_ERROR_CODES.NOT_FOUND]: 'The requested metrics resource was not found.',
    [METRICS_ERROR_CODES.VALIDATION_ERROR]: 'The request contains invalid parameters.',
    [METRICS_ERROR_CODES.UPSTREAM_ERROR]: 'A metrics upstream dependency is temporarily unavailable.',
    [METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR]: 'An unexpected error occurred while processing the metrics request.',
  };

  const safe = SAFE_MESSAGES[code] || SAFE_MESSAGES[METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR];

  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && err && err.message) {
    return `${safe} (${err.message})`;
  }

  return safe;
}

/**
 * Express error-handling middleware that produces a uniform structured
 * response for all metrics-related errors.
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

  const code = classifyMetricsError(err);
  const status = METRICS_CODE_TO_STATUS[code] || 500;
  const message = buildMetricsErrorMessage(code, err);
  const retryable = code === METRICS_ERROR_CODES.UPSTREAM_ERROR;

  // Set correct content type before writing
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
};
