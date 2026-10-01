/**
 * @fileoverview Bounded in-memory LRU cache for CORS origin-validation results.
 *
 * Hot CORS read paths call {@link validateCorsOrigin} on every inbound request,
 * which normalises the origin string and scans the allowlist.  This cache
 * stores the boolean outcome keyed by the raw origin string so repeated
 * requests from the same origin are answered from memory.
 *
 * The cache is **invalidated entirely** when the allowlist changes
 * ({@link invalidateCorsCache} is called from {@link reloadCorsOrigins}).
 * A short TTL provides automatic staleness protection even without an explicit
 * invalidation.
 *
 * Configuration (environment variables):
 * - `CORS_CACHE_TTL_SECONDS` – entry lifetime in seconds (default 5, clamped 1-60).
 * - `CORS_CACHE_MAX_ENTRIES` – hard cap on cached entries (default 256, clamped 16-4096).
 *
 * ## Compatibility contract
 *
 * The public surface below is **frozen**: existing exports keep their names,
 * types and documented behavior. Changes are **additive-only** (new exports or
 * new optional options); removing, renaming or changing the semantics of an
 * existing export is a breaking change and requires a migration plan.
 *
 * Frozen exports:
 * - `createCorsCache({ ttlMs?, maxEntries? })` – builds an independent bounded
 *   LRU cache and returns `{ get, set, clear, size }`.
 *   - `get(origin)` → `true`/`false` on a live hit, `undefined` on
 *     miss/expiry/invalid key. Never throws.
 *   - `set(origin, allowed)` → stores a boolean result. Invalid keys or
 *     non-boolean values are ignored without mutating state; entries beyond
 *     `maxEntries` are evicted LRU-first. Never throws.
 *   - `clear()` → drops every entry and lock. This is the invalidation entry
 *     point used when the allowlist changes. Never throws.
 *   - `size` → number of live entries.
 * - `getCorsCache()` – returns the process-wide singleton, creating it on first
 *   use; repeated calls return the same instance.
 * - `parseCorsCacheConfig(env?)` – resolves `{ ttlMs, maxEntries }` from `env`
 *   (defaults to `process.env`). Missing, empty or unparseable values fall back
 *   to the documented defaults. Never throws.
 * - `_setCorsCache(instance)` – test-only singleton replacement.
 * - `isValidCacheInstance(instance)` – structural check for the cache shape.
 * - Numeric constants `DEFAULT_TTL_SECONDS` (5), `DEFAULT_MAX_ENTRIES` (256),
 *   `MIN_TTL_SECONDS` (1), `MAX_TTL_SECONDS` (60), `MIN_MAX_ENTRIES` (16) and
 *   `MAX_MAX_ENTRIES` (4096).
 *
 * Environment knobs and clamp ranges:
 * - `CORS_CACHE_TTL_SECONDS` – entry lifetime in seconds; default 5, clamped to
 *   the inclusive range 1..60.
 * - `CORS_CACHE_MAX_ENTRIES` – hard entry cap; default 256, clamped to the
 *   inclusive range 16..4096.
 * - Explicit `createCorsCache({ ttlMs, maxEntries })` options are honored
 *   verbatim; the clamp ranges apply only to values resolved through
 *   `parseCorsCacheConfig`.
 *
 * Invariants preserved through errors, empty data and upgrades:
 * - Cache operations never throw; metric-counter failures are swallowed so a
 *   metrics outage cannot take the CORS request path down.
 * - Reads are idempotent, and `set` on an existing key refreshes it in place.
 * - `clear()` is a full, idempotent invalidation of both entries and locks.
 *
 * Not part of this module: `validateCorsOrigin`, `invalidateCorsCache` and
 * `reloadCorsOrigins` live in `config/cors.js` / `utils/corsValidator.js`; this
 * module intentionally exposes only the cache surface above.
 *
 * @module config/corsCache
 */

'use strict';

