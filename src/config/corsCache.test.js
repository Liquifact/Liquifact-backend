/**
 * @fileoverview Unit tests for src/config/corsCache.js.
 *
 * Covers: config parsing, LRU eviction, TTL expiry, metrics emission,
 * invalidation, and edge cases.
 *
 * @jest-environment node
 */

'use strict';

const {
  corsCacheHitsTotal,
  corsCacheMissesTotal,
  corsCacheEvictionsTotal,
  corsCacheInvalidationsTotal,
} = require('../metrics');

function resetMetricCounter(counter) {
  if (counter && typeof counter.reset === 'function') {
    counter.reset();
  }
}

function getCounterValue(counter) {
  return Object.values(counter.hashMap).reduce((sum, entry) => sum + entry.value, 0);
}

describe('corsCache', () => {
  let OLD_ENV;

  beforeAll(() => {
    OLD_ENV = { ...process.env };
  });

  beforeEach(() => {
    delete process.env.CORS_CACHE_TTL_SECONDS;
    delete process.env.CORS_CACHE_MAX_ENTRIES;
    resetMetricCounter(corsCacheHitsTotal);
    resetMetricCounter(corsCacheMissesTotal);
    resetMetricCounter(corsCacheEvictionsTotal);
    resetMetricCounter(corsCacheInvalidationsTotal);
  });

  afterAll(() => {
    process.env = { ...OLD_ENV };
  });

  // ─── parseCorsCacheConfig ──────────────────────────────────────────────

  describe('parseCorsCacheConfig', () => {
    it('returns defaults when env vars are absent', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      const cfg = parseCorsCacheConfig({});
      expect(cfg.ttlMs).toBe(5000);
      expect(cfg.maxEntries).toBe(256);
    });

    it('uses env-provided values when valid', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      const cfg = parseCorsCacheConfig({
        CORS_CACHE_TTL_SECONDS: '10',
        CORS_CACHE_MAX_ENTRIES: '512',
      });
      expect(cfg.ttlMs).toBe(10000);
      expect(cfg.maxEntries).toBe(512);
    });

    it('clamps TTL to MIN_TTL_SECONDS when too low', () => {
      const { parseCorsCacheConfig, MIN_TTL_SECONDS } = require('./corsCache');
      const cfg = parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '0' });
      expect(cfg.ttlMs).toBe(MIN_TTL_SECONDS * 1000);
    });

    it('clamps TTL to MAX_TTL_SECONDS when too high', () => {
      const { parseCorsCacheConfig, MAX_TTL_SECONDS } = require('./corsCache');
      const cfg = parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '999' });
      expect(cfg.ttlMs).toBe(MAX_TTL_SECONDS * 1000);
    });

    it('clamps maxEntries to MIN_MAX_ENTRIES when too low', () => {
      const { parseCorsCacheConfig, MIN_MAX_ENTRIES } = require('./corsCache');
      const cfg = parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '1' });
      expect(cfg.maxEntries).toBe(MIN_MAX_ENTRIES);
    });

    it('clamps maxEntries to MAX_MAX_ENTRIES when too high', () => {
      const { parseCorsCacheConfig, MAX_MAX_ENTRIES } = require('./corsCache');
      const cfg = parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '99999' });
      expect(cfg.maxEntries).toBe(MAX_MAX_ENTRIES);
    });

    it('falls back to defaults for non-numeric strings', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      const cfg = parseCorsCacheConfig({
        CORS_CACHE_TTL_SECONDS: 'xyz',
        CORS_CACHE_MAX_ENTRIES: 'xyz',
      });
      expect(cfg.ttlMs).toBe(5000);
      expect(cfg.maxEntries).toBe(256);
    });
  });

  // ─── createCorsCache ───────────────────────────────────────────────────

  describe('createCorsCache', () => {
    it('returns undefined on cache miss', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      expect(cache.get('https://a.com')).toBeUndefined();
    });

    it('stores and retrieves a boolean result', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('https://a.com', true);
      expect(cache.get('https://a.com')).toBe(true);
    });

    it('stores and retrieves a rejection result', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('https://evil.com', false);
      expect(cache.get('https://evil.com')).toBe(false);
    });

    it('overwrites an existing entry on re-set', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('https://a.com', true);
      cache.set('https://a.com', false);
      expect(cache.get('https://a.com')).toBe(false);
    });

    it('tracks size correctly', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      expect(cache.size).toBe(0);
      cache.set('a', true);
      expect(cache.size).toBe(1);
      cache.set('b', false);
      expect(cache.size).toBe(2);
    });
  });

  // ─── TTL expiry ─────────────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('returns undefined after TTL expires', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 1, maxEntries: 256 });
      cache.set('https://a.com', true);
      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + 10;
        expect(cache.get('https://a.com')).toBeUndefined();
      } finally {
        Date.now = originalNow;
      }
    });

    it('does not evict entries before TTL expires', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('https://a.com', true);
      expect(cache.get('https://a.com')).toBe(true);
    });
  });

  // ─── LRU eviction ──────────────────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts the least-recently-used entry when max entries is exceeded', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 2 });
      cache.set('a', true);
      cache.set('b', true);
      cache.set('c', true); // evicts 'a'
      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(true);
      expect(cache.get('c')).toBe(true);
    });

    it('promotes an entry to most-recently-used on get', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 2 });
      cache.set('a', true);
      cache.set('b', true);
      cache.get('a'); // promote 'a' — now 'b' is LRU
      cache.set('c', true); // evicts 'b'
      expect(cache.get('a')).toBe(true);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(true);
    });
  });

  // ─── clear ──────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all entries', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('a', true);
      cache.set('b', false);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });
  });

  // ─── Metrics ──────────────────────────────────────────────────────────

  describe('metrics', () => {
    it('increments miss counter on cache miss', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.get('https://a.com');
      expect(getCounterValue(corsCacheMissesTotal)).toBe(1);
    });

    it('increments hit counter on cache hit', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('https://a.com', true);
      cache.get('https://a.com');
      expect(getCounterValue(corsCacheHitsTotal)).toBe(1);
      expect(getCounterValue(corsCacheMissesTotal)).toBe(0);
    });

    it('increments eviction counter on LRU eviction', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 2 });
      cache.set('a', true);
      cache.set('b', true);
      cache.set('c', true); // evicts 'a'
      expect(getCounterValue(corsCacheEvictionsTotal)).toBe(1);
    });

    it('increments invalidation counter on clear', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('a', true);
      cache.clear();
      expect(getCounterValue(corsCacheInvalidationsTotal)).toBe(1);
    });

    it('increments miss on TTL expiry', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 1, maxEntries: 256 });
      cache.set('https://a.com', true);
      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + 10;
        cache.get('https://a.com');
        expect(getCounterValue(corsCacheMissesTotal)).toBe(1);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  // ─── Singleton ────────────────────────────────────────────────────────

  describe('getCorsCache', () => {
    it('returns the same instance on repeated calls', () => {
      const { getCorsCache, _setCorsCache } = require('./corsCache');
      _setCorsCache(null);
      const a = getCorsCache();
      const b = getCorsCache();
      expect(a).toBe(b);
    });
  });
});
