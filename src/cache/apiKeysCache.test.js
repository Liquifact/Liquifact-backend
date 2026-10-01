'use strict';

/**
 * Validation-boundary tests for src/cache/apiKeysCache.js (issue #1262).
 *
 * The registry loader and metrics are mocked so that the cache's own boundary
 * logic is exercised in isolation and deterministically. Coverage maps to the
 * acceptance criteria: valid/invalid/duplicate configuration parsing, clamping
 * of explicit options, cache-key and timestamp boundaries, TTL expiry at the
 * exact boundary, duplicate-key overwrite, bounded eviction, retry safety after
 * a failed load, and idempotence of repeated parse/load.
 */

jest.mock('../config/apiKeys', () => ({ loadApiKeyRegistry: jest.fn() }));
jest.mock('../metrics', () => ({
  apiKeysCacheHitsTotal: { inc: jest.fn() },
  apiKeysCacheMissesTotal: { inc: jest.fn() },
}));

const { loadApiKeyRegistry } = require('../config/apiKeys');
const { apiKeysCacheHitsTotal, apiKeysCacheMissesTotal } = require('../metrics');

const {
  ApiKeysCache,
  parseApiKeysCacheConfig,
  normalizeCacheKey,
  normalizeTimestamp,
  validateVersion,
  isKeyActive,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  MIN_MAX_ENTRIES,
  MAX_MAX_ENTRIES,
  DEFAULT_CACHE_KEY,
  MAX_CACHE_KEY_LENGTH,
} = require('./apiKeysCache');

function registryOf(entries = [[DEFAULT_CACHE_KEY, { clientId: 'service-a' }]]) {
  return new Map(entries);
}

function loaderCalls() {
  return loadApiKeyRegistry.mock.calls.length;
}

beforeEach(() => {
  loadApiKeyRegistry.mockReset();
  loadApiKeyRegistry.mockReturnValue(registryOf());
  apiKeysCacheHitsTotal.inc.mockReset();
  apiKeysCacheMissesTotal.inc.mockReset();
});

describe('parseApiKeysCacheConfig', () => {
  it('returns the documented defaults when variables are absent', () => {
    const config = parseApiKeysCacheConfig({});
    expect(config).toEqual({ ttlMs: DEFAULT_TTL_MS, maxEntries: DEFAULT_MAX_ENTRIES });
  });

  it('treats empty and whitespace-only values as absent', () => {
    const config = parseApiKeysCacheConfig({
      API_KEYS_CACHE_TTL_MS: '',
      API_KEYS_CACHE_MAX_ENTRIES: '   ',
    });
    expect(config).toEqual({ ttlMs: DEFAULT_TTL_MS, maxEntries: DEFAULT_MAX_ENTRIES });
  });

  it('parses valid in-range values', () => {
    const config = parseApiKeysCacheConfig({
      API_KEYS_CACHE_TTL_MS: '5000',
      API_KEYS_CACHE_MAX_ENTRIES: '50',
    });
    expect(config).toEqual({ ttlMs: 5000, maxEntries: 50 });
  });

  it('accepts the inclusive MIN/MAX boundaries', () => {
    expect(
      parseApiKeysCacheConfig({
        API_KEYS_CACHE_TTL_MS: String(MIN_TTL_MS),
        API_KEYS_CACHE_MAX_ENTRIES: String(MIN_MAX_ENTRIES),
      })
    ).toEqual({ ttlMs: MIN_TTL_MS, maxEntries: MIN_MAX_ENTRIES });
    expect(
      parseApiKeysCacheConfig({
        API_KEYS_CACHE_TTL_MS: String(MAX_TTL_MS),
        API_KEYS_CACHE_MAX_ENTRIES: String(MAX_MAX_ENTRIES),
      })
    ).toEqual({ ttlMs: MAX_TTL_MS, maxEntries: MAX_MAX_ENTRIES });
  });

  it('falls back to the default for non-numeric, fractional and non-finite values', () => {
    for (const raw of ['abc', '1.5', 'NaN', 'Infinity', '0x', '1e']) {
      expect(
        parseApiKeysCacheConfig({ API_KEYS_CACHE_TTL_MS: raw, API_KEYS_CACHE_MAX_ENTRIES: raw })
      ).toEqual({ ttlMs: DEFAULT_TTL_MS, maxEntries: DEFAULT_MAX_ENTRIES });
    }
  });

  it('falls back to the default (not clamped) for out-of-range values', () => {
    expect(parseApiKeysCacheConfig({ API_KEYS_CACHE_TTL_MS: String(MIN_TTL_MS - 1) }).ttlMs).toBe(
      DEFAULT_TTL_MS
    );
    expect(parseApiKeysCacheConfig({ API_KEYS_CACHE_TTL_MS: String(MAX_TTL_MS + 1) }).ttlMs).toBe(
      DEFAULT_TTL_MS
    );
    expect(
      parseApiKeysCacheConfig({ API_KEYS_CACHE_MAX_ENTRIES: String(MIN_MAX_ENTRIES - 1) }).maxEntries
    ).toBe(DEFAULT_MAX_ENTRIES);
    expect(
      parseApiKeysCacheConfig({ API_KEYS_CACHE_MAX_ENTRIES: String(MAX_MAX_ENTRIES + 1) }).maxEntries
    ).toBe(DEFAULT_MAX_ENTRIES);
  });

  it('is idempotent for an identical environment', () => {
    const env = { API_KEYS_CACHE_TTL_MS: '5000', API_KEYS_CACHE_MAX_ENTRIES: '25' };
    expect(parseApiKeysCacheConfig(env)).toEqual(parseApiKeysCacheConfig(env));
  });
});

