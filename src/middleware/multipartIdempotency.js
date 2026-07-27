'use strict';

/**
 * @fileoverview Multipart-aware idempotency middleware for persistence write
 * endpoints that accept `multipart/form-data` uploads (e.g. POST /api/sme/invoice).
 *
 * ## Why a separate middleware?
 *
 * The standard `idempotencyMiddleware` fingerprints `req.body` (JSON-serialised).
 * For multipart form submissions, `req.body` carries only the text fields parsed by
 * multer; the uploaded binary lives in `req.file.buffer`.  A fingerprint that ignores
 * the file would let a retry with a *different* file sneak past the conflict check.
 *
 * This middleware runs **after** multer has populated `req.file` (and `req.body`
 * with any accompanying form fields).  It computes a compound fingerprint:
 *
 *   SHA-256( JSON.stringify(formFields) + ":" + SHA-256(fileBuffer) )
 *
 * Behaviour then mirrors `idempotencyMiddleware` exactly:
 *   - COMPLETED key + matching fingerprint → replay cached response (no re-upload).
 *   - IN-PROGRESS key + matching fingerprint → 409 (another concurrent request is
 *     processing).
 *   - Any key + different fingerprint → 409 Conflict (RFC 7807).
 *   - New key → insert placeholder, run handler, cache response.
 *
 * ## Optional vs. mandatory
 *
 * Two exports are provided:
 *  - `multipartIdempotencyMiddleware` — mandatory; returns 400 when the header is
 *    absent.  Use this when idempotency is a hard contract for a route.
 *  - `optionalMultipartIdempotency` — optional; skips idempotency entirely when
 *    the `Idempotency-Key` header is absent.  Use this to preserve backward
 *    compatibility for callers that do not send the header.
 *
 * ## Security
 *  - The file buffer is hashed (SHA-256) before storage — no raw binary is persisted.
 *  - Only the SHA-256 compound fingerprint is stored; no payload or file content leaks
 *    into the idempotency store.
 *  - Keys expire after a configurable TTL (default 24 h) and are purged by the
 *    background `idempotencyPurge` job.
 *  - Key format is validated against the shared `IDEMPOTENCY_KEY_PATTERN` before any
 *    DB access.
 *
 * @module middleware/multipartIdempotency
 * @see src/middleware/idempotency.js — base implementation for JSON bodies
 */

const crypto = require('crypto');
const { IDEMPOTENCY_KEY_PATTERN } = require('../services/escrowSubmit');
const db = require('../db/knex');
const { createProblemDetails, LIQUifact_PROBLEM_BASE } = require('./problemJson');
const logger = require('../logger');

let idempotencyStorageFailureTotal;
try {
  idempotencyStorageFailureTotal =
    require('../metrics').idempotencyStorageFailureTotal || { inc: () => {} };
} catch (_e) {
  idempotencyStorageFailureTotal = { inc: () => {} };
}

// ---------------------------------------------------------------------------
// Configuration constants (mirror idempotency.js values for consistency)
// ---------------------------------------------------------------------------

const DEFAULT_TTL_HOURS = 24;
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2000;

const ORPHAN_IN_FLIGHT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 120000;
})();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
 * Sleep for a specified number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential back-off with up to 25% jitter.
 * @param {number} attempt - 0-indexed attempt number.
 * @returns {number} Delay in milliseconds.
 */
function calculateBackoff(attempt) {
  const exponentialDelay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_BACKOFF_MS);
  const jitter = cappedDelay * 0.25 * Math.random();
  return Math.floor(cappedDelay + jitter);
}

/**
 * Compute a compound SHA-256 fingerprint for a multipart request.
 *
 * The fingerprint covers both the form fields and the uploaded file so that
 * changing *either* part constitutes a new payload and triggers a 409 on key
 * reuse.
 *
 * Formula:
 *   outer = SHA-256(
 *     JSON.stringify(sortedFormFields) + ":" + SHA-256(fileBuffer || "")
 *   )
 *
 * Form field keys are sorted alphabetically to ensure key-order independence
 * (multer's field ordering is deterministic, but callers should not rely on it).
 * When no file is present the file contribution is SHA-256("") so the
 * fingerprint is still valid for form-field-only multipart bodies.
 *
 * @param {object} formFields - `req.body` from multer (may be `{}`).
 * @param {Buffer|null|undefined} fileBuffer - `req.file.buffer` from multer.
 * @returns {string} 64-character lowercase hex SHA-256 digest.
 */
function multipartFingerprint(formFields, fileBuffer) {
  // Canonical form-fields string — sort keys to be order-independent.
  const sortedFields = {};
  for (const k of Object.keys(formFields || {}).sort()) {
    sortedFields[k] = (formFields || {})[k];
  }
  const fieldsStr = JSON.stringify(sortedFields);

  // File contribution — hash the raw buffer; hash("") when no file.
  const fileHash = crypto
    .createHash('sha256')
    .update(fileBuffer || Buffer.alloc(0))
    .digest('hex');

  // Compound outer hash
  return crypto
    .createHash('sha256')
    .update(`${fieldsStr}:${fileHash}`, 'utf8')
    .digest('hex');
}

/**
 * Build an RFC 7807 problem+json body for an idempotency-key conflict.
 * @param {import('express').Request} req
 * @param {string} detail
 * @returns {object}
 */
function buildConflict(req, detail) {
  return createProblemDetails({
    type: `${LIQUifact_PROBLEM_BASE || 'https://liquifact.com/probs'}/conflict`,
    title: 'Conflict',
    status: 409,
    detail,
    requestId: req.id || req.headers['x-request-id'] || 'unknown',
  });
}

