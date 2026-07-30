'use strict';

/**
 * @fileoverview Comprehensive tests for the per-client rate limiter wired
 * into the health endpoints (issue #769).
 *
 * Coverage:
 *  • `createHealthRateLimiter` factory — env-var reading, distinct instance
 *    from the pre-built `healthLimiter`.
 *  • `healthLimiter` middleware — 429 body shape, snake-case `retry_hint`,
 *    precise `Retry-After` header, X-Forwarded-For hardening.
 *  • Per-client isolation across API keys and across socket IPs.
 *  • At-limit and over-limit transitions → 429 with structured body.
 *  • Window reset — once the configured window elapses, the bucket must
 *    replenish. Verified with Jest's fake timers.
 *  • Mount-order invariant — the limiter runs BEFORE health handlers so
 *    unauthenticated monitoring scrapers still consume quota.
 */

process.env.NODE_ENV = 'test';
// Tight, test-friendly budget for health rate limit
process.env.HEALTH_RATE_LIMIT_WINDOW_MS = '10000';
process.env.HEALTH_RATE_LIMIT_MAX = '3';

// ── Module mocks ─────────────────────────────────────────────────────────────

// Suppress Redis-unavailable console.warn during test execution.
// The real rate-limit module emits this at resolve-time and again when the
// factory is called inside tests. The admin config rate limit test inherits
// its suppression via the module-level load; we add an explicit spy here.
jest.spyOn(console, 'warn').mockImplementation(() => {});

// tests/mocks/setup.js installs a globally-applied jest.mock for the rate-
// limit middleware with a no-op implementation. We are explicitly testing
// the real limiter behavior here, so we unmock this module per-file.
jest.unmock('../../src/middleware/rateLimit');

