/**
 * @fileoverview Request body size limit middleware for LiquiFact API.
 *
 * Enforces per-route payload size caps to protect API availability
 * against oversized or malicious request bodies. All limits are
 * environment-configurable with safe production defaults.
 *
 * @module middleware/bodySizeLimits
 */

'use strict';

const express = require('express');
const { bodySizeLimitRejectionsTotal } = require('../metrics');

const BODY_LIMIT_CONTEXT = Symbol('liquifact.bodyLimitContext');

/**
 * Default byte limits for each body content type.
 * Values are intentionally conservative to prevent abuse.
 *
 * @constant {Object} DEFAULT_LIMITS
 * @property {string} json        - Max JSON body size (default 100 KB).
 * @property {string} urlencoded  - Max URL-encoded body size (default 50 KB).
 * @property {string} raw         - Max raw/binary body size (default 1 MB).
 * @property {string} invoice     - Stricter limit for invoice upload endpoints (default 512 KB).
 */
const DEFAULT_LIMITS = {
  json:       process.env.BODY_LIMIT_JSON        || '100kb',
  urlencoded: process.env.BODY_LIMIT_URLENCODED  || '50kb',
  raw:        process.env.BODY_LIMIT_RAW         || '1mb',
  invoice:    process.env.BODY_LIMIT_INVOICE     || '512kb',
};

/**
 * Converts a human-readable size string (e.g. "100kb", "1mb") to bytes.
 *
 * Supports the following suffixes (case-insensitive):
 *   - `b`  → bytes
 *   - `kb` → kilobytes
 *   - `mb` → megabytes
 *   - `gb` → gigabytes
 *
 * @param {string} sizeStr - Human-readable size string.
 * @returns {number} Equivalent size in bytes.
 * @throws {TypeError} If `sizeStr` is not a non-empty string.
 * @throws {RangeError} If `sizeStr` cannot be parsed or uses an unknown unit.
 *
 * @example
 * parseSize('100kb'); // 102400
 * parseSize('1mb');   // 1048576
 */
