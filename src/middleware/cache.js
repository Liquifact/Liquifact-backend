/**
 * Response-caching middleware and cache-invalidation helpers.
 *
 * The {@link cacheResponse} function returns an Express middleware that caches
 * JSON responses with a configurable TTL.  Cache keys are derived via the
 * optional `keyFn` — the default uses `req.originalUrl`.
 *
 * Three key helpers are exported for route files:
 * - {@link makeMarketplaceKey}   — tenant-scoped key including the full query string
 * - {@link makeInvestorLocksKey} — tenant-scoped key for the locks-list endpoint
 * - {@link makeInvestorLockKey}  — key for a single lock identified by invoiceId + funderAddress
 *
 * The {@link invalidatePrefix} helper lets write-side services (e.g. invoice
 * state machine, investor commitment) flush groups of related cache entries
 * without knowing the exact keys.
 *
 * Cache store read/write failures are reported through the structured logger
 * (`req.log` when available, falling back to the root application logger) and
 * recorded on the `cache_store_errors_total` Prometheus counter — the request
 * always falls through so a cache outage never blocks the caller.
 *
 * Cached payloads are never included in log output.
 *
 * @module middleware/cache
 */

const crypto = require('crypto');
const logger = require('../logger');
const { cacheStoreErrorsTotal } = require('../metrics');
const { getInvestorLockPrincipalScope } = require('../utils/investorLockScope');

const SENSITIVE_QUERY_PARAMS = new Set(['funderAddress']);

/**
 * Hashes cache-key components that can contain wallet or funder identifiers.
 *
 * @param {unknown} value - Sensitive cache key component.
 * @returns {string} Stable SHA-256 cache-key segment.
 */
function hashCacheComponent(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

/**
 * Converts an Express query value into deterministic key segments.
 *
 * @param {string} name - Query parameter name.
 * @param {unknown} value - Query parameter value.
 * @returns {string[]} Encoded query segments.
 */
function encodeQueryValue(name, value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => {
      const safeValue = SENSITIVE_QUERY_PARAMS.has(name)
        ? `sha256:${hashCacheComponent(entry)}`
        : String(entry);
      return `${encodeURIComponent(name)}=${encodeURIComponent(safeValue)}`;
    })
    .sort();
}

/**
 * Builds a deterministic path+query segment for investor lock cache keys.
 *
 * Sensitive query values are hashed, and query parameters are sorted so
 * equivalent requests produce one cache key regardless of query-string order.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Stable request target key.
 */
function makeInvestorRequestTargetKey(req) {
  const originalUrl = req.originalUrl || '';
  const path = req.path || originalUrl.split('?')[0] || '';
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const queryKeys = Object.keys(query).sort();

  if (queryKeys.length === 0) {
    return path;
  }

  const queryString = queryKeys
    .flatMap((name) => encodeQueryValue(name, query[name]))
    .join('&');

  return `${path}?${queryString}`;
}

/**
 * Builds a hashed principal scope for investor-lock cache isolation.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Principal scope safe for cache keys.
 */
function makeInvestorPrincipalScopeKey(req) {
  return `sha256:${hashCacheComponent(getInvestorLockPrincipalScope(req))}`;
}

/**
 * Creates an Express middleware that caches JSON responses with a TTL.
 *
 * On cache hit, returns the cached JSON and sets `X-Cache: HIT` header.
 * On cache miss, intercepts `res.json()` to capture and cache 2xx responses,
 * then sets `X-Cache: MISS` header.
 *
 * The cache is bypassed when the request carries a `Cache-Control: no-cache`
 * header, allowing clients to always fetch fresh data.
 *
 * Cache store errors are caught and reported through the structured logger
 * with request context (requestId, correlationId) — the request always falls
 * through to the next handler so the cache never blocks a request. Cached
 * values are never written to log output.
 *
 * @param {object}    options          - Middleware configuration.
 * @param {number}    options.ttl      - Cache TTL in milliseconds.
 * @param {object}    options.store    - Cache store instance with get/set methods.
 * @param {Function} [options.keyFn]   - Function to derive cache key from request.
 *                                       Defaults to `req.originalUrl`.
 * @returns {Function} Express middleware function.
 */
