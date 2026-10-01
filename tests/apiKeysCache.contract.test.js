'use strict';

/**
 * Contract tests for `src/cache/apiKeysCache.js` (issue #1266).
 *
 * The cache sits in front of the API-key registry that every authenticated
 * request reads, so its *public contract* — the exports, the TTL/eviction
 * bounds, the activity-window semantics, and how failures propagate — must not
 * drift silently. These tests pin that contract:
 *
 *  - config parsing: defaults, clamping to the documented MIN/MAX, bad input
 *  - `isKeyActive`: naming conventions, half-open window boundaries, junk input
 *  - `getOrLoad`: hit/miss, TTL expiry (exclusive), activity filtering, empty
 *    registry, named keys, FIFO eviction at `maxEntries`
 *  - failure: a throwing loader must not be cached (no poisoned entry)
 *  - invalidation + the `getApiKeysCache` singleton/injection behaviour
 *  - the module still works when the optional metrics counters are absent
 *
 * The registry loader and metrics are mocked so nothing touches `process.env`
 * or the real metric registry.
 */

jest.mock('../src/config/apiKeys', () => ({
  loadApiKeyRegistry: jest.fn(),
}));

// NOTE: `tests/mocks/setup.js` already registers the shared `src/metrics` mock
// (now including the api-keys cache counters), so this file uses that rather
// than re-registering its own factory, which the setup mock would shadow.

const { loadApiKeyRegistry } = require('../src/config/apiKeys');
const {
  apiKeysCacheHitsTotal,
  apiKeysCacheMissesTotal,
} = require('../src/metrics');
const {
  ApiKeysCache,
  getApiKeysCache,
  parseApiKeysCacheConfig,
  isKeyActive,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  MIN_MAX_ENTRIES,
  MAX_MAX_ENTRIES,
} = require('../src/cache/apiKeysCache');

const registry = (entries) => new Map(entries.map((e) => [e.key, e]));

beforeEach(() => {
  loadApiKeyRegistry.mockReset();
  apiKeysCacheHitsTotal.inc.mockClear();
  apiKeysCacheMissesTotal.inc.mockClear();
});

describe('parseApiKeysCacheConfig', () => {
  it('falls back to the documented defaults for an empty env', () => {
    expect(parseApiKeysCacheConfig({})).toEqual({
      ttlMs: DEFAULT_TTL_MS,
      maxEntries: DEFAULT_MAX_ENTRIES,
    });
  });

  it('parses valid values', () => {
    expect(
      parseApiKeysCacheConfig({ API_KEYS_CACHE_TTL_MS: '45000', API_KEYS_CACHE_MAX_ENTRIES: '250' })
    ).toEqual({ ttlMs: 45000, maxEntries: 250 });
  });

  it('clamps below the minimum and above the maximum', () => {
    expect(
      parseApiKeysCacheConfig({ API_KEYS_CACHE_TTL_MS: '1', API_KEYS_CACHE_MAX_ENTRIES: '0' })
    ).toEqual({ ttlMs: MIN_TTL_MS, maxEntries: MIN_MAX_ENTRIES });
    expect(
      parseApiKeysCacheConfig({
        API_KEYS_CACHE_TTL_MS: '999999999',
        API_KEYS_CACHE_MAX_ENTRIES: '999999999',
      })
    ).toEqual({ ttlMs: MAX_TTL_MS, maxEntries: MAX_MAX_ENTRIES });
  });

  it('accepts the exact MIN/MAX boundary values', () => {
    expect(
      parseApiKeysCacheConfig({
        API_KEYS_CACHE_TTL_MS: String(MIN_TTL_MS),
        API_KEYS_CACHE_MAX_ENTRIES: String(MAX_MAX_ENTRIES),
      })
    ).toEqual({ ttlMs: MIN_TTL_MS, maxEntries: MAX_MAX_ENTRIES });
  });

  it('falls back for non-numeric input (contract: garbage never widens the bounds)', () => {
    expect(
      parseApiKeysCacheConfig({ API_KEYS_CACHE_TTL_MS: 'abc', API_KEYS_CACHE_MAX_ENTRIES: 'NaN' })
    ).toEqual({ ttlMs: DEFAULT_TTL_MS, maxEntries: DEFAULT_MAX_ENTRIES });
  });
});

describe('isKeyActive', () => {
  const now = 1_000;

  it('treats the window as half-open [start, end)', () => {
    const key = { validFrom: 1_000, validTo: 2_000 };
    expect(isKeyActive(key, 999)).toBe(false);
    expect(isKeyActive(key, 1_000)).toBe(true); // start inclusive
    expect(isKeyActive(key, 1_999)).toBe(true);
    expect(isKeyActive(key, 2_000)).toBe(false); // end exclusive
  });

  it('supports the alternate naming conventions', () => {
    expect(isKeyActive({ notBefore: 500, notAfter: 1_500 }, now)).toBe(true);
    expect(isKeyActive({ activatedAt: 500, expiresAt: 1_500 }, now)).toBe(true);
    expect(isKeyActive({ activatedAt: 2_000 }, now)).toBe(false);
  });

  it('treats missing bounds as an open interval', () => {
    expect(isKeyActive({}, now)).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(isKeyActive(undefined, now)).toBe(false);
    expect(isKeyActive(null, now)).toBe(false);
    expect(isKeyActive('lf_abc', now)).toBe(false);
    expect(isKeyActive(42, now)).toBe(false);
  });
});

