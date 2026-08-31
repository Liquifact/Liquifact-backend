'use strict';

/**
 * Idempotency middleware for POST /api/invest/fund-invoice and escrow
 * funding submissions.
 *
 * State Machine:
 *   - COMPLETED: response_status IS NOT NULL - returns cached response on replay
 *   - IN_PROGRESS: response_status IS NULL with matching fingerprint - re-executes safely
 *   - CONFLICT: different fingerprint - returns 409
 *
 * Accepts an `Idempotency-Key` header validated against the existing
 * IDEMPOTENCY_KEY_PATTERN from escrowSubmit.js. Stores key +
 * (request fingerprint, status, response) with a TTL in the `idempotency_keys` table.
 * Returns the cached response on duplicate keys; returns 409 when the same key
 * is reused with a different request body fingerprint.
 *
 * Security:
 *  - Keys are validated against a strict pattern before any DB access.
 *  - Request body is hashed (SHA-256) before storage — no raw payload
 *    is persisted.
 *  - Keys expire after a configurable TTL (default 24 h) and are
 *    automatically purged.
 *  - Cached bodies are keyed by idempotency_key only and never leak across
 *    tenants or requests.
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

const DEFAULT_TTL_HOURS = 24;

/**
 * Maximum number of retry attempts for response storage persistence.
 * @type {number}
 */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Initial backoff delay in milliseconds for storage retry.
 * @type {number}
 */
const INITIAL_BACKOFF_MS = 100;

/**
 * Maximum backoff delay in milliseconds for storage retry.
 * @type {number}
 */
const MAX_BACKOFF_MS = 2000;

/**
 * Maximum age (ms) of a non-completed placeholder before it is treated as orphaned.
 */
const ORPHAN_IN_FLIGHT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 120000;
})();

/**
 * How often to refresh `updated_at` for an in-progress idempotency record.
 * Keeps long-running reconciliation batches from being mistaken for orphans.
 */
const HEARTBEAT_INTERVAL_MS = Math.max(
  1000,
  Math.floor(ORPHAN_IN_FLIGHT_TIMEOUT_MS / 3)
);

/**
 * Build an RFC 7807 problem+json body for an idempotency-key conflict.
 * @param {object} req - Express request
 * @param {string} detail - Human-readable reason
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
 * Build a durable run identity for an idempotency record.
 * The key is scoped to the tenant and reconciliation time window so the same
 * client-supplied Idempotency-Key cannot collide or replay across tenants or
 * windows.
 * @param {object} req - Express request
 * @param {string} key - Client-supplied Idempotency-Key
 * @returns {string} SHA-256 hex digest used as the idempotency_keys primary key
 */
function buildRunKey(req, key) {
  const body = req.body || {};
  const query = req.query || {};
  const tenantId =
    req.tenantId ||
    (req.tenant && req.tenant.id) ||
    (req.auth && req.auth.tenantId) ||
    'anonymous';
  const windowStart =
    body.windowStart || body.startDate || body.start ||
    query.windowStart || query.start || null;
  const windowEnd =
    body.windowEnd || body.endDate || body.end ||
    query.windowEnd || query.end || null;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ tenantId, windowStart, windowEnd, key }), 'utf8')
    .digest('hex');
}

/**
 * Detect a database unique-constraint violation.
 * @param {Error} err
 * @returns {boolean}
 */
function isUniqueViolation(err) {
  if (!err) return false;
  const code = err.code || '';
  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE constraint failed|duplicate key value/i.test(err.message || '')
  );
}

/**
 * Sleep for a specified number of milliseconds.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff with jitter.
 * @param {number} attempt - Current attempt number (0-indexed).
 * @returns {number} Backoff delay in milliseconds.
 */
function calculateBackoff(attempt) {
  const exponentialDelay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_BACKOFF_MS);
  // Add up to 25% jitter to prevent thundering herd
  const jitter = cappedDelay * 0.25 * Math.random();
  return Math.floor(cappedDelay + jitter);
}

