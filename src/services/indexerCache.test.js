'use strict';

const {
  indexerCacheHitsTotal,
  indexerCacheMissesTotal,
  indexerCacheEvictionsTotal,
} = require('../metrics');
const { IndexerCache } = require('./indexerCache');

describe('IndexerCache', () => {
  let clock;
  let cache;

  beforeEach(() => {
    clock = 1000;
    cache = new IndexerCache({
      ttlMs: 100,
      maxEntries: 3,
      now: () => clock,
    });
    jest.spyOn(indexerCacheHitsTotal, 'inc').mockImplementation(() => {});
    jest.spyOn(indexerCacheMissesTotal, 'inc').mockImplementation(() => {});
    jest.spyOn(indexerCacheEvictionsTotal, 'labels').mockReturnValue({ inc: jest.fn() });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── buildKey ─────────────────────────────────────────────────────────────

  describe('buildKey', () => {
    test('produces deterministic key for same params', () => {
      const a = IndexerCache.buildKey({ filters: { invoiceId: 'inv-1' }, sorting: {}, pagination: { limit: 10 } });
      const b = IndexerCache.buildKey({ filters: { invoiceId: 'inv-1' }, sorting: {}, pagination: { limit: 10 } });
      expect(a).toBe(b);
    });

    test('different filters produce different keys', () => {
      const a = IndexerCache.buildKey({ filters: { invoiceId: 'inv-1' } });
      const b = IndexerCache.buildKey({ filters: { invoiceId: 'inv-2' } });
      expect(a).not.toBe(b);
    });

    test('different sorting produces different keys', () => {
      const a = IndexerCache.buildKey({ sorting: { sortBy: 'observed_at', order: 'desc' } });
      const b = IndexerCache.buildKey({ sorting: { sortBy: 'ledger_sequence', order: 'asc' } });
      expect(a).not.toBe(b);
    });

    test('different limits produce different keys', () => {
      const a = IndexerCache.buildKey({ pagination: { limit: 10 } });
      const b = IndexerCache.buildKey({ pagination: { limit: 20 } });
      expect(a).not.toBe(b);
    });

    test('different cursors produce different keys', () => {
      const a = IndexerCache.buildKey({ pagination: { cursor: 'abc', limit: 10 } });
      const b = IndexerCache.buildKey({ pagination: { cursor: 'xyz', limit: 10 } });
      expect(a).not.toBe(b);
    });

    test('different pages produce different keys', () => {
      const a = IndexerCache.buildKey({ pagination: { page: 1, limit: 10 } });
      const b = IndexerCache.buildKey({ pagination: { page: 2, limit: 10 } });
      expect(a).not.toBe(b);
    });

    test('defaults sorting to observed_at desc and limit to 20', () => {
      const key = IndexerCache.buildKey({});
      const parsed = JSON.parse(key);
      expect(parsed.sorting).toEqual({ sortBy: 'observed_at', order: 'desc' });
      expect(parsed.limit).toBe(20);
    });

    test('cursor takes precedence over page in key', () => {
      const withCursor = IndexerCache.buildKey({ pagination: { cursor: 'abc', page: 5, limit: 10 } });
      const parsed = JSON.parse(withCursor);
      expect(parsed.cursor).toBe('abc');
      expect(parsed.page).toBeUndefined();
    });
  });

  // ── get / set (miss → hit) ───────────────────────────────────────────────

  describe('get and set', () => {
    test('returns undefined on cold miss', () => {
      expect(cache.get('key-1')).toBeUndefined();
      expect(indexerCacheMissesTotal.inc).toHaveBeenCalledTimes(1);
    });

    test('returns cached value on hit after set', () => {
      cache.set('key-1', { data: [1, 2], meta: { total: 2 } });
      expect(cache.get('key-1')).toEqual({ data: [1, 2], meta: { total: 2 } });
      expect(indexerCacheHitsTotal.inc).toHaveBeenCalledTimes(1);
    });

    test('get refreshes recency (LRU)', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Access 'a' to refresh its recency
      cache.get('a');
      // Insert a 4th entry — should evict 'b' (oldest unaccessed)
      cache.set('d', 4);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });
  });

  // ── TTL expiry ───────────────────────────────────────────────────────────

  describe('TTL expiry', () => {
    test('returns undefined after TTL expires', () => {
      cache.set('key-1', { data: [] });
      clock += 100;
      expect(cache.get('key-1')).toBeUndefined();
      expect(indexerCacheEvictionsTotal.labels).toHaveBeenCalledWith('expired');
    });

    test('returns value before TTL expires', () => {
      cache.set('key-1', { data: [] });
      clock += 99;
      expect(cache.get('key-1')).toEqual({ data: [] });
    });
  });

  // ── capacity eviction ────────────────────────────────────────────────────

  describe('capacity eviction', () => {
    test('evicts oldest entry when maxEntries exceeded', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // should evict 'a'
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(indexerCacheEvictionsTotal.labels).toHaveBeenCalledWith('capacity');
    });

    test('replacing an existing key does not count toward capacity', () => {
      let clock = 0;
      const smallCache = new IndexerCache({
        ttlMs: 60000,
        maxEntries: 2,
        now: () => clock,
      });
      smallCache.set('a', 1);
      smallCache.set('a', 2);
      smallCache.set('b', 3);
      // Only 2 unique keys, no eviction
      expect(smallCache.size).toBe(2);
      expect(smallCache.get('a')).toBe(2);
      expect(smallCache.get('b')).toBe(3);
    });
  });

  // ── invalidateAll ────────────────────────────────────────────────────────

  describe('invalidateAll', () => {
    test('clears all entries', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.invalidateAll();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });

    test('works on empty cache', () => {
      expect(() => cache.invalidateAll()).not.toThrow();
      expect(cache.size).toBe(0);
    });
  });

  // ── size getter ──────────────────────────────────────────────────────────

  describe('size', () => {
    test('reflects current entry count', () => {
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
      cache.invalidateAll();
      expect(cache.size).toBe(0);
    });
  });
});
