'use strict';

/**
 * Comprehensive tests for the rate-limit middleware store-selection and
 * hardening paths added for issue #429.
 *
 * Sections:
 *   1. Store selection from config (explicit + resolved, ioredis-aware).
 *   2. Clustering warning path (summary + per-scope follow-up).
 *   3. Redis unavailable fallback (no package / throws / null client).
 *   4. Key-spoofing guard (XFF ignored, socket peer used).
 *   5. Single-instance default (no warn, no Redis).
 *
 * Test isolation note: this file mocks `rateLimit.resolveRedisClient`
 * and `rateLimit.loadRedisStoreCtor` directly. It does NOT require
 * `../src/cache/redis` because that file transitively loads
 * `../src/metrics` which has a TDZ issue on the bare upstream/main
 * branch (out of scope for #429).
 */

const rateLimit = require('../src/middleware/rateLimit');
const express = require('express');
const request = require('supertest');
const { MemoryStore } = require('express-rate-limit');

/**
 * A test double that satisfies express-rate-limit v7's store-interface
 * validator (`increment`/`decrement`/`resetKey`/`resetAll`/`init`) AND
 * records what was wired through `sendCommand`. Inheriting from the real
 * `MemoryStore` makes it pass any `instanceof` checks express-rate-limit
 * performs internally.
 */
class FakeRedisStore extends MemoryStore {
  constructor(opts) {
    super();
    this.sendCommand = opts && opts.sendCommand;
    this.prefix = opts && opts.prefix;
  }
}

// ============================================================================
// 1. Store selection from config
// ============================================================================

describe('rate-limit middleware — issue #429 store selection', () => {
  beforeEach(() => {
    delete process.env.WEB_CONCURRENCY;
    delete process.env.CLUSTER_WORKERS;
    rateLimit._resetMemoryWarningLatchForTests();
    rateLimit._detectClusterForTests();
    rateLimit._resetRedisStoreCtorCacheForTests();
    rateLimit._setClusterWarningsAllowedInTestsForTests(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('selects a Redis store when an explicit redisClient with sendCommand is supplied', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(FakeRedisStore);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue({ sendCommand: () => Promise.resolve(1) });

    const limiter = rateLimit.createRateLimiter('scope-explicit', 60_000, 10, {
      redisClient: { sendCommand: () => Promise.resolve(1) },
    });

    expect(limiter.__liquifactStoreType).toBe('redis');
    expect(limiter.__liquifactScope).toBe('scope-explicit');
  });

  it('selects a Redis store when resolveRedisClient reports a connected client', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(FakeRedisStore);
    const resolveSpy = jest.spyOn(rateLimit, 'resolveRedisClient')
      .mockReturnValue({ sendCommand: () => Promise.resolve(1) });

    const limiter = rateLimit.createRateLimiter('scope-cache', 60_000, 10);

    expect(limiter.__liquifactStoreType).toBe('redis');
    expect(resolveSpy).toHaveBeenCalled();
  });

  it('falls back to memory when an explicit redisClient is null', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(FakeRedisStore);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue(null);

    const limiter = rateLimit.createRateLimiter('scope-null-explicit', 60_000, 10, {
      redisClient: null,
    });

    expect(limiter.__liquifactStoreType).toBe('memory');
  });

  it('falls back to memory when resolveRedisClient reports an unavailable client', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(FakeRedisStore);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue(null);

    const limiter = rateLimit.createRateLimiter('scope-resolver-down', 60_000, 10);

    expect(limiter.__liquifactStoreType).toBe('memory');
  });

  it('falls back to memory when loadRedisStoreCtor returns null (no package installed)', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(null);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue({ sendCommand: () => Promise.resolve(1) });

    const limiter = rateLimit.createRateLimiter('scope-no-package', 60_000, 10, {
      redisClient: { sendCommand: () => Promise.resolve(1) },
    });

    expect(limiter.__liquifactStoreType).toBe('memory');
  });

  it('keeps scope-isolation fingerprints even when both scopes share the same connected client', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(FakeRedisStore);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue({ sendCommand: () => Promise.resolve(1) });

    const limiterA = rateLimit.createRateLimiter('scopeFingerprintA', 60_000, 10);
    const limiterB = rateLimit.createRateLimiter('scopeFingerprintB', 60_000, 10);

    expect(limiterA.__liquifactScope).toBe('scopeFingerprintA');
    expect(limiterB.__liquifactScope).toBe('scopeFingerprintB');
    expect(limiterA.__liquifactScope).not.toBe(limiterB.__liquifactScope);
  });

  it('recognizes ioredis-style clients (no sendCommand) and adapts them', async () => {
    const callSpy = jest.fn().mockResolvedValue(1);
    const ioredisClient = { call: callSpy, other: 'x' };
    // Wrap the FakeRedisStore ctor so we can capture the actual store instance
    // that gets plugged into express-rate-limit (rather than constructing a
    // second one locally).
    let capturedStore = null;
    function CapturingStore(opts) {
      const inst = new FakeRedisStore(opts);
      capturedStore = inst;
      return inst;
    }
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(CapturingStore);

    const limiter = rateLimit.createRateLimiter('scope-ioredis', 60_000, 10, {
      redisClient: ioredisClient,
    });

    expect(limiter.__liquifactStoreType).toBe('redis');
    expect(capturedStore).not.toBeNull();

    // Drive the actual sendCommand bridge that buildRedisStore wired through
    // `adaptClientSendCommand`. The bridge spreads the parts array back so
    // ioredis's `call(cmd, ...rest)` is satisfied.
    await capturedStore.sendCommand(['PING']);
    expect(callSpy).toHaveBeenCalledWith('PING');
  });
});

