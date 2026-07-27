/**
 * Bounded in-memory cache for API key registry reads.
 *
 * Prevents repeated parsing of the `API_KEYS` environment variable on every
 * request by caching the parsed registry with a configurable TTL and a
 * bounded number of entries. The cache is invalidated on writes (when the
 * registry is reloaded) and exposes hit/miss metrics for observability.
 *
 * @module cache/apiKeysCache
 */

'use strict';

const { loadApiKeyRegistry } = require('../config/apiKeys');
const { apiKeysCacheHitsTotal, apiKeysCacheMissesTotal } = require('../metrics');

/**
 * Default time-to-live for a cache entry in milliseconds.
 * @type {number}
 */
const DEFAULT_TTL_MS = 30_000; // 30 seconds

/**
 * Minimum allowed TTL in milliseconds.
 * @type {number}
 */
const MIN_TTL_MS = 1_000; // 1 second

/**
 * Maximum allowed TTL in milliseconds.
 * @type {number}
 */
const MAX_TTL_MS = 300_000; // 5 minutes

/**
 * Default maximum number of entries in the cache.
 * @type {number}
 */
const DEFAULT_MAX_ENTRIES = 100;

/**
 * Minimum allowed max entries.
 * @type {number}
 */
const MIN_MAX_ENTRIES = 1;

/**
 * Maximum allowed max entries.
 * @type {number}
 */
const MAX_MAX_ENTRIES = 10_000;

/**
 * Parses a raw value into a positive integer within a specified range.
 * @param {any} rawValue The value to parse.
 * @param {number} fallback The fallback value if parsing fails.
 * @param {number} min The minimum allowed value.
 * @param {number} max The maximum allowed value.
 * @returns {number} The parsed integer or fallback.
 */
function parsePositiveInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Parses API key cache configuration from environment variables.
 *
 * @param {Object} [env=process.env] Environment variables.
 * @returns {{ ttlMs: number, maxEntries: number }} Parsed configuration.
 */
function parseApiKeysCacheConfig(env = process.env) {
  return {
    ttlMs: parsePositiveInt(
      env.API_KEYS_CACHE_TTL_MS,
      DEFAULT_TTL_MS,
      MIN_TTL_MS,
      MAX_TTL_MS
    ),
    maxEntries: parsePositiveInt(
      env.API_KEYS_CACHE_MAX_ENTRIES,
      DEFAULT_MAX_ENTRIES,
      MIN_MAX_ENTRIES,
      MAX_MAX_ENTRIES
    ),
  };
}

/**
 * Bounded in-memory cache for API key registries with TTL-based expiry.
 *
 * Design:
 * - Stores a single cached registry (since all API keys come from one env var).
 * - Entries are invalidated after the configured TTL.
 * - A maximum-entries bound prevents unbounded growth (though with a single
 *   registry we'll only ever have 1 entry; the bound is there for future use
 *   if the cache is extended to per-client entries).
 * - Cache hit/miss counters are exported as Prometheus metrics.
 */
class ApiKeysCache {
  /**
   * @param {Object} [options] Configuration options.
   * @param {number} [options.ttlMs] Cache TTL in milliseconds.
   * @param {number} [options.maxEntries] Maximum number of cache entries.
   */
  constructor(options = {}) {
    const config = options.config || parseApiKeysCacheConfig();

    /** @type {number} TTL in milliseconds. */
    this.ttlMs = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, options.ttlMs || config.ttlMs));

    /** @type {number} Maximum entries. */
    this.maxEntries = Math.max(
      MIN_MAX_ENTRIES,
      Math.min(MAX_MAX_ENTRIES, options.maxEntries || config.maxEntries)
    );

    /**
     * Internal cache store.
     * Key: string identifier (default: 'default')
     * Value: { registry: Map<string, Object>, expiresAt: number }
     * @type {Map<string, { registry: Map<string, Object>, expiresAt: number }>}
     */
    this._cache = new Map();
  }

  /**
   * Retrieves the cached API key registry, or loads and caches a fresh one.
   *
   * If the cache is cold or expired, calls `loadApiKeyRegistry()` to rebuild
   * the parsed registry, stores it with a new expiry, and increments the
   * miss counter. Otherwise returns the cached entry and increments the hit
   * counter.
   *
   * @param {string} [key='default'] Cache key (future-proofing for per-client caching).
   * @returns {Map<string, Object>} The API key registry.
   */
  getOrLoad(key = 'default') {
    const now = Date.now();
    const entry = this._cache.get(key);

    if (entry && entry.expiresAt > now) {
      // Cache hit
      if (apiKeysCacheHitsTotal) {
        apiKeysCacheHitsTotal.inc();
      }
      return entry.registry;
    }

    // Cache miss or expired — reload
    if (apiKeysCacheMissesTotal) {
      apiKeysCacheMissesTotal.inc();
    }

    const registry = loadApiKeyRegistry();

    // Evict oldest entry if at capacity (LRU-style for multi-key, though
    // we currently only use the default key).
    if (this._cache.size >= this.maxEntries) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }

    this._cache.set(key, {
      registry,
      expiresAt: now + this.ttlMs,
    });

    return registry;
  }

  /**
   * Invalidates the entire cache, forcing the next `getOrLoad` call to
   * reload from the environment.
   *
   * Should be called whenever the API keys are modified (e.g., after a
   * configuration reload or write operation).
   */
  invalidateAll() {
    this._cache.clear();
  }

  /**
   * Invalidates a specific cache entry.
   * @param {string} key Cache key to invalidate.
   */
  invalidate(key) {
    this._cache.delete(key);
  }

  /**
   * Returns the number of currently cached entries.
   * @returns {number} Cache size.
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Resets the cache to its initial empty state.
   */
  reset() {
    this._cache.clear();
  }
}

/**
 * Singleton cache instance used by the application.
 * @type {ApiKeysCache}
 */
let defaultCache = null;

/**
 * Returns the singleton ApiKeysCache instance, creating it if necessary.
 *
 * Accepts an optional cache instance for dependency injection in tests.
 *
 * @param {ApiKeysCache} [instance] Optional cache instance (for testing).
 * @returns {ApiKeysCache} The cache instance.
 */
function getApiKeysCache(instance) {
  if (instance !== undefined) {
    defaultCache = instance;
  }
  if (!defaultCache) {
    defaultCache = new ApiKeysCache();
  }
  return defaultCache;
}

module.exports = {
  ApiKeysCache,
  getApiKeysCache,
  parseApiKeysCacheConfig,
  // Constants exposed for testing
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  MIN_MAX_ENTRIES,
  MAX_MAX_ENTRIES,
};
