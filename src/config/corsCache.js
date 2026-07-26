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
 * - `CORS_CACHE_TTL_SECONDS` – entry lifetime in seconds (default 5, clamped 1–60).
 * - `CORS_CACHE_MAX_ENTRIES` – hard cap on cached entries (default 256, clamped 16–4096).
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
   * Retrieves a cached validation result.
   *
   * @param {string} origin - The raw origin string.
   * @returns {boolean|undefined} `true`/`false` when cached, `undefined` on miss.
   */
  function get(origin) {
    const entry = map.get(origin);
    if (!entry) {
      corsCacheMissesTotal.inc();
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      map.delete(origin);
      corsCacheMissesTotal.inc();
      return undefined;
    }
    // Promote to most-recently-used
    map.delete(origin);
    map.set(origin, entry);
    corsCacheHitsTotal.inc();
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
    if (map.has(origin)) {
      map.delete(origin);
    }
    map.set(origin, { allowed, expiresAt: Date.now() + effectiveTtl });
    while (map.size > effectiveMax) {
      const lruKey = map.keys().next().value;
      map.delete(lruKey);
      corsCacheEvictionsTotal.inc();
    }
  }

  /**
   * Clears the entire cache. Called when the allowlist changes.
   *
   * @returns {void}
   */
  function clear() {
    map.clear();
    corsCacheInvalidationsTotal.inc();
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
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_ENTRIES,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_MAX_ENTRIES,
  MAX_MAX_ENTRIES,
};
