'use strict';

/**
 * @fileoverview Comprehensive tests for the per-client rate limiter wired
 * into the /metrics endpoint (issue #744).
 *
 * Coverage:
 *  • `createMetricsRateLimiter` factory — env-var reading, distinct instance
 *    from the pre-built `metricsLimiter`.
 *  • `metricsLimiter` middleware — 429 body shape, snake-case `retry_hint`,
 *    precise `Retry-After` header, X-Forwarded-For hardening, scoped message.
 *  • Per-client isolation across API keys (apikey_* bucket) and across
 *    socket IPs (IP-fallback bucket).
 *  • At-limit and over-limit transitions → 429 with structured body.
 *  • Window reset — once the configured window elapses, the bucket replenishes.
 *  • Mount-order invariant — limiter runs BEFORE metricsAuth so
 *    unauthenticated attempts still consume quota.
 *  • Key generator priority (API key > IP > 127.0.0.1).
 *  • 429 handler emits canonical problem+json with scope 'metrics'.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
// Tight, test-friendly budget — read by parseRateLimitEnv at rateLimit.js
// module load. Must be set BEFORE requiring the module.
process.env.METRICS_RATE_LIMIT_WINDOW_MS = '60000';
process.env.METRICS_RATE_LIMIT_MAX = '2';

// ── Module mocks ─────────────────────────────────────────────────────────────

// tests/mocks/setup.js installs a globally-applied jest.mock for the rate-
// limit middleware with a no-op implementation. Unmock it so we test the
// real limiter behavior.
jest.unmock('../../src/middleware/rateLimit');

// ── Imports ───────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');

const rateLimitModule = require('../../src/middleware/rateLimit');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an isolated Express app that mounts the metrics limiter.
 *
 * @param {Function} [limiter] Optional limiter to use (defaults to module-level metricsLimiter).
 * @returns {import('express').Express}
 */
function buildApp(limiter) {
  const app = express();
  const theLimiter = limiter || rateLimitModule.metricsLimiter;
  // Mirror production: limiter BEFORE auth then handler
  app.get('/metrics', theLimiter, (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.end('# HELP test_metric Test metric\n# TYPE test_metric counter\ntest_metric 1\n');
  });
  return app;
}

/**
 * Drive N GET requests through a limiter for a given API key.
 */
async function fire(key, n, app) {
  const results = [];
  const agent = request(app);
  for (let i = 0; i < n; i += 1) {
    const req = agent.get('/metrics');
    if (key) req.set('x-api-key', key);
    const r = await req;
    results.push(r);
  }
  return results;
}

// ── Fake timers —──────────────────────────────────────────────────────────────

let testClockBaseMs = 0;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  testClockBaseMs += 120_001;
  jest.setSystemTime(new Date(testClockBaseMs));
});