const {
  corsCacheHitsTotal,
  corsCacheMissesTotal,
  corsCacheEvictionsTotal,
  corsCacheInvalidationsTotal,
} = require('../metrics');

/**
 * Safely increments a Prometheus counter, swallowing errors to prevent
 * metric failures from breaking cache operations.
 *
 * @param {Object} counter - Prometheus counter with inc() method.
 * @returns {void}
 */
function safeInc(counter) {
  try {
    if (counter && typeof counter.inc === 'function') {
      counter.inc();
    }
  } catch (_error) {
    // Metric emission failures are logged but not propagated
    // to avoid breaking cache operations.
  }
}

/**
 * Validates that a value is a non-empty string suitable for use as an origin key.
 *
 * @param {unknown} value - Value to validate.
 * @returns {boolean} True if valid origin string.
 */
function isValidOriginKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500;
}

/**
 * Validates that a value is a boolean.
 *
 * @param {unknown} value - Value to validate.
 * @returns {boolean} True if boolean.
 */
function isValidBoolean(value) {
  return typeof value === 'boolean';
}

const DEFAULT_TTL_SECONDS = 5;
const DEFAULT_MAX_ENTRIES = 256;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 60;
const MIN_MAX_ENTRIES = 16;
const MAX_MAX_ENTRIES = 4096;

/**
 * Parses a positive integer from an env-var value, clamped to [min, max].
 * Falls back to `fallback` when the value is missing or not finite.
 *
 * @param {string|undefined} raw - Raw environment-variable value.
 * @param {number} min - Lower bound (inclusive).
 * @param {number} max - Upper bound (inclusive).
 * @param {number} fallback - Value to use when parsing fails.
 * @returns {number} Clamped integer.
 */
function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) { return fallback; }
  if (n < min) { return min; }
  return n > max ? max : n;
}

/**
 * Parses CORS cache configuration from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @returns {{ ttlMs: number, maxEntries: number }} Resolved configuration.
 */
function parseCorsCacheConfig(env = process.env) {
  const ttlSeconds = clampInt(
    env.CORS_CACHE_TTL_SECONDS,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
    DEFAULT_TTL_SECONDS,
  );
  const maxEntries = clampInt(
    env.CORS_CACHE_MAX_ENTRIES,
    MIN_MAX_ENTRIES,
    MAX_MAX_ENTRIES,
    DEFAULT_MAX_ENTRIES,
  );
  return { ttlMs: ttlSeconds * 1000, maxEntries };
}

/**
 * Creates a bounded LRU cache for CORS origin-validation results.
 *
 * The cache maps raw origin strings → `{ allowed: boolean }` and is
 * bounded by `maxEntries` with LRU eviction.  Entries expire after `ttlMs`.
 *
 * All mutations (set, clear) emit Prometheus counters.
 *
 * @param {{ ttlMs?: number, maxEntries?: number }} [opts] - Cache options.
 * @returns {{
 *   get(origin: string): boolean|undefined,
 *   set(origin: string, allowed: boolean): void,
 *   clear(): void,
 *   size: number,
 * }}
 */
