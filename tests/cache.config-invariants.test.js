'use strict';

// The repository setup loads metrics before test-file factories; clear that cached mock.
jest.resetModules();
jest.doMock('../src/metrics', () => ({
  indexerCacheHitsTotal: { inc: jest.fn() },
  indexerCacheMissesTotal: { inc: jest.fn() },
  indexerCacheEvictionsTotal: { labels: jest.fn().mockReturnValue({ inc: jest.fn() }) },
}));

const { IndexerCache } = require('../src/services/indexerCache');
const { cacheConfig } = require('../src/config/cache');

test('default indexer configuration bounds retention and expires at the TTL boundary', () => {
  let now = 100;
  const cache = new IndexerCache({ now: () => now });
  for (let i = 0; i <= cacheConfig.indexerMaxEntries; i++) {
    cache.set(String(i), { index: i });
  }
  expect(cache.size).toBe(200);
  expect(cache.get('0')).toBeUndefined();
  expect(cache.get('200')).toEqual({ index: 200 });
  cache.set('200', { index: 'updated' });
  expect(cache.size).toBe(200);
  now += cacheConfig.indexerTtl - 1;
  expect(cache.get('200')).toEqual({ index: 'updated' });
  now += 1;
  expect(cache.get('200')).toBeUndefined();
  cache.set('200', { index: 'retry' });
  expect(cache.get('200')).toEqual({ index: 'retry' });
  cache.invalidateAll();
  cache.invalidateAll();
  expect(cache.size).toBe(0);
});
