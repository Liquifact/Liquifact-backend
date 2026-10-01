'use strict';

/**
 * Focused state-invariant tests for `src/cache/apiKeysCache.js` (issue #1263).
 *
 * The suite pins the cache's state contract in isolation from the registry
 * loader and metrics: exclusive TTL expiry, the `maxEntries` bound, failure
 * atomicity, key validation, deterministic duplicate overwrite, and snapshot
 * stability.
 *
 * It deliberately does not rely on the repository-wide `tests/mocks/setup.js`
 * (broken at base) — both collaborators are mocked locally here.
 */

const mockLoadApiKeyRegistry = jest.fn();
const mockHitsInc = jest.fn();
const mockMissesInc = jest.fn();

jest.mock('../config/apiKeys', () => ({
  loadApiKeyRegistry: (...args) => mockLoadApiKeyRegistry(...args),
}));

jest.mock('../metrics', () => ({
  apiKeysCacheHitsTotal: { inc: (...args) => mockHitsInc(...args) },
  apiKeysCacheMissesTotal: { inc: (...args) => mockMissesInc(...args) },
}));

const {
  ApiKeysCache,
  normalizeCacheKey,
  normalizeTimestamp,
  MAX_CACHE_KEY_LENGTH,
  MIN_MAX_ENTRIES,
} = require('./apiKeysCache');

function registry(entries) {
  return new Map(entries.map((entry) => [entry.key, entry]));
}

function activeRegistry(...keys) {
  return registry(keys.map((key) => ({ key, clientId: 'test-client' })));
}

beforeEach(() => {
  mockLoadApiKeyRegistry.mockReset();
  mockHitsInc.mockReset();
  mockMissesInc.mockReset();
});

describe('invariant: TTL never serves an expired entry', () => {
  it('serves within the TTL and reloads at the exclusive expiry boundary', () => {
    mockLoadApiKeyRegistry
      .mockReturnValueOnce(activeRegistry('lf_old'))
      .mockReturnValueOnce(activeRegistry('lf_new'));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    expect([...cache.getOrLoad('k', 0).keys()]).toEqual(['lf_old']);
    expect([...cache.getOrLoad('k', 999).keys()]).toEqual(['lf_old']);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(1);
    expect(mockHitsInc).toHaveBeenCalledTimes(1);

    // now === expiresAt is a miss: the stale registry must never be served.
    expect([...cache.getOrLoad('k', 1_000).keys()]).toEqual(['lf_new']);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(2);
    expect(mockMissesInc).toHaveBeenCalledTimes(2);
  });

  it('never serves a key outside its activity window, even on a cache hit', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce(
      registry([{ key: 'lf_a', clientId: 'a', validFrom: 0, validTo: 1_000 }]),
    );
    const cache = new ApiKeysCache({ ttlMs: 100_000, maxEntries: 10 });

    expect([...cache.getOrLoad('k', 0).keys()]).toEqual(['lf_a']);
    // Hit within the cache TTL, but the key itself has expired.
    expect(cache.getOrLoad('k', 1_000).size).toBe(0);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(1);
  });
});