function cacheResponse({ ttl, store, keyFn }) {
  /**
   * Resolves the cache key for a given request.
   *
   * @param {import('express').Request} req - The Express request.
   * @returns {string} The cache key.
   */
  const resolveKey = keyFn || ((req) => req.originalUrl);

  return (req, res, next) => {
    // Honour Cache-Control: no-cache — bypass cache entirely
    const cc = req.headers ? req.headers['cache-control'] : undefined;
    if (cc && typeof cc === 'string' && cc.indexOf('no-cache') !== -1) {
      return next();
    }

    let cached;
    const key = resolveKey(req);

    try {
      cached = store.get(key);
    } catch (err) {
      cacheStoreErrorsTotal.inc();
      (req.log || logger).warn({ err, component: 'cache' }, 'Cache store get error, falling through');
      return next();
    }

    if (cached !== undefined) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    res.set('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);

    /**
     * Patched `res.json` that caches 2xx responses before sending.
     *
     * @param {*} body - The response body to send.
     * @returns {object} The Express response.
     */
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          store.set(key, body, ttl);
        } catch (err) {
          cacheStoreErrorsTotal.inc();
          (req.log || logger).warn({ err, component: 'cache' }, 'Cache store set error');
        }
      }
      return originalJson(body);
    };

    return next();
  };
}

/**
 * Creates a tenant-isolated cache key for the marketplace search endpoint.
 *
 * The key includes the tenant ID and the full original URL (path + query
 * string) so that different filter / sort / pagination parameters produce
 * distinct cache entries.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `marketplace:tenant-abc:/api/marketplace?status=verified`
 */
function makeMarketplaceKey(req) {
  const tenantId = req.tenantId || 'unknown';
  return 'marketplace:' + tenantId + ':' + req.originalUrl;
}

/**
 * Creates a tenant-isolated cache key for the investor locks list endpoint.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `investor:locks:tenant-abc:/api/investor/locks?funderAddress=G...`
 */
function makeInvestorLocksKey(req) {
  const tenantId = req.tenantId || 'unknown';
  return 'investor:locks:' + tenantId + ':' + makeInvestorPrincipalScopeKey(req) + ':' + makeInvestorRequestTargetKey(req);
}

/**
 * Creates a tenant-isolated cache key for a single investor lock by invoice
 * ID and funder address.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `investor:lock:tenant-abc:inv_123:G...`
 */
function makeInvestorLockKey(req) {
  const tenantId = req.tenantId || 'unknown';
  return 'investor:lock:' + tenantId + ':' + makeInvestorPrincipalScopeKey(req) + ':' + req.params.invoiceId + ':sha256:' + hashCacheComponent(req.query.funderAddress);
}

/**
 * Invalidates all cache entries whose key starts with the given prefix.
 *
 * This is called by write-side services (invoice state machine, investor
 * commitment) so that subsequent reads return fresh data.
 *
 * Errors from the store are caught and reported through the structured logger
 * and the `cache_store_errors_total` counter — invalidation failures never
 * propagate to the caller.
 *
 * @param {object} store  - Cache store instance with a `delByPrefix` method.
 * @param {string} prefix - Key prefix (e.g. `marketplace:`, `investor:`).
 * @returns {void}
 */
function invalidatePrefix(store, prefix) {
  try {
    store.delByPrefix(prefix);
  } catch (err) {
    cacheStoreErrorsTotal.inc();
    logger.warn({ err, component: 'cache', cachePrefix: prefix }, 'Cache invalidation error');
  }
}

module.exports = {
  cacheResponse,
  invalidatePrefix,
  makeMarketplaceKey,
  makeInvestorLocksKey,
  makeInvestorLockKey,
  hashCacheComponent,
};
