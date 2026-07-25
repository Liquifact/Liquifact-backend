/**
 * API Key Authentication Middleware.
 *
 * Validates the `X-API-Key` request header against the in-memory key registry
 * loaded from environment variables, checks revocation status, and enforces
 * optional scope-based permission checks.
 *
 * On success the authenticated client description is attached to `req.apiClient`
 * so that downstream handlers can inspect it.
 *
 * @module middleware/apiKeyAuth
 */

const crypto = require('crypto');
const { loadApiKeyRegistry } = require('../config/apiKeys');
const logger = require('../logger');

/** Name of the HTTP request header that carries the API key. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Compares two strings in constant time to prevent timing attacks.
 *
 * Both strings are hashed with SHA-256 before comparison so that
 * `crypto.timingSafeEqual` always receives equal-length buffers, regardless
 * of the input lengths.
 *
 * @param {string} a - First string (e.g. the candidate key from the request).
 * @param {string} b - Second string (e.g. a key from the registry).
 * @returns {boolean} `true` when both strings are identical.
 */
function timingSafeStringEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Looks up a key in the registry using constant-time comparison for every
 * candidate, preventing timing-based enumeration of valid keys.
 *
 * @param {Map<string, import('../config/apiKeys').ApiKeyEntry>} registry
 * @param {string} candidate - The trimmed key from the request header.
 * @returns {import('../config/apiKeys').ApiKeyEntry | undefined}
 */
function findEntry(registry, candidate) {
  let matched;
  for (const [registryKey, entry] of registry) {
    if (timingSafeStringEqual(candidate, registryKey)) {
      matched = entry;
    }
  }
  return matched;
}

/**
 * @typedef {Object} ApiClient
 * @property {string}   clientId - Identifier of the authenticated service client.
 * @property {string[]} scopes   - Permissions granted to this client for this request.
 */

/**
 * Creates an Express middleware that authenticates requests via an API key
 * supplied in the `X-API-Key` header.
 *
 * The middleware operates in three stages:
 * 1. **Presence check** — rejects with `401` when the header is missing.
 * 2. **Registry lookup + revocation check** — rejects with `401` when the key
 *    is unknown or has been revoked. The lookup uses constant-time comparison
 *    to prevent timing-based side-channel attacks.
 * 3. **Scope check** (optional) — when `requiredScope` is supplied the key must
 *    include that scope, otherwise the request is rejected with `403`.
 *
 * @param {Object} [options={}] - Middleware configuration.
 * @param {string} [options.requiredScope] - Scope the key must possess. When
 *   omitted any valid, non-revoked key is accepted.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment source used
 *   to load the key registry; override in tests.
 * @returns {import('express').RequestHandler} Configured Express middleware function.
 */
function authenticateApiKey(options = {}) {
  const { requiredScope, env = process.env } = options;

  return (req, res, next) => {
    const rawKey = req.headers[API_KEY_HEADER];

    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      // Audit: missing X-API-Key. Never include the value in the log.
      logger.warn(
        { event: 'api_key.auth', outcome: 'missing_header', ip: req.ip, path: req.path },
        'API key authentication rejected'
      );
      return res.status(401).json({
        error: 'API key is required. Provide it via the X-API-Key header.',
      });
    }

    // Load registry fresh on each call so env changes in tests are respected.
    const registry = loadApiKeyRegistry(env);
    const entry = findEntry(registry, rawKey.trim());

    if (!entry) {
      // Audit: unknown key. Never log the candidate key.
      logger.warn(
        { event: 'api_key.auth', outcome: 'invalid_key', ip: req.ip, path: req.path },
        'API key authentication rejected'
      );
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    if (entry.revoked) {
      // Audit: revoked key. We can record the clientId but never the key string.
      logger.warn(
        {
          event: 'api_key.auth',
          outcome: 'revoked',
          clientId: entry.clientId,
          ip: req.ip,
          path: req.path,
        },
        'API key authentication rejected'
      );
      return res.status(401).json({ error: 'API key has been revoked.' });
    }

    if (requiredScope && !entry.scopes.includes(requiredScope)) {
      // Audit: scope mismatch. Record the clientId + required scope, never the key.
      logger.warn(
        {
          event: 'api_key.auth',
          outcome: 'insufficient_scope',
          clientId: entry.clientId,
          requiredScope,
          ip: req.ip,
          path: req.path,
        },
        'API key authentication rejected'
      );
      return res.status(403).json({
        error: `Insufficient permissions. Required scope: "${requiredScope}".`,
      });
    }

    /** @type {ApiClient} */
    req.apiClient = {
      clientId: entry.clientId,
      scopes: [...entry.scopes],
    };

    // Audit: successful auth. Record clientId + scopes only — never the key.
    logger.info(
      {
        event: 'api_key.auth',
        outcome: 'success',
        clientId: entry.clientId,
        scopes: entry.scopes,
        ip: req.ip,
        path: req.path,
      },
      'API key authentication succeeded'
    );

    return next();
  };
}

module.exports = {
  authenticateApiKey,
  API_KEY_HEADER,
  timingSafeStringEqual,
};