describe('invariant: the maxEntries bound is never exceeded', () => {
  it('allows exactly maxEntries entries then evicts the oldest (FIFO)', () => {
    mockLoadApiKeyRegistry.mockReturnValue(activeRegistry('lf_a'));
    const cache = new ApiKeysCache({ ttlMs: 10_000, maxEntries: 2 });

    cache.getOrLoad('k1', 0);
    cache.getOrLoad('k2', 0);
    expect(cache.size).toBe(2); // exactly at the bound is allowed

    cache.getOrLoad('k3', 0);
    expect(cache.size).toBe(2);
    expect(cache.size).toBeLessThanOrEqual(cache.maxEntries);

    // k1 was the oldest; reading it again proves eviction, not just size.
    cache.getOrLoad('k1', 0);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(4);
  });

  it('never exceeds the bound when saturated with distinct keys', () => {
    mockLoadApiKeyRegistry.mockReturnValue(activeRegistry('lf_a'));
    const cache = new ApiKeysCache({ ttlMs: 10_000, maxEntries: 3 });

    for (let i = 0; i < 25; i += 1) {
      cache.getOrLoad(`k${i}`, 0);
      expect(cache.size).toBeLessThanOrEqual(cache.maxEntries);
    }
    expect(cache.size).toBe(3);
  });

  it('replacing an existing key at capacity does not evict an unrelated key', () => {
    mockLoadApiKeyRegistry.mockReturnValue(activeRegistry('lf_a'));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 2 });

    cache.getOrLoad('k1', 0); // expires at 1_000
    cache.getOrLoad('k2', 500); // expires at 1_500
    cache.getOrLoad('k1', 1_000); // expired -> reloaded, must NOT evict k2

    expect(cache.size).toBe(2);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(3);

    // k2 is still cached, so this is a hit and performs no load.
    cache.getOrLoad('k2', 1_000);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(3);
    expect(mockHitsInc).toHaveBeenCalledTimes(1);
  });

  it('clamps a below-minimum maxEntries to the documented minimum', () => {
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: -5 });
    expect(cache.maxEntries).toBe(MIN_MAX_ENTRIES);
  });
});

describe('invariant: a failed load never publishes or overwrites an entry', () => {
  it('leaves the cache empty when a cold load throws', () => {
    mockLoadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    expect(() => cache.getOrLoad('k', 0)).toThrow('registry unavailable');
    expect(cache.size).toBe(0);
    expect(mockMissesInc).toHaveBeenCalledTimes(1);

    // Recovery leaves no partial state behind.
    mockLoadApiKeyRegistry.mockReturnValueOnce(activeRegistry('lf_a'));
    expect(cache.getOrLoad('k', 0).has('lf_a')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('does not evict or overwrite existing entries when a later load throws', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce(activeRegistry('lf_a'));
    const cache = new ApiKeysCache({ ttlMs: 10_000, maxEntries: 10 });
    cache.getOrLoad('k1', 0);

    mockLoadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    expect(() => cache.getOrLoad('k2', 0)).toThrow('registry unavailable');

    expect(cache.size).toBe(1);
    expect(cache.getOrLoad('k1', 0).has('lf_a')).toBe(true);
  });

  it('does not cache a non-Map loader result', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce({ key: 'not-a-map' });
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    expect(() => cache.getOrLoad('k', 0)).toThrow(/loader must return a Map/);
    expect(cache.size).toBe(0);
  });

  it('does not publish a registry that throws while being validated', () => {
    const partial = new Map();
    partial[Symbol.iterator] = function* iteratePartially() {
      yield ['partial-key', { key: 'partial-key' }];
      throw new Error('registry iteration failed');
    };
    mockLoadApiKeyRegistry.mockReturnValueOnce(partial);
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    expect(() => cache.getOrLoad('k', 0)).toThrow('registry iteration failed');
    expect(cache.size).toBe(0);
  });

  it('preserves an expired entry across a failed reload but never serves it', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce(activeRegistry('lf_stale'));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });
    cache.getOrLoad('k', 0); // expires at 1_000

    mockLoadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    expect(() => cache.getOrLoad('k', 1_000)).toThrow('registry unavailable');
    expect(cache.size).toBe(1); // state preserved, not destroyed by the failure

    // The stale entry is still a miss and is replaced only on success.
    mockLoadApiKeyRegistry.mockReturnValueOnce(activeRegistry('lf_fresh'));
    expect(cache.getOrLoad('k', 1_000).has('lf_fresh')).toBe(true);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(3);
  });
});

