'use strict';

/**
 * Focused regression tests for the concurrency / replay hardening of
 * `src/cache/apiKeysCache.js` (issue #1265).
 *
 * The module under test is configured with an isolated loader mock so these
 * tests do not depend on the repository-wide jest setup (which is broken at the
 * base commit) or on any environment variables.
 */

jest.mock('../config/apiKeys', () => ({
  loadApiKeyRegistry: jest.fn(),
}));

jest.mock('../metrics', () => ({
  apiKeysCacheHitsTotal: { inc: jest.fn() },
  apiKeysCacheMissesTotal: { inc: jest.fn() },
}));

const { loadApiKeyRegistry } = require('../config/apiKeys');
const {
  apiKeysCacheHitsTotal,
  apiKeysCacheMissesTotal,
} = require('../metrics');
const {
  ApiKeysCache,
  getApiKeysCache,
  normalizeCacheKey,
  normalizeTimestamp,
  DEFAULT_CACHE_KEY,
  MAX_CACHE_KEY_LENGTH,
} = require('./apiKeysCache');

const T0 = 1_700_000_000_000;
const TTL_MS = 1_000;

function keyObject(overrides = {}) {
  return { clientId: 'client-1', ...overrides };
}

function registry(entries) {
  return new Map(entries);
}

beforeEach(() => {
  loadApiKeyRegistry.mockReset();
  apiKeysCacheHitsTotal.inc.mockReset();
  apiKeysCacheMissesTotal.inc.mockReset();
});

