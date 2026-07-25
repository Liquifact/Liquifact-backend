/**
 * Rate Limiting Middleware
 * Protects endpoints from abuse and DoS using IP and token-based limiting.
 * Supports per-IP and per-API key limiting via environment variables.
 *
 * Environment Variables:
 * - RATE_LIMIT_WINDOW_MS: Time window in milliseconds (default: 15 minutes)
 * - RATE_LIMIT_MAX_REQUESTS: Max requests per window for global limiter (default: 100)
 * - RATE_LIMIT_SENSITIVE_WINDOW_MS: Time window for sensitive endpoints (default: 1 hour)
 * - RATE_LIMIT_SENSITIVE_MAX: Max requests per window for sensitive limiter (default: 40)
 * - RATE_LIMIT_API_KEY_WINDOW_MS: Time window for API key limit (default: 15 minutes)
 * - RATE_LIMIT_API_KEY_MAX: Max requests per window per API key (default: 1000)
 * - CONFIG_RATE_LIMIT_WINDOW_MS: Time window for config endpoints (#754) (default: 60 s)
 * - CONFIG_RATE_LIMIT_MAX: Max requests per window per client for config endpoints
 *   (#754), defaults to a tight budget because config writes are infrequent
 *   admin-only operations.
 *
 * Trust-proxy note: the application does not call `app.set('trust proxy', ...)`
 * anywhere, so `req.ip` reflects the socket remote address by default. We pass
 * `validate: { xForwardedForHeader: false }` to express-rate-limit so any future
 * reverse-proxy adapter can opt-in explicitly; otherwise an attacker cannot
 * escape per-IP quotas by spoofing `X-Forwarded-For`.
 */

const rateLimit = require('express-rate-limit');

/**
 * Resolves the Redis-backed store for a scope when the shared Redis client is
 * available and `rate-limit-redis` can be loaded; otherwise returns
 * `undefined` so express-rate-limit falls back to its default `MemoryStore`.
 * Logs exactly the same warning shape `createRateLimiter` used historically so
 * cluster-detection (issue #429) keeps working. Factored out so the config
 * limiter and the generic factory can both opt into cluster-safe storage
 * without duplicating the resolution logic.
 *
 * @param {string} scope - Structural namespace isolation marker.
 * @returns {object | undefined} `RedisStore` instance or `undefined`.
 */
function resolveRateLimitStore(scope) {
  let store;
  try {
    const { getRedisClient } = require('../cache/redis');
    const { client, isAvailable } = getRedisClient();
    if (isAvailable && client) {
      const { RedisStore } = require('rate-limit-redis');
      store = new RedisStore({
        sendCommand: (...args) => client.sendCommand(args),
        prefix: `rate-limit:${scope}:`,
      });
    } else {
      console.warn(
        `[RateLimit] Redis store unavailable for scope [${scope}]. Falling back safely to MemoryStore.`,
      );
    }
  } catch (_err) {
    console.warn(
      `[RateLimit] rate-limit-redis unavailable for scope [${scope}]. Falling back to MemoryStore.`,
    );
  }
  return store;
}

/**
 * Creates an isolated, context-aware rate limiting middleware block.
 * Uses a Redis backing layer if available, otherwise safely falls back to standard memory tracks.
 * @param {string} scope - The structural namespace isolation marker (e.g., 'global', 'sensitive', 'api-key', 'config')
 * @param {number} windowMs - The tracking duration window block in milliseconds
 * @param {number} max - Request limits allowed inside the designated window frame
 * @returns {Function} Express middleware handler
 */
function createRateLimiter(scope, windowMs = WINDOW_MS, max = MAX_REQUESTS) {
  const { getRedisClient } = require('../cache/redis');
  const store = resolveRateLimitStore(scope);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => {
      // Prioritize authenticated API Keys over direct machine client IP strings
      return req.headers['x-api-key'] || req.ip;
    },
    handler: (req, res, next, options) => {
      res.status(options.statusCode).json({
        error: 'Too many requests.',
        message: `Rate limit threshold breached for scope: ${scope}. Please try again later.`,
      });
    },
    // Fail-open strategy: If Redis times out or fails midway through execution, log warning and let request bypass
    skip: () => {
      if (store && !getRedisClient().isAvailable) {
        console.error(`[RateLimit] Emergency fail-open bypass activated on scope [${scope}] due to live Redis link dropout.`);
        return true;
      }
      return false;
    }
  });
}