describe('invariant: cache keys are validated', () => {
  it('accepts the boundary length and trims surrounding whitespace', () => {
    const maxKey = 'x'.repeat(MAX_CACHE_KEY_LENGTH);
    expect(normalizeCacheKey(maxKey)).toBe(maxKey);
    expect(normalizeCacheKey('  tenant  ')).toBe('tenant');
  });

  it('rejects non-string, empty, and over-long keys', () => {
    expect(() => normalizeCacheKey(42)).toThrow(TypeError);
    expect(() => normalizeCacheKey(null)).toThrow(/must be a string/);
    expect(() => normalizeCacheKey('')).toThrow(/must not be empty/);
    expect(() => normalizeCacheKey('   ')).toThrow(/must not be empty/);
    expect(() => normalizeCacheKey('x'.repeat(MAX_CACHE_KEY_LENGTH + 1))).toThrow(
      /must not exceed/,
    );
  });

  it('rejects invalid keys and timestamps before touching the loader or cache', () => {
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 10 });

    expect(() => cache.getOrLoad('')).toThrow(/must not be empty/);
    expect(() => cache.getOrLoad('x'.repeat(MAX_CACHE_KEY_LENGTH + 1))).toThrow(
      /must not exceed/,
    );
    expect(() => cache.getOrLoad('k', NaN)).toThrow(/finite number/);
    expect(() => normalizeTimestamp('0')).toThrow(TypeError);

    expect(mockLoadApiKeyRegistry).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });
});

describe('invariant: duplicate keys overwrite deterministically', () => {
  it('replaces the same key in place, keeping size stable and serving the latest registry', () => {
    mockLoadApiKeyRegistry
      .mockReturnValueOnce(activeRegistry('lf_v1'))
      .mockReturnValueOnce(activeRegistry('lf_v2'));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 5 });

    expect(cache.getOrLoad('k', 0).has('lf_v1')).toBe(true);
    expect(cache.getOrLoad('k', 1_000).has('lf_v2')).toBe(true);
    expect(cache.getOrLoad('k', 1_000).has('lf_v2')).toBe(true);

    expect(cache.size).toBe(1);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes equivalent keys to a single entry', () => {
    mockLoadApiKeyRegistry.mockReturnValue(activeRegistry('lf_a'));
    const cache = new ApiKeysCache({ ttlMs: 10_000, maxEntries: 5 });

    cache.getOrLoad('  tenant  ', 0);
    expect(cache.getOrLoad('tenant', 0).has('lf_a')).toBe(true);

    expect(cache.size).toBe(1);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(1);
  });

  it('preserves insertion order when overwriting, so FIFO eviction stays deterministic', () => {
    mockLoadApiKeyRegistry.mockReturnValue(activeRegistry('lf_a'));
    const cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 2 });

    cache.getOrLoad('k1', 0); // expires at 1_000
    cache.getOrLoad('k2', 500); // expires at 1_500
    cache.getOrLoad('k1', 1_000); // overwrite k1; order remains [k1, k2]
    cache.getOrLoad('k3', 0); // evicts the oldest, k1

    expect(cache.size).toBe(2);
    cache.getOrLoad('k2', 0); // still cached -> hit, no load
    expect(cache.getOrLoad('k1', 0).has('lf_a')).toBe(true); // reloaded after eviction

    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(5);
  });
});

describe('invariant: snapshots are stable and independent', () => {
  it('returns a fresh Map on every call that cannot mutate the cache', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce(activeRegistry('lf_a'));
    const cache = new ApiKeysCache({ ttlMs: 10_000, maxEntries: 5 });

    const first = cache.getOrLoad('k', 0);
    const second = cache.getOrLoad('k', 0);

    expect(first).not.toBe(second);
    expect([...first.keys()]).toEqual(['lf_a']);

    first.clear();
    expect([...cache.getOrLoad('k', 0).keys()]).toEqual(['lf_a']);
  });

  it('is deterministic for the same key and timestamp', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce(
      registry([
        { key: 'lf_a', clientId: 'a', validFrom: 0, validTo: 1_000 },
        { key: 'lf_b', clientId: 'b', validFrom: 0, validTo: 2_000 },
      ]),
    );
    const cache = new ApiKeysCache({ ttlMs: 10_000, maxEntries: 5 });

    const s1 = cache.getOrLoad('k', 500);
    const s2 = cache.getOrLoad('k', 500);
    expect([...s1.keys()]).toEqual([...s2.keys()]);
    expect([...s1.keys()]).toEqual(['lf_a', 'lf_b']);

    expect([...cache.getOrLoad('k', 1_500).keys()]).toEqual(['lf_b']);
    expect(mockLoadApiKeyRegistry).toHaveBeenCalledTimes(1);
  });
});
