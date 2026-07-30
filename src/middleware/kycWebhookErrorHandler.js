'use strict';

/**
 * @fileoverview Shared error-handling middleware for KYC webhook routes.
 *
 * Intercepts {@link KycWebhookError} instances thrown by route handlers and
 * produces an RFC 7807 application/problem+json response via the canonical
 * problem-detail builder.
 *
 * Non-KycWebhookError values are forwarded to the next error handler in the
 * Express chain.
 *
 * @module middleware/kycWebhookErrorHandler
 */

const KycWebhookError = require('../errors/KycWebhookError');
const formatProblemDetails = require('../utils/problemDetails');
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
 * Emits RFC 7807 application/problem+json responses with type, title, status,
 * detail, instance, code, retryable, and retry_hint fields.
 *
 * @param {KycWebhookError} err - The intercepted error.
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

  const problem = formatProblemDetails({
    type: formatProblemDetails.getProblemType(err.status),
    title: formatProblemDetails.getStandardTitle(err.status),
    status: err.status,
    detail: err.message,
    instance: req.originalUrl || req.url,
    code: err.code,
    retryable,
    retryHint: resolveRetryHint(err),
  });

  res.status(err.status).type('application/problem+json').json(problem);
}

module.exports = kycWebhookErrorHandler;
