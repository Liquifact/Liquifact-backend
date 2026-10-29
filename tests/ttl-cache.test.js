'use strict';

const { TtlCache } = require('../src/lib/ttl-cache');

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TtlCache', () => {
  test('hit within TTL and miss after TTL', async () => {
    const cache = new TtlCache();
    const loader = jest.fn().mockResolvedValue({ v: 1 });
    const a = await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 });
    expect(a.status).toBe('miss');
    expect(loader).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(500);
    const b = await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 });
    expect(b.status).toBe('hit');
    expect(loader).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    const c = await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 });
    expect(c.status).toBe('stale');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('serves stale while one background refresh runs', async () => {
    const cache = new TtlCache();
    let resolveRefresh;
    const loader = jest.fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockImplementationOnce(() => new Promise((res) => { resolveRefresh = res; }));
    await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 });
    jest.advanceTimersByTime(1500);

    const s = await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 });
    expect(s.status).toBe('stale');
    expect(s.value).toEqual({ v: 1 });
    expect(loader).toHaveBeenCalledTimes(2);

    // A second stale read must not start another refresh.
    const s2 = await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 });
    expect(s2.status).toBe('stale');
    expect(loader).toHaveBeenCalledTimes(2);

    resolveRefresh({ v: 2 });
    await Promise.resolve();
    await Promise.resolve();
    const fresh = await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 });
    expect(fresh.status).toBe('hit');
    expect(fresh.value).toEqual({ v: 2 });
  });

  test('single-flight: 10 concurrent getOrLoad -> loader called once', async () => {
    const cache = new TtlCache();
    let resolveLoader;
    const loader = jest.fn(() => new Promise((res) => { resolveLoader = res; }));
    const promises = Array.from({ length: 10 }, () =>
      cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000 }),
    );
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoader({ v: 42 });
    const results = await Promise.all(promises);
    expect(loader).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.value).toEqual({ v: 42 });
    }
  });

  test('negative caching of failures', async () => {
    const cache = new TtlCache();
    const loader = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000, errorTtlMs: 2000 })).rejects.toThrow('boom');
    await expect(cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000, errorTtlMs: 2000 })).rejects.toThrow('boom');
    expect(loader).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2500);
    loader.mockResolvedValue({ v: 'ok' });
    const r = await cache.getOrLoad('k', loader, { ttlMs: 1000, staleMs: 10000, errorTtlMs: 2000 });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(r.value).toEqual({ v: 'ok' });
  });

  test('LRU eviction bounds the cache', async () => {
    const cache = new TtlCache();
    const loader = (k) => Promise.resolve({ k: k });
    const opts = { maxEntries: 3, ttlMs: 10000, staleMs: 10000 };
    for (let i = 0; i < 5; i++) {
      await cache.getOrLoad(`key-${i}`, () => loader(`key-${i}`), opts);
    }
    expect(cache.size()).toBeLessThanOrEqual(3);
    expect(cache.size()).toBe(3);
    // Touch key-3 to make it MRU, then add another and check key-2 is evicted.
    await cache.getOrLoad('key-3', () => loader('key-3'), opts);
    await cache.getOrLoad('key-4', () => loader('key-4'), opts);
    expect(cache.size()).toBe(3);
    expect(cache.entries.has('key-2')).toBe(false);
    expect(cache.entries.has('key-3')).toBe(true);
  });
});
