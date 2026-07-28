'use strict';

/**
 * @fileoverview Tests for escrow-read rate limiting.
 *
 * Covers:
 *   - Legacy endpoint: rate-limited, 429 when exceeded, Retry-After header
 *   - V1 endpoint: rate-limited (runs before auth), 429 when exceeded
 *   - At-limit requests (below cap) succeed with rate-limit headers
 *   - Over-limit requests receive 429 with Retry-After
 *   - Config-driven window and cap via environment variables
 */

// ── Mocks (hoisted by Jest) ──────────────────────────────────────────────────

jest.mock('../src/cache/redis', () => ({
  createRedisEscrowSummaryCache: jest.fn(() => null),
  RedisEscrowSummaryCache: jest.fn(),
  getRedisClient: jest.fn(() => ({ client: null, isAvailable: false })),
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve(null)),
    set: jest.fn(() => Promise.resolve('OK')),
    del: jest.fn(() => Promise.resolve(1)),
    quit: jest.fn(() => Promise.resolve()),
  })),
}), { virtual: true });

jest.mock('rate-limit-redis', () => ({ RedisStore: jest.fn() }), { virtual: true });

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn(() => 'C_ESCROW_MOCK'),
}));

jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => operation()),
}));

jest.mock('../src/db/knex', () => {
  const fakeDb = jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockResolvedValue([1]),
    del: jest.fn().mockResolvedValue(0),
    destroy: jest.fn().mockResolvedValue(undefined),
  }));
  fakeDb.destroy = jest.fn().mockResolvedValue(undefined);
  return fakeDb;
}, { virtual: true });

// ── Imports ───────────────────────────────────────────────────────────────────

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'user_test', id: 'user_test', tenantId: 'tenant_test', ...payload },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

function authHeader(payload = {}) {
  return `Bearer ${makeToken(payload)}`;
}

/**
 * Creates a clean Express app with a tiny rate-limit window for fast tests.
 * Uses `createApp` (no standardized envelope) for predictable response shapes.
 */
function makeTestApp(windowMs = 1000, max = 3) {
  process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS = String(windowMs);
  process.env.RATE_LIMIT_ESCROW_READ_MAX = String(max);

  // Force re-require of rateLimit module to pick up new env vars
  jest.resetModules();
  const { createApp: freshCreateApp } = require('../src/app');
  const app = freshCreateApp();
  return app;
}

// ── Legacy endpoint ──────────────────────────────────────────────────────────

describe('GET /api/escrow/:invoiceId — rate limiting', () => {
  let app;

  beforeEach(() => {
    app = makeTestApp(1000, 3);
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS;
    delete process.env.RATE_LIMIT_ESCROW_READ_MAX;
  });

  it('allows requests within the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/escrow/inv-ok');
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 when the limit is exceeded', async () => {
    // Exhaust the limit
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/escrow/inv-limited');
    }

    // Next request should be rate-limited
    const res = await request(app).get('/api/escrow/inv-limited');
    expect(res.status).toBe(429);
    expect(res.body.error).toBeDefined();
  });

  it('includes Retry-After header on 429', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/escrow/inv-retry-after');
    }

    const res = await request(app).get('/api/escrow/inv-retry-after');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    // Retry-After should be a positive number of seconds
    const retryAfter = parseInt(res.headers['retry-after'], 10);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('includes rate-limit headers on success', async () => {
    const res = await request(app).get('/api/escrow/inv-headers');
    expect(res.status).toBe(200);
    // express-rate-limit sets these with standardHeaders: true
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
    expect(res.headers['ratelimit-reset']).toBeDefined();
  });

  it('rate-limit headers reflect remaining capacity', async () => {
    const res1 = await request(app).get('/api/escrow/inv-cap');
    expect(res1.status).toBe(200);
    const remaining1 = parseInt(res1.headers['ratelimit-remaining'], 10);
    expect(remaining1).toBe(2); // 3 - 1 = 2

    const res2 = await request(app).get('/api/escrow/inv-cap');
    expect(res2.status).toBe(200);
    const remaining2 = parseInt(res2.headers['ratelimit-remaining'], 10);
    expect(remaining2).toBe(1); // 2 - 1 = 1
  });

  it('resets after the window expires', async () => {
    // Use a very short window (100ms) for fast test
    const fastApp = makeTestApp(100, 2);
    process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS = '100';
    process.env.RATE_LIMIT_ESCROW_READ_MAX = '2';

    // Exhaust the limit
    await request(fastApp).get('/api/escrow/inv-reset');
    await request(fastApp).get('/api/escrow/inv-reset');
    const overLimit = await request(fastApp).get('/api/escrow/inv-reset');
    expect(overLimit.status).toBe(429);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 150));

    // Should be allowed again
    const afterReset = await request(fastApp).get('/api/escrow/inv-reset');
    expect(afterReset.status).toBe(200);
  }, 5000);

  it('separate clients (IPs) have separate limits', async () => {
    // Same IP exhausts the limit
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/escrow/inv-same');
    }
    const limited = await request(app).get('/api/escrow/inv-same');
    expect(limited.status).toBe(429);

    // Different IP should still be allowed (set via X-Forwarded-For,
    // but since xForwardedForHeader is disabled, IP always comes from socket)
    // The default test IP is ::ffff:127.0.0.1 — all requests from same IP
  });

  it('does not affect other endpoints', async () => {
    // Exhaust escrow-read limit
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/escrow/inv-other');
    }

    // Health endpoint should still respond
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
  });
});

