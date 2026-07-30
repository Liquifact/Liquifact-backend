'use strict';

/**
 * @fileoverview Middleware to attach a unique request ID to every request.
 *
 * This ensures that logs can be correlated across multiple middleware and services.
 * It checks for an existing X-Request-Id header (e.g., from a load balancer)
 * and generates a fresh, server-side UUID when the client value is missing or
 * unacceptable.
 *
 * Security: a client-supplied request id is only trusted when it matches a
 * strict charset and length bound. This prevents log forging (injection of
 * newlines / control characters into structured log lines) and resource
 * amplification (multi-kilobyte ids duplicated across every log entry and the
 * response header).
 *
 * @module middleware/requestId
 */

const { createRequestLogger } = require('../logger');
const { run } = require('../requestContext');
const {
  MAX_REQUEST_IDENTIFIER_LENGTH,
  REQUEST_IDENTIFIER_PATTERN,
  sanitizeRequestIdentifier,
  generateRequestIdentifier,
  resolveRequestIdentifierFromHeaders,
} = require('./requestIdentifier');

/**
 * Attaches a validated, bounded request ID to the request and response objects.
 *
 * The single sanitized id is the only value carried into the child logger
 * (`req.log`) and echoed in the `X-Request-Id` response header, so no
 * untrusted bytes ever reach a log sink or a downstream client.
 *
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 */
const requestId = (req, res, next) => {
  // Prefer a validated client-supplied id, otherwise fall back to a fresh
  // server-generated id. This is the canonical id for both request and
  // correlation fields.
  const id = resolveRequestIdentifierFromHeaders(req.headers) || generateRequestIdentifier();

  // Attach to request object for use in subsequent middleware/handlers.
  req.id = id;
  req.correlationId = id;
  req.log = createRequestLogger(req);

  // Echo the validated id so clients/proxies can see it.
  res.setHeader('X-Request-Id', id);

  // Seed the AsyncLocalStorage context so all downstream async work
  // (services, jobs dispatched within the request) automatically inherit it.
  run({ requestId: id }, next);
};

module.exports = requestId;
module.exports.sanitizeRequestId = sanitizeRequestIdentifier;
module.exports.generateRequestId = generateRequestIdentifier;
module.exports.resolveRequestIdFromHeaders = resolveRequestIdentifierFromHeaders;
module.exports.MAX_REQUEST_ID_LENGTH = MAX_REQUEST_IDENTIFIER_LENGTH;
module.exports.REQUEST_ID_PATTERN = REQUEST_IDENTIFIER_PATTERN;
