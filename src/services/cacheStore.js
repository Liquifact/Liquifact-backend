/**
 * In-memory cache store backed by a native Map.
 * Each entry is stored with an expiry timestamp for TTL-based eviction.
 *
 * @class
 */
class MemoryCacheStore {
  /**
   * Creates a new MemoryCacheStore instance.
   *
   * @returns {MemoryCacheStore} A new cache store.
   */
  constructor() {
    this._cache = new Map();
  }

  /**
   * Retrieves a cached value by key. Returns undefined if the key is missing
   * or expired. Expired entries are lazily evicted.
   *
   * @param {string} key - The cache key to look up.
   * @returns {*} The cached value, or undefined if missing/expired.
   */
  get(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Stores a value in the cache with a TTL in milliseconds.
   *
   * @param {string} key - The cache key.
   * @param {*} value - The value to cache.
   * @param {number} ttlMs - Time-to-live in milliseconds.
   * @returns {void}
   */
  set(key, value, ttlMs) {
    this._cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Removes a specific entry from the cache.
   *
   * @param {string} key - The cache key to remove.
   * @returns {void}
   */
  del(key) {
    this._cache.delete(key);
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
 * @returns {MemoryCacheStore} A cache store instance.
 */
function createCacheStore() {
  return new MemoryCacheStore();
}

module.exports = {
  MemoryCacheStore,
  createCacheStore,
};