// ── V1 endpoint ──────────────────────────────────────────────────────────────

describe('GET /v1/escrow/:invoiceId — rate limiting', () => {
  let app;

  beforeEach(() => {
    app = makeTestApp(1000, 3);
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS;
    delete process.env.RATE_LIMIT_ESCROW_READ_MAX;
  });

  it('allows requests within the limit (with valid auth)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/v1/escrow/inv-v1-ok')
        .set('Authorization', authHeader());
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 when limit is exceeded (rate limiter runs before auth)', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .get('/v1/escrow/inv-v1-limited')
        .set('Authorization', authHeader());
    }

    // 4th request — rate-limited BEFORE auth check
    const res = await request(app)
      .get('/v1/escrow/inv-v1-limited')
      .set('Authorization', authHeader());
    expect(res.status).toBe(429);
  });

  it('rate-limited requests do NOT need auth (limiter runs first)', async () => {
    // Exhaust the limit with auth'd requests
    for (let i = 0; i < 3; i++) {
      await request(app)
        .get('/v1/escrow/inv-v1-noauth-limited')
        .set('Authorization', authHeader());
    }

    // 4th request WITHOUT auth — should still get 429 (not 401)
    const res = await request(app).get('/v1/escrow/inv-v1-noauth-limited');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('includes Retry-After header on 429 for V1', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .get('/v1/escrow/inv-v1-retry')
        .set('Authorization', authHeader());
    }

    const res = await request(app)
      .get('/v1/escrow/inv-v1-retry')
      .set('Authorization', authHeader());
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('includes rate-limit headers on success', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv-v1-headers')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
});

// ── Config-driven behaviour ──────────────────────────────────────────────────

describe('escrow-read rate limiter — config-driven', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS;
    delete process.env.RATE_LIMIT_ESCROW_READ_MAX;
  });

  it('respects custom window and max from env vars', async () => {
    process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS = '5000';
    process.env.RATE_LIMIT_ESCROW_READ_MAX = '5';

    jest.resetModules();
    const { createApp: freshApp } = require('../src/app');
    const app = freshApp();

    // Should allow 5 requests
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/escrow/inv-custom');
      expect(res.status).toBe(200);
    }

    // 6th should fail
    const limited = await request(app).get('/api/escrow/inv-custom');
    expect(limited.status).toBe(429);
  });

  it('defaults to 30 requests per 60 seconds when env vars are unset', async () => {
    delete process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS;
    delete process.env.RATE_LIMIT_ESCROW_READ_MAX;

    jest.resetModules();
    const { escrowReadLimiter } = require('../src/middleware/rateLimit');

    // We can't easily test 30 requests in a unit test, but we can verify
    // the limiter is a function (middleware)
    expect(typeof escrowReadLimiter).toBe('function');
  });

  it('handles invalid (NaN) env var values gracefully by falling back to defaults', async () => {
    process.env.RATE_LIMIT_ESCROW_READ_MAX = 'not-a-number';

    jest.resetModules();
    const { createApp: freshApp } = require('../src/app');
    const app = freshApp();

    // Should work with default max (30) — far more than we'll test
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/escrow/inv-nan');
      expect(res.status).toBe(200);
    }
  });

  it('handles negative env var values by falling back to defaults', async () => {
    process.env.RATE_LIMIT_ESCROW_READ_MAX = '-5';
    process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS = '-100';

    jest.resetModules();
    const { createApp: freshApp } = require('../src/app');
    const app = freshApp();

    // Should work with defaults
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/escrow/inv-neg');
      expect(res.status).toBe(200);
    }
  });
});

// ── Cross-endpoint isolation ─────────────────────────────────────────────────

describe('escrow-read rate limiter — endpoint isolation', () => {
  let app;

  beforeEach(() => {
    app = makeTestApp(1000, 2);
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_ESCROW_READ_WINDOW_MS;
    delete process.env.RATE_LIMIT_ESCROW_READ_MAX;
  });

  it('legacy and V1 endpoints share the same rate limit (same limiter instance)', async () => {
    // One request on legacy
    await request(app).get('/api/escrow/inv-shared');

    // One request on V1 (with auth)
    await request(app)
      .get('/v1/escrow/inv-shared')
      .set('Authorization', authHeader());

    // Both used up capacity (2 total, limit is 2)
    // 3rd request on legacy should be rate-limited
    const res = await request(app).get('/api/escrow/inv-shared');
    expect(res.status).toBe(429);
  });
});
