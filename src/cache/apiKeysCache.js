'use strict';

const { loadApiKeyRegistry } = require('../config/apiKeys');
const { apiKeysCacheHitsTotal, apiKeysCacheMissesTotal } = require('../metrics');

const DEFAULT_TTL_MS = 30_000;

const MIN_TTL_MS = 1_000;

const MAX_TTL_MS = 300_000;

const DEFAULT_MAX_ENTRIES = 100;

const MIN_MAX_ENTRIES = 1;

const MAX_MAX_ENTRIES = 10_000;

const DEFAULT_CACHE_KEY = 'default';

const MAX_CACHE_KEY_LENGTH = 256;

/**
 * Parse an integer environment value and clamp it into [min, max].
 *
 * Returns the fallback when the value is missing, non-numeric, or not a
 * finite integer. Fractional values are truncated toward zero so that
 * behavior is deterministic across runtimes.
 *
 * @param {*} rawValue Raw environment value.
 * @param {number} fallback Value used when parsing fails.
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @returns {number} A finite integer within [min, max].
 */
function parsePositiveInt(rawValue, fallback, min, max) {
  if (rawValue === undefined || rawValue === null) {
    return fallback;
  }

  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    return fallback;
  }

  const normalized = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return fallback;
  }

  if (parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

/**
 * Validate a cache key. Keys must be non-empty strings of bounded length.
 * This prevents unbounded memory growth and ambiguous key identity.
 *
 * @param {*} key Candidate cache key.
 * @returns {string} The normalized key.
 * @throws {TypeError} When the key is not a valid string.
 */
function normalizeCacheKey(key) {
  if (typeof key !== 'string') {
    throw new TypeError('Cache key must be a string');
  }

  const trimmed = key.trim();

  if (trimmed.length === 0) {
    throw new TypeError('Cache key must not be empty');
  }

  if (trimmed.length > MAX_CACHE_KEY_LENGTH) {
    throw new TypeError(
      `Cache key must not exceed ${MAX_CACHE_KEY_LENGTH} characters`
    );
  }

  return trimmed;
}

/**
 * Validate a timestamp used for expiry computation. Non-finite values
 * would produce NaN expiry times and silently break caching, so they are
 * rejected early.
 *
 * @param {*} now Candidate timestamp.
 * @returns {number} The validated timestamp.
 * @throws {TypeError} When the timestamp is not a finite number.
 */
function normalizeTimestamp(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('now must be a finite number');
  }

  return now;
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
      MIN_MAX_ENTRIES,
      Math.min(MAX_MAX_ENTRIES, options.maxEntries || config.maxEntries)
    );
    this._cache = new Map();
  }

  _validateRegistry(registry) {
    if (!(registry instanceof Map)) {
      throw new TypeError('loader must return a Map');
    }

    for (const [key, value] of registry) {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new TypeError('registry keys must be non-empty strings');
      }
      if (value !== null && value !== undefined && typeof value !== 'object') {
        throw new TypeError('registry values must be objects');
      }
    }

    return registry;
  }

  getOrLoad(key = 'default', now = Date.now()) {
    const entry = this._cache.get(key);

    const entry = this._cache.get(normalizedKey);

    if (entry && entry.expiresAt > normalizedNow) {
      if (apiKeysCacheHitsTotal) {
        apiKeysCacheHitsTotal.inc();
      }
      return this._buildSnapshot(entry.registry, normalizedNow);
    }

    if (entry) {
      // Evict expired entries so the bound is always measured against
      // live entries and stale data cannot be served accidentally.
      this._cache.delete(normalizedKey);
    }

    if (entry) {
      // Expired entry: remove it before loading so a failed load cannot leave
      // a stale entry that would be served as a hit on the next call.
      this._cache.delete(key);
    }

    if (apiKeysCacheMissesTotal) {
      apiKeysCacheMissesTotal.inc();
    }

    let registry;
    try {
      registry = loadApiKeyRegistry();
    } catch (error) {
      throw error;
    }

    const validatedRegistry = this._validateRegistry(registry);
    const snapshot = this._buildSnapshot(validatedRegistry, now);

    // Evict the oldest entry only when inserting a new key, so repeated loads
    // for the same key cannot evict unrelated entries.
    if (!this._cache.has(key) && this._cache.size >= this.maxEntries) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }

    this._cache.set(key, {
      registry: validatedRegistry,
      expiresAt: now + this.ttlMs,
    });

    return snapshot;
  }

  _buildHSnapshot(registry, now) {
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
    return this._cache.delete(key);
  }

  get size() {
    return this._cache.size;
  }

  reset() {
    this._cache.clear();
  }
}

function validateVersion(version) {
  if (typeof version !== 'string') {
    return { valid: false, reason: 'version must be a string' };
  }

  const trimmed = version.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: 'version must not be empty' };
  }

  if (trimmed.length > MAX_CACHE_KEY_LENGTH) {
    return {
      valid: false,
      reason: `version must not exceed ${MAX_CACHE_KEY_LENGTH} characters`,
    };
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return {
      valid: false,
      reason: 'version must only contain alphanumeric, dot, underscore, or hyphen characters',
    };
  }

  return { valid: true, value: trimmed };
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
  normalizeCacheKey,
  normalizeTimestamp,
  validateVersion,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  MIN_MAX_ENTRIES,
  MAX_MAX_ENTRIES,
  DEFAULT_CACHE_KEY,
  MAX_CACHE_KEY_LENGTH,
  isKeyActive,
};