describe('ApiKeysCache.getOrLoad', () => {
  it('misses, loads the registry, and returns only the active keys', () => {
    loadApiKeyRegistry.mockReturnValue(
      registry([
        { key: 'lf_active', clientId: 'a', validFrom: 0, validTo: 10_000 },
        { key: 'lf_future', clientId: 'b', validFrom: 5_000, validTo: 10_000 },
        { key: 'lf_expired', clientId: 'c', validFrom: 0, validTo: 100 },
      ])
    );
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    const snapshot = cache.getOrLoad('default', 1_000);

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect([...snapshot.keys()]).toEqual(['lf_active']);
    expect(apiKeysCacheMissesTotal.inc).toHaveBeenCalledTimes(1);
    expect(apiKeysCacheHitsTotal.inc).not.toHaveBeenCalled();
  });

  it('serves a hit within the TTL without reloading, and counts the hit', () => {
    loadApiKeyRegistry.mockReturnValue(registry([{ key: 'lf_a', clientId: 'a' }]));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    cache.getOrLoad('default', 0);
    const second = cache.getOrLoad('default', 500);

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect(second.has('lf_a')).toBe(true);
    expect(apiKeysCacheHitsTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('reloads once the TTL has expired (expiry is exclusive)', () => {
    loadApiKeyRegistry.mockReturnValue(registry([{ key: 'lf_a', clientId: 'a' }]));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    cache.getOrLoad('default', 0); // expiresAt = 1000
    cache.getOrLoad('default', 1_000); // now === expiresAt → miss

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(2);
    expect(apiKeysCacheMissesTotal.inc).toHaveBeenCalledTimes(2);
  });

  it('returns an empty snapshot for an empty registry', () => {
    loadApiKeyRegistry.mockReturnValue(new Map());
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });
    expect(cache.getOrLoad('default', 0).size).toBe(0);
  });

  it('keeps named keys independent', () => {
    loadApiKeyRegistry.mockReturnValue(registry([{ key: 'lf_a', clientId: 'a' }]));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    cache.getOrLoad('tenant-1', 0);
    cache.getOrLoad('tenant-2', 0);

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it('evicts in insertion order (FIFO) once maxEntries is reached', () => {
    loadApiKeyRegistry.mockReturnValue(registry([{ key: 'lf_a', clientId: 'a' }]));
    const cache = new ApiKeysCache({ ttlMs: 10_000, maxEntries: 2 });

    cache.getOrLoad('k1', 0);
    cache.getOrLoad('k2', 0);
    cache.getOrLoad('k3', 0); // size (2) >= max → evicts the oldest (k1)

    expect(cache.size).toBe(2);
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(3);

    // k1 was evicted, so reading it again is a miss (proves eviction, not just size).
    cache.getOrLoad('k1', 0);
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(4);
  });

  it('clamps constructor options to the documented bounds', () => {
    const tooSmall = new ApiKeysCache({ ttlMs: -5, maxEntries: -5 });
    expect(tooSmall.ttlMs).toBe(MIN_TTL_MS);
    expect(tooSmall.maxEntries).toBe(MIN_MAX_ENTRIES);

    const tooLarge = new ApiKeysCache({ ttlMs: 10_000_000, maxEntries: 10_000_000 });
    expect(tooLarge.ttlMs).toBe(MAX_TTL_MS);
    expect(tooLarge.maxEntries).toBe(MAX_MAX_ENTRIES);
  });

  it('treats a falsy option (0) as "use the config default", not the minimum', () => {
    // Contract: `options.x || config.x` means 0 falls through to the parsed
    // config (which defaults to the DEFAULT_* value), where it is then clamped.
    const config = parseApiKeysCacheConfig();
    const cache = new ApiKeysCache({ ttlMs: 0, maxEntries: 0 });
    expect(cache.ttlMs).toBe(config.ttlMs);
    expect(cache.maxEntries).toBe(config.maxEntries);
  });

  it('does not cache a poisoned entry when the loader throws', () => {
    loadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('API_KEYS: duplicate key detected');
    });

    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });
    expect(() => cache.getOrLoad('default', 0)).toThrow(/duplicate key/);
    expect(cache.size).toBe(0);
    expect(apiKeysCacheMissesTotal.inc).toHaveBeenCalledTimes(1);

    // A subsequent successful load works — the failure left no partial state.
    loadApiKeyRegistry.mockReturnValue(registry([{ key: 'lf_a', clientId: 'a' }]));
    expect(cache.getOrLoad('default', 0).has('lf_a')).toBe(true);
  });
});

describe('ApiKeysCache invalidation', () => {
  it('invalidate(key), invalidateAll() and reset() clear entries; size reflects it', () => {
    loadApiKeyRegistry.mockReturnValue(registry([{ key: 'lf_a', clientId: 'a' }]));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    cache.getOrLoad('k1', 0);
    cache.getOrLoad('k2', 0);
    expect(cache.size).toBe(2);

    cache.invalidate('k1');
    expect(cache.size).toBe(1);

    cache.invalidateAll();
    expect(cache.size).toBe(0);

    cache.getOrLoad('k1', 0);
    cache.reset();
    expect(cache.size).toBe(0);
  });
});

describe('getApiKeysCache', () => {
  it('returns a stable singleton across calls', () => {
    const a = getApiKeysCache();
    const b = getApiKeysCache();
    expect(a).toBeInstanceOf(ApiKeysCache);
    expect(a).toBe(b);
  });

  it('accepts an injected instance and returns it thereafter', () => {
    const injected = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 5 });
    expect(getApiKeysCache(injected)).toBe(injected);
    expect(getApiKeysCache()).toBe(injected);
  });
});
