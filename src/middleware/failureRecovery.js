'use strict';

/**
 * @fileoverview Deterministic, leak-free failure-recovery middleware for the
 * LiquiFact API.
 *
 * This module owns the terminal error handlers mounted by `src/app.js`. It is
 * extracted into its own unit so the failure paths can be exercised without
 * booting the entire application graph (issue #1259).
 *
 * ## Failure-recovery invariants
 *
 * 1. **Single writer per response.** No handler writes a body once
 *    `res.headersSent` is true. Instead it forwards the error to Express, which
 *    terminates the connection. This makes repeated or overlapping failures
 *    idempotent and prevents `ERR_HTTP_HEADERS_SENT`.
 * 2. **Stable, documented shapes.** Each failure class maps to exactly one
 *    response body (see the table below); the mapping does not depend on call
 *    ordering or shared mutable state.
 * 3. **No internal leakage.** Outside `development`, 5xx failures and
 *    unhandled errors expose only a fixed, generic message. Stack traces and
 *    internal `detail`/`title`/`message` values are never serialized.
 * 4. **Observable, never swallowed.** Every handled failure is logged at a
 *    level matching its class, and logging is best-effort so it can never throw
 *    into the response path.
 * 5. **Pure and side-effect free.** Handlers derive their output solely from
 *    their arguments plus the immutable `NODE_ENV`, so the same failure always
 *    produces the same body.
 *
 * ## Canonical response shapes
 *
 * | Failure class              | Status | Body                                        |
 * | -------------------------- | ------ | ------------------------------------------- |
 * | Blocked CORS origin        | 403    | `{ error, code }`                           |
 * | Malformed JSON / bare 400  | 400    | `{ error: 'Bad Request' }`                  |
 * | Status-bearing 4xx error   | 4xx    | `{ error: { code, message } }`              |
 * | Status-bearing 5xx error   | 5xx    | `{ error: { code, message } }`              |
 * | Unhandled error (prod)     | 500    | `{ error: 'Internal server error' }`        |
 * | Unhandled error (dev)      | 500    | `{ error: { message, stack } }`             |
 *
 * @module middleware/failureRecovery
 */

const { isCorsOriginRejectedError } = require('../config/cors');
const logger = require('../logger');

/** Generic, non-leaking message used for 5xx and unhandled failures. */
const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/** Legacy message preserved for malformed-JSON / bare-400 responses. */
const BAD_REQUEST_MESSAGE = 'Bad Request';

/**
 * Emits a structured log line without ever affecting the response path.
 *
 * Logging failures are swallowed deliberately: observability must never turn a
 * recoverable request failure into a crash or a second response.
 *
 * @param {string} level - Pino level method name (e.g. `warn`, `error`).
 * @param {Object} payload - Structured fields to log.
 * @param {string} message - Human-readable log message.
 * @returns {void}
 */
function safeLog(level, payload, message) {
  try {
    if (logger && typeof logger[level] === 'function') {
      logger[level](payload, message);
    }
  } catch (_err) {
    // Intentionally ignored: logging must not alter response semantics.
  }
}

/**
 * Returns a 403 JSON response only for the dedicated blocked-origin CORS error.
 *
 * All other errors pass through unchanged so the next error handler can decide
 * how to recover. When a response has already been committed the error is
 * forwarded instead of written, keeping the handler idempotent.
 *
 * @param {Error} err - Request error.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function handleCorsError(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (isCorsOriginRejectedError(err)) {
    if (res.locals) {
      res.locals.isCorsOriginRejected = true;
    }
    return res.status(403).json({ error: err.message, code: err.code });
  }

  return next(err);
}

/**
 * Handles uncaught application errors with a stable, leak-free response.
 *
 * The response shape is a pure function of the error class (malformed body,
 * status-bearing error, or unhandled error) and the environment. Every handled
 * failure is logged and no internal detail is emitted for server-side failures
 * outside `development`.
 *
 * @param {Error} err - Request error.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function handleInternalError(err, req, res, next) {
  // A committed response cannot be replaced. Delegate so Express terminates
  // the connection rather than attempting a second body write.
  if (res.headersSent) {
    return next(err);
  }

  const isDevelopment = process.env.NODE_ENV === 'development';
  const reqId = req && req.id;

  // Malformed JSON (body-parser) and bare 400s keep the legacy shape.
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    safeLog('warn', { err, reqId }, 'Client request rejected');
    return res.status(400).json({ error: BAD_REQUEST_MESSAGE });
  }

  // AppError family: use the status it carries (400–599). This covers both
  // 4xx client errors and 5xx upstream errors (e.g. 502).
  if (err && err.status >= 400 && err.status <= 599) {
    const status = err.status;
    const isServerError = status >= 500;
    const code = err.code || String(status);

    // Log every handled failure so it is observable and never swallowed.
    safeLog(
      isServerError ? 'error' : 'warn',
      { err, reqId, status },
      'Request failed'
    );

    // Never leak internal detail for server-side failures in production.
    const message = isServerError && !isDevelopment
      ? INTERNAL_ERROR_MESSAGE
      : err.detail || err.title || err.message || INTERNAL_ERROR_MESSAGE;

    return res.status(status).json({ error: { code, message } });
  }

  safeLog('error', { err, reqId }, INTERNAL_ERROR_MESSAGE);

  if (isDevelopment) {
    return res.status(500).json({
      error: {
        message: err && err.message ? err.message : INTERNAL_ERROR_MESSAGE,
        stack: err && err.stack ? err.stack : null,
      },
    });
  }

  return res.status(500).json({ error: INTERNAL_ERROR_MESSAGE });
}

module.exports = {
  INTERNAL_ERROR_MESSAGE,
  BAD_REQUEST_MESSAGE,
  handleCorsError,
  handleInternalError,
};
