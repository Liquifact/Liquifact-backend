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
 * ## Determinism contract
 *
 * Retryability and retry hints are **owned by the error instance** — this
 * middleware reads `err.retryable` and `err.retryHint` directly rather than
 * maintaining its own lookup sets.  The single source of truth is the
 * `KYC_WEBHOOK_ERROR_RECOVERY` table in `src/errors/KycWebhookError.js`.
 *
 * @module middleware/kycWebhookErrorHandler
 */

const KycWebhookError = require('../errors/KycWebhookError');
const formatProblemDetails = require('../utils/problemDetails');
const logger = require('../logger');
const { sanitizeTelemetryString } = require('../utils/telemetryRedaction');

/**
 * Express error-handling middleware for KYC webhook routes.
 *
 * Only handles {@link KycWebhookError} instances; all other errors are
 * forwarded to the next error handler.
 *
 * Emits RFC 7807 application/problem+json responses with type, title, status,
 * detail, instance, code, retryable, and retry_hint fields.
 *
 * Recovery metadata (`retryable`, `retry_hint`) is read directly from the
 * error instance — no local lookup sets are maintained here.
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

  // `err.message` is redacted here as a final, defense-in-depth choke point
  // for the log line specifically (issue #1200) — the messages that can
  // carry provider-controlled content are already sanitized at the point
  // they are constructed (see kycWebhookService.js), so this is a backstop
  // rather than the only line of defense.  `correlationId` is a value this
  // service generates itself, never provider input, so it is logged as-is.
  //
  // toLogContext() provides structured observability fields (code, status,
  // smeId, tenantId, requestId) without leaking raw error internals.
  logger.warn(
    {
      err: sanitizeTelemetryString(err.message),
      correlationId,
      ...err.toLogContext(),
    },
    'kyc-webhook error',
  );

  // Store the error code so the post-response metrics hook can read it.
  req._kycErrorCode = err.code;

  // Recovery metadata comes directly from the error instance — computed once
  // at construction from the canonical KYC_WEBHOOK_ERROR_RECOVERY table.
  const retryable = err.retryable;
  const retryHint = err.retryHint ?? '';

  const problem = formatProblemDetails({
    type: formatProblemDetails.getProblemType(err.status),
    title: formatProblemDetails.getStandardTitle(err.status),
    status: err.status,
    detail: err.message,
    instance: req.originalUrl || req.url,
    code: err.code,
    retryable,
    retryHint,
  });

  res.status(err.status).type('application/problem+json').json(problem);
}

module.exports = kycWebhookErrorHandler;
