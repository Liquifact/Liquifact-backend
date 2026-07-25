'use strict';

/**
 * @fileoverview Comprehensive tests for the per-client rate limiter wired
 * into /api/admin/config (issue #754).
 *
 * Coverage:
 *  • `createConfigRateLimiter` factory — env-var reading, distinct instance
 *    from the pre-built `adminConfigLimiter`.
 *  • `adminConfigLimiter` middleware — 429 body shape, snake-case `retry_hint`
 *    (matches {@link module:utils/problemDetails} wire format), precise
 *    `Retry-After` header, X-Forwarded-For hardening, prefixed bucket key.
 *  • Per-client isolation across API keys (apikey_* bucket) and across
 *    socket IPs (IP-fallback bucket).
 *  • At-limit and over-limit transitions → 429 with structured body.
 *  • Window reset — once the configured window elapses, the bucket must
 *    replenish (issue #754 explicitly calls this out as a required edge
 *    case). Verified with Jest's fake timers.
 *  • End-to-end integration through the adminConfig router — both POST
 *    (write) and GET (sections) paths go through the limiter, with valid
 *    API keys + `x-tenant-id` header reaching 200.
 *  • Mount-order invariant — the limiter is mounted BEFORE adminStack so
 *    failed authentication attempts still consume quota (auth-flooding
 *    defence).
 *
 * Why the `X-Tenant-Id` header:
 *  `extractTenant` derives the tenant id from either the `x-tenant-id`
 *  header or an authenticated JWT claim (`req.user.tenantId`). When the
 *  request is routed through the API-key auth path (`req.headers['x-api-key']`
 *  present) there is no decoded JWT, so we supply `x-tenant-id` explicitly.
 *  This mirrors how tier-1 operator tools (curl, Postman) hit the surface.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
// Tight, test-friendly budget — read by parseRateLimitEnv at rateLimit.js
// module load. Must be set BEFORE requiring adminConfig (which builds the
// limiter inside the module).
process.env.CONFIG_RATE_LIMIT_WINDOW_MS = '60000';
process.env.CONFIG_RATE_LIMIT_MAX = '2';
// Pool of pre-registered API keys. Each test grabs one via `apiKey(idx)` so
// the rate limiter's `apikey_*` bucket is unique per test. All keys share
// the same minimal scope set so the adminAuth chain accepts them.
const ADMIN_CONFIG_TEST_KEYS = Array.from({ length: 8 }, (_, i) => ({
  key: `lf_admin_cfg_test_key_${i}`,
  clientId: `cfg-test-client-${i}`,
  scopes: ['invoices:read', 'invoices:write'],
  revoked: false,
}));
process.env.API_KEYS = ADMIN_CONFIG_TEST_KEYS
  .map((entry) => JSON.stringify(entry))
  .join(';');

const TENANT_ID = 'tenant_test';

// ── Module mocks ─────────────────────────────────────────────────────────────

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
  webhookReplayTotal: { inc: jest.fn() },
  registry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const adminConfigRouter = require('../../src/routes/adminConfig');
const rateLimitModule = require('../../src/middleware/rateLimit');

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

/** Mint a valid admin JWT for test requests. */
function makeAdminToken(sub = 'admin-user', tenantId = TENANT_ID) {
  return jwt.sign({ sub, tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Pick a pre-registered API key from the pool by index. Tests use distinct
 * indices so each test sees its own rate-limit bucket.
 *
 * @param {number} idx Index into the pool (modulo the pool size).
 * @returns {string} Pre-registered API key value.
 */
function apiKey(idx) {
  return ADMIN_CONFIG_TEST_KEYS[idx % ADMIN_CONFIG_TEST_KEYS.length].key;
}

/**
 * Build an isolated Express app that mounts the adminConfig router.
 *
 * @returns {import('express').Express}
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/config', adminConfigRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

const TOKEN = makeAdminToken();
const AUTH = `Bearer ${TOKEN}`;

// ── Global Jest clock control ────────────────────────────────────────────────
//
// Enable fake timers for the entire file so the limiter's internal Date.now()
// reset logic advances predictably between tests. Each test starts at a
// unique timestamp strictly past the previous test's window so every rate-
// limit bucket is freshly replenished. SECTION 4 additionally advances the
// clock mid-test to assert the window-reset behaviour at run-time.

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

describe('adminConfigLimiter — factory + module exports', () => {
  it('exports the resolved env values so operators can inspect them at startup', () => {
    expect(typeof rateLimitModule.CONFIG_RATE_LIMIT_WINDOW_MS).toBe('number');
    expect(typeof rateLimitModule.CONFIG_RATE_LIMIT_MAX).toBe('number');
    expect(rateLimitModule.CONFIG_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(rateLimitModule.CONFIG_RATE_LIMIT_MAX).toBe(2);
  });

  it('exports a pre-built adminConfigLimiter middleware (Express handler)', () => {
    expect(typeof rateLimitModule.adminConfigLimiter).toBe('function');
  });

  it('exports a createConfigRateLimiter factory returning a fresh limiter', () => {
    expect(typeof rateLimitModule.createConfigRateLimiter).toBe('function');
    const fresh = rateLimitModule.createConfigRateLimiter();
    expect(typeof fresh).toBe('function');
    // Factory returns a *different* middleware instance (not the cached one)
    expect(fresh).not.toBe(rateLimitModule.adminConfigLimiter);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — adminConfigLimiter contract: handler shape, XFF, key prefix
// ═════════════════════════════════════════════════════════════════════════════

describe('adminConfigLimiter — direct contract (mounted without adminStack)', () => {
  /**
   * Drive N GET requests through the limiter for a given API key. Returns the
   * resolved response objects in order.
   *
   * @param {string} key Pre-registered API key.
   * @param {number} n Number of requests to fire.
   * @returns {Promise<Array>}
   */
  async function fire(key, n) {
    const app = express();
    app.use(rateLimitModule.adminConfigLimiter);
    app.get('/', (_req, res) => res.status(200).json({ ok: true }));
    const agent = request(app);
    const results = [];
    for (let i = 0; i < n; i += 1) {
      const r = await agent.get('/').set('x-api-key', key);
      results.push(r);
    }
    return results;
  }

  it('429 body carries the canonical problem+json extensions (type, title, code, retryable, scope, retry_hint)', async () => {
    const key = apiKey(0);
    const results = await fire(key, 3);
    const blocked = results[results.length - 1];

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      type: 'https://liquifact.com/probs/too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      // `retry_hint` is snake-cased to match the rest of the platform's
      // problem+json wire format.
      retry_hint: expect.stringMatching(/rate-limit/i),
      scope: 'config',
    });
    expect(blocked.body.message).toMatch(/config/i);
  });

  it('429 response carries Retry-After as integer seconds (bounded by windowMs)', async () => {
    const key = apiKey(1);
    const results = await fire(key, 3);
    const blocked = results[results.length - 1];

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    // 60 s window — Retry-After must never ask a client to wait more than 60 s.
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('does NOT trust X-Forwarded-For — same socket keeps the same bucket regardless of XFF', async () => {
    const key = apiKey(2);
    const app = express();
    app.use(rateLimitModule.adminConfigLimiter);
    app.get('/', (_req, res) => res.status(200).json({ ok: true }));
    const agent = request(app);

    const r1 = await agent.get('/').set('x-api-key', key).set('x-forwarded-for', '198.51.100.10');
    const r2 = await agent.get('/').set('x-api-key', key).set('x-forwarded-for', '198.51.100.11');
    const r3 = await agent.get('/').set('x-api-key', key).set('x-forwarded-for', '198.51.100.12');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429); // third call blocked despite XFF pivots
  });

  it('keyGenerator prefixes an arbitrary X-API-Key header value with "apikey_"', () => {
    // Drive the named module-level keyGenerator directly so the test does
    // not rely on express-rate-limit attaching the option to the returned
    // middleware function (which is internal implementation, not public
    // API). We assert the prefix on an arbitrary synthetic value because
    // this property is independent of the registered API-key pool.
    const kpg = rateLimitModule.adminConfigKeyGenerator;
    expect(typeof kpg).toBe('function');

    const reqWithKey = {
      ip: '203.0.113.99',
      socket: { remoteAddress: '203.0.113.99' },
      headers: { 'x-api-key': 'lf_synthetic_test_key' },
    };
    expect(kpg(reqWithKey)).toBe('apikey_lf_synthetic_test_key');

    // Whitespace in the X-API-Key header value is trimmed before prefixing
    // (mirrors how the auth middleware parses the header).
    const reqWithPaddedKey = {
      ip: '203.0.113.99',
      socket: { remoteAddress: '203.0.113.99' },
      headers: { 'x-api-key': '  lf_padded_test_key  ' },
    };
    expect(kpg(reqWithPaddedKey)).toBe('apikey_lf_padded_test_key');

    // No API key → falls back to socket IP.
    const noKeyReq = {
      ip: '203.0.113.99',
      socket: { remoteAddress: '203.0.113.99' },
      headers: {},
    };
    expect(kpg(noKeyReq)).toBe('203.0.113.99');

    // No IP and no API key → localhost fallback.
    const emptyReq = { ip: undefined, socket: null, headers: {} };
    expect(kpg(emptyReq)).toBe('127.0.0.1');
  });

  it('handler emits the canonical snake_case retry_hint problem+json shape', () => {
    const handler = rateLimitModule.adminConfigHandler;
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
      scope: 'config',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Wired-up integration through adminConfig router
// ═════════════════════════════════════════════════════════════════════════════

describe('adminConfig router — rate-limit integration (GET sections)', () => {
  let app;

  beforeAll(() => {
    app = buildApp();
  });

  it('returns 200 for the first N=CONFIG_RATE_LIMIT_MAX requests in a window', async () => {
    const key = apiKey(0);
    const r1 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    const r2 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.sections).toEqual(expect.arrayContaining(['webhook', 'fraudThresholds']));
  });

  it('returns 429 on the request that breaches CONFIG_RATE_LIMIT_MAX', async () => {
    const key = apiKey(1);
    await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    const over = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);

    expect(over.status).toBe(429);
  });

  it('429 response carries Retry-After header on the wired-up router', async () => {
    const key = apiKey(2);
    await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    const blocked = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('429 response body is a structured RFC 7807 problem (type, title, code, scope, snake-case retry_hint)', async () => {
    const key = apiKey(3);
    await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    const blocked = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);

    expect(blocked.body).toMatchObject({
      type: 'https://liquifact.com/probs/too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      retry_hint: expect.stringMatching(/rate-limit/i),
      scope: 'config',
    });
  });

  it('per-client isolation: a different API key starts with a fresh budget', async () => {
    const keyA = apiKey(4);
    const keyB = apiKey(5);

    // Burn client A's budget.
    const a1 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', keyA).set('X-Tenant-Id', TENANT_ID);
    const a2 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', keyA).set('X-Tenant-Id', TENANT_ID);
    const a3 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', keyA).set('X-Tenant-Id', TENANT_ID);

    // Client B must still be allowed in.
    const b1 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', keyB).set('X-Tenant-Id', TENANT_ID);
    const b2 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', keyB).set('X-Tenant-Id', TENANT_ID);

    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    expect(a3.status).toBe(429);
    expect(b1.status).toBe(200);
    expect(b2.status).toBe(200);
  });

  it('IP-fallback bucket: same socket (no API key) shares an IP bucket and the third call is blocked', async () => {
    // Three requests with NO X-API-Key all originate from the same loopback
    // socket under supertest, so they share the IP-fallback bucket and the
    // third must be blocked (= limit reached).
    const r1 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-Tenant-Id', TENANT_ID);
    const r2 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-Tenant-Id', TENANT_ID);
    const r3 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-Tenant-Id', TENANT_ID);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  it('API key client and IP-only client consume different buckets', async () => {
    const key = apiKey(6);

    // IP-only client (no X-API-Key) — burns 2/2 of the loopback IP bucket.
    const ip1 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-Tenant-Id', TENANT_ID);
    const ip2 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-Tenant-Id', TENANT_ID);

    // API-key client uses a separate bucket (apikey_<key>) — also 2/2, but
    // that bucket is independent of the loopback bucket.
    const key1 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    const key2 = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);

    expect(ip1.status).toBe(200);
    expect(ip2.status).toBe(200);
    expect(key1.status).toBe(200);
    expect(key2.status).toBe(200);
  });

  it('rate-limits POST /api/admin/config writes the same way as GET', async () => {
    const key = apiKey(7);
    const payload = {
      section: 'fraudThresholds',
      config: { fraudCeiling: 1000000, manualReviewThreshold: 100000 },
    };

    const w1 = await request(app)
      .post('/api/admin/config')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID)
      .send(payload);
    const w2 = await request(app)
      .post('/api/admin/config')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID)
      .send(payload);
    const w3 = await request(app)
      .post('/api/admin/config')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID)
      .send(payload);

    expect(w1.status).toBe(200);
    expect(w2.status).toBe(200);
    expect(w3.status).toBe(429);
    expect(w3.headers['retry-after']).toMatch(/^\d+$/);
    expect(w3.body.code).toBe('RATE_LIMITED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Window-reset edge case (issue #754 explicit requirement)
// ═════════════════════════════════════════════════════════════════════════════

describe('adminConfigLimiter — window reopens after the configured elapses', () => {
  it('rejects a third request, then accepts requests again once the window passes', async () => {
    const key = apiKey(0);

    const r1 = await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    const r2 = await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    const r3 = await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);

    // Advance just past the 60 s window — the bucket must replenish.
    jest.advanceTimersByTime(60_001);

    const r4 = await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    const r5 = await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);

    expect(r4.status).toBe(200);
    expect(r5.status).toBe(200);
  });

  it('requests inside the original window remain blocked even after a partial time advance', async () => {
    const key = apiKey(1);

    await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    const blocked = await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    expect(blocked.status).toBe(429);

    // 30 s into the window — the bucket is still full.
    jest.advanceTimersByTime(30_000);
    const stillBlocked = await request(buildApp())
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH).set('X-API-Key', key).set('X-Tenant-Id', TENANT_ID);
    expect(stillBlocked.status).toBe(429);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Mount-order invariant: limiter runs BEFORE adminStack
// ═════════════════════════════════════════════════════════════════════════════

describe('adminConfig router — middleware order', () => {
  it('limiter consumes quota even when the request has no Authorization header', async () => {
    const app = buildApp();
    const key = apiKey(0);

    const ok = await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    expect(ok.status).toBe(200);

    // Exhaust budget with one more authenticated call.
    await request(app)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);

    // Now issue the next request with the same X-API-Key but NO Authorization
    // header. Limiter-before-auth means the X-API-Key bucket is full → 429
    // even though the admin auth stack would have rejected with 401 if it ran
    // first.
    const noAuth = await request(app)
      .get('/api/admin/config/sections')
      .set('X-API-Key', key)
      .set('X-Tenant-Id', TENANT_ID);
    expect(noAuth.status).toBe(429);
    expect(noAuth.body.code).toBe('RATE_LIMITED');
  });
});
