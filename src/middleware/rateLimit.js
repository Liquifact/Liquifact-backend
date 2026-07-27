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

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 100;

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
const ESCROW_READ_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_ESCROW_READ_WINDOW_MS', 60 * 1000);
const ESCROW_READ_MAX = parseRateLimitEnv('RATE_LIMIT_ESCROW_READ_MAX', 30);

/**
 * Escrow-read rate limiter.
 *
 * Protects GET /api/escrow/:invoiceId and GET /v1/escrow/:invoiceId from
 * abuse.  Per-client (API key or IP) limiting with a short window (default
 * 60 s, 30 requests) suitable for a read-heavy endpoint.
 *
 * Environment overrides:
 *   RATE_LIMIT_ESCROW_READ_WINDOW_MS  - window in ms (default 60 000)
 *   RATE_LIMIT_ESCROW_READ_MAX        - max requests per window (default 30)
 *
 * @returns {Function} Express rate limiting middleware.
 */
const escrowReadLimiter = rateLimit({
  windowMs: ESCROW_READ_WINDOW_MS,
  limit: ESCROW_READ_MAX,
  message: {
    error: 'Too many escrow-read requests. Please try again shortly.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

// Issue #754 â€” config-endpoint rate limiter. Defaults target the admin-only
// reality of /api/admin/config: a 60 s window with 20 requests per client is
// enough for six interactive writes per minute across the entire feature
// surface while still making accidental bursts (e.g. a buggy redeploy loop)
// fail loudly within seconds rather than silently after hours of damage.
const CONFIG_RATE_LIMIT_WINDOW_MS = parseRateLimitEnv('CONFIG_RATE_LIMIT_WINDOW_MS', 60 * 1000);
const CONFIG_RATE_LIMIT_MAX = parseRateLimitEnv('CONFIG_RATE_LIMIT_MAX', 20);

// Issue #744 — metrics-endpoint rate limiter. Defaults target the Prometheus
// scrape reality: a 60 s window with 30 requests per client lets a typical
// 15-30 s scrape interval work comfortably while still shutting down
// accidental tight loops or abusive reloads within one scrape cycle.
const METRICS_RATE_LIMIT_WINDOW_MS = parseRateLimitEnv('METRICS_RATE_LIMIT_WINDOW_MS', 60 * 1000);
const METRICS_RATE_LIMIT_MAX = parseRateLimitEnv('METRICS_RATE_LIMIT_MAX', 30);
const CORS_RATE_LIMIT_WINDOW_MS = parseRateLimitEnv('CORS_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
const CORS_RATE_LIMIT_MAX = parseRateLimitEnv('CORS_RATE_LIMIT_MAX', 120);

/**
 * CORS request rate-limit handler.
 * Returns a structured 429 response and preserves standard rate-limit headers.
 *
 * @param {import('express').Request} _req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} _next - Express next callback.
 * @param {{ statusCode: number, windowMs: number }} options - Rate limiter options.
 * @returns {void}
 */
function corsRateLimitHandler(_req, res, _next, options) {
  res.status(options.statusCode).json({
    type: 'https://liquifact.com/probs/too-many-requests',
    title: 'Too Many Requests',
    status: options.statusCode,
    code: 'RATE_LIMITED',
    retryable: true,
    retry_hint: 'Wait for the rate-limit window to reset before retrying.',
    scope: 'cors',
    error: 'Too many requests.',
    message: 'Rate limit threshold breached for CORS requests. Please try again later.',
  });
}

/**
 * Per-client rate limiter for CORS requests.
 * Limits browser-origin requests by API key or IP and returns Retry-After on 429.
 *
 * Env vars:
 *   - `CORS_RATE_LIMIT_WINDOW_MS` (default 15 min)
 *   - `CORS_RATE_LIMIT_MAX`       (default 120)
 *
 * @type {import('express').RequestHandler}
 */
const corsLimiter = rateLimit({
  windowMs: CORS_RATE_LIMIT_WINDOW_MS,
  limit: CORS_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: resolveRateLimitStore('cors'),
  keyGenerator: apiKeyKeyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
  skip: (req) => !req.get('Origin'),
  handler: corsRateLimitHandler,
});

/**
 * Factory for creating a fresh CORS limiter instance (useful for tests/apps).
 * Returns a new express-rate-limit middleware configured for CORS.
 */
function createCorsRateLimiter() {
  return rateLimit({
    windowMs: CORS_RATE_LIMIT_WINDOW_MS,
    max: CORS_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('cors'),
    keyGenerator: apiKeyKeyGenerator,
    validate: {
      xForwardedForHeader: false,
    },
    skip: (req) => !req.get('Origin'),
    handler: corsRateLimitHandler,
  });
}

/**
 * 429 response body for the metrics rate limiter.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} _next - Express next (unused).
 * @param {{ statusCode: number }} options - RateLimit options.
 * @returns {void}
 */
function metricsRateLimitHandler(_req, res, _next, options) {
  res.status(options.statusCode).json({
    error: 'Too many requests.',
    message: 'Rate limit threshold breached for /metrics. Please try again later.',
  });
}

/**
 * Metrics endpoint limiter. Keeps Prometheus scrapes and similar probes from
 * overwhelming the service while still allowing normal traffic.
 *
 * @type {import('express').RequestHandler}
 */
const metricsLimiter = rateLimit({
  windowMs: METRICS_RATE_LIMIT_WINDOW_MS,
  limit: METRICS_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
  handler: metricsRateLimitHandler,
});

/**
 * Factory variant for constructing a fresh metrics limiter.
 *
 * @returns {import('express').RequestHandler}
 */
function createMetricsRateLimiter() {
  return rateLimit({
    windowMs: METRICS_RATE_LIMIT_WINDOW_MS,
    limit: METRICS_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    validate: {
      xForwardedForHeader: false,
    },
    handler: metricsRateLimitHandler,
  });
}

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
  validate: {
    xForwardedForHeader: false,
  },
  handler: adminConfigHandler,
});

/**
 * Factory variant of {@link adminConfigLimiter} for callers (mostly tests)
 * that need to construct a fresh limiter with different bounds.
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
// metricsLimiter (issue #744)
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// kycWebhookLimiter (issue #729)
// ────────────────────────────────────────────────────────────────────────────

const KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS = parseRateLimitEnv('KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS', 60 * 1000);
const KYC_WEBHOOK_RATE_LIMIT_MAX = parseRateLimitEnv('KYC_WEBHOOK_RATE_LIMIT_MAX', 30);

/**
 * 429 response body for {@link kycWebhookLimiter}.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} _next - Express next (unused).
 * @param {{ statusCode: number, windowMs: number }} options - RateLimit options.
 * @returns {void}
 */
function kycWebhookRateLimitHandler(_req, res, _next, options) {
  res.status(options.statusCode).json({
    type: 'https://liquifact.com/probs/too-many-requests',
    title: 'Too Many Requests',
    status: options.statusCode,
    code: 'RATE_LIMITED',
    retryable: true,
    retry_hint: 'Wait for the rate-limit window to reset before retrying.',
    scope: 'kyc-webhooks',
    error: 'Too many requests.',
    message: 'Rate limit threshold breached for /api/kyc webhook endpoints. Please try again later.',
  });
}

/**
 * Per-client (API key / IP) rate limiter for the kyc-webhooks endpoints
 * (issue #729): POST /api/kyc/webhook (provider ingestion) and
 * GET /api/kyc/webhooks (listing).
 *
 * Config-driven via KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS / KYC_WEBHOOK_RATE_LIMIT_MAX.
 * express-rate-limit sets Retry-After via standardHeaders on 429.
 * Reuses adminConfigKeyGenerator: X-API-Key first, falling back to the
 * socket-bound req.ip (X-Forwarded-For is never trusted).
 *
 * @type {import('express').RequestHandler}
 */
const kycWebhookLimiter = rateLimit({
  windowMs: KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS,
  limit: KYC_WEBHOOK_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: resolveRateLimitStore('kyc-webhooks'),
  keyGenerator: adminConfigKeyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
  handler: kycWebhookRateLimitHandler,
});

/**
 * Factory variant of {@link kycWebhookLimiter} for callers (mostly tests)
 * that need to construct a fresh limiter with different bounds.
 *
 * @returns {import('express').RequestHandler}
 */
function createKycWebhookRateLimiter() {
  return rateLimit({
    windowMs: KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS,
    limit: KYC_WEBHOOK_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('kyc-webhooks'),
    keyGenerator: adminConfigKeyGenerator,
    validate: {
      xForwardedForHeader: false,
    },
    handler: kycWebhookRateLimitHandler,
  });
}

const INVOICE_STATE_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_INVOICE_STATE_WINDOW_MS', 15 * 60 * 1000);
const INVOICE_STATE_MAX = parseRateLimitEnv('RATE_LIMIT_INVOICE_STATE_MAX', 60);
const INDEXER_RATE_LIMIT_WINDOW_MS = parseRateLimitEnv('RATE_LIMIT_INDEXER_WINDOW_MS', 15 * 60 * 1000);
const INDEXER_RATE_LIMIT_MAX = parseRateLimitEnv('RATE_LIMIT_INDEXER_MAX', 60);

/**
 * Generates a rate-limit key using the API key when present, otherwise the
 * client IP address.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The rate-limit key.
 */
function indexerKeyGenerator(req) {
  const apiKey = getApiKey(req);
  if (apiKey) {
    return `apikey_${apiKey}`;
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * 429 response body for {@link metricsLimiter}.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function metricsRateLimitHandler(_req, res) {
  res.status(429).json({
    error: 'Too many metrics requests',
  });
}

/**
 * Per-client (API key / IP) rate limiter for the invoice-state endpoints.
 * Config-driven via RATE_LIMIT_INVOICE_STATE_WINDOW_MS / RATE_LIMIT_INVOICE_STATE_MAX.
 * express-rate-limit sets Retry-After via standardHeaders on 429.
 *
 * @returns {Function} Express rate limiting middleware.
 */
const invoiceStateLimiter = rateLimit({
  windowMs: INVOICE_STATE_WINDOW_MS,
  limit: INVOICE_STATE_MAX,
  message: {
    error: `Too many invoice-state requests. Max ${INVOICE_STATE_MAX} per ${Math.round(INVOICE_STATE_WINDOW_MS / 60000)} minutes.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});

const indexerLimiter = rateLimit({
  windowMs: INDEXER_RATE_LIMIT_WINDOW_MS,
  limit: INDEXER_RATE_LIMIT_MAX,
  message: {
    error: `Too many indexer requests. Max ${INDEXER_RATE_LIMIT_MAX} per ${Math.round(INDEXER_RATE_LIMIT_WINDOW_MS / 60000)} minutes.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: indexerKeyGenerator,
  validate: {
    xForwardedForHeader: false,
  },
});


const { createPersistenceRateLimiter } = require('./persistenceRateLimit');

module.exports = {
  createRateLimiter,
  createPersistenceRateLimiter,
  escrowReadLimiter,
  globalLimiter,
  sensitiveLimiter,
  apiKeyLimiter,
  createConfigRateLimiter,
  adminConfigLimiter,
  adminConfigKeyGenerator,
  adminConfigHandler,
  invoiceStateLimiter,
  indexerLimiter,
  getApiKey,
  CONFIG_RATE_LIMIT_WINDOW_MS,
  CONFIG_RATE_LIMIT_MAX,
  METRICS_RATE_LIMIT_WINDOW_MS,
  METRICS_RATE_LIMIT_MAX,
  CORS_RATE_LIMIT_WINDOW_MS,
  CORS_RATE_LIMIT_MAX,
  corsLimiter,
  corsRateLimitHandler,
  createCorsRateLimiter,
  metricsLimiter,
  metricsRateLimitHandler,
  createMetricsRateLimiter,
  KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS,
  KYC_WEBHOOK_RATE_LIMIT_MAX,
  kycWebhookLimiter,
  kycWebhookRateLimitHandler,
  createKycWebhookRateLimiter,
};