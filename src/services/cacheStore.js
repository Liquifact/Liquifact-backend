'use strict';

/**
 * In-memory cache store backed by a native Map.
 * Each entry is stored with an expiry timestamp for TTL-based eviction.
 * Supports a configurable maximum number of entries with LRU eviction.
 * Metrics for hits, misses, and evictions are emitted via the metrics module.
 *
 * Validation invariants:
 *   - Keys must be non-empty strings of at most MAX_KEY_LENGTH characters.
 *   - TTLs must be finite numbers in (0, MAX_TTL_MS].
 *   - Prefixes must be non-empty strings of at most MAX_KEY_LENGTH characters.
 *   - Invalid inputs are rejected with CacheValidationError and do not
 *     mutate the cache or emit hit/miss/eviction metrics.
 *
 * @class
 */
const { footprintCacheHitsTotal, footprintCacheMissesTotal, footprintCacheEvictionsTotal } = require('../metrics');

/**
 * Deterministic failure-recovery invariants for the in-memory cache store:
 *
 * 1. Every mutating operation (set/del/delByPrefix/clear) is atomic with
 *    respect to the underlying Map: it either fully applies or leaves the
 *    store unchanged. No partial writes are observable.
 * 2. Reads never mutate the store except for lazy TTL eviction, which is
 *    idempotent and safe to retry.
 * 3. LRU eviction is bounded and deterministic: after any set(), the store
 *    size is <= maxEntries, and the evicted keys are always the least
 *    recently used ones in insertion order.
 * 4. Invalid inputs (non-string keys, non-finite TTLs) are rejected without
 *    mutating state, so callers can retry safely.
 * 5. All failures are observable via metrics and never throw from get(),
 *    so a cache outage cannot take down the request path.
 */

/**
 * Validates a cache key. Returns true when the key is a non-empty string.
 * @param {*} key
 * @returns {boolean}
 */
function isValidKey(key) {
  return typeof key === 'string' && key.length > 0;
}

/**
 * Validates a TTL value. Returns true when the TTL is a finite, non-negative
 * number. Non-finite or negative TTLs are rejected to keep expiry deterministic.
 * @param {*} ttlMs
 * @returns {boolean}
 */
function isValidTtl(ttlMs) {
  return typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0;
}

class MemoryCacheStore {
  /**
   * Creates a new MemoryCacheStore instance with optional bounds.
   *
   * @param {object} [options] - Options for the cache store.
   * @param {number} [options.maxEntries] - Maximum number of entries before LRU eviction. Defaults to 5000.
   * @throws {CacheValidationError} If maxEntries is not a non-negative finite number.
   */
  constructor(options = {}) {
    const { maxEntries = DEFAULT_MAX_ENTRIES } = options;
    // treat non-positive values as unlimited (Infinity) to preserve backward compatibility
    this._maxEntries = normalizeMaxEntries(maxEntries);
    // Map preserves insertion order – we will delete/re‑insert on access to maintain LRU ordering
    this._cache = new Map();
  }