describe('ApiKeysCache constructor clamping', () => {
  it('clamps ttlMs to MIN_TTL_MS / MAX_TTL_MS', () => {
    expect(new ApiKeysCache({ ttlMs: MIN_TTL_MS - 1 }).ttlMs).toBe(MIN_TTL_MS);
    expect(new ApiKeysCache({ ttlMs: 0 }).ttlMs).toBe(MIN_TTL_MS);
    expect(new ApiKeysCache({ ttlMs: -1000 }).ttlMs).toBe(MIN_TTL_MS);
    expect(new ApiKeysCache({ ttlMs: MAX_TTL_MS + 1 }).ttlMs).toBe(MAX_TTL_MS);
  });

  it('keeps ttlMs at the exact bounds', () => {
    expect(new ApiKeysCache({ ttlMs: MIN_TTL_MS }).ttlMs).toBe(MIN_TTL_MS);
    expect(new ApiKeysCache({ ttlMs: MAX_TTL_MS }).ttlMs).toBe(MAX_TTL_MS);
  });

  it('clamps maxEntries to MIN_MAX_ENTRIES / MAX_MAX_ENTRIES', () => {
    expect(new ApiKeysCache({ maxEntries: MIN_MAX_ENTRIES - 1 }).maxEntries).toBe(MIN_MAX_ENTRIES);
    expect(new ApiKeysCache({ maxEntries: 0 }).maxEntries).toBe(MIN_MAX_ENTRIES);
    expect(new ApiKeysCache({ maxEntries: MAX_MAX_ENTRIES + 1 }).maxEntries).toBe(MAX_MAX_ENTRIES);
    expect(new ApiKeysCache({ maxEntries: MIN_MAX_ENTRIES }).maxEntries).toBe(MIN_MAX_ENTRIES);
    expect(new ApiKeysCache({ maxEntries: MAX_MAX_ENTRIES }).maxEntries).toBe(MAX_MAX_ENTRIES);
  });

  it('falls back to the supplied config when options are absent or non-finite', () => {
    const config = { ttlMs: 7000, maxEntries: 42 };
    expect(new ApiKeysCache({ config }).ttlMs).toBe(7000);
    expect(new ApiKeysCache({ config }).maxEntries).toBe(42);
    expect(new ApiKeysCache({ config, ttlMs: Number.NaN }).ttlMs).toBe(7000);
    expect(new ApiKeysCache({ config, maxEntries: 'nope' }).maxEntries).toBe(42);
  });
});

