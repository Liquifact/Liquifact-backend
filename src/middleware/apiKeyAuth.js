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

const { loadApiKeyRegistry } = require('../config/apiKeys');

/** Name of the HTTP request header that carries the API key. */
const API_KEY_HEADER = 'x-api-key';

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
 *    is unknown or has been revoked.
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
    // eslint-disable-next-line security/detect-object-injection
    const rawKey = req.headers[API_KEY_HEADER];

    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      return res.status(401).json({
        error: 'API key is required. Provide it via the X-API-Key header.',
      });
    }

    // Load registry fresh on each call so env changes in tests are respected.
    const registry = loadApiKeyRegistry(env);
    const entry = registry.get(rawKey.trim());

    if (!entry) {
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    if (entry.revoked) {
      return res.status(401).json({ error: 'API key has been revoked.' });
    }

    if (requiredScope && !entry.scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: `Insufficient permissions. Required scope: "${requiredScope}".`,
      });
    }

    /** @type {ApiClient} */
    req.apiClient = {
      clientId: entry.clientId,
      scopes: [...entry.scopes],
    };

    return next();
  };
}

module.exports = {
  authenticateApiKey,
  API_KEY_HEADER,
};
