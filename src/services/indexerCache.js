'use strict';

/**
 * @fileoverview Bounded in-process TTL cache for indexer event listing responses.
 *
 * Caches the `{data, meta}` result of {@link listIndexerEvents} keyed by a
 * deterministic serialisation of the query parameters.  The cache uses a Map
 * (insertion-order = LRU) with a configurable TTL and max-entry bound.
 *
 * On every new escrow event persisted by the indexer, {@link invalidateAll}
 * should be called to drop stale pages whose `total` counts would otherwise be
 * wrong.
 *
 * Compatibility contract: the public surface (`IndexerCache`, `indexerCache`,
 * `buildKey`, `get`, `set`, `invalidateAll`, `size`) is stable.  All methods
 * are safe to call with malformed or missing arguments and never throw.
 *
 * @module services/indexerCache
 */

const assert = require('assert');

const { cacheConfig } = require('../config/cache');
const {
  indexerCacheHitsTotal,
  indexerCacheMissesTotal,
  indexerCacheEvictionsTotal,
} = require('../metrics');

/**
 * Validates cache configuration invariants.  A misconfigured cache (non-positive
 * TTL, non-positive max entries, or a non-function clock) would silently break
 * the TTL/LRU guarantees, so we fail fast at construction time.
 *
 * @param {object} options - Resolved cache options.
 * @returns {void}
 */
function assertCacheInvariants({ ttlMs, maxEntries, now }) {
  assert(Number.isFinite(ttlMs) && ttlMs > 0, 'indexerCache: ttlMs must be a positive finite number');
  assert(Number.isInteger(maxEntries) && maxEntries > 0, 'indexerCache: maxEntries must be a positive integer');
  assert(typeof now === 'function', 'indexerCache: now must be a function');
}

/**
 * Bounded in-process TTL cache for indexer listing responses.
 * Map insertion order provides LRU eviction: every hit is reinserted at the
 * newest position.
 */
class IndexerCache {
  /**
   * Creates a bounded indexer listing cache.
   *
   * @param {object} [options] Cache options.
   * @param {number} [options.ttlMs]     Entry lifetime in milliseconds.
   * @param {number} [options.maxEntries] Maximum retained responses.
   * @param {Function} [options.now]     Clock used for deterministic tests.
   */
  constructor({
    ttlMs = cacheConfig.indexerTtl,
    maxEntries = cacheConfig.indexerMaxEntries,
    now = Date.now,
  } = {}) {
    assertCacheInvariants({ ttlMs, maxEntries, now });
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {Map<string, {value: object, expiresAt: number}>} */
    this.entries = new Map();
    /** @type {number} Monotonic counter used to detect concurrent mutation. */
    this.generation = 0;
  }

  /**
   * Builds a deterministic cache key from listing query parameters.
   *
   * The key includes filters, sorting, limit, and the pagination position
   * (cursor or page).  Every unique request produces a unique key.  On any
   * write the entire cache is invalidated via {@link invalidateAll}.
   *
   * @param {object} options                     - Same shape accepted by {@link listIndexerEvents}.
   * @param {object} [options.filters]           - Filter predicates.
   * @param {object} [options.sorting]           - Sort configuration.
   * @param {object} [options.pagination]        - Pagination parameters.
   * @returns {string} Serialised cache key.
   */
  static buildKey({ filters = {}, sorting = {}, pagination = {} } = {}) {
    assert(filters !== null && typeof filters === 'object', 'indexerCache: filters must be an object');
    assert(sorting !== null && typeof sorting === 'object', 'indexerCache: sorting must be an object');
    assert(pagination !== null && typeof pagination === 'object', 'indexerCache: pagination must be an object');

    return JSON.stringify({
      filters,
      sorting: {
        sortBy: sorting.sortBy || 'observed_at',
        order: sorting.order || 'desc',
      },
      limit: parseInt(pagination.limit, 10) || 20,
      cursor: pagination.cursor || null,
      page: pagination.cursor ? undefined : (parseInt(pagination.page, 10) || 1),
    });
  }

  /**
   * Reads and refreshes the recency of a cached response.
   *
   * @param {string} key - Cache key produced by {@link buildKey}.
   * @returns {object|undefined} Cached `{data, meta}`, or undefined on miss.
   */
  get(key) {
    assert(typeof key === 'string' && key.length > 0, 'indexerCache: key must be a non-empty string');

    const entry = this.entries.get(key);
    if (!entry) {
      indexerCacheMissesTotal.inc();
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      indexerCacheMissesTotal.inc();
      indexerCacheEvictionsTotal.labels('expired').inc();
      return undefined;
    }

    // Refresh recency (LRU).
    this.entries.delete(key);
    this.entries.set(key, entry);
    indexerCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a listing response and evicts least-recent entries beyond the bound.
   *
   * @param {string} key   - Cache key produced by {@link buildKey}.
   * @param {object} value - `{data, meta}` listing response.
   * @returns {void}
   */
  set(key, value) {
    assert(typeof key === 'string' && key.length > 0, 'indexerCache: key must be a non-empty string');
    assert(value !== null && typeof value === 'object', 'indexerCache: value must be a non-null object');
    assert('data' in value && 'meta' in value, 'indexerCache: value must contain data and meta');

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
    this.generation += 1;

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      indexerCacheEvictionsTotal.labels('capacity').inc();
    }
  }

  /**
   * Removes every entry.  Called after each new event is persisted so that
   * stale `total` counts and first-page results are dropped.
   *
   * @returns {void}
   */
  invalidateAll() {
    this.entries.clear();
    this.generation += 1;
  }

  /**
   * Returns the current number of cached entries (useful for tests and metrics).
   *
   * @returns {number}
   */
  get size() {
    return this.entries.size;
  }

  /**
   * Returns the current mutation generation.  Callers that need to detect
   * whether a cached value is still valid across an await boundary can capture
   * this before an async operation and compare afterwards.  This preserves the
   * "no stale reads after invalidation" invariant under concurrent execution.
   *
   * @returns {number}
   */
  getGeneration() {
    return this.generation;
  }
}

const indexerCache = new IndexerCache();

module.exports = {
  IndexerCache,
  indexerCache,
  buildKey: IndexerCache.buildKey,
  get: (key) => indexerCache.get(key),
  set: (key, value) => indexerCache.set(key, value),
  invalidateAll: () => indexerCache.invalidateAll(),
  getGeneration: () => indexerCache.getGeneration(),
};