describe('normalizeCacheKey', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeCacheKey('  tenant-a  ')).toBe('tenant-a');
  });

  it('accepts keys up to and including MAX_CACHE_KEY_LENGTH', () => {
    const key = 'k'.repeat(MAX_CACHE_KEY_LENGTH);
    expect(normalizeCacheKey(key)).toBe(key);
    expect(normalizeCacheKey(`  ${key}  `)).toBe(key);
  });

  it('rejects non-strings, empty/whitespace and over-long keys', () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol('k')]) {
      expect(() => normalizeCacheKey(bad)).toThrow(TypeError);
    }
    expect(() => normalizeCacheKey('')).toThrow(TypeError);
    expect(() => normalizeCacheKey('   ')).toThrow(TypeError);
    expect(() => normalizeCacheKey('k'.repeat(MAX_CACHE_KEY_LENGTH + 1))).toThrow(TypeError);
  });

  it('is idempotent', () => {
    const once = normalizeCacheKey('  x.y  ');
    expect(normalizeCacheKey(once)).toBe(once);
  });
});

describe('normalizeTimestamp', () => {
  it('returns finite numbers unchanged', () => {
    expect(normalizeTimestamp(0)).toBe(0);
    expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(normalizeTimestamp(-1)).toBe(-1);
  });

  it('rejects non-numbers and non-finite numbers', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => normalizeTimestamp(bad)).toThrow(TypeError);
    }
    for (const bad of [undefined, null, '1000', {}, []]) {
      expect(() => normalizeTimestamp(bad)).toThrow(TypeError);
    }
  });
});

describe('validateVersion', () => {
  it('accepts trimmed, allow-listed versions', () => {
    expect(validateVersion('  v1.2.3-rc_1  ')).toEqual({ valid: true, value: 'v1.2.3-rc_1' });
  });

  it('enforces the MAX_CACHE_KEY_LENGTH boundary', () => {
    const max = 'a'.repeat(MAX_CACHE_KEY_LENGTH);
    expect(validateVersion(max).valid).toBe(true);
    expect(validateVersion('a'.repeat(MAX_CACHE_KEY_LENGTH + 1)).valid).toBe(false);
  });

  it('rejects non-strings, empty strings and disallowed characters', () => {
    expect(validateVersion(7).valid).toBe(false);
    expect(validateVersion('').valid).toBe(false);
    expect(validateVersion('   ').valid).toBe(false);
    expect(validateVersion('v1/2').valid).toBe(false);
  });
});

describe('isKeyActive', () => {
  it('honours the half-open [start, end) window', () => {
    const key = { validFrom: 100, validTo: 200 };
    expect(isKeyActive(key, 99)).toBe(false);
    expect(isKeyActive(key, 100)).toBe(true);
    expect(isKeyActive(key, 199)).toBe(true);
    expect(isKeyActive(key, 200)).toBe(false);
  });

  it('supports alias fields and defaults to an open window', () => {
    expect(isKeyActive({ notBefore: 100 }, 150)).toBe(true);
    expect(isKeyActive({ notAfter: 200 }, 150)).toBe(true);
    expect(isKeyActive({ activatedAt: 100, expiresAt: 200 }, 150)).toBe(true);
    expect(isKeyActive({}, 0)).toBe(true);
  });

  it('rejects non-object records', () => {
    for (const bad of [null, undefined, 42, 'key']) {
      expect(isKeyActive(bad, 0)).toBe(false);
    }
  });
});

