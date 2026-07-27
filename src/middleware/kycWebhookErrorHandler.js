'use strict';

/**
 * @fileoverview Shared error-handling middleware for KYC webhook routes.
 *
 * Intercepts {@link KycWebhookError} instances thrown by route handlers and
 * produces a consistent structured error response envelope:
 *
 *   { error: { code, message, correlation_id, retryable, retry_hint } }
 *
 * Non-KycWebhookError values are forwarded to the next error handler in the
 * Express chain.
 *
 * @module middleware/kycWebhookErrorHandler
 */

const KycWebhookError = require('../errors/KycWebhookError');
const logger = require('../logger');

/**
 * HTTP status codes that are considered retryable.
 * @type {Set<number>}
 */
const RETRYABLE_STATUSES = new Set([429, 503]);

/**
 * Error codes that are explicitly retryable regardless of status.
 * @type {Set<string>}
 */
const RETRYABLE_CODES = new Set(['missing_secret', 'CIRCUIT_OPEN']);

/**
 * Maps a KycWebhookError to a retry hint string.
 *
 * @param {KycWebhookError} err - The intercepted error.
 * @returns {string} Client-facing retry guidance.
 */
function resolveRetryHint(err) {
  if (RETRYABLE_CODES.has(err.code)) {
    return 'Retry the request in a few moments.';
  }
  if (err.status === 429) {
    return 'Wait for the rate limit window to reset before retrying.';
  }
  if (err.status === 503) {
    return 'Retry the request in a few moments.';
  }
  return '';
}

/**
 * Express error-handling middleware for KYC webhook routes.
 *
 * Only handles {@link KycWebhookError} instances; all other errors are
 * forwarded to the next error handler.
 *
 * @param {Error}   req  - Express request.
 * @param {import('express').Request}   req  - Express request.
 * @param {import('express').Response}  res  - Express response.
 * @param {import('express').NextFunction} next - Next error handler.
 * @returns {void}
 */
function kycWebhookErrorHandler(err, req, res, next) {
  if (!(err instanceof KycWebhookError)) {
    return next(err);
  }

  const correlationId = req.correlationId || req.id || 'unknown';
  const retryable = RETRYABLE_CODES.has(err.code) || RETRYABLE_STATUSES.has(err.status);

  logger.warn(
    {
      err: err.message,
      code: err.code,
      status: err.status,
      correlationId,
    },
    'kyc-webhook error',
  );

  // Store the error code so the post-response metrics hook can read it.
  req._kycErrorCode = err.code;

  res.status(err.status).json({
    error: {
      code: err.code,
      message: err.message,
      correlation_id: correlationId,
      retryable,
      retry_hint: resolveRetryHint(err),
    },
  });
}

module.exports = kycWebhookErrorHandler;