describe('getOrLoad - public shape', () => {
  it('keeps the exported public API stable', () => {
    expect(typeof ApiKeysCache).toBe('function');
    expect(typeof getApiKeysCache).toBe('function');
    expect(typeof normalizeCacheKey).toBe('function');
    expect(typeof normalizeTimestamp).toBe('function');
    expect(DEFAULT_CACHE_KEY).toBe('default');
    expect(MAX_CACHE_KEY_LENGTH).toBe(256);
  });

  it('defaults to the default cache key and the current time', () => {
    loadApiKeyRegistry.mockReturnValue(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    const snapshot = cache.getOrLoad();

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect([...snapshot.keys()]).toEqual(['k1']);
  });
});

describe('getOrLoad - idempotent under repeated and replayed calls', () => {
  it('loads once and serves the same registry on repeated calls', () => {
    loadApiKeyRegistry.mockReturnValue(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    const first = cache.getOrLoad('tenant-a', T0);
    const second = cache.getOrLoad('tenant-a', T0 + 1);
    const third = cache.getOrLoad('tenant-a', T0 + TTL_MS - 1);

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    expect([...first.keys()]).toEqual(['k1']);
    expect([...second.keys()]).toEqual(['k1']);
    expect([...third.keys()]).toEqual(['k1']);
    expect(apiKeysCacheMissesTotal.inc).toHaveBeenCalledTimes(1);
    expect(apiKeysCacheHitsTotal.inc).toHaveBeenCalledTimes(2);
  });

  it('treats a replayed call within the TTL as a hit (loader not re-run)', () => {
    loadApiKeyRegistry.mockReturnValue(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    cache.getOrLoad('tenant-a', T0);
    // A replay with a different underlying registry must not be observed until
    // the cached entry expires.
    loadApiKeyRegistry.mockReturnValue(registry([['k2', keyObject()]]));
    const replayed = cache.getOrLoad('tenant-a', T0 + 10);

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect([...replayed.keys()]).toEqual(['k1']);
  });

  it('normalizes the key once so equivalent keys share an entry', () => {
    loadApiKeyRegistry.mockReturnValue(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    cache.getOrLoad('  tenant-a  ', T0);
    const hit = cache.getOrLoad('tenant-a', T0 + 1);

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    expect([...hit.keys()]).toEqual(['k1']);
  });
});

describe('getOrLoad - concurrent callers do not double-insert', () => {
  it('loads a single time for many interleaved async callers', async () => {
    loadApiKeyRegistry.mockReturnValue(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    const snapshots = await Promise.all(
      Array.from({ length: 25 }, () =>
        Promise.resolve().then(() => cache.getOrLoad('tenant-a', T0))
      )
    );

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    for (const snapshot of snapshots) {
      expect([...snapshot.keys()]).toEqual(['k1']);
    }
  });
});

describe('getOrLoad - TTL expiry boundary', () => {
  it('is a hit just before expiry and a miss exactly at the boundary', () => {
    loadApiKeyRegistry.mockReturnValue(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    cache.getOrLoad('tenant-a', T0); // miss, expiresAt = T0 + TTL_MS
    cache.getOrLoad('tenant-a', T0 + TTL_MS - 1); // hit
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);

    cache.getOrLoad('tenant-a', T0 + TTL_MS); // expired: strict >
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
  });

  it('serves the freshly loaded registry after a replayed expiry', () => {
    loadApiKeyRegistry.mockReturnValueOnce(registry([['old', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    cache.getOrLoad('tenant-a', T0);
    loadApiKeyRegistry.mockReturnValue(registry([['new', keyObject()]]));

    const replayed = cache.getOrLoad('tenant-a', T0 + TTL_MS);

    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(2);
    expect([...replayed.keys()]).toEqual(['new']);
    expect(cache.size).toBe(1);
  });
});

describe('getOrLoad - failed / expired loads are never served', () => {
  it('does not cache anything when the loader throws on a cold miss', () => {
    loadApiKeyRegistry.mockImplementation(() => {
      throw new Error('registry unavailable');
    });
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    expect(() => cache.getOrLoad('tenant-a', T0)).toThrow('registry unavailable');
    expect(cache.size).toBe(0);
  });

  it('evicts an expired entry before loading, so a failed load leaves no stale entry', () => {
    loadApiKeyRegistry.mockReturnValueOnce(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    cache.getOrLoad('tenant-a', T0);
    expect(cache.size).toBe(1);

    loadApiKeyRegistry.mockImplementation(() => {
      throw new Error('load failed');
    });

    // At expiry the stale entry must be removed even though the reload fails.
    expect(() => cache.getOrLoad('tenant-a', T0 + TTL_MS)).toThrow('load failed');
    expect(cache.size).toBe(0);

    // A later successful load repopulates the cache cleanly.
    loadApiKeyRegistry.mockReturnValue(registry([['k2', keyObject()]]));
    const snapshot = cache.getOrLoad('tenant-a', T0 + TTL_MS + 1);
    expect([...snapshot.keys()]).toEqual(['k2']);
    expect(cache.size).toBe(1);
  });

  it('does not invoke the loader while a live entry exists', () => {
    loadApiKeyRegistry.mockReturnValue(registry([['k1', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    cache.getOrLoad('tenant-a', T0);
    loadApiKeyRegistry.mockImplementation(() => {
      throw new Error('should not run');
    });

    const snapshot = cache.getOrLoad('tenant-a', T0 + 1);
    expect([...snapshot.keys()]).toEqual(['k1']);
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(1);
  });

  it('filters inactive keys out of the returned snapshot', () => {
    const active = keyObject();
    const future = keyObject({ validFrom: T0 + 10_000 });
    const expired = keyObject({ validTo: T0 - 1 });
    loadApiKeyRegistry.mockReturnValue(
      registry([
        ['active', active],
        ['future', future],
        ['expired', expired],
      ])
    );
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    const snapshot = cache.getOrLoad('tenant-a', T0);

    expect([...snapshot.keys()]).toEqual(['active']);
  });
});

describe('getOrLoad - entry bound and eviction', () => {
  it('never exceeds maxEntries and evicts the oldest key', () => {
    loadApiKeyRegistry.mockImplementation((env) => env);
    const cache = new ApiKeysCache({ ttlMs: TTL_MS, maxEntries: 2 });

    loadApiKeyRegistry.mockReturnValueOnce(registry([['a', keyObject()]]));
    cache.getOrLoad('a', T0);
    loadApiKeyRegistry.mockReturnValueOnce(registry([['b', keyObject()]]));
    cache.getOrLoad('b', T0);
    loadApiKeyRegistry.mockReturnValueOnce(registry([['c', keyObject()]]));
    cache.getOrLoad('c', T0);

    expect(cache.size).toBe(2);

    // 'b' and 'c' remain; 'a' was evicted and will miss / reload.
    cache.getOrLoad('b', T0 + 1);
    cache.getOrLoad('c', T0 + 1);
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(3);

    loadApiKeyRegistry.mockReturnValueOnce(registry([['a', keyObject()]]));
    cache.getOrLoad('a', T0 + 2);
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(2);
  });

  it('does not evict unrelated entries when replaying the same key', () => {
    loadApiKeyRegistry.mockImplementation(() => registry([['x', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS, maxEntries: 2 });

    cache.getOrLoad('a', T0);
    cache.getOrLoad('b', T0);
    expect(cache.size).toBe(2);

    for (let i = 1; i < 5; i += 1) {
      cache.getOrLoad('a', T0 + i);
    }

    expect(cache.size).toBe(2);
    // 'b' is still cached: a hit, so no extra load.
    cache.getOrLoad('b', T0 + 5);
    expect(loadApiKeyRegistry).toHaveBeenCalledTimes(2);
  });
});

describe('getOrLoad - invalid input rejection', () => {
  const invalidKeys = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-string number', 42],
    ['null', null],
    ['object', { key: 'x' }],
    ['too long', 'k'.repeat(MAX_CACHE_KEY_LENGTH + 1)],
  ];

  it.each(invalidKeys)('rejects %s without calling the loader', (_label, key) => {
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    expect(() => cache.getOrLoad(key, T0)).toThrow(TypeError);
    expect(loadApiKeyRegistry).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it('exposes normalizeCacheKey as a strict validator', () => {
    expect(normalizeCacheKey('  tenant-a  ')).toBe('tenant-a');
    expect(() => normalizeCacheKey('')).toThrow(TypeError);
    expect(() => normalizeCacheKey(null)).toThrow(TypeError);
  });

  it('rejects a non-finite timestamp', () => {
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    expect(() => cache.getOrLoad('tenant-a', Number.NaN)).toThrow(TypeError);
    expect(() => cache.getOrLoad('tenant-a', Infinity)).toThrow(TypeError);
    expect(loadApiKeyRegistry).not.toHaveBeenCalled();
  });

  it('rejects a registry that is not a Map', () => {
    loadApiKeyRegistry.mockReturnValue({ nope: true });
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    expect(() => cache.getOrLoad('tenant-a', T0)).toThrow(
      'loader must return a Map'
    );
    expect(cache.size).toBe(0);
  });

  it('does not cache an invalid registry (validation runs before insert)', () => {
    loadApiKeyRegistry.mockReturnValue(new Map([['', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    expect(() => cache.getOrLoad('tenant-a', T0)).toThrow(TypeError);
    expect(cache.size).toBe(0);
  });
});

describe('cache maintenance helpers', () => {
  it('invalidate, invalidateAll and reset clear entries deterministically', () => {
    loadApiKeyRegistry.mockImplementation(() => registry([['x', keyObject()]]));
    const cache = new ApiKeysCache({ ttlMs: TTL_MS });

    cache.getOrLoad('a', T0);
    cache.getOrLoad('b', T0);
    expect(cache.size).toBe(2);

    expect(cache.invalidate('a')).toBe(true);
    expect(cache.invalidate('a')).toBe(false);
    expect(cache.size).toBe(1);

    cache.invalidateAll();
    expect(cache.size).toBe(0);

    cache.getOrLoad('c', T0);
    cache.reset();
    expect(cache.size).toBe(0);
  });
});