// ============================================================================
// 2. Clustering warning path
// ============================================================================

describe('rate-limit middleware — issue #429 clustering warning', () => {
  let warnSpy;
  beforeEach(() => {
    delete process.env.WEB_CONCURRENCY;
    delete process.env.CLUSTER_WORKERS;
    rateLimit._resetMemoryWarningLatchForTests();
    rateLimit._detectClusterForTests();
    rateLimit._resetRedisStoreCtorCacheForTests();
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(null);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue(null);
    rateLimit._setClusterWarningsAllowedInTestsForTests(true);
    warnSpy = jest.spyOn(rateLimit._loggerForTests(), 'warn');
  });

  afterEach(() => {
    rateLimit._setClusterWarningsAllowedInTestsForTests(false);
    jest.restoreAllMocks();
  });

  it('emits a memory-in-cluster warning when WEB_CONCURRENCY > 1 and store is memory', () => {
    process.env.WEB_CONCURRENCY = '4';
    rateLimit._detectClusterForTests();

    rateLimit.createRateLimiter('warn-scope', 60_000, 10);

    expect(rateLimit.isMemoryInClusterWarning()).toBe(true);

    const summary = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'memory_in_cluster',
    );
    expect(summary).toBeDefined();
    expect(summary[0].signal).toBe('WEB_CONCURRENCY');
    expect(summary[0].webConcurrency).toBe(4);
    expect(String(summary[1])).toMatch(/in-memory store active in clustered deployment/i);
  });

  it('does NOT emit a memory-in-cluster warning when WEB_CONCURRENCY > 1 but a Redis store is in use', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(FakeRedisStore);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue({ sendCommand: () => Promise.resolve(1) });

    process.env.WEB_CONCURRENCY = '4';
    rateLimit._detectClusterForTests();

    rateLimit.createRateLimiter('redis-in-cluster', 60_000, 10);

    expect(rateLimit.isMemoryInClusterWarning()).toBe(false);
    const summary = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'memory_in_cluster',
    );
    expect(summary).toBeUndefined();
  });

  it('does NOT emit any cluster warning when WEB_CONCURRENCY is unset', () => {
    rateLimit.createRateLimiter('no-cluster', 60_000, 10);

    expect(rateLimit.isMemoryInClusterWarning()).toBe(false);
    const summary = warnSpy.mock.calls.find(
      (c) => c[0] && /memory_in_cluster/.test(c[0].event || ''),
    );
    expect(summary).toBeUndefined();
  });

  it('emits a per-scope follow-up warning for additional memory limiters under the same cluster', () => {
    process.env.WEB_CONCURRENCY = '2';
    rateLimit._detectClusterForTests();

    // First limiter → summary warning (sets latch).
    rateLimit.createRateLimiter('warn-scope-one', 60_000, 10);
    expect(rateLimit.isMemoryInClusterWarning()).toBe(true);

    // Second limiter under the SAME cluster → follow-up warning.
    rateLimit.createRateLimiter('warn-scope-two', 60_000, 10);

    const additional = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'memory_in_cluster_additional_scope',
    );
    expect(additional).toBeDefined();
    expect(additional[0].scope).toBe('warn-scope-two');
    expect(additional[0].signal).toBe('WEB_CONCURRENCY');
  });

  it('recognizes CLUSTER_WORKERS as an alternative multi-instance signal', () => {
    process.env.CLUSTER_WORKERS = '8';
    rateLimit._detectClusterForTests();

    rateLimit.createRateLimiter('cluster-workers', 60_000, 10);

    const summary = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'memory_in_cluster',
    );
    expect(summary).toBeDefined();
    expect(summary[0].signal).toBe('CLUSTER_WORKERS');
    expect(summary[0].webConcurrency).toBe(8);
  });
});

// ============================================================================
// 3. Redis unavailable fallback
// ============================================================================

