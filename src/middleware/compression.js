'use strict';

/**
 * @fileoverview Threshold-based gzip/deflate response compression middleware.
 *
 * Intercepts `res.json()` calls on routes where it is mounted, serialises the
 * payload, and — when the serialised byte length exceeds the configured
 * threshold AND the client advertises a supported encoding via
 * `Accept-Encoding` — compresses the body with gzip or deflate before
 * writing it to the socket.
 *
 * Design decisions
 * ────────────────
 * - Uses Node's built-in `zlib` module; **no new runtime dependencies**.
 * - Encoding preference order: gzip → deflate → identity (no compression).
 * - Small responses (below threshold) are always sent as plain JSON, even
 *   when the client accepts compression.  This avoids the overhead of
 *   compressing already-small payloads where gains are negligible.
 * - Only `application/json` responses are compressed; binary / stream
 *   responses pass through untouched.
 * - The `Content-Length` header is removed and `Transfer-Encoding: chunked`
 *   is not set — Express handles framing automatically once we write the
 *   compressed buffer.
 * - `Vary: Accept-Encoding` is always set so caches correctly key on the
 *   negotiated encoding.
 *
 * Usage
 * ─────
 * Mount on the invoice-state router (or any Express router) **before** the
 * route handlers:
 *
 *   const { createCompressionMiddleware } = require('./middleware/compression');
 *   router.use(createCompressionMiddleware());
 *
 * Or with a custom threshold:
 *
 *   router.use(createCompressionMiddleware({ threshold: 2048 }));
 *
 * @module middleware/compression
 */

const zlib = require('zlib');

/**
 * Default byte threshold above which responses are compressed.
 * 1 KB — small enough to catch most non-trivial JSON payloads.
 * @type {number}
 */
const DEFAULT_THRESHOLD = 1024;

/**
 * Parses the `Accept-Encoding` request header and returns the best supported
 * encoding from the preference list, or `'identity'` when none match.
 *
 * Respects quality values (`q=`) and the wildcard (`*`).  The server
 * preference order is: gzip > deflate > identity.
 *
 * @param {string|undefined} acceptEncoding - Value of the `Accept-Encoding` header.
 * @returns {'gzip'|'deflate'|'identity'} The negotiated encoding.
 */
function negotiateEncoding(acceptEncoding) {
  if (!acceptEncoding || typeof acceptEncoding !== 'string') {
    return 'identity';
  }

  // Parse "gzip;q=1.0, deflate;q=0.8, *;q=0.1" into a map of encoding → q
  const encodings = {};
  for (const part of acceptEncoding.split(',')) {
    const [rawName, ...qParts] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    let q = 1.0;
    for (const qPart of qParts) {
      const m = qPart.trim().match(/^q\s*=\s*([0-9.]+)$/i);
      if (m) {
        q = parseFloat(m[1]);
        break;
      }
    }
    if (!encodings[name] || encodings[name] < q) {
      encodings[name] = q;
    }
  }

  // Resolve wildcard: treat '*' as applying to any not explicitly listed
  const wildcard = encodings['*'];

  /**
   * Returns the effective q-value for a named encoding.
   * @param {string} name
   * @returns {number}
   */
  function qOf(name) {
    if (name in encodings) return encodings[name];
    if (wildcard !== undefined) return wildcard;
    return 0;
  }

  // Server preference: gzip first, then deflate, then identity
  if (qOf('gzip') > 0) return 'gzip';
  if (qOf('deflate') > 0) return 'deflate';
  return 'identity';
}

/**
 * Compresses `buffer` with the specified encoding.
 *
 * @param {Buffer} buffer - The data to compress.
 * @param {'gzip'|'deflate'} encoding - Compression algorithm.
 * @returns {Promise<Buffer>} Compressed data.
 */
function compress(buffer, encoding) {
  return new Promise((resolve, reject) => {
    const fn = encoding === 'gzip' ? zlib.gzip : zlib.deflate;
    fn(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * Creates a threshold-based JSON compression middleware.
 *
 * The middleware wraps `res.json()` so that:
 *
 *   1. The payload is serialised to JSON (same as Express would do).
 *   2. If the byte length is **≤ threshold**, the original `res.json()` is
 *      called unchanged — no compression, no header mutation.
 *   3. If the byte length is **> threshold** AND the client advertises a
 *      supported encoding, the body is compressed, `Content-Encoding` is set,
 *      `Content-Length` is removed (length changes post-compression), and the
 *      compressed buffer is written directly via `res.end()`.
 *   4. `Vary: Accept-Encoding` is always appended so proxies/CDNs cache
 *      compressed and uncompressed variants separately.
 *
 * @param {object}  [options={}]
 * @param {number}  [options.threshold=1024] - Minimum byte length to trigger
 *   compression.  Responses at or below this size are never compressed.
 * @returns {import('express').RequestHandler} Express middleware function.
 */
function createCompressionMiddleware(options = {}) {
  const threshold = typeof options.threshold === 'number' && options.threshold >= 0
    ? options.threshold
    : DEFAULT_THRESHOLD;

  return function compressionMiddleware(req, res, next) {
    // Always advertise that this route varies on Accept-Encoding so that
    // intermediate caches never serve a compressed response to a client that
    // didn't request compression (and vice-versa).
    res.vary('Accept-Encoding');

    const originalJson = res.json.bind(res);

    /**
     * Replacement for `res.json()` that compresses large payloads.
     *
     * @param {*} body - Value to serialise and send.
     * @returns {import('express').Response}
     */
    res.json = function compressedJson(body) {
      // Serialise exactly as Express would
      const payload = JSON.stringify(body);
      const buffer = Buffer.from(payload, 'utf8');

      // Below threshold → pass through without touching anything
      if (buffer.length <= threshold) {
        // Restore original and delegate — ensures all Express header logic runs
        res.json = originalJson;
        return originalJson(body);
      }

      // Negotiate encoding from the request
      const encoding = negotiateEncoding(req.headers['accept-encoding']);

      if (encoding === 'identity') {
        // Client doesn't accept compression → plain JSON
        res.json = originalJson;
        return originalJson(body);
      }

      // Compress asynchronously then write the response
      compress(buffer, encoding)
        .then((compressed) => {
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          // Remove Content-Length — the compressed size differs from the JSON size
          res.removeHeader('Content-Length');
          res.end(compressed);
        })
        .catch((err) => {
          // Compression failed — fall back to uncompressed JSON
          res.json = originalJson;
          originalJson(body);
        });

      // Return res to maintain Express chaining contract
      return res;
    };

    next();
  };
}

module.exports = {
  createCompressionMiddleware,
  negotiateEncoding,
  DEFAULT_THRESHOLD,
};
