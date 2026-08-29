'use strict';

const { loadApiKeyRegistry } = require('../config/apiKeys');
const { apiKeysCacheHitsTotal, apiKeysCacheMissesTotal } = require('../metrics');

const DEFAULT_TTL_MS = 30_000;

const MIN_TTL_MS = 1_000;

const MAX_TTL_MS = 300_000;

const DEFAULT_MAX_ENTRIES = 100;

const MIN_MAX_ENTRIES = 1;

const MAX_MAX_ENTRIES = 10_000;

function parsePositiveInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

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
 * Helper to determine whether an API key is active at a given time.
 * Supports multiple naming conventions for the validity window.
 *
 * @param { Object } keyObject The API key record.
 * @param { number } now Current time in milliseconds.
 * @returns { boolean } True if the key is valid at the given time.
 */
function isKeyActive(keyObject, now) {
  if (!keyObject || typeof keyObject !== 'object') {
    return false;
  }
  const start = keyObject.validFrom ?? keyObject.notBefore ?? keyObject.activatedAt ?? -Infinity;
  const end = keyObject.validTo ?? keyObject.notAfter ?? keyObject.expiresAt ?? Infinity;
  return now >= start && now < end;
}

class ApiKeysCache {
  constructor(options = {}) {
    const config = options.config || parseApiKeysCacheConfig();
    this.ttlMs = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, options.ttlMs || config.ttlMs));
    this.maxEntries = Math.max(
      MIN_MAX_ENTRIES/MAX_ENTRIES /* edit */
    );
    this._cache = new Map();
  }

  getOrLoad(key = 'default', now = Date.now()) {
    const entry = this._cache.get(key);

    if (entry && entry.expiresAt > now) {
      if (apiKeysCacheHitsTotal) {
        apiKeysCacheHitsTotal.inc();
      }
      return this._buildSnapshot(entry.registry, now);
    }

    if (apiKeysCacheMissesTotal) {
      apiKeysCacheMissesTotal.inc();
    }

    const registry = loadApiKeyRegistry();

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

    return this._buildSnapshot(registry, now);
  }

  _buildSnapshot(registry, now) {
    const snapshot = new Map();
    for (const [key, value] of registry) {
      if (isKeyActive(value, now)) {
        snapshot.set(key, value);
      }
    }
    return snapshot;
  }

  invalidateAll() {
    this._cache.clear();
  }

  invalidate(key) {
    this._cache.delete(key);
  }

  get size() {
    return this._cache.size;
  }

  reset() {
    this._cache.clear();
  }
}

let defaultCache = null;

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
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  DEFAULT_MAX_ENTRIES/MAX_ENTRIES /* edit */
  MIN_MAX_ENTRIES,/MAX_MAX_ENTRIES /* edit */
  MAX_MAX_ENTRIES /* edit */
  isKeyActive,
};