afterEach(() => {
  jest.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Factory-level: env-var parsing and exports
// ═════════════════════════════════════════════════════════════════════════════

describe('metricsLimiter — factory + module exports', () => {
  it('exports the resolved env values so operators can inspect them at startup', () => {
    expect(typeof rateLimitModule.METRICS_RATE_LIMIT_WINDOW_MS).toBe('number');
    expect(typeof rateLimitModule.METRICS_RATE_LIMIT_MAX).toBe('number');
    expect(rateLimitModule.METRICS_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(rateLimitModule.METRICS_RATE_LIMIT_MAX).toBe(2);
  });

  it('exports a pre-built metricsLimiter middleware (Express handler)', () => {
    expect(typeof rateLimitModule.metricsLimiter).toBe('function');
  });

  it('exports a createMetricsRateLimiter factory returning a fresh limiter', () => {
    expect(typeof rateLimitModule.createMetricsRateLimiter).toBe('function');
    const fresh = rateLimitModule.createMetricsRateLimiter();
    expect(typeof fresh).toBe('function');
    expect(fresh).not.toBe(rateLimitModule.metricsLimiter);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — metricsLimiter contract: handler shape, scoped message
// ═════════════════════════════════════════════════════════════════════════════

describe('metricsLimiter — direct contract', () => {
  it('429 body carries canonical problem+json extensions (type, title, code, scope: metrics)', async () => {
    const app = buildApp();
    const results = await fire('key-a', 3, app);
    const blocked = results[results.length - 1];

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      type: 'https://liquifact.com/probs/too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      retry_hint: expect.stringMatching(/rate-limit/i),
      scope: 'metrics',
    });
    expect(blocked.body.message).toMatch(/\/metrics/);
  });

  it('429 response carries Retry-After as integer seconds bounded by windowMs', async () => {
    const app = buildApp();
    const results = await fire('key-b', 3, app);
    const blocked = results[results.length - 1];

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('does NOT trust X-Forwarded-For — same socket keeps same bucket regardless of XFF', async () => {
    const app = buildApp();
    const agent = request(app);

    const r1 = await agent.get('/metrics').set('x-forwarded-for', '198.51.100.10');
    const r2 = await agent.get('/metrics').set('x-forwarded-for', '198.51.100.11');
    const r3 = await agent.get('/metrics').set('x-forwarded-for', '198.51.100.12');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429); // blocked regardless of XFF pivoting
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Per-client isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('metricsLimiter — per-client isolation', () => {
  it('different API keys get separate buckets', async () => {
    const app = buildApp();
    // Client A: saturate
    const resultsA = await fire('key-aaa', 2, app);
    expect(resultsA[0].status).toBe(200);
    expect(resultsA[1].status).toBe(200);

    // Client A: third request blocked
    const resABlocked = await request(app).get('/metrics').set('x-api-key', 'key-aaa');
    expect(resABlocked.status).toBe(429);

    // Client B: fresh bucket
    const resB1 = await request(app).get('/metrics').set('x-api-key', 'key-bbb');
    expect(resB1.status).toBe(200);
  });

  it('API key client and IP-only client consume different buckets', async () => {
    const app = buildApp();
    // IP-only: saturate
    const ip1 = await request(app).get('/metrics');
    const ip2 = await request(app).get('/metrics');
    expect(ip1.status).toBe(200);
    expect(ip2.status).toBe(200);

    // API-key client: separate bucket — still allowed
    const key1 = await request(app).get('/metrics').set('x-api-key', 'fresh-key');
    const key2 = await request(app).get('/metrics').set('x-api-key', 'fresh-key');
    expect(key1.status).toBe(200);
    expect(key2.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Window reset
// ═════════════════════════════════════════════════════════════════════════════

describe('metricsLimiter — window reset', () => {
  it('rejects a third request, then accepts again after window passes', async () => {
    const app = buildApp();
    const r1 = await request(app).get('/metrics');
    const r2 = await request(app).get('/metrics');
    const r3 = await request(app).get('/metrics');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);

    // Advance past the window
    jest.advanceTimersByTime(60_001);

    const r4 = await request(app).get('/metrics');
    expect(r4.status).toBe(200);
  });

  it('mid-window advance does NOT reset the bucket', async () => {
    const app = buildApp();
    await request(app).get('/metrics');
    await request(app).get('/metrics');
    const blocked = await request(app).get('/metrics');
    expect(blocked.status).toBe(429);

    // Only 30s elapsed — bucket still full
    jest.advanceTimersByTime(30_000);
    const stillBlocked = await request(app).get('/metrics');
    expect(stillBlocked.status).toBe(429);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Key generator (reuses adminConfigKeyGenerator)
// ═════════════════════════════════════════════════════════════════════════════

describe('metricsLimiter key generator (adminConfigKeyGenerator)', () => {
  it('returns apikey_ prefixed key when X-API-Key is present', () => {
    const kpg = rateLimitModule.adminConfigKeyGenerator;
    const req = {
      ip: '203.0.113.99',
      socket: { remoteAddress: '203.0.113.99' },
      headers: { 'x-api-key': 'lf_test_key' },
    };
    expect(kpg(req)).toBe('apikey_lf_test_key');
  });

  it('trims whitespace from API key value', () => {
    const kpg = rateLimitModule.adminConfigKeyGenerator;
    const req = {
      ip: '203.0.113.99',
      socket: { remoteAddress: '203.0.113.99' },
      headers: { 'x-api-key': '  lf_padded_key  ' },
    };
    expect(kpg(req)).toBe('apikey_lf_padded_key');
  });

  it('falls back to req.ip when no API key', () => {
    const kpg = rateLimitModule.adminConfigKeyGenerator;
    const req = {
      ip: '10.0.0.1',
      socket: { remoteAddress: '10.0.0.1' },
      headers: {},
    };
    expect(kpg(req)).toBe('10.0.0.1');
  });

  it('falls back to socket.remoteAddress when req.ip missing', () => {
    const kpg = rateLimitModule.adminConfigKeyGenerator;
    const req = {
      socket: { remoteAddress: '192.168.1.1' },
      headers: {},
    };
    expect(kpg(req)).toBe('192.168.1.1');
  });

  it('falls back to 127.0.0.1 when no IP source available', () => {
    const kpg = rateLimitModule.adminConfigKeyGenerator;
    const req = { headers: {} };
    expect(kpg(req)).toBe('127.0.0.1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — 429 handler
// ═════════════════════════════════════════════════════════════════════════════

describe('metricsRateLimitHandler', () => {
  it('emits the canonical snake_case retry_hint problem+json with scope metrics', () => {
    const handler = rateLimitModule.metricsRateLimitHandler;
    expect(typeof handler).toBe('function');

    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    handler(
      {},
      res,
      jest.fn(),
      { statusCode: 429, windowMs: 60_000 },
    );
    expect(res.status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body).toMatchObject({
      type: 'https://liquifact.com/probs/too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      retry_hint: expect.stringMatching(/rate-limit/i),
      scope: 'metrics',
    });
    expect(body.message).toMatch(/\/metrics/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Mount-order invariant: limiter runs BEFORE auth
// ═════════════════════════════════════════════════════════════════════════════

describe('metricsLimiter — mount order (limiter before auth)', () => {
  it('limiter consumes quota even when the request is unauthenticated', async () => {
    let authCallCount = 0;
    const app = express();
    // Mirror production order: limiter → auth → handler
    app.get('/metrics',
      rateLimitModule.metricsLimiter,
      (req, res, next) => {
        authCallCount++;
        // Simulate auth failure
        return res.status(401).json({ error: 'Unauthorized' });
      },
      (req, res) => { res.end('metrics'); }
    );

    // Saturate with unauthenticated requests
    const r1 = await request(app).get('/metrics');
    const r2 = await request(app).get('/metrics');
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(authCallCount).toBe(2);

    // Third: bucket exhausted → 429 BEFORE auth runs
    const r3 = await request(app).get('/metrics');
    expect(r3.status).toBe(429);
    expect(r3.body.code).toBe('RATE_LIMITED');
    // Auth was NOT called for the 429 request
    expect(authCallCount).toBe(2);
  });
});
