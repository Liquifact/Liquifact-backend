'use strict';

/**
 * Optional idempotency middleware.
 *
 * Thin wrapper around the full idempotency middleware that only activates
 * when the client sends an `Idempotency-Key` header.  When the header is
 * absent the request passes through unchanged, preserving backward
 * compatibility for callers that do not need idempotency guarantees.
 *
 * This is applied to the invoice-state write endpoints so that retried
 * requests with the same key + body return the original response instead
 * of double-applying the state transition.
 *
 * @see src/middleware/idempotency.js
 */

const idempotencyMiddleware = require('./idempotency');

/**
 * Express middleware – optional idempotency.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function optionalIdempotency(req, res, next) {
  if (req.headers['idempotency-key']) {
    return idempotencyMiddleware(req, res, next);
  }
  next();
}

module.exports = optionalIdempotency;
