'use strict';

/**
 * API-key authentication and role-based authorization for mutating routes.
 *
 * Keys are configured through the `API_KEYS` environment variable as
 * `id:role:sha256hex` entries (comma separated). Only SHA-256 hashes are held
 * in configuration; raw keys exist only in the request header and are never
 * logged, stored or returned.
 *
 * `Authorization: Bearer <key>` and `X-API-Key: <key>` are both accepted.
 * Outcomes:
 *   - missing/malformed header -> 401 UNAUTHENTICATED (+ WWW-Authenticate: Bearer)
 *   - unknown key             -> 401 UNAUTHENTICATED
 *   - valid key, wrong role   -> 403 FORBIDDEN
 *   - production with no keys -> 503 AUTH_NOT_CONFIGURED (fail closed)
 *
 * On success `req.principal = { keyId, role }` is attached for handlers
 * (e.g. to record `createdBy` on new invoices).
 */

const crypto = require('crypto');
const config = require('../config');

/**
 * SHA-256 hex digest of a presented key.
 *
 * @param {string} value raw key
 * @returns {string} lowercase 64-char hex digest
 */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Constant-time string comparison that never throws, even for different-length
 * inputs. Both sides are hashed to a fixed 32 bytes first, so
 * `crypto.timingSafeEqual` always receives equal-length buffers and the result
 * is independent of the input length.
 *
 * @param {string} a first value
 * @param {string} b second value
 * @returns {boolean} whether the values are equal
 */
function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(Buffer.from(String(a), 'utf8')).digest();
  const right = crypto.createHash('sha256').update(Buffer.from(String(b), 'utf8')).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Extracts the API key from a request.
 *
 * @param {import('express').Request} req incoming request
 * @returns {{ state: 'missing' } | { state: 'malformed' } | { state: 'ok', key: string }} extraction result
 */
function extractKey(req) {
  const authorization = req.get('authorization');
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
    if (!match) {
      return { state: 'malformed' };
    }
    return { state: 'ok', key: match[1] };
  }
  const apiKey = req.get('x-api-key');
  if (apiKey !== undefined) {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return { state: 'malformed' };
    }
    return { state: 'ok', key: trimmed };
  }
  return { state: 'missing' };
}

/**
 * Resolves a presented raw key to a principal, or `null` when it matches none.
 *
 * The comparison runs over every configured entry in constant time so neither
 * the timing nor the result reveals which key (or role) matched first.
 *
 * @param {string} key raw presented key
 * @returns {{ keyId: string, role: string } | null} the principal
 */
function authenticate(key) {
  if (config.apiKeys.length === 0) {
    // Development fallback: a single dev key with the admin role. Never used
    // in production — the guard fails closed with 503 before reaching here.
    if (config.devApiKey && constantTimeEqual(key, config.devApiKey)) {
      return { keyId: 'dev', role: 'admin' };
    }
    return null;
  }
  const presented = sha256Hex(key);
  let matched = null;
  for (const entry of config.apiKeys) {
    if (constantTimeEqual(presented, entry.hash) && matched === null) {
      matched = { keyId: entry.id, role: entry.role };
    }
  }
  return matched;
}

/**
 * Builds middleware that authenticates the request and enforces one of the
 * given roles. Attach it per-route so GET routes stay public.
 *
 * @param {...string} roles roles allowed to use the route (from config.ROLES)
 * @returns {import('express').RequestHandler} guard middleware
 */
function requireRole(...roles) {
  if (roles.length === 0) {
    throw new Error('requireRole needs at least one role');
  }
  const unknown = roles.filter((role) => !config.ROLES.includes(role));
  if (unknown.length > 0) {
    throw new Error(`requireRole received unknown role(s): ${unknown.join(', ')}`);
  }
  const guard = function apiKeyGuard(req, res, next) {
    if (config.apiKeys.length === 0 && config.nodeEnv === 'production') {
      // Misconfigured production deployment: fail closed, never open.
      return res
        .status(503)
        .json({ error: 'API key authentication is not configured', code: 'AUTH_NOT_CONFIGURED' });
    }
    const extracted = extractKey(req);
    if (extracted.state !== 'ok') {
      res.set('WWW-Authenticate', 'Bearer');
      if (extracted.state === 'missing') {
        return res.status(401).json({ error: 'API key required', code: 'UNAUTHENTICATED' });
      }
      return res
        .status(401)
        .json({ error: 'Malformed credentials; expected "Authorization: Bearer <key>"', code: 'UNAUTHENTICATED' });
    }
    const principal = authenticate(extracted.key);
    if (principal === null) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unknown API key', code: 'UNAUTHENTICATED' });
    }
    if (!roles.includes(principal.role)) {
      return res.status(403).json({
        error: `Role "${principal.role}" is not allowed on this endpoint`,
        code: 'FORBIDDEN',
      });
    }
    req.principal = principal;
    return next();
  };
  // Marker consumed by the route-table guard test in tests/apiKeyAuth.test.js.
  guard.requiredRoles = roles.slice();
  return guard;
}

module.exports = {
  authenticate,
  constantTimeEqual,
  extractKey,
  requireRole,
  sha256Hex,
};
