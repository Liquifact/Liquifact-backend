'use strict';

/**
 * @fileoverview Shared error-handling middleware for invoice-state routes
 * (issue #968).
 *
 * ## Problem
 * Before this module existed, each invoice-state handler (approve, link-escrow,
 * reject, history) formatted {@link StateTransitionError} responses
 * independently via the inline `sendTransitionError()` helper, producing
 * duplicated error-formatting logic in every handler.
 *
 * ## Solution
 * `invoiceStateErrorHandler` is a standard Express 4-argument error middleware that:
 *
 * 1. Intercepts only {@link StateTransitionError} instances.
 * 2. Produces a consistent `responseHelper.error()` envelope matching the
 *    existing wire format (data, meta, error with code/message/details).
 * 3. Passes non-StateTransitionError values through to `next(err)` so the
 *    global error handler can deal with them normally.
 *
 * Mount it **after** the route handlers on the invoice-state router:
 *
 *   router.use(invoiceStateErrorHandler);
 *
 * @module middleware/invoiceStateErrorHandler
 */

const responseHelper = require('../utils/responseHelper');
const logger = require('../logger');

/**
 * Invoice-state error codes and their corresponding HTTP status codes.
 * Maps the bounded set of StateTransitionError codes to statuses.
 *
 * @readonly
 * @enum {string}
 */
const INVOICE_STATE_ERROR_CODES = Object.freeze({
  /** Invoice was not found in the tenant scope. */
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
  /** Target state was not provided. */
  MISSING_TARGET_STATE: 'MISSING_TARGET_STATE',
  /** Reason is required for the target transition. */
  MISSING_TRANSITION_REASON: 'MISSING_TRANSITION_REASON',
  /** Invoice cannot be linked to escrow from its current state. */
  CANNOT_LINK_TO_ESCROW: 'CANNOT_LINK_TO_ESCROW',
  /** Invoice is already in the requested target state. */
  ALREADY_IN_TARGET_STATE: 'ALREADY_IN_TARGET_STATE',
  /** Invoice is in a terminal state and cannot transition further. */
  TERMINAL_STATE: 'TERMINAL_STATE',
  /** The requested transition is not allowed by the state machine. */
  INVALID_TRANSITION: 'INVALID_TRANSITION',
});

/**
 * Error codes that map to a 404 status rather than the default 400.
 *
 * @type {ReadonlySet<string>}
 */
const NOT_FOUND_CODES = new Set([INVOICE_STATE_ERROR_CODES.INVOICE_NOT_FOUND]);

/**
 * Resolves the HTTP status code for a {@link StateTransitionError}.
 * Uses the error's own `statusCode` when present; otherwise derives it
 * from the error code. Falls back to 400.
 *
 * @param {Error & { code?: string, statusCode?: number }} err - The error.
 * @returns {number} HTTP status code (400–404).
 */
function resolveStatus(err) {
  if (err && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  if (err && typeof err.code === 'string' && NOT_FOUND_CODES.has(err.code)) {
    return 404;
  }
  return 400;
}

/**
 * Returns `true` when the error should be handled by this middleware.
 * Matches {@link StateTransitionError} by its `name` property so that
 * `jest.resetModules()` does not break instance checks.
 *
 * @param {Error|unknown} err - The thrown error.
 * @returns {boolean}
 */
function isStateTransitionError(err) {
  return Boolean(
    err &&
    typeof err === 'object' &&
    err.name === 'StateTransitionError',
  );
}

/**
 * Extracts the `allowedTransitions` detail payload from the error, if any.
 *
 * @param {Error & { allowedTransitions?: string[] }} err - The error.
 * @returns {Object|null} Detail payload or null.
 */
function extractDetails(err) {
  if (err && Array.isArray(err.allowedTransitions) && err.allowedTransitions.length > 0) {
    return { allowedTransitions: err.allowedTransitions };
  }
  return null;
}

/**
 * Express error-handling middleware that intercepts {@link StateTransitionError}
 * instances and formats a consistent error envelope.
 *
 * Response body shape (identical to the previous inline `sendTransitionError`
 * helper):
 *
 * ```json
 * {
 *   "data": null,
 *   "meta": { "timestamp": "...", "version": "0.1.0" },
 *   "error": {
 *     "message": "Invoice not found",
 *     "code": "INVOICE_NOT_FOUND",
 *     "details": null
 *   }
 * }
 * ```
 *
 * Non-StateTransitionError values are forwarded untouched to `next(err)`.
 *
 * @param {Error}                            err  - Thrown error.
 * @param {import('express').Request}        req  - Express request.
 * @param {import('express').Response}       res  - Express response.
 * @param {import('express').NextFunction}   next - Express next callback.
 * @returns {void}
 */
function invoiceStateErrorHandler(err, req, res, next) {
  if (!isStateTransitionError(err)) {
    return next(err);
  }

  const status = resolveStatus(err);
  const details = extractDetails(err);
  const body = responseHelper.error(err.message, err.code, details);

  logger.warn(
    {
      code: err.code,
      status,
      requestId: req.id || 'unknown',
    },
    `Invoice-state error: ${err.message}`,
  );

  return res.status(status).json(body);
}

module.exports = invoiceStateErrorHandler;
module.exports.invoiceStateErrorHandler = invoiceStateErrorHandler;
module.exports.isStateTransitionError = isStateTransitionError;
module.exports.resolveStatus = resolveStatus;
module.exports.extractDetails = extractDetails;
module.exports.INVOICE_STATE_ERROR_CODES = INVOICE_STATE_ERROR_CODES;