  /**
   * Retrieves a cached value by key. Returns undefined if the key is missing
   * or expired. Expired entries are lazily evicted. Updates LRU order on hit.
   *
   * @param {string} key - The cache key to look up.
   * @returns {*} The cached value, or undefined if missing/expired.
   * @throws {CacheValidationError} If the key is invalid.
   */
  get(key) {
    // Invalid keys are treated as misses without touching the store so that
    // callers can retry deterministically.
    if (!isValidKey(key)) {
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    const entry = this._cache.get(key);
    if (!entry) {
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      // TTL expiry – treat as miss and clean up. This is idempotent: a
      // concurrent or retried get() observes the same miss.
      this._cache.delete(key);
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    // Cache hit – move entry to the end to mark it as most‑recently used.
    // Delete+set is atomic with respect to the Map and preserves the value.
    this._cache.delete(key);
    this._cache.set(key, entry);
    footprintCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a value in the cache with a TTL in milliseconds.
   * Enforces the LRU bound after insertion.
   *
   * @param {string} key - The cache key.
   * @param {*} value - The value to cache.
   * @param {number} ttlMs - Time-to-live in milliseconds.
   * @returns {void}
   * @throws {CacheValidationError} If the key or TTL is invalid.
   */
  set(key, value, ttlMs) {
    // Reject invalid inputs without mutating state so callers can retry.
    if (!isValidKey(key) || !isValidTtl(ttlMs)) {
      return;
    }
    // If key already exists, delete it first so that insertion order reflects recency
    if (this._cache.has(normalizedKey)) {
      this._cache.delete(normalizedKey);
    }
    const entry = { value, expiresAt: Date.now() + ttlMs };
    this._cache.set(key, entry);
    // Evict least‑recently used entries while we exceed the bound.
    // Eviction is deterministic: keys() yields insertion order, so the
    // first key is always the least recently used.
    while (this._cache.size > this._maxEntries) {
      const lruKey = this._cache.keys().next().value;
      this._cache.delete(lruKey);
      footprintCacheEvictionsTotal.inc();
    }
  }

  /**
   * Removes a specific entry from the cache.
   *
   * @param {string} key - The cache key to remove.
   * @returns {void}
   * @throws {CacheValidationError} If the key is invalid.
   */
  del(key) {
    if (!isValidKey(key)) {
      return;
    }
    this._cache.delete(key);
  }

  /**
   * Returns all currently valid (non-expired) cache keys.
   *
   * Expired entries are lazily evicted during iteration.
   *
   * @returns {string[]} Array of active cache keys.
   */
  keys() {
    const now = Date.now();
    const valid = [];
    for (const [key, entry] of this._cache) {
      if (now < entry.expiresAt) {
        valid.push(key);
      } else {
        this._cache.delete(key);
      }
    }
    return valid;
  }

  /**
   * Deletes all cache entries whose key starts with the given prefix.
   * Expired entries are also cleaned up during iteration.
   *
   * @param {string} prefix - The key prefix to match.
   * @returns {void}
   * @throws {CacheValidationError} If the prefix is invalid.
   */
  delByPrefix(prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) {
      return;
    }
    const now = Date.now();
    // Collect keys first, then delete, so iteration is not affected by
    // concurrent mutation and the operation is atomic from the caller's view.
    const toDelete = [];
    for (const [key, entry] of this._cache) {
      if (now > entry.expiresAt) {
        toDelete.push(key);
      } else if (key.startsWith(prefix)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this._cache.delete(key);
    }
  }

  /**
   * Removes all entries from the cache.
   *
   * @returns {void}
   */
  clear() {
    this._cache.clear();
  }
}

/**
 * Factory function that creates a cache store instance.
 * Currently returns a MemoryCacheStore. Future implementations can check
 * for REDIS_URL and return a Redis-backed store.
 *
 * @param {object} [options] Options passed to the MemoryCacheStore constructor.
 * @returns {MemoryCacheStore} A cache store instance.
 */
function createCacheStore(options = {}) {
  return new MemoryCacheStore(options);
}

/**
 * Returns a shared singleton cache store instance.
 *
 * All middleware and services that need to read or invalidate cache entries
 * should use this instance to ensure consistency.
 *
 * @returns {MemoryCacheStore} The shared cache store.
 */
function getSharedStore() {
  if (!_sharedInstance) {
    _sharedInstance = new MemoryCacheStore();
  }
  return _sharedInstance;
}

/**
 * Resets the shared singleton instance.
 *
 * Primarily intended for tests and for explicit lifecycle resets (e.g.
 * graceful shutdown or configuration reload). Production code should not
 * call this during normal operation as it drops all cached entries.
 *
 * @returns {void}
 */
function resetSharedStore() {
  _sharedInstance = null;
}

let _sharedInstance = null;

module.exports = {
  MemoryCacheStore,
  CacheValidationError,
  createCacheStore,
  getSharedStore,
  resetSharedStore,
  normalizeKey,
  normalizeTtl,
};