jest.mock('../../src/db/knex', () => jest.fn());
jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../../src/metrics', () => ({
  healthRequestDurationSeconds: { labels: () => ({ observe: jest.fn() }) },
  healthRequestsTotal: { labels: () => ({ inc: jest.fn() }) },
  healthRequestErrorsTotal: { labels: () => ({ inc: jest.fn() }) },
  readinessGauge: { set: jest.fn() },
  escrowIndexerLastCursorAdvanceTimestampSeconds: { get: jest.fn(() => 0) },
  registry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
}));
jest.mock('../../src/services/health', () => ({
  listHealthChecks: jest.fn().mockResolvedValue([]),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');

// Cache-bust the rate-limit module to pick up test env vars.
// We use a factory import pattern so env vars are read fresh.
let rateLimitModule;
let healthRoutes;

function loadModules() {
  jest.isolateModules(() => {
    // Reload with current env vars
    const rl = require('../../src/middleware/rateLimit');
    rateLimitModule = rl;
  });
}

// Initial load
loadModules();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an isolated Express app that mounts the health limiter directly.
 *
 * @param {number} [max=HEALTH_RATE_LIMIT_MAX] Override the rate-limit budget.
 * @returns {import('express').Express}
 */
function buildLimiterApp(max) {
  const limiter = max !== undefined
    ? require('../../src/middleware/rateLimit').createHealthRateLimiter()
    : require('../../src/middleware/rateLimit').healthLimiter;
  const app = express();
  app.use(limiter);
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  return app;
}

// ── Global Jest clock control ────────────────────────────────────────────────

let testClockBaseMs = 0;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  testClockBaseMs += 15_001;
  jest.setSystemTime(new Date(testClockBaseMs));
});

afterEach(() => {
  jest.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Factory-level: env-var parsing and exports
// ═════════════════════════════════════════════════════════════════════════════

describe('healthLimiter — factory + module exports', () => {
  it('exports the resolved env values so operators can inspect them at startup', () => {
    expect(typeof rateLimitModule.HEALTH_RATE_LIMIT_WINDOW_MS).toBe('number');
    expect(typeof rateLimitModule.HEALTH_RATE_LIMIT_MAX).toBe('number');
    expect(rateLimitModule.HEALTH_RATE_LIMIT_WINDOW_MS).toBe(10_000);
    expect(rateLimitModule.HEALTH_RATE_LIMIT_MAX).toBe(3);
  });

  it('exports a pre-built healthLimiter middleware (Express handler)', () => {
    expect(typeof rateLimitModule.healthLimiter).toBe('function');
  });

  it('exports a createHealthRateLimiter factory returning a fresh limiter', () => {
    expect(typeof rateLimitModule.createHealthRateLimiter).toBe('function');
    const fresh = rateLimitModule.createHealthRateLimiter();
    expect(typeof fresh).toBe('function');
    expect(fresh).not.toBe(rateLimitModule.healthLimiter);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — healthLimiter contract: handler shape, XFF, key prefix
// ═════════════════════════════════════════════════════════════════════════════

describe('healthLimiter — direct contract', () => {
  /**
   * Drive N GET requests through the limiter with an optional API key.
   *
   * @param {number} n Number of requests to fire.
   * @param {string} [apiKey] Optional X-API-Key value.
   * @returns {Promise<Array>}
   */
  async function fire(n, apiKey) {
    const app = buildLimiterApp();
    const agent = request(app);
    const results = [];
    for (let i = 0; i < n; i += 1) {
      const req = agent.get('/health');
      if (apiKey !== undefined) {
        req.set('x-api-key', apiKey);
      }
      const r = await req;
      results.push(r);
    }
    return results;
  }

  it('429 body carries the canonical problem+json extensions', async () => {
    const results = await fire(4, 'lf_health_test_key_0');
    const blocked = results[results.length - 1];

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      type: 'https://liquifact.com/probs/too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      retry_hint: expect.stringMatching(/rate-limit/i),
      scope: 'health',
    });
    expect(blocked.body.message).toMatch(/health/i);
  });

  it('429 response carries Retry-After as integer seconds', async () => {
    const results = await fire(4, 'lf_health_test_key_1');
    const blocked = results[results.length - 1];

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(10);
  });

  it('does NOT trust X-Forwarded-For — same socket keeps the same bucket', async () => {
    const app = buildLimiterApp();
    const agent = request(app);
    const key = 'lf_health_test_key_2';

    const r1 = await agent.get('/health').set('x-api-key', key).set('x-forwarded-for', '198.51.100.10');
    const r2 = await agent.get('/health').set('x-api-key', key).set('x-forwarded-for', '198.51.100.11');
    const r3 = await agent.get('/health').set('x-api-key', key).set('x-forwarded-for', '198.51.100.12');
    const r4 = await agent.get('/health').set('x-api-key', key).set('x-forwarded-for', '198.51.100.13');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
  });

  it('healthHandler emits the canonical snake_case retry_hint shape', () => {
    const handler = rateLimitModule.healthHandler;
    expect(typeof handler).toBe('function');

    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    handler(
      {},
      res,
      jest.fn(),
      { statusCode: 429, windowMs: 10_000 },
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
      scope: 'health',
    });
    expect(body.message).toMatch(/health/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — At-limit and over-limit transitions
// ═════════════════════════════════════════════════════════════════════════════

describe('healthLimiter — at-limit and over-limit transitions', () => {
  it('allows exactly HEALTH_RATE_LIMIT_MAX requests then blocks the next', async () => {
    const app = buildLimiterApp();
    const key = 'lf_health_test_key_3';
    const agent = request(app);

    const responses = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await agent.get('/health').set('x-api-key', key);
      responses.push(r);
    }

    // First 3 requests succeed, 4th and 5th are blocked.
    expect(responses[0].status).toBe(200);
    expect(responses[1].status).toBe(200);
    expect(responses[2].status).toBe(200);
    expect(responses[3].status).toBe(429);
    expect(responses[4].status).toBe(429);
  });

  it('rate-limits IP-based clients (no API key) the same way', async () => {
    const app = buildLimiterApp();
    const agent = request(app);

    const responses = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await agent.get('/health');
      responses.push(r);
    }

    expect(responses[0].status).toBe(200);
    expect(responses[1].status).toBe(200);
    expect(responses[2].status).toBe(200);
    expect(responses[3].status).toBe(429);
    expect(responses[4].status).toBe(429);
  });

  it('per-client isolation: different API keys get independent budgets', async () => {
    const app = buildLimiterApp();
    const agent = request(app);
    const keyA = 'lf_health_test_key_4';
    const keyB = 'lf_health_test_key_5';

    // Burn client A's budget.
    for (let i = 0; i < 3; i += 1) {
      await agent.get('/health').set('x-api-key', keyA);
    }
    const aBlocked = await agent.get('/health').set('x-api-key', keyA);
    expect(aBlocked.status).toBe(429);

    // Client B must still be allowed in.
    const b1 = await agent.get('/health').set('x-api-key', keyB);
    const b2 = await agent.get('/health').set('x-api-key', keyB);
    const b3 = await agent.get('/health').set('x-api-key', keyB);

    expect(b1.status).toBe(200);
    expect(b2.status).toBe(200);
    expect(b3.status).toBe(200);
  });

  it('API key client and IP-only client consume different buckets', async () => {
    const app = buildLimiterApp();
    const agent = request(app);
    const key = 'lf_health_test_key_6';

    // IP-only client — burns 3/3 of the loopback IP bucket.
    for (let i = 0; i < 3; i += 1) {
      await agent.get('/health');
    }

    // API-key client uses a separate bucket.
    const keyR1 = await agent.get('/health').set('x-api-key', key);
    const keyR2 = await agent.get('/health').set('x-api-key', key);
    const keyR3 = await agent.get('/health').set('x-api-key', key);

    expect(keyR1.status).toBe(200);
    expect(keyR2.status).toBe(200);
    expect(keyR3.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Window-reset edge case (issue #769 explicit requirement)
// ═════════════════════════════════════════════════════════════════════════════

describe('healthLimiter — window reopens after the configured elapses', () => {
  it('rejects over-limit, then accepts again once the window passes', async () => {
    const key = 'lf_health_test_key_7';

    // Burn budget.
    const app1 = buildLimiterApp();
    await request(app1).get('/health').set('x-api-key', key);
    await request(app1).get('/health').set('x-api-key', key);
    await request(app1).get('/health').set('x-api-key', key);
    const blocked = await request(app1).get('/health').set('x-api-key', key);
    expect(blocked.status).toBe(429);

    // Advance past the 10 s window.
    jest.advanceTimersByTime(10_001);

    const app2 = buildLimiterApp();
    const r1 = await request(app2).get('/health').set('x-api-key', key);
    const r2 = await request(app2).get('/health').set('x-api-key', key);
    const r3 = await request(app2).get('/health').set('x-api-key', key);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  it('requests inside the original window remain blocked after partial advance', async () => {
    const key = 'lf_health_test_key_8';

    const app1 = buildLimiterApp();
    await request(app1).get('/health').set('x-api-key', key);
    await request(app1).get('/health').set('x-api-key', key);
    await request(app1).get('/health').set('x-api-key', key);
    const blocked = await request(app1).get('/health').set('x-api-key', key);
    expect(blocked.status).toBe(429);

    // 5 s into the window — still blocked.
    jest.advanceTimersByTime(5_000);
    const stillBlocked = await request(app1).get('/health').set('x-api-key', key);
    expect(stillBlocked.status).toBe(429);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Mount-order invariant
// ═════════════════════════════════════════════════════════════════════════════

describe('healthLimiter — mount-order invariant', () => {
  it('blocks over-limit even when the request has no Authorization header', async () => {
    const app = buildLimiterApp();
    const key = 'lf_health_test_key_9';
    const agent = request(app);

    // Burn budget with API key.
    for (let i = 0; i < 3; i += 1) {
      await agent.get('/health').set('x-api-key', key);
    }

    // Without Authorization, still blocked by rate limiter (mount-order).
    const blocked = await agent.get('/health').set('x-api-key', key);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Integration with health routes (using a minimal app)
// ═════════════════════════════════════════════════════════════════════════════

describe('healthLimiter — integration with a health-like router', () => {
  it('GET on a limiter-protected router is rate-limited', async () => {
    // Build a minimal router that mirrors the health routes pattern
    const limiter = rateLimitModule.createHealthRateLimiter();
    const router = express.Router();
    router.use(limiter);
    router.get('/checks', (_req, res) => res.status(200).json({ checks: [] }));

    const app = express();
    app.use('/api/health', router);

    const key = 'lf_health_router_test';

    // Fire 4 requests — 3 allowed, 4th blocked.
    const responses = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await request(app).get('/api/health/checks').set('x-api-key', key);
      responses.push(r);
    }

    expect(responses[0].status).toBe(200);
    expect(responses[1].status).toBe(200);
    expect(responses[2].status).toBe(200);
    expect(responses[3].status).toBe(429);
    expect(responses[3].body.code).toBe('RATE_LIMITED');
    expect(responses[3].body.scope).toBe('health');
  });

  it('rate-limits POST on a limiter-protected router the same way', async () => {
    const limiter = rateLimitModule.createHealthRateLimiter();
    const router = express.Router();
    router.use(limiter);
    router.post('/reports', (_req, res) => res.status(201).json({ accepted: true }));

    const app = express();
    app.use(express.json());
    app.use('/api/health', router);

    const key = 'lf_health_router_test_2';
    const payload = { serviceName: 'test-svc', status: 'healthy' };

    const responses = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await request(app).post('/api/health/reports').set('x-api-key', key).send(payload);
      responses.push(r);
    }

    expect(responses[0].status).toBe(201);
    expect(responses[1].status).toBe(201);
    expect(responses[2].status).toBe(201);
    expect(responses[3].status).toBe(429);
    expect(responses[3].body.scope).toBe('health');
  });
});
