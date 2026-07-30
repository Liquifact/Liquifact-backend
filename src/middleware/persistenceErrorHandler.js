'use strict';

/**
 * @fileoverview Shared error-handling middleware for persistence routes
 * (issue #988).
 *
 * ## Problem
 * Before this module existed, each persistence handler (presigned URL, invoice
 * upload) formatted error responses independently with inline try/catch blocks
 * that duplicated the same classification and formatting logic.
 *
 * ## Solution
 * `persistenceErrorHandler` is a standard Express 4-argument error middleware
 * that:
 *
 * 1. Classifies the error into a bounded `code` from `PERSISTENCE_ERROR_CODES`.
 * 2. Maps the code to an HTTP status code via `PERSISTENCE_CODE_TO_STATUS`.
 * 3. Produces a consistent `application/json` response with the error details.
 * 4. Falls through to `next(err)` for errors outside the persistence domain.
 *
 * Mount it **after** the route handlers on the persistence router:
 *
 *   router.use(persistenceErrorHandler);
 *
 * @module middleware/persistenceErrorHandler
 */

const logger = require('../logger');

/**
 * Bounded set of error codes that the persistence error handler recognises.
 * Codes outside this set fall through to the next error handler.
 *
 * @readonly
 * @enum {string}
 */
const PERSISTENCE_ERROR_CODES = Object.freeze({
  /** MIME type is not in the allowlist. */
  INVALID_MIME_TYPE: 'INVALID_MIME_TYPE',
  /** File size exceeds the configured maximum. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** Tenant ID contains invalid characters. */
  INVALID_TENANT_ID: 'INVALID_TENANT_ID',
  /** File name is invalid or contains path traversal. */
  INVALID_FILENAME: 'INVALID_FILENAME',
  /** Invoice ID contains invalid characters. */
  INVALID_INVOICE_ID: 'INVALID_INVOICE_ID',
  /** Presigned URL expiry is out of range. */
  INVALID_EXPIRY: 'INVALID_EXPIRY',
  /** Catch-all for unexpected server errors. */
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
});

/**
 * Maps a `PERSISTENCE_ERROR_CODES` member to its HTTP status code.
 *
 * @type {Readonly<Record<string, number>>}
 */
const PERSISTENCE_CODE_TO_STATUS = Object.freeze({
  [PERSISTENCE_ERROR_CODES.INVALID_MIME_TYPE]: 400,
  [PERSISTENCE_ERROR_CODES.FILE_TOO_LARGE]: 400,
  [PERSISTENCE_ERROR_CODES.INVALID_TENANT_ID]: 400,
  [PERSISTENCE_ERROR_CODES.INVALID_FILENAME]: 400,
  [PERSISTENCE_ERROR_CODES.INVALID_INVOICE_ID]: 400,
  [PERSISTENCE_ERROR_CODES.INVALID_EXPIRY]: 400,
  [PERSISTENCE_ERROR_CODES.INTERNAL_SERVER_ERROR]: 500,
});

/**
 * Classifies an error object into one of the bounded `PERSISTENCE_ERROR_CODES`.
 *
 * Classification order (first match wins):
 *   1. `err.code` already matches a known `PERSISTENCE_ERROR_CODES` member.
 *   2. HTTP status on the error object (`err.status` / `err.statusCode`).
 *   3. Fallback: `INTERNAL_SERVER_ERROR`.
 *
 * @param {Error|unknown} err - The thrown error.
 * @returns {string} A member of `PERSISTENCE_ERROR_CODES`.
 */
function classifyPersistenceError(err) {
  if (err && typeof err === 'object') {
    // Honour explicit code if it is within our bounded set
    const knownCodes = Object.values(PERSISTENCE_ERROR_CODES);
    if (typeof err.code === 'string' && knownCodes.includes(err.code)) {
      return err.code;
    }

    // Derive from HTTP status attached to the error
    const status = Number(err.status || err.statusCode || 0);
    if (status >= 400 && status < 500) return err.code || String(status);
  }

  return PERSISTENCE_ERROR_CODES.INTERNAL_SERVER_ERROR;
}

/**
 * Express error-handling middleware that produces a uniform structured
 * response for all persistence errors.
 *
 * Response body shape:
 *
 * ```json
 * {
 *   "error": "<message>"
 * }
 * ```
 *
 * This matches the existing wire format expected by SME persistence clients.
 *
 * @param {Error}                            err  - Thrown error.
 * @param {import('express').Request}        req  - Express request.
 * @param {import('express').Response}       res  - Express response.
 * @param {import('express').NextFunction}   next - Express next callback.
 * @returns {void}
 */
function persistenceErrorHandler(err, req, res, next) {
  // Only handle errors; pass non-error calls through
  if (!err) {
    return next();
  }

  // Only handle known persistence errors; pass others through
  const knownCodes = Object.values(PERSISTENCE_ERROR_CODES);
  if (!err.code || !knownCodes.includes(err.code)) {
    return next(err);
  }

  const code = classifyPersistenceError(err);
  const status = PERSISTENCE_CODE_TO_STATUS[code] || 500;
  const message = err.message || 'A persistence error occurred.';

  // Log server errors, warn on client errors
  if (status >= 500) {
    logger.error({ err, code, status, requestId: req.id || 'unknown' }, `Persistence error: ${message}`);
  } else {
    logger.warn({ err, code, status, requestId: req.id || 'unknown' }, `Persistence client error: ${message}`);
  }

  res.status(status).json({ error: message });
}

module.exports = {
  persistenceErrorHandler,
  classifyPersistenceError,
  PERSISTENCE_ERROR_CODES,
  PERSISTENCE_CODE_TO_STATUS,
};
