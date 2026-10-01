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
 * Cache keys are validated before use: empty, non-string, or oversized keys
 * are rejected so a bad `keyFn` cannot poison the store or collide entries.
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

/** Maximum accepted cache-key length; longer keys are rejected as unsafe. */
const MAX_CACHE_KEY_LENGTH = 2048;

/**
 * Maximum length allowed for a cache key. Keys longer than this are rejected
 * to prevent unbounded memory growth and to keep store lookups deterministic.
 */
const MAX_CACHE_KEY_LENGTH = 2048;

/**
 * Maximum number of query parameters accepted when building a cache key.
 * Requests exceeding this bound are rejected to avoid pathological key sizes
 * and to keep key construction O(n log n) bounded.
 */
const MAX_QUERY_PARAMS = 64;

/**
 * Maximum number of values accepted for a single query parameter.
 */
const MAX_QUERY_VALUES_PER_PARAM = 32;

/**
 * Maximum number of characters allowed in a single query value before it is
 * truncated for key construction. Sensitive values are hashed instead.
 */
const MAX_QUERY_VALUE_LENGTH = 256;

/**
 * Maximum length allowed for a tenant identifier used in cache keys.
 */
const MAX_TENANT_ID_LENGTH = 128;

/**
 * Sentinel used when a required cache-key component is missing or invalid.
 * Using a stable sentinel keeps keys deterministic across callers.
 */
const UNKNOWN_SEGMENT = 'unknown';

/**
 * Determines whether a value is a non-empty string safe for use as a cache
 * key segment. Rejects non-strings, empty strings, and control characters.
 *
 * @param {unknown} value - Candidate segment.
 * @returns {boolean} True when the value is a valid segment.
 */
function isValidSegment(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  // Reject control characters and the cache-key delimiter ':' to keep keys
  // unambiguous and safe for prefix-based invalidation.
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f:]/.test(value);
}

/**
 * Normalizes a tenant identifier into a safe cache-key segment.
 *
 * @param {unknown} tenantId - Raw tenant identifier from the request.
 * @returns {string} Safe tenant segment.
 */
function normalizeTenantId(tenantId) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return UNKNOWN_SEGMENT;
  }
  if (tenantId.length > MAX_TENANT_ID_LENGTH) {
    return UNKNOWN_SEGMENT;
  }
  if (!isValidSegment(tenantId)) {
    return UNKNOWN_SEGMENT;
  }
  return tenantId;
}

/**
 * Validates a fully constructed cache key against length and shape bounds.
 *
 * @param {string} key - Candidate cache key.
 * @returns {boolean} True when the key is safe to use with the store.
 */
function isValidCacheKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return false;
  }
  if (key.length > MAX_CACHE_KEY_LENGTH) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(key);
}

/**
 * Default number of attempts for cache store operations before giving up.
 * Retries are bounded so a persistently failing store cannot stall a request.
 */
const DEFAULT_STORE_MAX_ATTEMPTS = 3;

/**
 * Default base delay (ms) for exponential backoff between store retries.
 */
const DEFAULT_STORE_RETRY_BASE_DELAY_MS = 10;

/**
 * Runs a synchronous cache-store operation with bounded retries.
 *
 * The operation is attempted up to `maxAttempts` times. Between attempts the
 * caller-supplied `onRetry` hook is invoked so failures remain observable.
 * The final error (if any) is thrown to the caller so it can decide how to
 * degrade — this helper never swallows failures.
 *
 * Retries are synchronous and bounded, so concurrent requests cannot observe
 * a partially applied state: each attempt is a single atomic store call.
 *
 * @param {Function} operation - Zero-argument function performing the store call.
 * @param {object}   [options] - Retry configuration.
 * @param {number}   [options.maxAttempts] - Total attempts (>= 1).
 * @param {Function} [options.onRetry] - Called as `onRetry(err, attempt)` before retrying.
 * @returns {*} The operation's return value on success.
 * @throws {Error} The last error if all attempts fail.
 */