/**
 * Parse environment variable as positive integer.
 * @param {string} envVar - Environment variable name.
 * @param {number} defaultValue - Default value if parse fails.
 * @returns {number} Parsed integer value.
 */
function parseRateLimitEnv(envVar, defaultValue) {
  const value = process.env[envVar];
  if (!value) { return defaultValue; }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

/**
 * Gets the API key from request headers or returns undefined.
 * @param {import('express').Request} req - Express request object.
 * @returns {string|undefined} The API key if present.
 */
function getApiKey(req) {
  const headers = req.headers || {};
  const apiKey = headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : undefined;
}

/**
 * Generates a rate-limit key using user ID, API key, or IP address.
 * Uses API key when available for more granular limiting.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The rate-limit key.
 */
function keyGenerator(req) {
  if (req.user && req.user.id) {
    return `user_${req.user.id}`;
  }
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Generates a rate-limit key specifically for API key-based limiting.
 * Falls back to IP when no API key is present.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The rate-limit key.
 */
function apiKeyKeyGenerator(req) {
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

const GLOBAL_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
const GLOBAL_MAX_REQUESTS = parseRateLimitEnv('RATE_LIMIT_MAX_REQUESTS', 100);
const SENSITIVE_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_WINDOW_MS', 60 * 60 * 1000);
const SENSITIVE_MAX = parseRateLimitEnv('RATE_LIMIT_SENSITIVE_MAX', 40);
const API_KEY_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_API_KEY_WINDOW_MS', 15 * 60 * 1000);
const API_KEY_MAX = parseRateLimitEnv('RATE_LIMIT_API_KEY_MAX', 1000);

// Issue #754 — config-endpoint rate limiter. Defaults target the admin-only
// reality of /api/admin/config: a 60 s window with 20 requests per client is
// enough for six interactive writes per minute across the entire feature
// surface while still making accidental bursts (e.g. a buggy redeploy loop)
// fail loudly within seconds rather than silently after hours of damage.
const CONFIG_RATE_LIMIT_WINDOW_MS = parseRateLimitEnv('CONFIG_RATE_LIMIT_WINDOW_MS', 60 * 1000);
const CONFIG_RATE_LIMIT_MAX = parseRateLimitEnv('CONFIG_RATE_LIMIT_MAX', 20);

// Issue #769 — health-endpoint rate limiter. Defaults are generous enough for
// Kubernetes liveness/readiness probes (every 1–10 s per pod) plus external
// monitoring scrapers while still bounding the blast radius of an accidental
// polling loop or a misconfigured probe.
const HEALTH_RATE_LIMIT_WINDOW_MS = parseRateLimitEnv('HEALTH_RATE_LIMIT_WINDOW_MS', 15 * 1000);
const HEALTH_RATE_LIMIT_MAX = parseRateLimitEnv('HEALTH_RATE_LIMIT_MAX', 60);

/**
 * Standard global rate limiter for all API endpoints.
 * Limits each IP/API key to configured requests per window.
 *
 * @returns {Function} Express rate limiting middleware.
 */
const globalLimiter = rateLimit({
  windowMs: GLOBAL_WINDOW_MS,
  limit: GLOBAL_MAX_REQUESTS,
  message: {
    error: `Too many requests from this IP/API key, please try again after ${Math.round(GLOBAL_WINDOW_MS / 60000)} minutes`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

/**
 * Stricter limiter for sensitive operations (Invoices, Escrow).
 * Limits each IP/API key to configured requests per hour.
 *
 * @returns {Function} Express rate limiting middleware.
 */
const sensitiveLimiter = rateLimit({
  windowMs: SENSITIVE_WINDOW_MS,
  limit: SENSITIVE_MAX,
  message: {
    error: `Strict rate limit exceeded for sensitive operations. Please try again later.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

/**
 * API key specific rate limiter.
 * Allows higher limits for authenticated API key clients.
 * Falls back to IP-based limiting when no API key is provided.
 *
 * @returns {Function} Express rate limiting middleware.
 */
const apiKeyLimiter = rateLimit({
  windowMs: API_KEY_WINDOW_MS,
  limit: API_KEY_MAX,
  message: {
    error: `API key rate limit exceeded. Max ${API_KEY_MAX} requests per ${Math.round(API_KEY_WINDOW_MS / 60000)} minutes.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyKeyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

/**
 * Per-client rate-limiter key generator for {@link adminConfigLimiter}.
 *
 * An X-API-Key takes priority so multiple writers sharing a NAT/public-IP
 * cannot drag each other into 429. Falls back to socket-bound `req.ip` when
 * no API key is supplied. The `apikey_` prefix keeps Redis prefixes legible
 * in monitoring dashboards.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} Bucket identifier.
 */
function adminConfigKeyGenerator(req) {
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

// ────────────────────────────────────────────────────────────────────────────
// adminConfigLimiter (issue #754)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 429 response body for {@link adminConfigLimiter}.
 *
 * Emits the canonical RFC 7807 extensions used elsewhere in this codebase
 * (see {@link module:utils/problemDetails} + {@link module:errors/AppError}).
 * Notably the `retry_hint` field is snake-cased for wire compatibility with
 * the rest of the platform's problem+json responses; clients can rely on
 * `retry_hint` being present on any 429 they receive.
 *
 * Note: express-rate-limit already sets a precise `Retry-After` header
 * (seconds remaining until the window resets). We deliberately do NOT
 * override it — the framework value is strictly more accurate than any
 * `windowMs`-derived estimate could ever be.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} _next - Express next (unused).
 * @param {{ statusCode: number, windowMs: number }} options - RateLimit options.
 * @returns {void}
 */
function adminConfigHandler(_req, res, _next, options) {
  res.status(options.statusCode).json({
    type: 'https://liquifact.com/probs/too-many-requests',
    title: 'Too Many Requests',
    status: options.statusCode,
    code: 'RATE_LIMITED',
    retryable: true,
    retry_hint: 'Wait for the rate-limit window to reset before retrying.',
    scope: 'config',
    error: 'Too many requests.',
    message: 'Rate limit threshold breached for /api/admin/config. Please try again later.',
  });
}

/**
 * Per-client rate limiter for /api/admin/config (issue #754).
 *
 * Each client — identified by X-API-Key when present, otherwise by socket IP —
 * is allotted a small but configurable per-window budget. The window and cap
 * are env-driven so operators can tighten the limit without a code change.
 *
 * Issue-specific options (X-Forwarded-For hardening, structured 429 body,
 * prefixed key format) are passed inline to express-rate-limit so they do not
 * leak into the shared {@link createRateLimiter} helper used by the global,
 * sensitive, and api-key scopes. The Redis store resolution is delegated to
 * {@link resolveRateLimitStore} so multi-instance deployments (#429) still
 * see cluster-correct counting when Redis is available.
 *
 * The limiter is mounted in {@link routes/adminConfig} BEFORE the admin auth
 * stack so that failed authentication attempts still consume quota (defending
 * against auth-flooding with bogus API keys / JWTs).
 *
 * Env vars:
 *   - `CONFIG_RATE_LIMIT_WINDOW_MS` (default 60 000)
 *   - `CONFIG_RATE_LIMIT_MAX`       (default 20)
 *
 * @type {import('express').RequestHandler}
 */
const adminConfigLimiter = rateLimit({
  windowMs: CONFIG_RATE_LIMIT_WINDOW_MS,
  limit: CONFIG_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: resolveRateLimitStore('config'),
  keyGenerator: adminConfigKeyGenerator,
  // Reject X-Forwarded-For at the express-rate-limit layer so nobody can
  // spoof a different `req.ip` to dodge the IP-fallback bucket. Operators
  // behind a real reverse proxy must still opt-in via `app.set('trust
  // proxy', …)` — see src/metrics.js for the cluster-detection caveats.
  validate: {
    xForwardedForHeader: false,
  },
  handler: adminConfigHandler,
});

/**
 * Factory variant of {@link adminConfigLimiter} for callers (mostly tests)
 * that need to construct a fresh limiter with different bounds. Production
 * code should mount `adminConfigLimiter` directly so the Redis/console.warn
 * handshake runs once at module load, not once per request.
 *
 * Inlines the same option shape as `adminConfigLimiter` instead of reaching
 * into its `.keyGenerator` / `.handler` symbols (which are not part of
 * express-rate-limit's public API).
 *
 * @returns {import('express').RequestHandler}
 */
function createConfigRateLimiter() {
  return rateLimit({
    windowMs: CONFIG_RATE_LIMIT_WINDOW_MS,
    limit: CONFIG_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('config'),
    keyGenerator: adminConfigKeyGenerator,
    validate: {
      xForwardedForHeader: false,
    },
    handler: adminConfigHandler,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// healthLimiter (issue #769)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 429 response body for {@link healthLimiter}.
 *
 * Emits the canonical RFC 7807 extensions used elsewhere in this codebase.
 * Notably the `retry_hint` field is snake-cased for wire compatibility with
 * the rest of the platform's problem+json responses.
 *
 * Note: express-rate-limit already sets a precise `Retry-After` header
 * (seconds remaining until the window resets). We deliberately do NOT
 * override it — the framework value is strictly more accurate than any
 * `windowMs`-derived estimate could ever be.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} _next - Express next (unused).
 * @param {{ statusCode: number, windowMs: number }} options - RateLimit options.
 * @returns {void}
 */
function healthHandler(_req, res, _next, options) {
  res.status(options.statusCode).json({
    type: 'https://liquifact.com/probs/too-many-requests',
    title: 'Too Many Requests',
    status: options.statusCode,
    code: 'RATE_LIMITED',
    retryable: true,
    retry_hint: 'Wait for the rate-limit window to reset before retrying.',
    scope: 'health',
    error: 'Too many requests.',
    message: 'Rate limit threshold breached for health endpoints. Please try again later.',
  });
}

/**
 * Per-client rate limiter for health endpoints (issue #769).
 *
 * Each client — identified by X-API-Key when present, otherwise by socket IP —
 * is allotted a configurable per-window budget. Defaults are generous enough
 * for Kubernetes liveness/readiness probes plus external monitoring scrapers
 * while still bounding the blast radius of accidental polling loops.
 *
 * The limiter is mounted BEFORE any auth middleware so that unauthenticated
 * clients still consume quota (defending against probe-flooding).
 *
 * Env vars:
 *   - `HEALTH_RATE_LIMIT_WINDOW_MS` (default 15 000)
 *   - `HEALTH_RATE_LIMIT_MAX`       (default 60)
 *
 * @type {import('express').RequestHandler}
 */
const healthLimiter = rateLimit({
  windowMs: HEALTH_RATE_LIMIT_WINDOW_MS,
  limit: HEALTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: resolveRateLimitStore('health'),
  keyGenerator: adminConfigKeyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
  handler: healthHandler,
});

/**
 * Factory variant of {@link healthLimiter} for callers (mostly tests)
 * that need to construct a fresh limiter with different bounds. Production
 * code should mount `healthLimiter` directly so the Redis/console.warn
 * handshake runs once at module load, not once per request.
 *
 * @returns {import('express').RequestHandler}
 */
function createHealthRateLimiter() {
  return rateLimit({
    windowMs: HEALTH_RATE_LIMIT_WINDOW_MS,
    limit: HEALTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('health'),
    keyGenerator: adminConfigKeyGenerator,
    validate: {
      xForwardedForHeader: false,
    },
    handler: healthHandler,
  });
}

module.exports = {
  createRateLimiter,
  globalLimiter,
  sensitiveLimiter,
  apiKeyLimiter,
  createConfigRateLimiter,
  adminConfigLimiter,
  adminConfigKeyGenerator,
  adminConfigHandler,
  healthLimiter,
  createHealthRateLimiter,
  healthHandler,
  parseRateLimitEnv,
  keyGenerator,
  apiKeyKeyGenerator,
  getApiKey,
  CONFIG_RATE_LIMIT_WINDOW_MS,
  CONFIG_RATE_LIMIT_MAX,
  HEALTH_RATE_LIMIT_WINDOW_MS,
  HEALTH_RATE_LIMIT_MAX,
};