function parseSize(sizeStr) {
  if (typeof sizeStr !== 'string' || sizeStr.trim() === '') {
    throw new TypeError('sizeStr must be a non-empty string');
  }

  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) {
    throw new RangeError(`Cannot parse size string: "${sizeStr}"`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();

  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.floor(value * multipliers[unit]);
}

/**
 * Builds a standardised 413 Payload Too Large JSON error response.
 *
 * @param {import('express').Request}  req  - Express request object.
 * @param {import('express').Response} res  - Express response object.
 * @param {string} limit - The human-readable size limit that was exceeded.
 * @param {string} type - Metric label for the body limit that rejected the request.
 * @returns {void}
 */
function sendPayloadTooLarge(req, res, limit, type) {
  bodySizeLimitRejectionsTotal.labels(type).inc();

  res.status(413).json({
    error: 'Payload Too Large',
    message: `Request body exceeds the maximum allowed size of ${limit}.`,
    limit,
    path: req.path,
  });
}

/**
 * Determines the limit type label for metrics from the body parser type.
 * Used to distinguish between `json`, `urlencoded`, and `invoice` limit types.
 *
 * @param {string} parserType - The base parser type ('json' or 'urlencoded').
 * @param {string} resolvedLimit - The resolved limit string, used to detect invoice limit.
 * @returns {string} The metric label type.
 */
function resolveLimitType(parserType, resolvedLimit) {
  // When the invoice limit (512 KB) is used, label as 'invoice' for operational visibility
  if (parserType === 'json' && resolvedLimit === DEFAULT_LIMITS.invoice) {
    return 'invoice';
  }
  return parserType;
}

/**
 * Stores body-limit metadata on the request so parser-raised size errors keep
 * the same metric label as pre-flight rejections.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {string} limit - Human-readable limit string.
 * @param {string} type - Metric label for the active body limit.
 * @returns {void}
 */
function setBodyLimitContext(req, limit, type) {
  req[BODY_LIMIT_CONTEXT] = { limit, type };
}

/**
 * Reads body-limit metadata captured by the pre-parser guard.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {{ limit: string, type: string }|undefined} Stored context.
 */
function getBodyLimitContext(req) {
  return req[BODY_LIMIT_CONTEXT];
}

/**
 * Parses a trustworthy Content-Length value.
 *
 * Missing, repeated, negative, decimal, or malformed values return null so the
 * downstream parser limit remains authoritative instead of treating the body as
 * zero bytes.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {number|null} Declared byte length, or null when absent or invalid.
 */
function getDeclaredContentLength(req) {
  const rawContentLength = req.headers && req.headers['content-length'];

  if (typeof rawContentLength !== 'string' || rawContentLength.trim() === '') {
    return null;
  }

  const declaredLength = Number(rawContentLength);

  if (!Number.isInteger(declaredLength) || declaredLength < 0) {
    return null;
  }

  return declaredLength;
}

/**
 * Applies the shared body-size pre-flight behavior for parser middleware.
 *
 * Requests without a valid Content-Length, including chunked transfer bodies,
 * are not assumed to be zero bytes. The parser still enforces the configured
 * byte cap, and the stored context preserves the correct 413 metric label.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @param {number} maxBytes - Maximum allowed bytes.
 * @param {string} resolvedLimit - Human-readable limit string.
 * @param {string} limitType - Metric label for this body limit.
 * @returns {void}
 */
function enforceDeclaredBodyLimit(req, res, next, maxBytes, resolvedLimit, limitType) {
  setBodyLimitContext(req, resolvedLimit, limitType);

  const contentLength = getDeclaredContentLength(req);

  if (contentLength === null) {
    next();
    return;
  }

  if (contentLength > maxBytes) {
    sendPayloadTooLarge(req, res, resolvedLimit, limitType);
    return;
  }

  next();
}

/**
 * Creates a JSON body parser middleware with an explicit size limit.
 *
 * The middleware sets `strict: true` so only JSON objects and arrays
 * are accepted (primitive root values are rejected).
 *
 * @param {string} [limit=DEFAULT_LIMITS.json] - Maximum allowed body size.
 * @param {string} [typeOverride] - Optional metric label override.
 * @returns {import('express').RequestHandler[]} Array of two handlers:
 *   the express body parser and a size-validation guard.
 *
 * @example
 * app.use(jsonBodyLimit('200kb'));
 */
function jsonBodyLimit(limit, typeOverride) {
  const resolvedLimit = limit || DEFAULT_LIMITS.json;
  const maxBytes = parseSize(resolvedLimit);
  const limitType = typeOverride || resolveLimitType('json', resolvedLimit);

  return [
    /**
     * Content-Length pre-flight guard — runs before the body parser so that
     * oversized requests are rejected immediately without reading the body.
     *
     * @param {import('express').Request}      req
     * @param {import('express').Response}     res
     * @param {import('express').NextFunction} next
     * @returns {void}
     */
    function jsonSizeGuard(req, res, next) {
      enforceDeclaredBodyLimit(req, res, next, maxBytes, resolvedLimit, limitType);
    },
    express.json({ limit: resolvedLimit, strict: true }),
  ];
}

/**
 * Creates a URL-encoded body parser middleware with an explicit size limit.
 *
 * @param {string} [limit=DEFAULT_LIMITS.urlencoded] - Maximum allowed body size.
 * @returns {import('express').RequestHandler[]} Array of two handlers.
 *
 * @example
 * app.use(urlencodedBodyLimit('50kb'));
 */
function urlencodedBodyLimit(limit) {
  const resolvedLimit = limit || DEFAULT_LIMITS.urlencoded;
  const maxBytes = parseSize(resolvedLimit);

  return [
    /**
     * Content-Length pre-flight guard — runs before the body parser so that
     * oversized requests are rejected immediately without reading the body.
     *
     * @param {import('express').Request}      req
     * @param {import('express').Response}     res
     * @param {import('express').NextFunction} next
     * @returns {void}
     */
    function urlencodedSizeGuard(req, res, next) {
      enforceDeclaredBodyLimit(req, res, next, maxBytes, resolvedLimit, 'urlencoded');
    },
    express.urlencoded({ limit: resolvedLimit, extended: false }),
  ];
}

/**
 * Derives the limit type label from the request's content-type header for
 * metrics emitted by the error handler. Content-type headers are
 * attacker-controlled so we only match known safe prefixes; anything else
 * falls back to 'unknown'.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function deriveLimitTypeFromContentType(req) {
  const ct = (req.headers && req.headers['content-type']) || '';
  if (ct.startsWith('application/json')) {
    return 'json';
  }
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    return 'urlencoded';
  }
  return 'unknown';
}

/**
 * Express error-handling middleware that converts body-parser's
 * `PayloadTooLargeError` into a clean 413 JSON response.
 *
 * Mount this **after** all routes so it catches errors bubbled via `next(err)`.
 *
 * @param {Error} err - Body parser or application error.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 *
 * @example
 * app.use(payloadTooLargeHandler);
 */
function payloadTooLargeHandler(err, req, res, next) {
  if (err.type === 'entity.too.large') {
    const limitContext = getBodyLimitContext(req);
    const limitValue = typeof err.limit === 'number' ? `${err.limit}b` : 'unknown';
    const limitType = limitContext ? limitContext.type : deriveLimitTypeFromContentType(req);

    bodySizeLimitRejectionsTotal.labels(limitType).inc();

    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'Request body exceeds the maximum allowed size.',
      limit: limitValue,
      path: req.path,
    });
  }
  next(err);
}

/**
 * Creates stricter JSON body parser middleware for sensitive endpoints
 * such as invoice uploads and escrow writes.
 *
 * Uses `DEFAULT_LIMITS.invoice` (512 KB) unless overridden.
 *
 * @param {string} [limit=DEFAULT_LIMITS.invoice] - Maximum allowed body size.
 * @returns {import('express').RequestHandler[]} Array of two handlers.
 *
 * @example
 * router.post('/invoices', ...invoiceBodyLimit(), invoiceHandler);
 */
function invoiceBodyLimit(limit) {
  return jsonBodyLimit(limit || DEFAULT_LIMITS.invoice, 'invoice');
}

module.exports = {
  DEFAULT_LIMITS,
  parseSize,
  jsonBodyLimit,
  urlencodedBodyLimit,
  payloadTooLargeHandler,
  invoiceBodyLimit,
};
