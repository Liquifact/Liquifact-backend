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
 * ## Transaction gap fix
 *
 * The original implementation intercepted `res.json` inside a `db.transaction`
 * callback and used the `trx` reference inside the override.  Because
 * `db.transaction()` commits when its callback resolves, the override fired
 * **after** the transaction had already committed, meaning:
 *
 * - The response-body update used a settled (committed) transaction reference
 *   whose connection was already returned to the pool — this is undefined
 *   behaviour in Knex.
 * - The `trx` update was fire-and-forget: errors were silently swallowed.
 * - A concurrent identical request that read the placeholder row between the
 *   commit and the update would see a row with `response_status = null` and
 *   try to replay `null`, returning `200` with a null body.
 *
 * The fix:
 * - Use `db(table)` (the global pool connection) in the `res.json` override
 *   rather than the committed `trx` reference.
 * - Keep the `res.json` override outside the transaction; it runs after the
 *   response is flushed and after the transaction is long gone.
 * - The response-capture update is still fire-and-forget (best-effort) but
 *   now operates on a live connection.
 *
 * @module middleware/kycIdempotency
 */

const crypto = require('crypto');
const { IDEMPOTENCY_KEY_PATTERN } = require('../services/escrowSubmit');
const db = require('../db/knex');
const {
  HTTP_HEADERS,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_DB,
} = require('../constants/kycWebhooks');

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
  const key = req.header(HTTP_HEADERS.IDEMPOTENCY_KEY);
  if (!key) {
    return res.status(400).json({
      error: KYC_WEBHOOK_MESSAGES.IDEMPOTENCY_KEY_REQUIRED,
    });
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return res.status(400).json({
      error: KYC_WEBHOOK_MESSAGES.IDEMPOTENCY_KEY_INVALID,
    });
  }

  // Fingerprint the raw body — the KYC webhook uses express.raw(), so
  // `req.body` is a Buffer containing the exact bytes that were HMAC-signed.
  const rawBody = req.body instanceof Buffer
    ? req.body.toString('utf8')
    : String(req.body || '');
  const bodyFingerprint = fingerprintRawBody(rawBody);
  const ttlHours = getTTLHours();

  // The transaction only covers the read-then-write-placeholder path.
  // The response-capture update happens outside this transaction (see below)
  // using a fresh db() call against the global pool so that:
  // (a) it is not using a committed/returned transaction connection, and
  // (b) a crash between the placeholder insert and the response write still
  //     leaves the placeholder row in place (null response_body) which tells
  //     the next replay attempt that the request is "in-flight" and it should
  //     wait rather than immediately replaying null.
  db.transaction(async (trx) => {
    const existing = await trx(KYC_WEBHOOK_DB.TABLE_IDEMPOTENCY_KEYS)
      .where({ idempotency_key: key })
      .first();

    if (existing) {
      // Key reuse — verify same body
      if (existing.request_fingerprint !== bodyFingerprint) {
        return res.status(409).json({
          error: KYC_WEBHOOK_MESSAGES.IDEMPOTENCY_KEY_REUSED,
        });
      }

      // If the placeholder row exists but response_body is still null the
      // original request has not yet returned (concurrent in-flight or
      // crashed mid-flight).  Return a 202 Accepted so the caller knows to
      // poll / retry rather than receiving a misleading 200 with a null body.
      if (existing.response_body === null || existing.response_body === undefined) {
        return res.status(202).json({
          status: 'processing',
          message: 'Request is being processed. Retry with the same Idempotency-Key to get the final result.',
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

    // New key — insert placeholder row (response_body / response_status remain
    // null until the handler completes and the res.json override fires)
    await trx(KYC_WEBHOOK_DB.TABLE_IDEMPOTENCY_KEYS).insert({
      idempotency_key: key,
      request_fingerprint: bodyFingerprint,
      response_status: null,
      response_body: null,
      expires_at: db.raw("NOW() + INTERVAL '?? hours'", [ttlHours]),
    });

    // The transaction commits here when this callback resolves.
    // DO NOT use trx inside the res.json override — by the time it fires,
    // the transaction will already be committed and the connection returned.
  }).then(() => {
    // If the transaction callback already sent a response (replay, conflict,
    // or in-flight 202), headers are already flushed — do not call next()
    // and do not install the override.
    if (res.headersSent) {
      return;
    }

    // The transaction has committed (new-key path).  Install the res.json
    // override that captures the handler's response.  This runs on a fresh
    // db() connection (the global pool), not the committed trx reference.
    const originalJson = res.json.bind(res);
    res.json = function captureIdempotencyResponse(body) {
      // Restore immediately so a double-call (e.g. error handler after
      // handler) does not call captureIdempotencyResponse recursively.
      res.json = originalJson;

      // Best-effort: store the response for future replays.
      // Errors here must never prevent the response from reaching the client.
      db(KYC_WEBHOOK_DB.TABLE_IDEMPOTENCY_KEYS)
        .where({ idempotency_key: key })
        .update({
          response_status: res.statusCode,
          response_body: JSON.stringify(body),
          updated_at: db.fn.now(),
        })
        .catch((storeErr) => {
          // Log but do not re-throw: the request has already been processed
          // successfully; losing the cached response means the next identical
          // request will be treated as in-flight (202) rather than replayed,
          // which is safe behaviour.
          console.error('[kyc-idempotency] Failed to store idempotency response:', storeErr.message);
        });

      return originalJson(body);
    };

    next();
  }).catch((err) => {
    if (!res.headersSent) {
      return res.status(500).json({
        error: KYC_WEBHOOK_MESSAGES.IDEMPOTENCY_SERVER_ERROR,
      });
    }
    console.error('[kyc-idempotency] Post-response storage error:', err.message);
  });
}

module.exports = kycIdempotencyMiddleware;
