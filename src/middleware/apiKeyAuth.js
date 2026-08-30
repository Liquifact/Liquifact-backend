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
 * Every request is instrumented with a duration histogram and bounded error
 * counter, and a structured log line is emitted on response finish. No key
 * material, secrets, or PII are ever included in metrics or log output.
 *
 * @module middleware/apiKeyAuth
 */

const crypto = require('crypto');
const { loadApiKeyRegistry } = require('../config/apiKeys');
const logger = require('../logger');
const metrics = require('../metrics');

/** Name of the HTTP request header that carries the API key. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Classifies HTTP status code into an outcome metric label.
 * @param {number} statusCode
 * @returns {string}
 */
function classifyApiKeyOutcome(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 'success';
  if (statusCode === 401 || statusCode === 403) return 'unauthorized';
  if (statusCode === 400 || statusCode === 422) return 'bad_request';
  return 'error';
}

/**
 * Classifies HTTP status code into an error cause label.
 * @param {number} statusCode
 * @returns {string}
 */
function classifyApiKeyErrorCause(statusCode) {
  if (statusCode === 401) return 'invalid_key';
  if (statusCode === 403) return 'forbidden';
  if (statusCode >= 500) return 'server_error';
  return 'none';
}

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
 * @param {Object} [options={}] - Middleware configuration.
 * @param {string} [options.requiredScope] - Scope the key must possess.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment source used.
 * @returns {import('express').RequestHandler} Configured Express middleware function.
 */
function authenticateApiKey(options = {}) {
  const { requiredScope, env = process.env } = options;

  return (req, res, next) => {
    const startTime = process.hrtime.bigint();

    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
      const statusCode = res.statusCode;
      const outcome = classifyApiKeyOutcome(statusCode);
      const errorCause = classifyApiKeyErrorCause(statusCode);

      // Safely access metrics histogram in case it's mocked or uninitialized in test setup
      const histogram = metrics.apiKeyAuthDurationSeconds;
      if (histogram && typeof histogram.observe === 'function') {
        histogram.observe(
          {
            endpoint: req.path,
            method: req.method,
            status: String(statusCode),
            outcome,
          },
          durationMs / 1000,
        );
      }

      // Emit error cause counter only when the request resulted in an error.
      const errorCounter = metrics.apiKeyAuthErrorsTotal;
      if (statusCode >= 400 && errorCause && errorCounter && typeof errorCounter.inc === 'function') {
        errorCounter.inc({ cause: errorCause });
      }

      // Emit structured log — no keys, secrets, headers, or PII.
      const logPayload = {
        endpoint: req.path,
        method: req.method,
        status: statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        outcome,
      };

      if (statusCode >= 400) {
        logPayload.error_type = errorCause || 'unknown';
        logger.warn(logPayload, 'API key auth request failed');
      } else {
        logger.info(logPayload, 'API key auth request succeeded');
      }
    });

    const rawKey = req.headers[API_KEY_HEADER];

    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      logger.warn(
        { event: 'api_key.auth', outcome: 'missing_header', ip: req.ip, path: req.path },
        'API key authentication rejected'
      );
      return res.status(401).json({
        error: 'API key is required. Provide it via the X-API-Key header.',
      });
    }

    const registry = loadApiKeyRegistry(env);
    const entry = findEntry(registry, rawKey.trim());

    if (!entry) {
      logger.warn(
        { event: 'api_key.auth', outcome: 'invalid_key', ip: req.ip, path: req.path },
        'API key authentication rejected'
      );
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    if (entry.revoked) {
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

    setImmediate(() => {
      const { recordApiKeyUsage } = require('../services/apiKeyUsageService');
      recordApiKeyUsage(rawKey.trim(), entry.clientId, req.tenantId);
    });

    return next();
  };
}

module.exports = {
  authenticateApiKey,
  API_KEY_HEADER,
  timingSafeStringEqual,
  classifyApiKeyOutcome,
  classifyApiKeyErrorCause,
};