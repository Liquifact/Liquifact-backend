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
  // The shared test setup replaces prom-client counters with jest.fn() stubs
  // whose reset() is inert; clear the inc() call log so each test starts at 0.
  if (counter && counter.inc && counter.inc.mock && typeof counter.inc.mockClear === 'function') {
    counter.inc.mockClear();
  }
}

function getCounterValue(counter) {
  if (!counter) {
    return 0;
  }
  // Real prom-client counters expose a hashMap of label combinations.
  if (counter.hashMap) {
    return Object.values(counter.hashMap).reduce((sum, entry) => sum + entry.value, 0);
  }
  // Test-double counters track calls on .inc().
  if (counter.inc && counter.inc.mock && Array.isArray(counter.inc.mock.calls)) {
    return counter.inc.mock.calls.length;
  }
  return typeof counter.val === 'number' ? counter.val : 0;
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

  // ─── Input Validation ───────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects empty string origin in get', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      expect(cache.get('')).toBeUndefined();
    });

    it('rejects null origin in get', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      expect(cache.get(null)).toBeUndefined();
    });

    it('rejects undefined origin in get', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      expect(cache.get(undefined)).toBeUndefined();
    });

    it('rejects non-string origin in get', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      expect(cache.get(123)).toBeUndefined();
      expect(cache.get({})).toBeUndefined();
      expect(cache.get([])).toBeUndefined();
    });

    it('rejects oversized origin string in get', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      const longOrigin = 'a'.repeat(501);
      expect(cache.get(longOrigin)).toBeUndefined();
    });

    it('rejects empty string origin in set', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('', true);
      expect(cache.size).toBe(0);
    });

    it('rejects null origin in set', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set(null, true);
      expect(cache.size).toBe(0);
    });

    it('rejects non-boolean allowed value in set', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('https://a.com', 'true');
      cache.set('https://b.com', 1);
      cache.set('https://c.com', null);
      cache.set('https://d.com', undefined);
      expect(cache.size).toBe(0);
    });

    it('accepts valid origin strings within bounds', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      cache.set('https://a.com', true);
      cache.set('a', true);
      cache.set('a'.repeat(500), true);
      expect(cache.size).toBe(3);
    });
  });

  // ─── Concurrent Execution ─────────────────────────────────────────────────

  describe('concurrent execution', () => {
    it('handles rapid set operations on same key without corruption', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      
      // Simulate rapid concurrent sets
      for (let i = 0; i < 100; i++) {
        cache.set('https://a.com', i % 2 === 0);
      }
      
      // Cache should still be in a valid state
      expect(cache.size).toBe(1);
      const result = cache.get('https://a.com');
      expect(typeof result).toBe('boolean');
    });

    it('handles rapid get operations during set', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      
      cache.set('https://a.com', true);
      
      // Simulate rapid concurrent gets
      for (let i = 0; i < 100; i++) {
        const result = cache.get('https://a.com');
        expect(typeof result).toBe('boolean');
      }
    });

    it('handles eviction during concurrent operations', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 3 });
      
      // Fill cache to capacity
      cache.set('a', true);
      cache.set('b', true);
      cache.set('c', true);
      
      // Trigger eviction while accessing
      cache.set('d', true);
      cache.get('b');
      cache.set('e', true);
      
      // Cache should remain valid
      expect(cache.size).toBeLessThanOrEqual(3);
    });
  });

  // ─── Failure Recovery ───────────────────────────────────────────────────

  describe('failure recovery', () => {
    it('handles metric counter failures gracefully', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      
      // Temporarily break metrics
      const originalInc = corsCacheHitsTotal.inc;
      corsCacheHitsTotal.inc = () => { throw new Error('Metric error'); };
      
      try {
        cache.set('https://a.com', true);
        cache.get('https://a.com');
        // Cache should still work despite metric failure
        expect(cache.get('https://a.com')).toBe(true);
      } finally {
        corsCacheHitsTotal.inc = originalInc;
      }
    });

    it('validates cache instance structure', () => {
      const { createCorsCache, isValidCacheInstance } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      
      expect(isValidCacheInstance(cache)).toBe(true);
      expect(isValidCacheInstance(null)).toBe(false);
      expect(isValidCacheInstance(undefined)).toBe(false);
      expect(isValidCacheInstance({})).toBe(false);
      expect(isValidCacheInstance({ get: () => {} })).toBe(false);
    });

    it('clears locks on cache clear', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      
      cache.set('https://a.com', true);
      cache.clear();
      
      // Should be able to set again without lock conflicts
      cache.set('https://a.com', true);
      expect(cache.get('https://a.com')).toBe(true);
    });
  });

  // ─── Boundary Cases ─────────────────────────────────────────────────────

  describe('boundary cases', () => {
    it('handles origin string at max length', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      const maxOrigin = 'a'.repeat(500);
      
      cache.set(maxOrigin, true);
      expect(cache.get(maxOrigin)).toBe(true);
    });

    it('handles origin string at max length + 1', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      const tooLongOrigin = 'a'.repeat(501);
      
      cache.set(tooLongOrigin, true);
      expect(cache.get(tooLongOrigin)).toBeUndefined();
    });

    it('handles single character origin', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      
      cache.set('a', true);
      expect(cache.get('a')).toBe(true);
    });

    it('handles boolean true and false values', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      
      cache.set('https://a.com', true);
      cache.set('https://b.com', false);
      
      expect(cache.get('https://a.com')).toBe(true);
      expect(cache.get('https://b.com')).toBe(false);
    });
  });

  // ─── Compatibility contract: frozen public surface ─────────────────────

  describe('compatibility contract — frozen exports', () => {
    it('exposes exactly the documented public surface (sorted keys)', () => {
      const mod = require('./corsCache');
      expect(Object.keys(mod).sort()).toEqual([
        'DEFAULT_MAX_ENTRIES',
        'DEFAULT_TTL_SECONDS',
        'MAX_MAX_ENTRIES',
        'MAX_TTL_SECONDS',
        'MIN_MAX_ENTRIES',
        'MIN_TTL_SECONDS',
        '_setCorsCache',
        'createCorsCache',
        'getCorsCache',
        'isValidCacheInstance',
        'parseCorsCacheConfig',
      ]);
    });

    it('pins the runtime type of every export', () => {
      const mod = require('./corsCache');
      const fns = [
        'createCorsCache',
        'getCorsCache',
        'parseCorsCacheConfig',
        '_setCorsCache',
        'isValidCacheInstance',
      ];
      const numbers = [
        'DEFAULT_TTL_SECONDS',
        'DEFAULT_MAX_ENTRIES',
        'MIN_TTL_SECONDS',
        'MAX_TTL_SECONDS',
        'MIN_MAX_ENTRIES',
        'MAX_MAX_ENTRIES',
      ];
      fns.forEach((name) => expect(typeof mod[name]).toBe('function'));
      numbers.forEach((name) => expect(typeof mod[name]).toBe('number'));
    });

    it('pins the documented default and clamp constants', () => {
      const mod = require('./corsCache');
      expect(mod.DEFAULT_TTL_SECONDS).toBe(5);
      expect(mod.DEFAULT_MAX_ENTRIES).toBe(256);
      expect(mod.MIN_TTL_SECONDS).toBe(1);
      expect(mod.MAX_TTL_SECONDS).toBe(60);
      expect(mod.MIN_MAX_ENTRIES).toBe(16);
      expect(mod.MAX_MAX_ENTRIES).toBe(4096);
    });
  });

  // ─── Compatibility contract: empty / hostile env ───────────────────────

  describe('compatibility contract — empty and hostile env', () => {
    it('falls back to documented defaults for an empty env object', () => {
      const { parseCorsCacheConfig, DEFAULT_TTL_SECONDS, DEFAULT_MAX_ENTRIES } = require('./corsCache');
      expect(parseCorsCacheConfig({})).toEqual({
        ttlMs: DEFAULT_TTL_SECONDS * 1000,
        maxEntries: DEFAULT_MAX_ENTRIES,
      });
    });

    it('reads process.env by default and never throws', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      let cfg;
      expect(() => { cfg = parseCorsCacheConfig(); }).not.toThrow();
      expect(cfg.ttlMs).toBe(5000);
      expect(cfg.maxEntries).toBe(256);
    });

    it.each([
      ['undefined', undefined],
      ['empty', ''],
      ['whitespace', '   '],
      ['non-numeric', 'not-a-number'],
      ['NaN literal', 'NaN'],
      ['null literal', 'null'],
      ['null value', null],
      ['array value', []],
      ['object value', {}],
    ])('never throws and uses defaults for %s env values', (_label, raw) => {
      const { parseCorsCacheConfig } = require('./corsCache');
      let cfg;
      expect(() => {
        cfg = parseCorsCacheConfig({
          CORS_CACHE_TTL_SECONDS: raw,
          CORS_CACHE_MAX_ENTRIES: raw,
        });
      }).not.toThrow();
      expect(cfg.ttlMs).toBe(5000);
      expect(cfg.maxEntries).toBe(256);
    });
  });

  // ─── Compatibility contract: TTL / MAX_ENTRIES clamps ─────────────────

  describe('compatibility contract — TTL and entry clamps', () => {
    it('clamps TTL at the inclusive boundaries 1s and 60s', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      expect(parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '1' }).ttlMs).toBe(1000);
      expect(parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '60' }).ttlMs).toBe(60000);
    });

    it('clamps TTL below and above range', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      expect(parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '0' }).ttlMs).toBe(1000);
      expect(parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '-5' }).ttlMs).toBe(1000);
      expect(parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '61' }).ttlMs).toBe(60000);
      expect(parseCorsCacheConfig({ CORS_CACHE_TTL_SECONDS: '999999' }).ttlMs).toBe(60000);
    });

    it('clamps maxEntries at the inclusive boundaries 16 and 4096', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      expect(parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '16' }).maxEntries).toBe(16);
      expect(parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '4096' }).maxEntries).toBe(4096);
    });

    it('clamps maxEntries below and above range', () => {
      const { parseCorsCacheConfig } = require('./corsCache');
      expect(parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '15' }).maxEntries).toBe(16);
      expect(parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '0' }).maxEntries).toBe(16);
      expect(parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '4097' }).maxEntries).toBe(4096);
      expect(parseCorsCacheConfig({ CORS_CACHE_MAX_ENTRIES: '999999' }).maxEntries).toBe(4096);
    });

    it('applies parsed env knobs when createCorsCache is called without options', () => {
      const { createCorsCache } = require('./corsCache');
      process.env.CORS_CACHE_TTL_SECONDS = '1';
      process.env.CORS_CACHE_MAX_ENTRIES = '16';
      try {
        const cache = createCorsCache();
        for (let i = 0; i < 20; i += 1) {
          cache.set(`origin-${i}`, true);
        }
        expect(cache.size).toBe(16);
      } finally {
        delete process.env.CORS_CACHE_TTL_SECONDS;
        delete process.env.CORS_CACHE_MAX_ENTRIES;
      }
    });
  });

  // ─── Compatibility contract: hit / miss / eviction / invalidation ─────

  describe('compatibility contract — cache semantics', () => {
    it('distinguishes hits, misses, allow and reject outcomes without throwing', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 16 });
      expect(cache.get('https://miss.example')).toBeUndefined();
      cache.set('https://allow.example', true);
      cache.set('https://deny.example', false);
      expect(cache.get('https://allow.example')).toBe(true);
      expect(cache.get('https://deny.example')).toBe(false);
    });

    it('evicts the least-recently-used entry deterministically at the bound', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 16 });
      for (let i = 0; i < 16; i += 1) {
        cache.set(`origin-${i}`, true);
      }
      expect(cache.size).toBe(16);
      expect(cache.get('origin-0')).toBe(true); // promote origin-0
      cache.set('origin-16', true); // evicts origin-1
      expect(cache.size).toBe(16);
      expect(cache.get('origin-1')).toBeUndefined();
      expect(cache.get('origin-0')).toBe(true);
      expect(cache.get('origin-16')).toBe(true);
    });

    it('fully invalidates every entry and lock on clear (allowlist reload hook)', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 256 });
      for (let i = 0; i < 10; i += 1) {
        cache.set(`origin-${i}`, i % 2 === 0);
      }
      expect(cache.size).toBe(10);
      cache.clear();
      expect(cache.size).toBe(0);
      for (let i = 0; i < 10; i += 1) {
        expect(cache.get(`origin-${i}`)).toBeUndefined();
      }
      // Locks are released too: the same key can be re-set immediately.
      cache.set('origin-0', true);
      expect(cache.get('origin-0')).toBe(true);
    });
  });

  // ─── Compatibility contract: idempotency + metric isolation ───────────

  describe('compatibility contract — idempotency and metric isolation', () => {
    it('repeated reads are idempotent and preserve the stored result', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 16 });
      cache.set('https://a.example', false);
      expect(cache.get('https://a.example')).toBe(false);
      expect(cache.get('https://a.example')).toBe(false);
      expect(cache.size).toBe(1);
    });

    it('repeated sets of the same key are idempotent', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 16 });
      cache.set('https://a.example', true);
      cache.set('https://a.example', true);
      cache.set('https://a.example', true);
      expect(cache.size).toBe(1);
      expect(cache.get('https://a.example')).toBe(true);
    });

    it('repeated clears are idempotent', () => {
      const { createCorsCache } = require('./corsCache');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 16 });
      cache.set('https://a.example', true);
      cache.clear();
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('repeated getCorsCache() calls return the same instance', () => {
      const { getCorsCache, _setCorsCache, isValidCacheInstance } = require('./corsCache');
      _setCorsCache(null);
      const first = getCorsCache();
      expect(isValidCacheInstance(first)).toBe(true);
      expect(getCorsCache()).toBe(first);
    });

    it('never lets a throwing metric counter break get/set/clear', () => {
      const { createCorsCache } = require('./corsCache');
      const {
        corsCacheHitsTotal,
        corsCacheMissesTotal,
        corsCacheEvictionsTotal,
        corsCacheInvalidationsTotal,
      } = require('../metrics');
      const cache = createCorsCache({ ttlMs: 5000, maxEntries: 16 });
      const counters = [
        corsCacheHitsTotal,
        corsCacheMissesTotal,
        corsCacheEvictionsTotal,
        corsCacheInvalidationsTotal,
      ];
      const originals = counters.map((counter) => counter.inc);
      counters.forEach((counter) => {
        counter.inc = () => { throw new Error('metric backend down'); };
      });
      try {
        expect(() => { cache.set('https://a.example', true); }).not.toThrow();
        expect(cache.get('https://miss.example')).toBeUndefined();
        expect(cache.get('https://a.example')).toBe(true);
        expect(() => { cache.clear(); }).not.toThrow();
        expect(cache.size).toBe(0);
      } finally {
        counters.forEach((counter, index) => { counter.inc = originals[index]; });
      }
    });
  });
});
