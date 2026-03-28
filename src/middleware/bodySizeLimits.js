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
 * @returns {void}
 */
function sendPayloadTooLarge(req, res, limit) {
  res.status(413).json({
    error: 'Payload Too Large',
    message: `Request body exceeds the maximum allowed size of ${limit}.`,
    limit,
    path: req.path,
  });
}

/**
 * Creates a JSON body parser middleware with an explicit size limit.
 *
 * The middleware sets `strict: true` so only JSON objects and arrays
 * are accepted (primitive root values are rejected).
 *
 * @param {string} [limit=DEFAULT_LIMITS.json] - Maximum allowed body size.
 * @returns {import('express').RequestHandler[]} Array of two handlers:
 *   the express body parser and a size-validation guard.
 *
 * @example
 * app.use(jsonBodyLimit('200kb'));
 */
function jsonBodyLimit(limit) {
  const resolvedLimit = limit || DEFAULT_LIMITS.json;
  const maxBytes = parseSize(resolvedLimit);

  return [
    express.json({ limit: resolvedLimit, strict: true }),
    /**
     * Content-Length pre-flight guard.
     *
     * @param {import('express').Request}      req
     * @param {import('express').Response}     res
     * @param {import('express').NextFunction} next
     * @returns {void}
     */
    function jsonSizeGuard(req, res, next) {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (!isNaN(contentLength) && contentLength > maxBytes) {
        return sendPayloadTooLarge(req, res, resolvedLimit);
      }
      next();
    },
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
    express.urlencoded({ limit: resolvedLimit, extended: false }),
    /**
     * Content-Length pre-flight guard.
     *
     * @param {import('express').Request}      req
     * @param {import('express').Response}     res
     * @param {import('express').NextFunction} next
     * @returns {void}
     */
    function urlencodedSizeGuard(req, res, next) {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (!isNaN(contentLength) && contentLength > maxBytes) {
        return sendPayloadTooLarge(req, res, resolvedLimit);
      }
      next();
    },
  ];
}

/**
 * Express error-handling middleware that converts body-parser's
 * `PayloadTooLargeError` into a clean 413 JSON response.
 *
 * Mount this **after** all routes so it catches errors bubbled via `next(err)`.
 *
 * @param {Error}                          err
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} next
 * @returns {void}
 *
 * @example
 * app.use(payloadTooLargeHandler);
 */
function payloadTooLargeHandler(err, req, res, next) {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'Request body exceeds the maximum allowed size.',
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
  return jsonBodyLimit(limit || DEFAULT_LIMITS.invoice);
}

module.exports = {
  DEFAULT_LIMITS,
  parseSize,
  jsonBodyLimit,
  urlencodedBodyLimit,
  payloadTooLargeHandler,
  invoiceBodyLimit,
};