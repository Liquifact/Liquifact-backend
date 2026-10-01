/**
 * @fileoverview Bounded, validated in-memory cache for the API-key registry.
 *
 * The registry is re-parsed from `API_KEYS` on every miss, which is expensive
 * on hot authentication paths, so this module memoises it behind a bounded,
 * TTL-expiring map. Because the cached value is security-relevant (it decides
 * which keys authenticate), every input is validated against an explicit,
 * deterministic boundary before it can affect state.
 *
 * ## Validation boundaries
 *
 * | Input                          | Boundary                                        | Behaviour              |
 * | ------------------------------ | ----------------------------------------------- | ---------------------- |
 * | `API_KEYS_CACHE_TTL_MS`        | absent, empty, non-numeric, or outside `[MIN_TTL_MS, MAX_TTL_MS]` | `DEFAULT_TTL_MS` |
 * | `API_KEYS_CACHE_MAX_ENTRIES`   | absent, empty, non-numeric, or outside `[MIN_MAX_ENTRIES, MAX_MAX_ENTRIES]` | `DEFAULT_MAX_ENTRIES` |
 * | constructor `ttlMs`            | `< MIN_TTL_MS` or `> MAX_TTL_MS`                | clamped to the nearest bound |
 * | constructor `maxEntries`       | `< MIN_MAX_ENTRIES` or `> MAX_MAX_ENTRIES`      | clamped to the nearest bound |
 * | cache key                      | non-string, empty/whitespace-only, or `> MAX_CACHE_KEY_LENGTH` after trimming | `TypeError` |
 * | `now` timestamp                | non-number or non-finite                        | `TypeError`            |
 * | expiry                         | hit iff `expiresAt > now`; `expiresAt === now` is expired | reload on miss |
 *
 * Keys are trimmed before use, so whitespace variants collapse onto a single
 * entry. Expired entries are evicted *before* the reload, so a failed loader
 * cannot leave a stale entry that is later served as a hit; the next call
 * retries from scratch. Repeated parses and repeated loads are therefore
 * deterministic and idempotent.
 *
 * @module cache/apiKeysCache
 */

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
 * Parse an integer environment value and accept it only inside [min, max].
 *
 * Returns the fallback when the value is missing, empty, non-numeric, not a
 * finite integer, or outside the inclusive [min, max] range. Out-of-range
 * values deliberately fall back to the documented default rather than being
 * clamped, so a mis-set environment variable is observable (the default is
 * used) instead of silently pinned to a bound.
 *
 * @param {*} rawValue Raw environment value.
 * @param {number} fallback Value used when parsing fails or is out of range.
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @returns {number} A finite integer within [min, max], or the fallback.
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
 * Parse API-key cache limits from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source.
 * @returns {{ ttlMs: number, maxEntries: number }} Resolved, validated config.
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

/**
 * Clamp an explicit cache option into [min, max].
 *
 * A missing, non-number or non-finite option falls back to the resolved config
 * value (the documented default); a finite out-of-range value is clamped to the
 * nearest bound. Unlike {@link parsePositiveInt}, this never rejects:
 * constructor options are trusted knobs, so an out-of-range value is corrected
 * rather than substituted wholesale. `null`/`undefined` and `NaN` are treated
 * as "not supplied" so `0` is honoured as a real (clamped) value.
 *
 * @param {*} value Caller-supplied option.
 * @param {number} fallback Resolved config value used when `value` is absent or non-finite.
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @returns {number} A finite integer within [min, max].
 */
function clampToBounds(value, fallback, min, max) {
  let candidate = value;
  if (candidate === undefined || candidate === null || !Number.isFinite(candidate)) {
    candidate = fallback;
  }
  if (!Number.isFinite(candidate)) {
    return min;
  }
  return Math.max(min, Math.min(max, candidate));
}

class ApiKeysCache {
  /**
   * Create a bounded API-key registry cache.
   *
   * @param {Object} [options={}] Cache options.
   * @param {number} [options.ttlMs] Entry lifetime in ms; clamped to [MIN_TTL_MS, MAX_TTL_MS].
   * @param {number} [options.maxEntries] Entry cap; clamped to [MIN_MAX_ENTRIES, MAX_MAX_ENTRIES].
   * @param {{ ttlMs: number, maxEntries: number }} [options.config] Pre-resolved config for absent options.
   */
  constructor(options = {}) {
    const config = options.config || parseApiKeysCacheConfig();
    this.ttlMs = clampToBounds(options.ttlMs, config.ttlMs, MIN_TTL_MS, MAX_TTL_MS);
    this.maxEntries = clampToBounds(
      options.maxEntries,
      config.maxEntries,
      MIN_MAX_ENTRIES,
      MAX_MAX_ENTRIES
    );
    this._cache = new Map();
  }

  /**
   * Validate that a loader result is a Map of non-empty string keys to object
   * (or null/undefined) values. Rejecting malformed registries keeps the cache
   * from publishing an unusable authentication view.
   *
   * @param {*} registry Candidate loader result.
   * @returns {Map<string, Object>} The validated registry.
   * @throws {TypeError} When the registry or one of its entries is malformed.
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
   * Return a time-filtered snapshot of the registry, loading it on a miss.
   *
   * A hit requires an unexpired entry and returns a fresh snapshot filtered by
   * `now`. A miss (or expiry) loads, validates and caches the registry; a failed
   * load caches nothing, so the next call retries. Concurrent callers observe
   * either the previous or the next complete snapshot, never a partial one.
   *
   * @param {string} [key=DEFAULT_CACHE_KEY] Cache key; trimmed and length-checked.
   * @param {number} [now=Date.now()] Evaluation time in ms; must be finite.
   * @returns {Map<string, Object>} Keys active at `now`.
   * @throws {TypeError} When the key or timestamp is invalid.
   */
  getOrLoad(key = DEFAULT_CACHE_KEY, now = Date.now()) {
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
      // Expired entry: evict it before loading so a failed load cannot leave
      // a stale entry that would be served as a hit on the next call, and so
      // the entry bound is always measured against live entries.
      this._cache.delete(normalizedKey);
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
   * Build a new Map containing only registry entries active at `now`.
   *
   * @param {Map<string, Object>} registry Source registry.
   * @param {number} now Evaluation time in ms.
   * @returns {Map<string, Object>} Filtered snapshot.
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
   * Drop every cached entry.
   *
   * @returns {void}
   */
  invalidateAll() {
    this._cache.clear();
  }

  /**
   * Drop a single cached entry.
   *
   * @param {string} key Cache key to remove.
   * @returns {boolean} True when an entry was removed.
   */
  invalidate(key) {
    return this._cache.delete(key);
  }

  /**
   * Number of entries currently held.
   *
   * @returns {number} Cache size.
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Clear all entries (alias of {@link ApiKeysCache#invalidateAll}).
   *
   * @returns {void}
   */
  reset() {
    this._cache.clear();
  }
}

/**
 * Validate a version identifier against the cache-key length and character
 * policy, returning a structured result instead of throwing.
 *
 * @param {*} version Candidate version string.
 * @returns {{ valid: boolean, value?: string, reason?: string }} Validation result.
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
 * @param {ApiKeysCache} [instance] Replacement instance (tests/lifecycle wiring).
 * @returns {ApiKeysCache} The active singleton.
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