/**
 * Persist the response body for future replays, with exponential retry.
 *
 * Uses the **global** `db` (not a transaction) because this runs after
 * the surrounding transaction has already committed.
 *
 * @param {import('knex').Knex} knexClient - Global Knex instance.
 * @param {string} key - Idempotency key.
 * @param {number} status - HTTP status code of the response.
 * @param {object} body - Response body to persist.
 * @returns {Promise<void>}
 */
async function persistResponse(knexClient, key, status, body) {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      await knexClient('idempotency_keys')
        .where({ idempotency_key: key })
        .update({
          response_status: status,
          response_body: JSON.stringify(body),
          updated_at: db.fn.now(),
        });
      return; // success
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        const delay = calculateBackoff(attempt);
        logger.warn(
          { key, attempt: attempt + 1, delay, error: err.message },
          'multipartIdempotency: response storage failed, retrying'
        );
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  idempotencyStorageFailureTotal.inc({ keyPrefix: key.substring(0, 8) });
  logger.error(
    { key, error: lastError.message, attempts: MAX_RETRY_ATTEMPTS },
    'multipartIdempotency: response storage failed after max retries'
  );

  // Mark as sentinel -1 so next replay re-executes instead of returning broken data
  try {
    await knexClient('idempotency_keys')
      .where({ idempotency_key: key })
      .update({
        response_status: -1,
        response_body: null,
        updated_at: db.fn.now(),
      });
  } catch (markErr) {
    logger.error(
      { key, error: markErr.message },
      'multipartIdempotency: failed to mark key as incomplete after storage failure'
    );
  }
}

// ---------------------------------------------------------------------------
// Core middleware logic (shared between mandatory and optional variants)
// ---------------------------------------------------------------------------

/**
 * Inner implementation — always runs idempotency logic.
 *
 * Assumes `req.file` (and `req.body`) have already been populated by multer.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function runMultipartIdempotency(req, res, next) {
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

  // Fingerprint covers both form fields and file buffer.
  const fileBuffer = req.file ? req.file.buffer : null;
  const bodyFingerprint = multipartFingerprint(req.body || {}, fileBuffer);

  const ttlHours = getTTLHours();
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  db.transaction(async (trx) => {
    const now = new Date();
    let existing = await trx('idempotency_keys')
      .where({ idempotency_key: key })
      .first();

    // In-line TTL backstop: purge expired rows so a stale record never
    // causes a stale replay or a spurious 409.
    if (
      existing &&
      new Date(String(existing.expires_at)).getTime() <= now.getTime()
    ) {
      await trx('idempotency_keys').where({ idempotency_key: key }).del();
      existing = null;
    }

    // Orphan in-flight recovery: a placeholder whose handler crashed or
    // timed out would otherwise block the same key for the entire TTL.
    if (
      existing &&
      existing.response_status === null &&
      now.getTime() - new Date(String(existing.created_at)).getTime() >
        ORPHAN_IN_FLIGHT_TIMEOUT_MS
    ) {
      await trx('idempotency_keys').where({ idempotency_key: key }).del();
      existing = null;
    }

    if (existing) {
      // Fingerprint mismatch → conflict
      if (existing.request_fingerprint !== bodyFingerprint) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          buildConflict(
            req,
            'Idempotency-Key reused with a different request body. Use a unique key for each distinct payload.'
          )
        );
      }

      // In-flight (no response stored yet) → another concurrent request is
      // processing; reject the duplicate to prevent double-upload.
      if (existing.response_status === null) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          buildConflict(
            req,
            'Idempotency-Key is currently being processed. Retry after the original request completes.'
          )
        );
      }

      // Completed with a valid cached response → replay
      if (existing.response_status && existing.response_status > 0) {
        const cached = existing.response_body;
        const status = existing.response_status || 200;
        try {
          const parsed =
            typeof cached === 'string' ? JSON.parse(cached) : cached;
          return res.status(status).json(parsed);
        } catch {
          return res.status(status).json(cached);
        }
      }

      // Sentinel -1 (storage previously failed) → re-execute
      logger.info(
        { key },
        'multipartIdempotency: key found but response incomplete, re-executing handler'
      );
      next();
      return;
    }

    // New key — insert placeholder (in-progress)
    await trx('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: bodyFingerprint,
      response_status: null,
      response_body: null,
      expires_at: expiresAt,
    });

    // Override res.json to capture response for future replays.
    // Use global `db`, NOT `trx` — the transaction commits before the
    // async handler calls res.json().
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      persistResponse(db, key, res.statusCode, body).catch((err) => {
        logger.error(
          { key, error: err.message },
          'multipartIdempotency: unexpected persistence error'
        );
      });
      return originalJson(body);
    };

    next();
  }).catch((err) => {
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Internal server error processing idempotency key.',
      });
    }
    logger.error(
      '[multipartIdempotency] Post-response storage error: %s',
      err.message
    );
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Mandatory multipart idempotency middleware.
 *
 * Returns 400 when the `Idempotency-Key` header is absent.
 * Must be placed **after** `multer` (or equivalent) in the middleware chain.
 *
 * @type {import('express').RequestHandler}
 */
function multipartIdempotencyMiddleware(req, res, next) {
  return runMultipartIdempotency(req, res, next);
}

/**
 * Optional multipart idempotency middleware.
 *
 * When the `Idempotency-Key` header is absent the request passes through
 * unchanged, preserving backward compatibility for callers that do not send
 * the header.
 *
 * Must be placed **after** `multer` (or equivalent) in the middleware chain.
 *
 * @type {import('express').RequestHandler}
 */
function optionalMultipartIdempotency(req, res, next) {
  if (req.headers['idempotency-key']) {
    return runMultipartIdempotency(req, res, next);
  }
  next();
}

module.exports = {
  multipartIdempotencyMiddleware,
  optionalMultipartIdempotency,
  // Exported for testing
  multipartFingerprint,
};
