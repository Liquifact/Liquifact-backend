'use strict';

const { Counter } = require('prom-client');
const { metricsCache } = require('../config');

// Prometheus Metrics setup
const cacheHits = new Counter({
  name: 'metrics_cache_hits_total',
  help: 'Total number of metrics cache hits',
  labelNames: ['endpoint'],
});

const cacheMisses = new Counter({
  name: 'metrics_cache_misses_total',
  help: 'Total number of metrics cache misses',
  labelNames: ['endpoint'],
});

class MetricsCacheStore {
  constructor(ttlMs = metricsCache?.ttlMs || 5000, maxSize = metricsCache?.maxSize || 5000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.store = new Map();
  }

  get(key, endpoint = 'unknown') {
    const entry = this.store.get(key);
    if (!entry) {
      cacheMisses.inc({ endpoint });
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      cacheMisses.inc({ endpoint });
      return null;
    }

    // Refresh LRU order on access
    this.store.delete(key);
    this.store.set(key, entry);
    cacheHits.inc({ endpoint });
    return entry.value;
  }

  set(key, value) {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      // LRU Eviction: delete the least recently used key (first item in Map iterator)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidatePrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear() {
    this.store.clear();
  }
}

// Singleton instance for global app usage
let sharedStore = null;

function getMetricsCacheStore() {
  if (!sharedStore) {
    sharedStore = new MetricsCacheStore();
  }
  return sharedStore;
}

module.exports = {
  MetricsCacheStore,
  getMetricsCacheStore,
};