/**
 * Persist the response body atomically with the key, with retry logic.
 * Creates or updates the idempotency record to mark completion.
 *
 * Uses the global `db` (not the transaction `trx`) because the transaction
 * commits before the response handler runs asynchronously.
 *
 * @param {object} knexClient - Knex database client (global db, not trx).
 * @param {string} key - The idempotency key.
 * @param {number} status - HTTP response status code.
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

      // Success - no need to retry
      return;
    } catch (err) {
      lastError = err;

      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        const delay = calculateBackoff(attempt);
        logger.warn(
          { key, attempt: attempt + 1, delay, error: err.message },
          'idempotency: response storage failed, retrying'
        );
        await sleep(delay);
      }
    }
  }

  // All retries exhausted - record the failure
  idempotencyStorageFailureTotal.inc({ keyPrefix: key.substring(0, 8) });
  logger.error(
    { key, error: lastError.message, attempts: MAX_RETRY_ATTEMPTS },
    'idempotency: response storage failed after max retries - key will be re-executed on replay'
  );

  // Mark the key as incomplete by setting a sentinel status
  // This ensures replay will re-execute instead of returning broken data
  try {
    await knexClient('idempotency_keys')
      .where({ idempotency_key: key })
      .update({
        response_status: -1, // Sentinel: incomplete storage
        response_body: null,
        updated_at: db.fn.now(),
      });
  } catch (markErr) {
    // Best effort - the key will be treated as in-progress on replay
    logger.error(
      { key, error: markErr.message },
      'idempotency: failed to mark key as incomplete after storage failure'
    );
  }
}

/**
 * Express middleware enforcing idempotency on funding submissions.
 *
 * Replay Contract:
 *   1. Completed key (response_status IS NOT NULL and > 0):
 *      Returns cached response with original status code.
 *   2. In-progress key (response_status IS NULL):
 *      Re-executes the handler safely; original handler logic will overwrite.
 *   3. Failed-storage key (response_status = -1):
 *      Re-executes the handler safely to recover from storage failure.
 *
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
  const runKey = buildRunKey(req, key);
  const ttlHours = getTTLHours();
  // Store as an explicit ISO 8601 string. Knex + SQLite + node-sqlite3 may
  // serialise Date objects as numbers or non-ISO strings depending on column
  // affinity rules and the surrounding column definitions; an explicit ISO
  // string is the only format that round-trips parseably on both SQLite and
  // PostgreSQL.
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  db.transaction(async (trx) => {
    const now = new Date();
    let existing = await trx('idempotency_keys')
      .where({ idempotency_key: runKey })
      .first();

    // Retention TTL backstop: purge expired rows so a stale record never
    // causes a stale replay or a spurious 409. Authoritative cleanup is
    // the background purge job; this is a defensive in-line step.
    if (
      existing &&
      new Date(String(existing.expires_at)).getTime() <= now.getTime()
    ) {
      await trx('idempotency_keys').where({ idempotency_key: runKey }).del();
      existing = null;
    }

    // Orphan in-flight recovery: a placeholder whose handler crashed,
    // timed out, or whose process restarted mid-flight would otherwise
    // remain stuck with response_status=null for the entire retention
    // TTL, permanently 409-ing the same key. Bound the poison window.
    // Use updated_at (heartbeated by the active worker) instead of
    // created_at so a slow, legitimate batch is never treated as orphaned.
    const lastActivity = existing && (existing.updated_at || existing.created_at);
    if (
      existing &&
      existing.response_status === null &&
      now.getTime() - new Date(String(lastActivity)).getTime() >
        ORPHAN_IN_FLIGHT_TIMEOUT_MS
    ) {
      await trx('idempotency_keys').where({ idempotency_key: runKey }).del();
      existing = null;
    }

    if (existing) {
      // Same key — check fingerprint
      if (existing.request_fingerprint !== bodyFingerprint) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          buildConflict(
            req,
            'Idempotency-Key reused with a different request body. Use a unique key for each distinct payload.'
          )
        );
      }

      // In-flight: another concurrent request is processing this key but
      // has not yet stored the response. Returning 409 prevents the
      // second caller from running the funding handler twice — a
      // financially dangerous outcome. Caller may safely retry after
      // completion (response stored → replay) or after the orphan
      // timeout elapses (row cleared → fresh insert).
      if (existing.response_status === null) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          buildConflict(
            req,
            'Idempotency-Key is currently being processed. Retry after the original request completes.'
          )
        );
      }

      // Check if response is actually stored (completed state)
      // response_status === -1 means storage failed, treat as incomplete
      if (existing.response_status && existing.response_status > 0) {
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

      // Response not stored (in-progress or failed-storage state)
      // Re-execute the handler safely
      logger.info(
        { key },
        'idempotency: key found but response incomplete, re-executing handler'
      );
      next();
      return;
    }

    // New key — insert placeholder on 'In Progress' state
    // response_status = null indicates request is in progress
    try {
      await trx('idempotency_keys').insert({
        idempotency_key: runKey,
        request_fingerprint: bodyFingerprint,
        response_status: null,
        response_body: null,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      // Two workers can race past the initial SELECT and both attempt the
      // INSERT. A unique violation means another worker owns this run; do not
      // execute the handler twice.
      if (isUniqueViolation(err)) {
        const conflictError = new Error('idempotency conflict');
        await trx.rollback(conflictError).catch(() => {});
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          buildConflict(
            req,
            'Idempotency-Key is currently being processed by another worker. Retry after the original request completes.'
          )
        );
      }
      throw err;
    }

    let heartbeat = null;
    const stopHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    heartbeat = setInterval(() => {
      db('idempotency_keys')
        .where({ idempotency_key: runKey })
        .update({ updated_at: db.fn.now() })
        .catch((err) => {
          logger.warn(
            { key, error: err.message },
            'idempotency: heartbeat update failed'
          );
        });
    }, HEARTBEAT_INTERVAL_MS);
    if (heartbeat.unref) heartbeat.unref();
    res.once('finish', stopHeartbeat);

    // Override res.json to capture the response for future replays.
    // IMPORTANT: use the global `db` (not `trx`) here. The surrounding
    // db.transaction() callback resolves immediately after next() — the
    // actual request handler runs asynchronously, AFTER the tx commits.
    // Calling `trx(...)` after commit throws "Transaction committed".
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      stopHeartbeat();
      // Persist response with the global `db` (NOT the trx). The trx has
      // already committed by the time res.json() is called, so using it
      // would throw "Transaction query already complete".
      persistResponse(db, runKey, res.statusCode, body).catch((err) => {
        // This catch is for synchronous context errors (shouldn't happen)
        // Background retries are handled inside persistResponse
        logger.error({ key, error: err.message }, 'idempotency: unexpected persistence error');
      });

      return originalJson(body);
    };

    next();
  }).catch((err) => {
    // Transaction-level errors (e.g. DB unavailable)
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Internal server error processing idempotency key.',
      });
    }
    // If headers already sent, the error happened post-response — log only
    logger.error('[idempotency] Post-response storage error: %s', err.message);
  });
}

module.exports = idempotencyMiddleware;