describe('ApiKeysCache.getOrLoad validation boundaries', () => {
  it('loads on miss, then serves within the TTL from cache', () => {
    const cache = new ApiKeysCache({ ttlMs: 1000 });
    const first = cache.getOrLoad(DEFAULT_CACHE_KEY, 0);
    expect(loaderCalls()).toBe(1);
    expect(cache.size).toBe(1);

    for (let i = 1; i < 5; i += 1) {
      expect(cache.getOrLoad(DEFAULT_CACHE_KEY, i)).toEqual(first);
    }
    expect(loaderCalls()).toBe(1);
  });

  it('treats now === expiresAt as expired and reloads (just-before/at/after)', () => {
    const cache = new ApiKeysCache({ ttlMs: 1000 });
    cache.getOrLoad(DEFAULT_CACHE_KEY, 1000);
    expect(loaderCalls()).toBe(1);

    cache.getOrLoad(DEFAULT_CACHE_KEY, 1999);
    expect(loaderCalls()).toBe(1);

    cache.getOrLoad(DEFAULT_CACHE_KEY, 2000);
    expect(loaderCalls()).toBe(2);

    cache.getOrLoad(DEFAULT_CACHE_KEY, 2001);
    expect(loaderCalls()).toBe(2);
  });

  it('trims cache keys so whitespace variants collapse onto one entry', () => {
    const cache = new ApiKeysCache();
    const first = cache.getOrLoad('  tenant-a  ', 0);
    const second = cache.getOrLoad('tenant-a', 1);
    expect(second).toEqual(first);
    expect(loaderCalls()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('accepts a key of exactly MAX_CACHE_KEY_LENGTH and rejects MAX+1 before loading', () => {
    const cache = new ApiKeysCache();
    expect(() => cache.getOrLoad('k'.repeat(MAX_CACHE_KEY_LENGTH), 0)).not.toThrow();
    expect(loaderCalls()).toBe(1);

    expect(() => cache.getOrLoad('k'.repeat(MAX_CACHE_KEY_LENGTH + 1), 0)).toThrow(TypeError);
    expect(() => cache.getOrLoad('', 0)).toThrow(TypeError);
    expect(() => cache.getOrLoad('   ', 0)).toThrow(TypeError);
    expect(() => cache.getOrLoad(42, 0)).toThrow(TypeError);
    expect(loaderCalls()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('rejects a non-finite timestamp before loading and defaults now when absent', () => {
    const cache = new ApiKeysCache();
    expect(() => cache.getOrLoad(DEFAULT_CACHE_KEY, Number.NaN)).toThrow(TypeError);
    expect(() => cache.getOrLoad(DEFAULT_CACHE_KEY, Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(loaderCalls()).toBe(0);

    expect(cache.getOrLoad()).toBeInstanceOf(Map);
    expect(loaderCalls()).toBe(1);
  });

  it('only includes keys active at the supplied time', () => {
    loadApiKeyRegistry.mockReturnValue(
      new Map([
        ['active', { validFrom: 0, validTo: 1000 }],
        ['future', { validFrom: 500 }],
        ['expired', { validTo: 10 }],
      ])
    );
    const cache = new ApiKeysCache();
    const snapshot = cache.getOrLoad(DEFAULT_CACHE_KEY, 100);
    expect([...snapshot.keys()]).toEqual(['active']);
  });
});

describe('ApiKeysCache duplicate-key and eviction semantics', () => {
  it('overwrites the cached registry for a duplicate key after expiry', () => {
    const cache = new ApiKeysCache({ ttlMs: 1000 });
    loadApiKeyRegistry.mockReturnValueOnce(new Map([['k1', { v: 1 }]]));
    expect([...cache.getOrLoad('dup', 0).keys()]).toEqual(['k1']);
    expect(cache.size).toBe(1);

    loadApiKeyRegistry.mockReturnValueOnce(new Map([['k2', { v: 2 }]]));
    expect([...cache.getOrLoad('dup', 1000).keys()]).toEqual(['k2']);
    expect(cache.size).toBe(1);
    expect(loaderCalls()).toBe(2);
  });

  it('evicts the oldest entry only when a new key exceeds maxEntries', () => {
    const cache = new ApiKeysCache({ maxEntries: 2 });
    cache.getOrLoad('a', 0);
    cache.getOrLoad('b', 0);
    cache.getOrLoad('c', 0);
    expect(cache.size).toBe(2);

    const before = loaderCalls();
    cache.getOrLoad('b', 0);
    expect(loaderCalls()).toBe(before);
    cache.getOrLoad('a', 0);
    expect(loaderCalls()).toBe(before + 1);
  });

  it('does not evict a sibling when reloading an expired existing key', () => {
    const cache = new ApiKeysCache({ ttlMs: 1000, maxEntries: 2 });
    cache.getOrLoad('a', 0);
    cache.getOrLoad('b', 0);
    cache.getOrLoad('a', 1000);
    expect(cache.size).toBe(2);
    const before = loaderCalls();
    cache.getOrLoad('b', 999);
    expect(loaderCalls()).toBe(before);
  });

  it('invalidate removes a single entry and invalidateAll clears the cache', () => {
    const cache = new ApiKeysCache();
    cache.getOrLoad('a', 0);
    expect(cache.invalidate('a')).toBe(true);
    expect(cache.invalidate('a')).toBe(false);
    cache.getOrLoad('a', 1);
    cache.getOrLoad('b', 1);
    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });
});

describe('ApiKeysCache concurrency and retry safety', () => {
  it('does not cache a failed load and retries on the next call', () => {
    const cache = new ApiKeysCache({ ttlMs: 1000 });
    loadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    expect(() => cache.getOrLoad(DEFAULT_CACHE_KEY, 0)).toThrow('registry unavailable');
    expect(cache.size).toBe(0);

    loadApiKeyRegistry.mockReturnValueOnce(registryOf([['recovered', { clientId: 'a' }]]));
    const snapshot = cache.getOrLoad(DEFAULT_CACHE_KEY, 0);
    expect(loaderCalls()).toBe(2);
    expect([...snapshot.keys()]).toEqual(['recovered']);
  });

  it('evicts an expired entry before a failing reload so stale data is never served', () => {
    const cache = new ApiKeysCache({ ttlMs: 1000 });
    cache.getOrLoad(DEFAULT_CACHE_KEY, 0);
    expect(cache.size).toBe(1);

    loadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    expect(() => cache.getOrLoad(DEFAULT_CACHE_KEY, 1000)).toThrow('registry unavailable');
    expect(cache.size).toBe(0);
  });

  it('rejects an invalid registry without caching it', () => {
    const cache = new ApiKeysCache();
    loadApiKeyRegistry.mockReturnValueOnce({});
    expect(() => cache.getOrLoad(DEFAULT_CACHE_KEY, 0)).toThrow(TypeError);
    expect(cache.size).toBe(0);

    loadApiKeyRegistry.mockReturnValueOnce(new Map([[7, { clientId: 'a' }]]));
    expect(() => cache.getOrLoad(DEFAULT_CACHE_KEY, 0)).toThrow(TypeError);
    expect(cache.size).toBe(0);

    loadApiKeyRegistry.mockReturnValueOnce(new Map([['ok', 'not-an-object']]));
    expect(() => cache.getOrLoad(DEFAULT_CACHE_KEY, 0)).toThrow(TypeError);
    expect(cache.size).toBe(0);
  });

  it('records a miss on load and a hit while the entry is fresh', () => {
    const cache = new ApiKeysCache({ ttlMs: 1000 });
    cache.getOrLoad(DEFAULT_CACHE_KEY, 0);
    cache.getOrLoad(DEFAULT_CACHE_KEY, 1);
    cache.getOrLoad(DEFAULT_CACHE_KEY, 2);
    expect(apiKeysCacheMissesTotal.inc).toHaveBeenCalledTimes(1);
    expect(apiKeysCacheHitsTotal.inc).toHaveBeenCalledTimes(2);
  });
});
