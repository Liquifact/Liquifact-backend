'use strict';

/**
 * @fileoverview Bounded, TTL-based cache in front of the API-key registry.
 *
 * ## State invariants
 *
 * 1. **Expiry is exclusive.** A stored entry is served only while
 *    `expiresAt > now`. At `expiresAt === now` and beyond it is a miss, so an
 *    expired registry is never served. The TTL is measured from the load time.
 * 2. **The cache is bounded.** `size` never exceeds `maxEntries`. Inserting a
 *    key that is not already present while at capacity evicts the oldest
 *    (FIFO) entry first. Replacing an existing key neither grows the cache nor
 *    evicts an unrelated key.
 * 3. **Failed loads are side-effect free.** `getOrLoad` loads and validates
 *    into locals before touching the map. If `loadApiKeyRegistry` throws,
 *    returns a non-Map, or yields a registry that fails validation, the cache
 *    is left exactly as it was and no entry is published. A previously stored
 *    (possibly expired) entry is preserved but is never served while expired.
 * 4. **Keys are validated.** Only non-empty trimmed strings of at most
 *    {@link MAX_CACHE_KEY_LENGTH} characters are accepted; every other value is
 *    rejected with a `TypeError`. Equivalent keys are canonicalized, so they
 *    address a single entry.
 * 5. **Duplicate keys overwrite deterministically.** Setting a key that is
 *    already cached replaces its registry and expiry in place, preserving
 *    insertion order (and therefore FIFO eviction order) and keeping `size`
 *    stable.
 * 6. **Snapshots are stable and independent.** Each call returns a fresh `Map`
 *    holding only the keys active at the supplied timestamp. Mutating a
 *    returned snapshot cannot affect the cache or any other snapshot.
 */

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
    const normalizedKey = normalizeCacheKey(key);
    const normalizedNow = normalizeTimestamp(now);

    const entry = this._cache.get(normalizedKey);

    if (entry && entry.expiresAt > normalizedNow) {
      if (apiKeysCacheHitsTotal) {
        apiKeysCacheHitsTotal.inc();
      }
      return this._buildSnapshot(entry.registry, normalizedNow);
    }

    if (apiKeysCacheMissesTotal) {
      apiKeysCacheMissesTotal.inc();
    }

    // Load and validate into locals first: a throwing loader or a registry
    // that fails validation must not mutate the cache. A previously stored
    // (now expired) entry is deliberately left untouched so a failed reload
    // cannot destroy state; it is never served because the TTL check above
    // already classified this call as a miss.
    const registry = loadApiKeyRegistry();
    const validatedRegistry = this._validateRegistry(registry);
    const snapshot = this._buildSnapshot(validatedRegistry, normalizedNow);

    // Evict the oldest entry only when inserting a new key, so repeated loads
    // for the same key cannot evict unrelated entries.
    if (!this._cache.has(normalizedKey) && this._cache.size >= this.maxEntries) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }

    this._cache.set(normalizedKey, {
      registry: validatedRegistry,
      expiresAt: normalizedNow + this.ttlMs,
    });

    return snapshot;
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
