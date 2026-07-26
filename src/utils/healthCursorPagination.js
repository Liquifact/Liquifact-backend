'use strict';

/**
 * @fileoverview Opaque cursor encoding/decoding for health-check listing pagination.
 *
 * Health checks are ordered by their `timestamp` field (ISO 8601) with an `id`
 * tiebreaker.  Cursors are HMAC-SHA256 signed so any tampering is immediately
 * detected and rejected with a 400.
 *
 * @module utils/healthCursorPagination
 */

const crypto = require('crypto');

/** Public fallback secret — only allowed in development / test. */
const DEV_CURSOR_SECRET = 'dev-health-cursor-secret-change-in-prod';

/** Default page size returned when `limit` is absent. */
const DEFAULT_PAGE_SIZE = 10;

/** Maximum page size a caller may request. */
const MAX_PAGE_SIZE = 100;

/**
 * Resolves the HMAC signing secret.
 *
 * Priority:
 *   1. `CURSOR_SECRET`
 *   2. `JWT_SECRET`
 *   3. Development / test fallback (blocked in production)
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string} Signing secret.
 * @throws {HealthCursorError} When no secret is configured outside dev/test.
 */
function _resolveSecret(env = process.env) {
  const configured = env.CURSOR_SECRET || env.JWT_SECRET;
  if (configured) {
    return configured;
  }
  const nodeEnv = env.NODE_ENV || 'development';
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return DEV_CURSOR_SECRET;
  }
  throw new HealthCursorError(
    'CURSOR_SECRET or JWT_SECRET must be configured for health cursor pagination outside development/test',
  );
}

/**
 * Computes an HMAC-SHA256 hex signature over a base64url payload.
 *
 * @param {string} b64  Base64url-encoded payload.
 * @param {string} secret  Signing secret.
 * @returns {string}  Lowercase hex signature.
 */
function _sign(b64, secret) {
  return crypto.createHmac('sha256', secret).update(b64).digest('hex');
}

/**
 * Encodes a health-check cursor from the last item in the current page.
 *
 * The cursor encodes:
 * - `timestamp`  — ISO 8601 string that is the primary sort key.
 * - `id`         — UUID tiebreaker for equal timestamps.
 * - `iat`        — Unix timestamp (seconds) for optional TTL checks.
 *
 * @param {Object} params
 * @param {string} params.timestamp  ISO 8601 timestamp of the last item.
 * @param {string} params.id         UUID / unique identifier of the last item.
 * @param {NodeJS.ProcessEnv} [params.env=process.env]
 * @returns {string}  Opaque cursor string `<base64url>.<hex-sig>`.
 * @throws {HealthCursorError}
 */
function encodeHealthCursor({ timestamp, id, env = process.env }) {
  if (!timestamp || typeof timestamp !== 'string') {
    throw new HealthCursorError('encodeHealthCursor: timestamp must be a non-empty string');
  }
  if (!id || typeof id !== 'string') {
    throw new HealthCursorError('encodeHealthCursor: id must be a non-empty string');
  }

  const payload = JSON.stringify({
    timestamp,
    id,
    iat: Math.floor(Date.now() / 1000),
  });

  const b64 = Buffer.from(payload).toString('base64url');
  const secret = _resolveSecret(env);
  const sig = _sign(b64, secret);
  return `${b64}.${sig}`;
}

/**
 * Decodes and validates an opaque health-check cursor.
 *
 * Validates:
 * - Structural format (`<base64url>.<hex>`)
 * - HMAC signature (constant-time comparison)
 * - Payload JSON and required fields
 * - Optional TTL expiry when `CURSOR_TTL_ENABLED=true`
 *
 * @param {string} cursor  Opaque cursor produced by {@link encodeHealthCursor}.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ timestamp: string, id: string, iat: number }}
 * @throws {HealthCursorError}  On any validation failure.
 */
function decodeHealthCursor(cursor, env = process.env) {
  if (typeof cursor !== 'string' || !cursor.includes('.')) {
    throw new HealthCursorError('Malformed cursor: expected base64url.signature format');
  }

  const dotIdx = cursor.lastIndexOf('.');
  const b64 = cursor.slice(0, dotIdx);
  const sig = cursor.slice(dotIdx + 1);

  if (!b64 || !sig) {
    throw new HealthCursorError('Malformed cursor: missing payload or signature');
  }

  const secret = _resolveSecret(env);
  const expectedSig = _sign(b64, secret);

  // Constant-time comparison to prevent timing attacks.
  let sigBuf;
  let expectedBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expectedBuf = Buffer.from(expectedSig, 'hex');
  } catch {
    throw new HealthCursorError('Malformed cursor: signature is not valid hex');
  }

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new HealthCursorError('Invalid cursor signature');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    throw new HealthCursorError('Malformed cursor: payload is not valid JSON');
  }

  const { timestamp, id, iat } = parsed;

  if (!timestamp || typeof timestamp !== 'string') {
    throw new HealthCursorError('Cursor is missing a valid timestamp field');
  }
  if (!id || typeof id !== 'string') {
    throw new HealthCursorError('Cursor is missing a valid id tiebreaker');
  }
  if (typeof iat !== 'number') {
    throw new HealthCursorError('Cursor is missing issued-at timestamp');
  }

  // Optional TTL enforcement.
  if (env.CURSOR_TTL_ENABLED === 'true') {
    const ttl = parseInt(env.CURSOR_TTL_SECONDS || '3600', 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - iat > ttl) {
      throw new HealthCursorError('Cursor has expired');
    }
  }

  return { timestamp, id, iat };
}

/**
 * Clamps a raw `limit` query parameter to the valid `[1, MAX_PAGE_SIZE]` range.
 *
 * @param {string|number|undefined} raw  Raw value from `req.query.limit`.
 * @returns {number}  Clamped integer limit.
 */
function resolveLimit(raw) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * Domain error for health-cursor-related failures.
 * Carry a `name` of `'HealthCursorError'` so callers can distinguish it from
 * generic `Error` without instanceof checks across module boundaries.
 */
class HealthCursorError extends Error {
  /**
   * Creates a new HealthCursorError with the given message.
   *
   * @param {string} message  Human-readable error description.
   */
  constructor(message) {
    super(message);
    this.name = 'HealthCursorError';
  }
}

module.exports = {
  encodeHealthCursor,
  decodeHealthCursor,
  resolveLimit,
  HealthCursorError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