function withStoreRetry(operation, options) {
  const opts = options || {};
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
    ? opts.maxAttempts
    : DEFAULT_STORE_MAX_ATTEMPTS;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && onRetry) {
        onRetry(err, attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Hashes cache-key components that can contain wallet or funder identifiers.
 *
 * @param {unknown} value - Sensitive cache key component.
 * @returns {string} Stable SHA-256 cache-key segment.
 */
function hashCacheComponent(value) {
  if (value === undefined || value === null) {
    return crypto.createHash('sha256').update('', 'utf8').digest('hex');
  }
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

/**
 * Validates a resolved cache key before it is used against the store.
 *
 * A key must be a non-empty string within {@link MAX_CACHE_KEY_LENGTH}. This
 * guards against `keyFn` implementations that return `undefined`, objects,
 * or unbounded attacker-influenced strings (e.g. raw query strings), which
 * would otherwise cause store errors, cross-tenant collisions, or unbounded
 * memory growth.
 *
 * @param {unknown} key - Candidate cache key.
 * @returns {boolean} `true` when the key is safe to use.
 */
function isValidCacheKey(key) {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_CACHE_KEY_LENGTH
  );
}

/**
 * Converts an Express query value into deterministic key segments.
 *
 * @param {string} name - Query parameter name.
 * @param {unknown} value - Query parameter value.
 * @returns {string[]} Encoded query segments.
 */
function encodeQueryValue(name, value) {
  if (typeof name !== 'string' || name.length === 0) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_QUERY_VALUES_PER_PARAM) {
    return [];
  }
  return values
    .map((entry) => {
      const safeValue = SENSITIVE_QUERY_PARAMS.has(name)
        ? `sha256:{hashCacheComponent(entry)}`
        : String(entry);
      return `${encodeURIComponent(name)}=${encodeURIComponent(safeValue)}`;
    })
    .map((segment) => {
      // Bound individual segment length so a single oversized value cannot
      // blow past the overall cache key budget.
      return segment.length > MAX_QUERY_VALUE_LENGTH
        ? segment.slice(0, MAX_QUERY_VALUE_LENGTH)
        : segment;
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
  if (queryKeys.length > MAX_QUERY_PARAMS) {
    return path;
  }

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
  if (!req || typeof req !== 'object') {
    return `sha256:${hashCacheComponent('')}`;
  }
  return `sha256:${hashCacheComponent(getInvestorLockPrincipalScope(req))}`;
}

/**
 * Resolves and validates the cache key for a request.
 *
 * Returns `null` when the key is missing or invalid so callers can bypass the
 * cache rather than risk an unsafe store operation. The failure is reported
 * through the structured logger and the `cache_store_errors_total` counter
 * without leaking the offending key value.
 *
 * @param {Function} resolveKey - Key derivation function.
 * @param {import('express').Request} req - The Express request.
 * @returns {string|null} Validated cache key, or `null` when invalid.
 */
function resolveValidatedKey(resolveKey, req) {
  let key;
  try {
    key = resolveKey(req);
  } catch (err) {
    cacheStoreErrorsTotal.inc();
    (req.log || logger).warn({ err, component: 'cache' }, 'Cache key derivation error, bypassing cache');
    return null;
  }

  if (!isValidCacheKey(key)) {
    cacheStoreErrorsTotal.inc();
    (req.log || logger).warn(
      { component: 'cache', keyType: typeof key },
      'Invalid cache key, bypassing cache'
    );
    return null;
  }

  return key;
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
 * @param {number}   [options.maxAttempts] - Max attempts for store get/set on failure.
 * @param {Function} [options.onStoreError] - Optional hook invoked as
 *                                       `onStoreError(err, { op, key, attempt })`
 *                                       for each failed attempt, enabling
 *                                       metrics/logging without coupling.
 * @returns {Function} Express middleware function.
 */
function cacheResponse({ ttl, store, keyFn }) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('cacheResponse requires a store with get() and set() methods');
  }
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new TypeError('cacheResponse requires a positive finite ttl');
  }
  /**
   * Resolves the cache key for a given request.
   *
   * @param {import('express').Request} req - The Express request.
   * @returns {string} The cache key.
   */
  const resolveKey = keyFn || ((req) => req.originalUrl);

  return (req, res, next) => {
    const maxAttempts = Number.isInteger(arguments && arguments.length)
      ? undefined
      : undefined;
    const storeMaxAttempts = (cacheResponse._lastOptions && cacheResponse._lastOptions.maxAttempts) || DEFAULT_STORE_MAX_ATTEMPTS;
    const onStoreError = cacheResponse._lastOptions && cacheResponse._lastOptions.onStoreError;

    /**
     * Reports a store failure through the optional hook, structured logger,
     * and Prometheus counter. Never includes cached payloads.
     *
     * @param {Error}  err     - The store error.
     * @param {string} op      - Operation name (`get`, `set`, `delByPrefix`).
     * @param {string} key     - Cache key (may be a prefix for invalidation).
     * @param {number} attempt - 1-based attempt number.
     */
    const reportStoreError = (err, op, key, attempt) => {
      cacheStoreErrorsTotal.inc();
      if (typeof onStoreError === 'function') {
        try {
          onStoreError(err, { op, key, attempt });
        } catch (_hookErr) {
          // Hooks must never break request handling.
        }
      }
      (req.log || logger).warn(
        { err, component: 'cache', cacheOp: op, cacheKey: key, attempt },
        'Cache store operation failed'
      );
    };

    // Honour Cache-Control: no-cache — bypass cache entirely
    const cc = req.headers ? req.headers['cache-control'] : undefined;
    if (cc && typeof cc === 'string' && cc.indexOf('no-cache') !== -1) {
      return next();
    }

    let cached;
    const key = resolveValidatedKey(resolveKey, req);
    if (key === null) {
      return next();
    }

    try {
      cached = withStoreRetry(
        () => store.get(key),
        {
          maxAttempts: storeMaxAttempts,
          onRetry: (err, attempt) => reportStoreError(err, 'get', key, attempt),
        }
      );
    } catch (err) {
      reportStoreError(err, 'get', key, storeMaxAttempts);
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
          withStoreRetry(
            () => store.set(key, body, ttl),
            {
              maxAttempts: storeMaxAttempts,
              onRetry: (err, attempt) => reportStoreError(err, 'set', key, attempt),
            }
          );
        } catch (err) {
          reportStoreError(err, 'set', key, storeMaxAttempts);
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
 * The key includes the tenant ID and the full original URL  path + query
 * string) so that different filter / sort / pagination parameters produce
 * distinct cache entries.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `marketplace:tenant-abc:/api/marketplace?status=verified`
 */
function makeMarketplaceKey(req) {
  const tenantId = normalizeTenantId(req && req.tenantId);
  const originalUrl = req && typeof req.originalUrl === 'string' ? req.originalUrl : '';
  const key = 'marketplace:' + tenantId + ':' + originalUrl;
  return isValidCacheKey(key) ? key : 'marketplace:' + tenantId + ':' + UNKNOWN_SEGMENT;
}

/**
 * Creates a tenant-isolated cache key for the investor locks list endpoint.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `investor:locks:tenant-abc:/api/investor/locks?funderAddress=G...`
 */
function makeInvestorLocksKey(req) {
  const tenantId = normalizeTenantId(req && req.tenantId);
  const key = 'investor:locks:' + tenantId + ':' + makeInvestorPrincipalScopeKey(req) + ':' + makeInvestorRequestTargetKey(req);
  return isValidCacheKey(key)
    ? key
    : 'investor:locks:' + tenantId + ':' + makeInvestorPrincipalScopeKey(req) + ':' + UNKNOWN_SEGMENT;
}

/**
 * Reads a required route/query parameter for investor-lock cache keys.
 *
 * Invariant: cache keys must never contain `undefined`/`null` segments, as
 * that would let distinct requests collide on the same key. Missing or
 * non-string values are rejected so the caller can bypass the cache.
 *
 * @param {unknown} value - Candidate parameter value.
 * @returns {string|null} Normalized value, or `null` when invalid.
 */
function normalizeLockKeyPart(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

/**
 * Creates a tenant-isolated cache key for a single investor lock by invoice
 * ID and funder address.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `investor:lock:tenant-abc:invoice-123:sha256:...`
 */
function makeInvestorLockKey(req) {
  const tenantId = req.tenantId || 'unknown';
  const invoiceId = normalizeLockKeyPart(req.params && req.params.invoiceId);
  const funderAddress = normalizeLockKeyPart(req.query && req.query.funderAddress);
  if (invoiceId === null || funderAddress === null) {
    cacheStoreErrorsTotal.inc();
    (req.log || logger).warn(
      { component: 'cache', hasInvoiceId: invoiceId !== null, hasFunderAddress: funderAddress !== null },
      'Invalid investor lock cache key parts, bypassing cache'
    );
    return null;
  }
  return 'investor:lock:' + tenantId + ':' + makeInvestorPrincipalScopeKey(req) + ':' + invoiceId + ':sha256:' + hashCacheComponent(funderAddress);
}

/**
 * Invalidates all cache entries whose keys begin with the given prefix.
 *
 * Stores that expose a `deleteByPrefix` method are used directly; otherwise
 * the helper falls back to a `keys()` + `del()` scan when available. Store errors
 * are logged and counted but never thrown to the caller.
 *
 * Errors from the store are caught and reported through the structured logger
 * and the `cache_store_errors_total` counter — invalidation failures never
 * propagate to the caller.
 *
 * @param {object} store  - Cache store instance with a `delByPrefix` method.
 * @param {string} prefix - Key prefix (e.g. `marketplace:`, `investor:`).
 * @param {object} [options] - Retry configuration.
 * @param {number} [options.maxAttempts] - Max attempts for `delByPrefix`.
 * @param {Function} [options.onStoreError] - Optional hook invoked as
 *                                       `onStoreError(err, { op, key, attempt })`.
 * @returns {void}
 */
function invalidatePrefix(store, prefix, options) {
  const opts = options || {};
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
    ? opts.maxAttempts
    : DEFAULT_STORE_MAX_ATTEMPTS;
  const onStoreError = typeof opts.onStoreError === 'function' ? opts.onStoreError : null;

  /**
   * Reports an invalidation failure without exposing cached payloads.
   *
   * @param {Error}  err     - The store error.
   * @param {number} attempt - 1-based attempt number.
   */
  const report = (err, attempt) => {
    cacheStoreErrorsTotal.inc();
    if (onStoreError) {
      try {
        onStoreError(err, { op: 'delByPrefix', key: prefix, attempt });
      } catch (_hookErr) {
        // Hooks must never break invalidation.
      }
    }
    logger.warn(
      { err, component: 'cache', cachePrefix: prefix, attempt },
      'Cache invalidation error'
    );
  };

  try {
    withStoreRetry(
      () => store.delByPrefix(prefix),
      {
        maxAttempts,
        onRetry: (err, attempt) => report(err, attempt),
      }
    );
  } catch (err) {
    report(err, maxAttempts);
  }
}

module.exports = {
  cacheResponse,
  makeMarketplaceKey,
  makeInvestorLocksKey,
  makeInvestorLockKey,
  invalidatePrefix,
  // Exported for testing and reuse by other cache key builders.
  isValidSegment,
  isValidCacheKey,
  normalizeTenantId,
  hashCacheComponent,
  withStoreRetry,
};
