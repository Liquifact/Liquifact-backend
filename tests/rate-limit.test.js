'use strict';

const express = require('express');
const request = require('supertest');
const { loadConfig, ConfigError } = require('../src/config');
const {
  createRateLimiter,
  createSlidingWindowStore,
  getClientKey,
  resetAllLimiters,
} = require('../src/middleware/rate-limit');
const app = require('../src/app');

describe('Sliding-window rate limiter', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetAllLimiters();
  });

  describe('createSlidingWindowStore with fake timers', () => {
    test('allows up to max requests and rejects excess with positive Retry-After', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const store = createSlidingWindowStore({ windowMs: 10_000, max: 3, maxClients: 100 });

      expect(store.consume('client-a')).toMatchObject({ allowed: true, limit: 3, remaining: 2 });
      expect(store.consume('client-a')).toMatchObject({ allowed: true, limit: 3, remaining: 1 });
      expect(store.consume('client-a')).toMatchObject({ allowed: true, limit: 3, remaining: 0 });

      const blocked = store.consume('client-a');
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
    });

    test('weights previous window on rollover and gradually releases capacity', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:09.000Z')); // 9s into first 10s window

      const store = createSlidingWindowStore({ windowMs: 10_000, max: 4, maxClients: 100 });

      // Consume full budget right before window boundary
      for (let i = 0; i < 4; i += 1) {
        expect(store.consume('client-roll').allowed).toBe(true);
      }

      // Advance 1s into next window (elapsed = 0ms -> previous weight = 1.0 -> estimated = 4)
      jest.advanceTimersByTime(1000);
      expect(store.consume('client-roll').allowed).toBe(false);

      // Advance 5s (halfway through new window -> previous weight = 0.5 -> estimated = 2.0)
      jest.advanceTimersByTime(5000);
      expect(store.consume('client-roll')).toMatchObject({ allowed: true, remaining: 1 });
      expect(store.consume('client-roll')).toMatchObject({ allowed: true, remaining: 0 });
      expect(store.consume('client-roll').allowed).toBe(false);

      // Advance past full expiry (2 windows) -> clean slate
      jest.advanceTimersByTime(20_000);
      expect(store.consume('client-roll')).toMatchObject({ allowed: true, remaining: 3 });
    });

    test('bounds memory with maxClients cap and LRU eviction', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const store = createSlidingWindowStore({ windowMs: 60_000, max: 5, maxClients: 3 });

      store.consume('c1');
      store.consume('c2');
      store.consume('c3');
      expect(store.size()).toBe(3);

      // Touch c1 so c2 becomes least recently used
      store.consume('c1');

      // Adding c4 must evict c2 and keep size capped at 3
      store.consume('c4');
      expect(store.size()).toBe(3);
      expect(store.keys()).toEqual(['c3', 'c1', 'c4']);

      // After 2 windows, prune removes all expired records
      jest.advanceTimersByTime(120_000);
      expect(store.prune()).toBe(3);
      expect(store.size()).toBe(0);
    });
  });

  describe('Identity and middleware HTTP contract', () => {
    function buildTestApp(limiter) {
      const testApp = express();
      testApp.set('trust proxy', true);
      testApp.post('/test', limiter, (_req, res) => res.status(200).json({ ok: true }));
      return testApp;
    }

    test('returns 429 problem+json with Retry-After and RateLimit-* headers', async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 2, maxClients: 50, namespace: 'test' });
      const testApp = buildTestApp(limiter);

      const r1 = await request(testApp).post('/test');
      expect(r1.status).toBe(200);
      expect(r1.headers['ratelimit-limit']).toBe('2');
      expect(r1.headers['ratelimit-remaining']).toBe('1');
      expect(Number(r1.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(1);

      const r2 = await request(testApp).post('/test');
      expect(r2.status).toBe(200);
      expect(r2.headers['ratelimit-remaining']).toBe('0');

      const r3 = await request(testApp).post('/test');
      expect(r3.status).toBe(429);
      expect(r3.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(Number(r3.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(r3.headers['ratelimit-limit']).toBe('2');
      expect(r3.headers['ratelimit-remaining']).toBe('0');
      expect(r3.body).toMatchObject({
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        title: 'Too Many Requests',
      });
      expect(r3.body.retryAfter).toBeGreaterThanOrEqual(1);
    });

    test('isolates budgets per API key and never stores raw keys in limiter state', async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1, maxClients: 50, namespace: 'iso' });
      const testApp = buildTestApp(limiter);

      const secretA = 'ak_live_super_secret_key_alpha';
      const secretB = 'ak_live_super_secret_key_beta';

      const a1 = await request(testApp).post('/test').set('Authorization', `Bearer ${secretA}`);
      expect(a1.status).toBe(200);

      // Key A is now exhausted
      const a2 = await request(testApp).post('/test').set('Authorization', `Bearer ${secretA}`);
      expect(a2.status).toBe(429);

      // Key B still has its own independent budget
      const b1 = await request(testApp).post('/test').set('X-API-Key', secretB);
      expect(b1.status).toBe(200);

      // Raw secrets must never appear in store keys
      const storedKeys = limiter.store.keys();
      expect(storedKeys.length).toBe(2);
      for (const k of storedKeys) {
        expect(k).not.toContain(secretA);
        expect(k).not.toContain(secretB);
        expect(k).toMatch(/^iso:apikey:[0-9a-f]{64}$/);
      }
    });

    test('getClientKey falls back to IP when no API key is provided', () => {
      const key = getClientKey({ get: () => undefined, ip: '203.0.113.5' }, { namespace: 'mutating' });
      expect(key).toBe('mutating:ip:203.0.113.5');
    });
  });

  describe('Config validation', () => {
    test('loads default rate limit settings', () => {
      const cfg = loadConfig({});
      expect(cfg.rateLimit).toEqual({
        windowMs: 60_000,
        max: 60,
        maxClients: 10_000,
        adminAuthWindowMs: 60_000,
        adminAuthMax: 10,
      });
    });

    test('accepts valid custom rate limit env vars', () => {
      const cfg = loadConfig({
        RATE_LIMIT_WINDOW_MS: '30000',
        RATE_LIMIT_MAX: '25',
        RATE_LIMIT_MAX_CLIENTS: '500',
        ADMIN_AUTH_RATE_LIMIT_WINDOW_MS: '120000',
        ADMIN_AUTH_RATE_LIMIT_MAX: '5',
      });
      expect(cfg.rateLimit).toEqual({
        windowMs: 30_000,
        max: 25,
        maxClients: 500,
        adminAuthWindowMs: 120_000,
        adminAuthMax: 5,
      });
    });

    test('rejects invalid rate limit values with ConfigError', () => {
      expect(() => loadConfig({ RATE_LIMIT_WINDOW_MS: '0' })).toThrow(ConfigError);
      expect(() => loadConfig({ RATE_LIMIT_MAX: '-5' })).toThrow(ConfigError);
      expect(() => loadConfig({ RATE_LIMIT_MAX_CLIENTS: 'abc' })).toThrow(ConfigError);
      expect(() => loadConfig({ ADMIN_AUTH_RATE_LIMIT_MAX: '1.5' })).toThrow(ConfigError);
      expect(() => loadConfig({ RATE_LIMIT_WINDOW_MS: '999999999' })).toThrow(ConfigError);
    });
  });

  describe('Failed admin & cron auth stricter bucket', () => {
    const origAdmin = process.env.ADMIN_API_TOKEN;
    const origCron = process.env.CRON_SECRET;

    beforeEach(() => {
      process.env.ADMIN_API_TOKEN = 'test-admin-secret';
      process.env.CRON_SECRET = 'test-cron-secret';
      resetAllLimiters();
    });

    afterEach(() => {
      if (origAdmin === undefined) { delete process.env.ADMIN_API_TOKEN; } else { process.env.ADMIN_API_TOKEN = origAdmin; }
      if (origCron === undefined) { delete process.env.CRON_SECRET; } else { process.env.CRON_SECRET = origCron; }
    });

    test('rate-limits repeated failed admin token attempts with 429 even with rotating tokens', async () => {
      // Default ADMIN_AUTH_RATE_LIMIT_MAX is 10
      for (let i = 0; i < 10; i += 1) {
        const res = await request(app)
          .post('/api/webhooks')
          .set('Authorization', `Bearer wrong-token-${i}`)
          .send({ url: 'https://example.com/hook', events: ['invoice.created'] });
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .post('/api/webhooks')
        .set('Authorization', 'Bearer wrong-token-11')
        .send({ url: 'https://example.com/hook', events: ['invoice.created'] });

      expect(blocked.status).toBe(429);
      expect(blocked.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(blocked.body.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    test('rate-limits repeated failed cron trigger attempts with 429', async () => {
      for (let i = 0; i < 10; i += 1) {
        const res = await request(app)
          .post('/api/internal/indexer/run')
          .set('Authorization', `Bearer bad-cron-${i}`);
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .post('/api/internal/indexer/run')
        .set('Authorization', 'Bearer bad-cron-11');

      expect(blocked.status).toBe(429);
      expect(blocked.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    });
  });
});
