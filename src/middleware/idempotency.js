'use strict';

/**
 * Idempotency middleware for POST /api/invest/fund-invoice and escrow
 * funding submissions.
 *
 * Accepts an `Idempotency-Key` header validated against the existing
 * IDEMPOTENCY_KEY_PATTERN from escrowSubmit.js.  Stores key ?
 * (request fingerprint, status, response) with a TTL in a new
 * `idempotency_keys` table.  Returns the cached response on duplicate
 * keys; returns 409 when the same key is reused with a different request
 * body fingerprint.
 *
 * Security:
 *  - Keys are validated against a strict pattern before any DB access.
 *  - Request body is hashed (SHA-256) before storage — no raw payload
 *    is persisted.
 *  - Keys expire after a configurable TTL (default 24 h) and are
 *    automatically purged.
 */

const crypto = require('crypto');
const { IDEMPOTENCY_KEY_PATTERN } = require('../services/escrowSubmit');
const db = require('../db/knex');

const DEFAULT_TTL_HOURS = 24;

/**
 * Get TTL in hours from env or default.
 * @returns {number}
 */
function getTTLHours() {
  const raw = process.env.IDEMPOTENCY_KEY_TTL_HOURS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_HOURS;
}

/**
 * Compute a SHA-256 fingerprint of the request body for conflict detection.
 * @param {object} body
 * @returns {string}
 */
function fingerprint(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}

/**
 * Express middleware that enforces idempotency on funding submissions.
 *
 * 1. Rejects missing / invalid `Idempotency-Key` header ? 400
 * 2. Looks up the key in the database
 *    a. Found + same fingerprint ? returns cached response (200/201)
 *    b. Found + different fingerprint ? 409 Conflict
 *    c. Not found ? stores the key + fingerprint, continues
 * 3. On response finish, stores the status + body for future replays
 */
/**
 * Express middleware enforcing idempotency on funding submissions.
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Express next callback
 * @returns {void}
 */
function idempotencyMiddleware(req, res, next) {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return res.status(400).json({
      success: false,
      error: 'Idempotency-Key header is required for this endpoint.',
    });
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return res.status(400).json({
      success: false,
      error:
        'Idempotency-Key must be 8–128 URL-safe characters (A-Za-z0-9._:-).',
    });
  }

  const bodyFingerprint = fingerprint(req.body);
  const ttlHours = getTTLHours();

  // Use a transaction so we don't race on insert
  db.transaction(async (trx) => {
    const existing = await trx('idempotency_keys')
      .where({ idempotency_key: key })
      .first();

    if (existing) {
      // Same key — check fingerprint
      if (existing.request_fingerprint !== bodyFingerprint) {
        return res.status(409).json({
          success: false,
          error:
            'Idempotency-Key reused with a different request body. Use a unique key for each distinct payload.',
        });
      }

      // Replay — return the original cached response
      const cached = existing.response_body;
      const status = existing.response_status || 201;
      try {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return res.status(status).json(parsed);
      } catch {
        return res.status(status).json(cached);
      }
    }

    // New key — insert placeholder
    await trx('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: bodyFingerprint,
      response_status: null,
      response_body: null,
      expires_at: db.raw("NOW() + INTERVAL '?? hours'", [ttlHours]),
    });

    // Override res.json to capture the response before sending
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Store the response for future replays (fire-and-forget)
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
    // Transaction-level errors (e.g. DB down)
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Internal server error processing idempotency key.',
      });
    }
    // If headers already sent, the error happened post-response — log only
    console.error('[idempotency] Post-response storage error:', err.message);
  });
}

module.exports = idempotencyMiddleware;