describe('rate-limit middleware — issue #429 Redis fallback', () => {
  beforeEach(() => {
    delete process.env.WEB_CONCURRENCY;
    delete process.env.CLUSTER_WORKERS;
    rateLimit._resetMemoryWarningLatchForTests();
    rateLimit._detectClusterForTests();
    rateLimit._resetRedisStoreCtorCacheForTests();
    rateLimit._setClusterWarningsAllowedInTestsForTests(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('falls back to in-memory when loadRedisStoreCtor returns null', () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(null);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue({ sendCommand: () => Promise.resolve(1) });

    const limiter = rateLimit.createRateLimiter('no-package', 60_000, 10);
    expect(limiter.__liquifactStoreType).toBe('memory');
  });

  it('falls back to in-memory when the constructor throws', () => {
    function BadCtor() { throw new Error('boom'); }
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(BadCtor);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue({ sendCommand: () => Promise.resolve(1) });

    const limiter = rateLimit.createRateLimiter('ctor-throws', 60_000, 10);
    expect(limiter.__liquifactStoreType).toBe('memory');
  });

  it('still serves requests when no Redis store is available (in-memory fallback)', async () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(null);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue(null);

    const limiter = rateLimit.createRateLimiter('fallback-serve', 60_000, 2);
    const app = express();
    app.use(limiter);
    app.get('/probe', (_req, res) => res.json({ ok: true }));

    const r1 = await request(app).get('/probe');
    const r2 = await request(app).get('/probe');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

// ============================================================================
// 4. Key-spoofing guard
// ============================================================================

describe('rate-limit middleware — issue #429 spoofing guard', () => {
  beforeEach(() => {
    delete process.env.WEB_CONCURRENCY;
    delete process.env.CLUSTER_WORKERS;
    rateLimit._resetMemoryWarningLatchForTests();
    rateLimit._detectClusterForTests();
    rateLimit._resetRedisStoreCtorCacheForTests();
    rateLimit._setClusterWarningsAllowedInTestsForTests(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keyGenerator reads the TCP socket peer, never the X-Forwarded-For header', () => {
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.66' },
      user: undefined,
      ip: '198.51.100.7',
      socket: { remoteAddress: '192.0.2.5' },
    };
    expect(rateLimit.keyGenerator(req)).toBe('192.0.2.5');
  });

  it('keyGenerator reads the TCP socket peer even when an attacker sets fake client-IP headers', () => {
    const req = {
      headers: {
        'x-forwarded-for': '127.0.0.1',
        'x-real-ip': '127.0.0.1',
      },
      ip: '127.0.0.1',
      socket: { remoteAddress: '203.0.113.1' },
    };
    const key = rateLimit.keyGenerator(req);
    expect(key).toBe('203.0.113.1');
    expect(key).not.toContain('127.0.0.1');
  });

  it('falls back to req.ip when no socket is present (test stub shape)', () => {
    expect(rateLimit.keyGenerator({ ip: '198.51.100.10' })).toBe('198.51.100.10');
  });

  it('falls back to 127.0.0.1 when neither ip nor socket is present', () => {
    expect(rateLimit.keyGenerator({})).toBe('127.0.0.1');
  });

  it('apiKeyKeyGenerator promotes the API key over the IP — but still rejects XFF-shaped keys', () => {
    const req = {
      headers: { 'x-api-key': 'lf_real_key', 'x-forwarded-for': '198.51.100.7' },
      socket: { remoteAddress: '192.0.2.5' },
    };
    expect(rateLimit.apiKeyKeyGenerator(req)).toBe('apikey_lf_real_key');
  });

  it('getApiKey trims whitespace from a string-shaped header', () => {
    expect(rateLimit.getApiKey({ headers: { 'x-api-key': '  lf_trim_me  ' } })).toBe('lf_trim_me');
  });

  it('getApiKey returns undefined when the header is missing or non-string', () => {
    expect(rateLimit.getApiKey({ headers: {} })).toBeUndefined();
    expect(rateLimit.getApiKey({ headers: { 'x-api-key': 12345 } })).toBeUndefined();
  });
});

// ============================================================================
// 5. Single-instance default
// ============================================================================

describe('rate-limit middleware — issue #429 single-instance default', () => {
  beforeEach(() => {
    delete process.env.WEB_CONCURRENCY;
    delete process.env.CLUSTER_WORKERS;
    rateLimit._resetMemoryWarningLatchForTests();
    rateLimit._detectClusterForTests();
    rateLimit._resetRedisStoreCtorCacheForTests();
    rateLimit._setClusterWarningsAllowedInTestsForTests(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs nothing and serves requests when single-instance and no Redis is supplied', async () => {
    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(null);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue(null);

    const limiter = rateLimit.createRateLimiter('single-instance', 60_000, 2);
    expect(limiter.__liquifactStoreType).toBe('memory');
    expect(rateLimit.isMemoryInClusterWarning()).toBe(false);

    const app = express();
    app.use(limiter);
    app.get('/check', (_req, res) => res.json({ ok: true }));

    const r = await request(app).get('/check');
    expect(r.status).toBe(200);
  });

  it('WEB_CONCURRENCY=1 (the boundary) stays strictly single-instance with no warnings', () => {
    process.env.WEB_CONCURRENCY = '1';
    rateLimit._detectClusterForTests();

    jest.spyOn(rateLimit, 'loadRedisStoreCtor').mockReturnValue(null);
    jest.spyOn(rateLimit, 'resolveRedisClient').mockReturnValue(null);

    const limiter = rateLimit.createRateLimiter('boundary-one', 60_000, 2);
    expect(rateLimit.isMemoryInClusterWarning()).toBe(false);
    expect(rateLimit.CLUSTER_SIGNAL.clustered).toBe(false);
    expect(limiter.__liquifactStoreType).toBe('memory');
  });
});
