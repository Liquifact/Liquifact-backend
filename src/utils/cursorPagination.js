'use strict';

/**
 * @fileoverview Opaque cursor encoding/decoding for marketplace keyset pagination.
 * @module utils/cursorPagination
 */

const crypto = require('crypto');

const DEV_CURSOR_SECRET = 'dev-cursor-secret-change-in-prod';

const ALLOWED_SORT_FIELDS = Object.freeze([
  // Marketplace / invoice fields
  'yield_bps', 'maturity_date', 'funded_ratio', 'amount', 'created_at', 'updated_at',
  // Indexer (escrow_events) fields
  'ledger_sequence', 'observed_at',
]);

/**
 * Resolves the HMAC secret used to sign and verify opaque cursors.
 * Production must use a real CURSOR_SECRET or JWT_SECRET. The public dev
 * fallback is available only for local development and test runs.
 *
 * @returns {string} Cursor signing secret.
 * @throws {Error} When no real secret is configured outside development/test.
 */
function _resolveCursorSecret() {
  const configuredSecret = process.env.CURSOR_SECRET || process.env.JWT_SECRET;
  if (configuredSecret) {
    return configuredSecret;
  }

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return DEV_CURSOR_SECRET;
  }

  throw new Error('CURSOR_SECRET or JWT_SECRET must be configured for cursor pagination outside development/test');
}

/**
 * Signs a base64url cursor payload with the resolved HMAC secret.
 *
 * @param {string} payload
 * @returns {string}
 */
function _sign(payload) {
  return crypto.createHmac('sha256', _resolveCursorSecret()).update(payload).digest('hex');
}

/**
 * Encodes a cursor from the last row returned in a page.
 *
 * @param {Object} params
 * @param {string} params.sortField
 * @param {*}      params.sortValue
 * @param {string} params.id
 * @returns {string}
 */
function encodeCursor({ sortField, sortValue, id }) {
  if (!ALLOWED_SORT_FIELDS.includes(sortField)) {
    throw new Error(`encodeCursor: unsupported sortField "${sortField}"`);
  }
  if (!id || typeof id !== 'string') {
    throw new Error('encodeCursor: id must be a non-empty string');
  }

  const payload = JSON.stringify({
    sortField,
    sortValue,
    id,
    iat: Math.floor(Date.now() / 1000),
  });

  const b64 = Buffer.from(payload).toString('base64url');
  const sig = _sign(b64);
  return `${b64}.${sig}`;
}

/**
 * Decodes and validates an opaque cursor string.
 *
 * @param {string} cursor
 * @param {string} expectedSortField
 * @returns {{ sortField: string, sortValue: *, id: string, iat: number }}
 * @throws {CursorError}
 */
function decodeCursor(cursor, expectedSortField) {
  if (typeof cursor !== 'string' || !cursor.includes('.')) {
    throw new CursorError('Malformed cursor: expected base64url.signature format');
  }

  const dotIdx = cursor.lastIndexOf('.');
  const b64 = cursor.slice(0, dotIdx);
  const sig = cursor.slice(dotIdx + 1);

  const expectedSig = _sign(b64);
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new CursorError('Invalid cursor signature');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('Malformed cursor: payload is not valid JSON');
  }

  const { sortField, sortValue, id, iat } = parsed;

  if (!ALLOWED_SORT_FIELDS.includes(sortField)) {
    throw new CursorError(`Cursor contains unknown sort field "${sortField}"`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new CursorError('Cursor is missing a valid id tiebreaker');
  }
  if (typeof iat !== 'number') {
    throw new CursorError('Cursor is missing issued-at timestamp');
  }

  if (process.env.CURSOR_TTL_ENABLED === 'true') {
    const ttl = parseInt(process.env.CURSOR_TTL_SECONDS || '3600', 10);
    const now = Math.floor(Date.now() / 1000);
    if (iat && (now - iat) > ttl) {
      throw new CursorError('Cursor has expired');
    }
  }

  if (expectedSortField !== undefined && sortField !== expectedSortField) {
    throw new CursorError(
      `Cursor sort field "${sortField}" does not match requested sort field "${expectedSortField}"`
    );
  }

  return { sortField, sortValue, id, iat };
}

/**
 * Domain error for cursor-related failures.
 */
class CursorError extends Error {
  /**
   * Create a cursor domain error.
   *
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'CursorError';
  }
}

module.exports = {
  encodeCursor,
  decodeCursor,
  CursorError,
  ALLOWED_SORT_FIELDS,
};
