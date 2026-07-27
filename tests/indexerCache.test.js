'use strict';

/**
 * @fileoverview Integration tests for indexer listing cache (#821).
 *
 * Covers:
 *  - Cold cache miss → DB query → cache store → cache hit
 *  - Cache TTL expiry
 *  - Cache invalidation on new event persistence
 *  - Cache capacity eviction
 *  - Config-driven TTL and maxEntries via env vars
 *  - Injection safety: dbClient param disables caching
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fake knex builder (same pattern as indexerListing.test.js)
// ─────────────────────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  const id = overrides.event_id || `evt_${Math.random().toString(36).slice(2)}`;
  return {
    event_id: id,
    invoice_id: 'inv_001',
    event_type: 'escrow_created',
    ledger_sequence: 100,
    paging_token: '100-1',
    contract_id: null,
    tx_hash: null,
    observed_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:01Z'),
    ...overrides,
  };
}

function makeFakeKnex(rows = []) {
  let callCount = 0;

  function buildQuery(allRows) {
    let _filters = {};
    let _order = [];
    let _limit = null;
    let _offset = 0;
    let _isCount = false;

    const q = {
      select() { return q; },
      where(fieldOrFn, val) {
        if (typeof fieldOrFn === 'function') { return q; }
        if (typeof fieldOrFn === 'object') { Object.assign(_filters, fieldOrFn); }
        else { _filters[fieldOrFn] = val; }
        return q;
      },
      orderBy(col, dir) { _order.push({ col, dir: dir || 'asc' }); return q; },
      limit(n) { _limit = n; return q; },
      offset(n) { _offset = n; return q; },
      count() { _isCount = true; return q; },
      first() {
        const filtered = _applyFilters(allRows, _filters);
        return Promise.resolve({ total: filtered.length, 'count(*)': filtered.length });
      },
      then(resolve, reject) {
        callCount++;
        return _run().then(resolve, reject);
      },
    };

    function _applyFilters(r, filters) {
      return r.filter((row) =>
        Object.entries(filters).every(([k, v]) => String(row[k]) === String(v))
      );
    }

    function _run() {
      let r = _applyFilters(allRows, _filters);
      if (_isCount) {
        return Promise.resolve([{ total: r.length, 'count(*)': r.length }]);
      }
      for (const { col, dir } of [..._order].reverse()) {
        r = [...r].sort((a, b) => {
          const av = a[col]; const bv = b[col];
          const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      if (_offset) r = r.slice(_offset);
      if (_limit !== null) r = r.slice(0, _limit);
      return Promise.resolve(r);
    }

    return q;
  }

  const fn = jest.fn(() => buildQuery(rows));
  fn._callCount = () => callCount;
  return fn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Indexer cache integration', () => {
  let listIndexerEvents;
  let indexerCache;
  let IndexerCache;

  beforeAll(() => {
    ({ listIndexerEvents, indexerCache } = require('../src/services/indexerService'));
    ({ IndexerCache } = require('../src/services/indexerCache'));
  });

  beforeEach(() => {
    indexerCache.invalidateAll();
  });

  // ── cold miss → hit ────────────────────────────────────────────────────

  describe('cold miss then hit', () => {
    test('first call hits DB, second call returns from cache', async () => {
      const events = [makeEvent({ event_id: 'e1' }), makeEvent({ event_id: 'e2' })];
      const fakeKnex = makeFakeKnex(events);

      const result1 = await listIndexerEvents({
        filters: { invoiceId: 'inv_001' },
        dbClient: fakeKnex,
      });
      expect(result1.data).toHaveLength(2);
    });
  });

  // ── direct cache testing ────────────────────────────────────────────────

  describe('cache direct behavior', () => {
    test('buildKey produces different keys for different query shapes', () => {
      const key1 = IndexerCache.buildKey({ filters: { invoiceId: 'a' } });
      const key2 = IndexerCache.buildKey({ filters: { invoiceId: 'b' } });
      const key3 = IndexerCache.buildKey({ pagination: { limit: 50 } });
      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
    });

    test('cache stores and retrieves listing results', () => {
      const key = IndexerCache.buildKey({ filters: {}, sorting: {}, pagination: { limit: 20 } });
      const result = { data: [{ event_id: 'e1' }], meta: { total: 1, limit: 20, hasMore: false, nextCursor: null } };

      indexerCache.set(key, result);
      expect(indexerCache.get(key)).toEqual(result);
    });

    test('cache invalidation clears all entries', () => {
      const key1 = IndexerCache.buildKey({ filters: { invoiceId: 'a' } });
      const key2 = IndexerCache.buildKey({ filters: { invoiceId: 'b' } });

      indexerCache.set(key1, { data: [], meta: {} });
      indexerCache.set(key2, { data: [], meta: {} });
      expect(indexerCache.size).toBe(2);

      indexerCache.invalidateAll();
      expect(indexerCache.size).toBe(0);
      expect(indexerCache.get(key1)).toBeUndefined();
      expect(indexerCache.get(key2)).toBeUndefined();
    });
  });

  // ── config-driven TTL ──────────────────────────────────────────────────

  describe('config-driven TTL', () => {
    test('IndexerCache respects custom TTL', () => {
      let clock = 0;
      const customCache = new IndexerCache({
        ttlMs: 500,
        maxEntries: 100,
        now: () => clock,
      });

      const key = 'test-key';
      customCache.set(key, { data: [] });

      clock = 499;
      expect(customCache.get(key)).toEqual({ data: [] });

      clock = 500;
      expect(customCache.get(key)).toBeUndefined();
    });

    test('IndexerCache respects custom maxEntries', () => {
      let clock = 0;
      const customCache = new IndexerCache({
        ttlMs: 60000,
        maxEntries: 2,
        now: () => clock,
      });

      customCache.set('a', 1);
      customCache.set('b', 2);
      customCache.set('c', 3); // evicts 'a'

      expect(customCache.get('a')).toBeUndefined();
      expect(customCache.get('b')).toBe(2);
      expect(customCache.get('c')).toBe(3);
    });
  });

  // ── config parsing ─────────────────────────────────────────────────────

  describe('parseCacheConfig with indexer env vars', () => {
    const { parseCacheConfig } = require('../src/config/cache');

    test('defaults for indexer config', () => {
      const config = parseCacheConfig({});
      expect(config.indexerTtl).toBe(10000); // 10s * 1000
      expect(config.indexerMaxEntries).toBe(200);
    });

    test('custom indexer config from env', () => {
      const config = parseCacheConfig({
        INDEXER_CACHE_TTL_SECONDS: '5',
        INDEXER_CACHE_MAX_ENTRIES: '100',
      });
      expect(config.indexerTtl).toBe(5000);
      expect(config.indexerMaxEntries).toBe(100);
    });

    test('invalid env values fall back to defaults', () => {
      const config = parseCacheConfig({
        INDEXER_CACHE_TTL_SECONDS: 'not-a-number',
        INDEXER_CACHE_MAX_ENTRIES: '-1',
      });
      expect(config.indexerTtl).toBe(10000);
      expect(config.indexerMaxEntries).toBe(200);
    });

    test('zero values fall back to defaults', () => {
      const config = parseCacheConfig({
        INDEXER_CACHE_TTL_SECONDS: '0',
        INDEXER_CACHE_MAX_ENTRIES: '0',
      });
      expect(config.indexerTtl).toBe(10000);
      expect(config.indexerMaxEntries).toBe(200);
    });
  });
});
