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

/**
 * Resolve the cache TTL and entry bound from the environment, clamped to the
 * documented safe ranges via {@link parsePositiveInt}.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment variables source.
 * @returns {{ttlMs: number, maxEntries: number}} Clamped cache configuration.
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
  /**
   * Create a bounded, TTL-scoped registry cache.
   *
   * @param {Object} [options={}] Cache options.
   * @param {Object} [options.config] Pre-parsed config; defaults to the environment.
   * @param {number} [options.ttlMs] Entry time-to-live in milliseconds.
   * @param {number} [options.maxEntries] Maximum number of cached registries.
   */
  constructor(options = {}) {
    const config = options.config || parseApiKeysCacheConfig();
    this.ttlMs = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, options.ttlMs || config.ttlMs));
    this.maxEntries = Math.max(
      MIN_MAX_ENTRIES,
      Math.min(MAX_MAX_ENTRIES, options.maxEntries || config.maxEntries)
    );
    this._cache = new Map();
  }

  /**
   * Validate that a loaded registry is a Map of non-empty string keys to
   * object (or null/undefined) values before it is cached.
   *
   * @param {Map<string, Object>} registry Candidate registry.
   * @returns {Map<string, Object>} The validated registry.
   * @throws {TypeError} When the registry is malformed.
   */
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

  /**
   * Return a time-filtered snapshot of the registry for `key`, loading it on a
   * miss or an expired entry.
   *
   * ## Invariant: idempotent under repeated / concurrent calls
   * Inputs are normalized exactly once, so identity (the key) and expiry (the
   * timestamp) cannot drift between lookup, eviction, and insertion. This makes
   * the method idempotent under repeated or replayed calls: the first call in a
   * window loads the registry, and every subsequent call within the TTL serves
   * the same cached registry without invoking the loader again.
   *
   * ## Invariant: expired / failed loads are never served
   * An expired entry is evicted *before* the loader runs, so a loader that
   * throws cannot leave a stale entry behind for a later call to serve as a
   * hit. A registry is written to the cache only after it has been loaded and
   * validated successfully. The entry bound is measured against live entries
   * only, and the TTL boundary is strict: an entry is a hit only while
   * `expiresAt > now`.
   *
   * @param {string} [key='default'] Cache key identifying the registry.
   * @param {number} [now=Date.now()] Current time in milliseconds.
   * @returns {Map<string, Object>} Time-filtered registry snapshot.
   */
  getOrLoad(key = DEFAULT_CACHE_KEY, now = Date.now()) {
    // Normalize once: every subsequent lookup, eviction, and insertion uses the
    // same canonical key and timestamp.
    const normalizedKey = normalizeCacheKey(key);
    const normalizedNow = normalizeTimestamp(now);

    const entry = this._cache.get(normalizedKey);

    if (entry && entry.expiresAt > normalizedNow) {
      if (apiKeysCacheHitsTotal) {
        apiKeysCacheHitsTotal.inc();
      }
      return this._buildSnapshot(entry.registry, normalizedNow);
    }

    if (entry) {
      // Expired entry: evict it before loading so a failed load cannot leave a
      // stale entry that would be served as a hit on the next call.
      this._cache.delete(normalizedKey);
    }

    if (apiKeysCacheMissesTotal) {
      apiKeysCacheMissesTotal.inc();
    }

    // Load + validate first; the cache is mutated only on success, so a throw
    // leaves the cache untouched (no stale, unservable entry).
    const validatedRegistry = this._validateRegistry(loadApiKeyRegistry());
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

  /**
   * Build a snapshot containing only the keys active at `now`.
   *
   * @param {Map<string, Object>} registry Source registry.
   * @param {number} now Current time in milliseconds.
   * @returns {Map<string, Object>} Filtered registry snapshot.
   */
  _buildSnapshot(registry, now) {
    const snapshot = new Map();
    for (const [key, value] of registry) {
      if (isKeyActive(value, now)) {
        snapshot.set(key, value);
      }
    }
    return snapshot;
  }

  /**
   * Drop every cached registry.
   *
   * @returns {void}
   */
  invalidateAll() {
    this._cache.clear();
  }

  /**
   * Drop a single cached registry by key.
   *
   * @param {string} key Cache key to evict.
   * @returns {boolean} True when an entry was removed.
   */
  invalidate(key) {
    return this._cache.delete(key);
  }

  /**
   * Number of currently cached (possibly expired) registries.
   *
   * @returns {number} Current cache size.
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Alias of {@link ApiKeysCache#invalidateAll} retained for callers that use
   * the reset-style API.
   *
   * @returns {void}
   */
  reset() {
    this._cache.clear();
  }
}

/**
 * Validate a registry version identifier.
 *
 * @param {*} version Candidate version.
 * @returns {{valid: boolean, value?: string, reason?: string}} Validation result.
 */
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

/**
 * Return the process-wide cache singleton, optionally replacing it.
 *
 * @param {ApiKeysCache} [instance] Instance to install as the singleton.
 * @returns {ApiKeysCache} The active cache singleton.
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
