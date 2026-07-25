'use strict';

const { cacheConfig } = require('../config/cache');
const {
  escrowReadCacheHitsTotal,
  escrowReadCacheMissesTotal,
  escrowReadCacheEvictionsTotal,
} = require('../metrics');

/**
 * Bounded in-process TTL cache. Map insertion order provides LRU eviction:
 * every hit is reinserted at the newest position.
 */
class EscrowReadCache {
  /**
   * Creates a bounded escrow response cache.
   * @param {object} [options] Cache options.
   * @param {number} [options.ttlMs] Entry lifetime in milliseconds.
   * @param {number} [options.maxEntries] Maximum retained responses.
   * @param {Function} [options.now] Clock used for deterministic tests.
   */
  constructor({
    ttlMs = cacheConfig.escrowTtl,
    maxEntries = cacheConfig.escrowMaxEntries,
    now = Date.now,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  /**
   * Reads and refreshes the recency of a cached response.
   * @param {string} invoiceId Cache key.
   * @returns {object|undefined} Cached response, or undefined on a miss.
   */
  get(invoiceId) {
    const entry = this.entries.get(invoiceId);
    if (!entry) {
      escrowReadCacheMissesTotal.inc();
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(invoiceId);
      escrowReadCacheMissesTotal.inc();
      escrowReadCacheEvictionsTotal.labels('expired').inc();
      return undefined;
    }

    this.entries.delete(invoiceId);
    this.entries.set(invoiceId, entry);
    escrowReadCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a response and evicts least-recent entries beyond the bound.
   * @param {string} invoiceId Cache key.
   * @param {object} value Escrow read response.
   * @returns {void}
   */
  set(invoiceId, value) {
    if (this.entries.has(invoiceId)) {
      this.entries.delete(invoiceId);
    }
    this.entries.set(invoiceId, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      escrowReadCacheEvictionsTotal.labels('capacity').inc();
    }
  }

  /**
   * Removes one invoice response.
   * @param {string} invoiceId Cache key.
   * @returns {boolean} Whether an entry existed.
   */
  invalidate(invoiceId) {
    return this.entries.delete(invoiceId);
  }

  /**
   * Removes every entry. Intended for lifecycle and test cleanup.
   * @returns {void}
   */
  clear() {
    this.entries.clear();
  }
}

const escrowReadCache = new EscrowReadCache();

module.exports = {
  EscrowReadCache,
  escrowReadCache,
};
