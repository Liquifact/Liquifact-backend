'use strict';

/**
 * @fileoverview Shared error middleware for config validation and config-route failures.
 *
 * Produces the same structured RFC 7807-style response body that the config
 * validation helper used to emit directly, but now does so through Express error
 * middleware so config routes share the same serialization path.
 *
 * @module middleware/configErrorHandler
 */

const AppError = require('../errors/AppError');
const { getProblemType, getStandardTitle } = require('../utils/problemDetails');

/**
 * Error codes that config routes may surface and that this middleware is expected
 * to serialize. Keeping this as a constant set makes the handling decision
 * deterministic and auditable.
 */
const HANDLED_STATUSS = new Set([400, 404, 409, 422, 429, 500, 503]);

/**
 * Error codes that indicate a transient failure and may be retried by the client.
 * This is used as a deterministic fallback when the thrown error does not
 * explicitly declare a `retryable` flag.
 */
const RETRYABLE_CODES = new Set([
  'CONFIG_LOCK_CONTENTION',
  'CONFIG_PERSIST_FAILED',
  'CONFIG_READ_FAILED',
  'CONFIG_WRITE_FAILED',
  'CONFIG_REVISION_CONFLICT',
  'ETAG_MISMATCH',
]);

/**
 * @param {unknown} error - The error thrown by a config route or validator.
 * @returns {boolean}
 */
function shouldHandle(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (error instanceof AppError || error.name === 'AppError') {
    return HANDLED_STATUSS.has(error.status);
  }

  return false;
}

/**
 * Normalize a potentially non-integer or out-of-range status code into a valid
 * HTTP status code that this middleware is allowed to emit. This guarantees a
 * deterministic response even if an error object is malformed or tampered with.
 *
 * @param {unknown} value - Raw status value.
 * @returns {number} A member of HANDLED_STATUSS, defaulting to 400.
 */
function normalizeStatus(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return 400;
  }

  if (!HANDLED_STATUSS.has(value)) {
    return 400;
  }

  return value;
}

/**
 * Determine whether an error is retryable. Prefers the explicit `retryable`
 * flag when it is a boolean, otherwise falls back to a deterministic decision
 * based on the error code and status.
 *
 * @param {object} error - The thrown error.
 * @param {number} status - The normalized status code.
 * @returns {boolean}
 */
function isRetryable(error, status) {
  if (typeof error.retryable === 'boolean') {
    return error.retryable;
  }

  if (typeof error.code === 'string' && RETRYABLE_CODES.has(error.code)) {
    return true;
  }

  return status === 503 || status === 500;
}

/**
 * Express error-handling middleware for config routes.
 *
 * Only handles errors that were explicitly raised as config validation failures
 * (via the shared validator) or as AppErrors coming from config routes. Other
 * errors are forwarded to the next middleware so the global error handler can
 * continue to process them.
 *
 * @param {Error|unknown} err - Thrown error.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next middleware.
 * @returns {void}
 */
function configErrorHandler(err, req, res, next) {
  if (!shouldHandle(err)) {
    return next(err);
  }

  const status = normalizeStatus(err.status);
  const body = {
    type: err.type || getProblemType(status),
    title: err.title || getStandardTitle(status),
    status,
    detail: err.detail || err.message || 'An error occurred while processing the request.',
    code: err.code,
  };

  if (err.instance !== undefined) {
    body.instance = err.instance;
  }

  if (err.fieldErrors !== undefined) {
    body.fieldErrors = err.fieldErrors;
  }

  // Always expose retry semantics for config failures so clients can recover in
  // a deterministic way without guessing from the status code alone.
  const retryable = isRetryable(err, status);
  body.retryable = retryable;

  if (err.retryHint !== undefined) {
    body.retry_hint = err.retryHint;
  } else if (retryable) {
    body.retry_hint = 'The request can be safely retried after a short delay.';
  }

  res.setHeader('Content-Type', 'application/problem+json');
  return res.status(status).json(body);
}

module.exports = {
  configErrorHandler,
  shouldHandle,
};