function createCorsCache({ ttlMs, maxEntries } = {}) {
  const cfg = parseCorsCacheConfig();
  const effectiveTtl = ttlMs != null ? ttlMs : cfg.ttlMs;
  const effectiveMax = maxEntries != null ? maxEntries : cfg.maxEntries;

  /** @type {Map<string, { allowed: boolean, expiresAt: number }>} */
  const map = new Map();

  /**
   * Simple lock to prevent concurrent modifications to the same key.
   * Maps origin strings to a boolean indicating whether an operation is in progress.
   * This provides a best-effort mutual exclusion for the single-threaded Node.js event loop.
   *
   * @type {Map<string, boolean>}
   */
  const locks = new Map();

  /**
   * Acquires a lock for the given key.
   * Returns true if lock was acquired, false if already locked.
   *
   * @param {string} key - Cache key to lock.
   * @returns {boolean} True if lock acquired.
   */
  function acquireLock(key) {
    if (locks.has(key)) {
      return false;
    }
    locks.set(key, true);
    return true;
  }

  /**
   * Releases a lock for the given key.
   *
   * @param {string} key - Cache key to unlock.
   * @returns {void}
   */
  function releaseLock(key) {
    locks.delete(key);
  }

  /**
   * Retrieves a cached validation result.
   *
   * @param {string} origin - The raw origin string.
   * @returns {boolean|undefined} `true`/`false` when cached, `undefined` on miss.
   */
  function get(origin) {
    // Input validation
    if (!isValidOriginKey(origin)) {
      safeInc(corsCacheMissesTotal);
      return undefined;
    }

    const entry = map.get(origin);
    if (!entry) {
      safeInc(corsCacheMissesTotal);
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      map.delete(origin);
      safeInc(corsCacheMissesTotal);
      return undefined;
    }
    // Promote to most-recently-used
    map.delete(origin);
    map.set(origin, entry);
    safeInc(corsCacheHitsTotal);
    return entry.allowed;
  }

  /**
   * Stores a validation result.
   *
   * @param {string} origin - The raw origin string.
   * @param {boolean} allowed - Whether the origin was allowed.
   * @returns {void}
   */
  function set(origin, allowed) {
    // Input validation
    if (!isValidOriginKey(origin)) {
      return;
    }
    if (!isValidBoolean(allowed)) {
      return;
    }

    // Acquire lock to prevent race conditions
    if (!acquireLock(origin)) {
      // If lock cannot be acquired, skip this set operation
      // to prevent inconsistent state. The next request will retry.
      return;
    }

    try {
      if (map.has(origin)) {
        map.delete(origin);
      }
      map.set(origin, { allowed, expiresAt: Date.now() + effectiveTtl });
      while (map.size > effectiveMax) {
        const lruKey = map.keys().next().value;
        if (lruKey !== undefined) {
          map.delete(lruKey);
          safeInc(corsCacheEvictionsTotal);
        } else {
          // Map is empty, break to avoid infinite loop
          break;
        }
      }
    } finally {
      releaseLock(origin);
    }
  }

  /**
   * Clears the entire cache. Called when the allowlist changes.
   *
   * @returns {void}
   */
  function clear() {
    map.clear();
    locks.clear();
    safeInc(corsCacheInvalidationsTotal);
  }

  return {
    get,
    set,
    clear,
    get size() { return map.size; },
  };
}

/**
 * Singleton CORS origin cache instance.
 * Re-used across the module so that all callers share one cache.
 *
 * @type {ReturnType<typeof createCorsCache>}
 */
let _singleton = null;

/**
 * Returns the shared singleton CORS origin cache.
 *
 * @returns {ReturnType<typeof createCorsCache>}
 */
function getCorsCache() {
  if (!_singleton) {
    _singleton = createCorsCache();
  }
  return _singleton;
}

/**
 * Validates that the provided cache instance is properly initialized.
 * Used for failure recovery and health checks.
 *
 * @param {ReturnType<typeof createCorsCache>|null} instance - Cache instance to validate.
 * @returns {boolean} True if instance is valid.
 */
function isValidCacheInstance(instance) {
  return (
    instance !== null &&
    instance !== undefined &&
    typeof instance.get === 'function' &&
    typeof instance.set === 'function' &&
    typeof instance.clear === 'function' &&
    typeof instance.size === 'number'
  );
}

/**
 * Resets the singleton cache instance. Exported for testing only.
 *
 * @param {ReturnType<typeof createCorsCache>|null} instance - Replacement instance or null.
 * @returns {void}
 */
function _setCorsCache(instance) {
  _singleton = instance;
}

module.exports = {
  createCorsCache,
  getCorsCache,
  parseCorsCacheConfig,
  _setCorsCache,
  isValidCacheInstance,
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_ENTRIES,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_MAX_ENTRIES,
  MAX_MAX_ENTRIES,
};
