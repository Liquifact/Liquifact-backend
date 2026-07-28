'use strict';

/**
 * @fileoverview Bounded in-process TTL cache for indexer event listing responses.
 *
 * Caches the `{ data, meta }` result of {@link listIndexerEvents} keyed by a
 * deterministic serialisation of the query parameters.  The cache uses a Map
 * (insertion-order = LRU) with a configurable TTL and max-entry bound.
 *
 * On every new escrow event persisted by the indexer, {@link invalidateAll}
 * should be called to drop stale pages whose `total` counts would otherwise be
 * wrong.
 *
 * @module services/indexerCache
 */

const { cacheConfig } = require('../config/cache');
const {
  indexerCacheHitsTotal,
  indexerCacheMissesTotal,
  indexerCacheEvictionsTotal,
} = require('../metrics');

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
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {Map<string, {value: object, expiresAt: number}>} */
    this.entries = new Map();
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
   * @returns {object|undefined} Cached `{ data, meta }`, or undefined on miss.
   */
  get(key) {
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

    // Refresh recency (LRU): delete then reinsert at end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    indexerCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a listing response and evicts least-recent entries beyond the bound.
   *
   * @param {string} key   - Cache key produced by {@link buildKey}.
   * @param {object} value - `{ data, meta }` listing response.
   * @returns {void}
   */
  set(key, value) {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });

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
  }

  /**
   * Returns the current number of cached entries (useful for tests and metrics).
   *
   * @returns {number}
   */
  get size() {
    return this.entries.size;
  }
}

const indexerCache = new IndexerCache();

module.exports = {
  IndexerCache,
  indexerCache,
};
