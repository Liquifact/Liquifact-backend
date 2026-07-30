'use strict';

const { randomUUID } = require('crypto');

const CORRELATION_HEADER = 'x-correlation-id';
const REQUEST_ID_HEADER_NAMES = Object.freeze(['x-request-id', 'request-id']);
const REQUEST_IDENTIFIER_HEADER_NAMES = Object.freeze([
  ...REQUEST_ID_HEADER_NAMES,
  CORRELATION_HEADER,
]);

const MAX_REQUEST_IDENTIFIER_LENGTH = 64;
const REQUEST_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Validate a client-supplied request identifier.
 *
 * @param {unknown} value Candidate identifier from a request header or request object.
 * @returns {string|null} The trusted identifier, or null when a new one is required.
 */
function sanitizeRequestIdentifier(value) {
  if (typeof value !== 'string') {
    return null;
  }

  if (value.length === 0 || value.length > MAX_REQUEST_IDENTIFIER_LENGTH) {
    return null;
  }

  if (!REQUEST_IDENTIFIER_PATTERN.test(value)) {
    return null;
  }

  return value;
}

/**
 * Generate a full-strength server-side request identifier.
 *
 * @returns {string} A generated identifier within the accepted charset and length bound.
 */
function generateRequestIdentifier() {
  return `req_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Resolve the first acceptable identifier from the supported inbound headers.
 *
 * Request-ID aliases are preferred over correlation ID when clients send both,
 * because `req.id` is the primary server-side request identity.
 *
 * @param {NodeJS.Dict<string | string[]> | undefined} headers Inbound request headers.
 * @returns {string|null} The first trusted identifier, or null when none are acceptable.
 */
function resolveRequestIdentifierFromHeaders(headers) {
  for (const headerName of REQUEST_IDENTIFIER_HEADER_NAMES) {
    const value = sanitizeRequestIdentifier(headers?.[headerName]);
    if (value) {
      return value;
    }
  }

  return null;
}

/**
 * Resolve the canonical identifier already attached to a request, if present.
 *
 * @param {import('express').Request} req Express request object.
 * @returns {string|null} The trusted in-memory identifier, or null.
 */
function resolveRequestIdentifierFromRequest(req) {
  return sanitizeRequestIdentifier(req.id) || sanitizeRequestIdentifier(req.correlationId);
}

module.exports = {
  CORRELATION_HEADER,
  REQUEST_ID_HEADER_NAMES,
  REQUEST_IDENTIFIER_HEADER_NAMES,
  MAX_REQUEST_IDENTIFIER_LENGTH,
  REQUEST_IDENTIFIER_PATTERN,
  sanitizeRequestIdentifier,
  generateRequestIdentifier,
  resolveRequestIdentifierFromHeaders,
  resolveRequestIdentifierFromRequest,
};
