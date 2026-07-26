'use strict';

/**
 * Idempotency middleware for KYC webhook write endpoints.
 *
 * The KYC webhook endpoint receives raw request bodies (Buffer) because
 * the HMAC signature must be verified against the exact bytes.  This
 * middleware fingerprints the raw body string (rather than `req.body` as
 * a parsed object) while otherwise following the same idempotency-key
 * pattern used by funding submissions.
 *
 * Behaviour:
 *   1. Missing / invalid `Idempotency-Key` header → 400
 *   2. New key → insert placeholder, continue to handler, store response
 *   3. Same key + same body → replay cached response
 *   4. Same key + different body → 409 Conflict
 *
 * Keys are stored in the shared `idempotency_keys` table and expire after
 * a configurable TTL (default 24 h, env: IDEMPOTENCY_KEY_TTL_HOURS).
 *
 * @module middleware/kycIdempotency
 */

const crypto = require('crypto');
const { IDEMPOTENCY_KEY_PATTERN } = require('../services/escrowSubmit');
const db = require('../db/knex');

const DEFAULT_TTL_HOURS = 24;

/**
 * Returns the configured idempotency-key TTL in hours.
 * @returns {number}
 */
function getTTLHours() {
  const raw = process.env.IDEMPOTENCY_KEY_TTL_HOURS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_HOURS;
}

/**
 * Computes a SHA-256 fingerprint of the raw request body string.
 * @param {string} rawBody - The raw request body as a UTF-8 string.
 * @returns {string} Hex-encoded SHA-256 hash.
 */
function fingerprintRawBody(rawBody) {
  return crypto
    .createHash('sha256')
    .update(rawBody, 'utf8')
    .digest('hex');
}

/**
 * Express middleware that enforces idempotency on KYC webhook writes.
 *
 * Mount BEFORE the KYC webhook handler.  The raw body parser
 * (`express.raw()`) must already have run so `req.body` is a Buffer.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function kycIdempotencyMiddleware(req, res, next) {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return res.status(400).json({
      error: 'Idempotency-Key header is required for this endpoint.',
    });
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return res.status(400).json({
      error:
        'Idempotency-Key must be 8–128 URL-safe characters (A-Za-z0-9._:-).',
    });
  }

  // Fingerprint the raw body — the KYC webhook uses express.raw(), so
  // `req.body` is a Buffer containing the exact bytes that were HMAC-signed.
  const rawBody = req.body instanceof Buffer
    ? req.body.toString('utf8')
    : String(req.body || '');
  const bodyFingerprint = fingerprintRawBody(rawBody);
  const ttlHours = getTTLHours();

  db.transaction(async (trx) => {
    const existing = await trx('idempotency_keys')
      .where({ idempotency_key: key })
      .first();

    if (existing) {
      // Key reuse — verify same body
      if (existing.request_fingerprint !== bodyFingerprint) {
        return res.status(409).json({
          error:
            'Idempotency-Key reused with a different request body. Use a unique key for each distinct payload.',
        });
      }

      // Replay the original cached response
      const cached = existing.response_body;
      const status = existing.response_status || 200;
      try {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return res.status(status).json(parsed);
      } catch (_e) {
        return res.status(status).json(cached);
      }
    }

    // New key — insert placeholder row
    await trx('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: bodyFingerprint,
      response_status: null,
      response_body: null,
      expires_at: db.raw("NOW() + INTERVAL '?? hours'", [ttlHours]),
    });

    // Intercept res.json to capture and store the response for future replays
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      trx('idempotency_keys')
        .where({ idempotency_key: key })
        .update({
          response_status: res.statusCode,
          response_body: JSON.stringify(body),
          updated_at: db.fn.now(),
        })
        .catch(() => {
          // Best-effort — don't fail the request if storage fails
        });
      return originalJson(body);
    };

    next();
  }).catch((err) => {
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Internal server error processing idempotency key.',
      });
    }
    console.error('[kyc-idempotency] Post-response storage error:', err.message);
  });
}

module.exports = kycIdempotencyMiddleware;
