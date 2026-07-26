'use strict';

const {
  RedisEscrowSummaryCache,
  createRedisEscrowSummaryCache,
  parseRedisEscrowCacheConfig,
} = require('../src/cache/redis');
const { CircuitBreaker, CircuitBreakerState } = require('../src/utils/circuitBreaker');

class FakeRedisClient {
  constructor() {
    this.map = new Map();
    this.lastSetArgs = null;
  }

  async get(key) {
    return this.map.get(key) || null;
  }

  async set(key, value, mode, ttl) {
    this.lastSetArgs = { key, value, mode, ttl };
    this.map.set(key, value);
    return 'OK';
  }

  async del(key) {
    this.map.delete(key);
    return 1;
  }
}

describe('redis escrow cache config', () => {
  it('disables cache when REDIS_URL is not set', () => {
    const config = parseRedisEscrowCacheConfig({
      REDIS_ESCROW_CACHE_ENABLED: 'true',
    });

    expect(config.enabled).toBe(false);
  });

  it('clamps TTL and ledger gap threshold to strict limits', () => {
    const config = parseRedisEscrowCacheConfig({
      REDIS_ESCROW_CACHE_ENABLED: 'true',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_ESCROW_CACHE_TTL_SECONDS: '9999',
      REDIS_ESCROW_LEDGER_GAP_THRESHOLD: '0',
    });

    expect(config.enabled).toBe(true);
    expect(config.ttlSeconds).toBe(300);
    expect(config.ledgerGapThreshold).toBe(1);
  });

  it('parses and clamps REDIS_ESCROW_CACHE_TIMEOUT_MS', () => {
    const config = parseRedisEscrowCacheConfig({
      REDIS_ESCROW_CACHE_ENABLED: 'true',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_ESCROW_CACHE_TIMEOUT_MS: '99999',
    });
    expect(config.timeoutMs).toBe(5000);

    const config2 = parseRedisEscrowCacheConfig({
      REDIS_ESCROW_CACHE_ENABLED: 'true',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_ESCROW_CACHE_TIMEOUT_MS: '10',
    });
    expect(config2.timeoutMs).toBe(50);

    const config3 = parseRedisEscrowCacheConfig({
      REDIS_ESCROW_CACHE_ENABLED: 'true',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config3.timeoutMs).toBe(500);
  });
});

describe('RedisEscrowSummaryCache', () => {
  it('stores cache entries with EX TTL', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 45,
      ledgerGapThreshold: 3,
    });

    await cache.setSummary('inv_123', { invoiceId: 'inv_123', status: 'not_found' }, 120);

    expect(client.lastSetArgs.mode).toBe('EX');
    expect(client.lastSetArgs.ttl).toBe(45);
  });

  it('returns miss and invalidates entry when ledger gap exceeds threshold', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 30,
      ledgerGapThreshold: 2,
    });

    await cache.setSummary('inv_ledger', { invoiceId: 'inv_ledger', status: 'funded' }, 100);
    const result = await cache.getSummary('inv_ledger', 104);

    expect(result.hit).toBe(false);
    expect(result.reason).toBe('ledger_gap');
    expect(await client.get('escrow:summary:inv_ledger')).toBeNull();
  });

  it('returns hit when ledger gap is within threshold', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 30,
      ledgerGapThreshold: 5,
    });

    await cache.setSummary('inv_ok', { invoiceId: 'inv_ok', status: 'not_found' }, 250);
    const result = await cache.getSummary('inv_ok', 254);

    expect(result.hit).toBe(true);
    expect(result.value).toEqual({ invoiceId: 'inv_ok', status: 'not_found' });
  });

  it('deletes the affected invoice on write invalidation', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });
    await cache.setSummary('inv_write', { status: 'pending' }, 10);

    expect(await cache.deleteSummary('inv_write')).toBe(true);
    expect((await cache.getSummary('inv_write')).hit).toBe(false);
  });

  it('does not create cache instance when optional redis cache is disabled', () => {
    const cache = createRedisEscrowSummaryCache({
      env: {
        REDIS_ESCROW_CACHE_ENABLED: 'false',
        REDIS_URL: 'redis://localhost:6379',
      },
    });

    expect(cache).toBeNull();
  });

  // ── Fail-open tests ────────────────────────────────────────────────────

  it('getSummary fails open on Redis timeout (returns miss, does not throw)', async () => {
    const slowClient = {
      get: () => new Promise((resolve) => setTimeout(() => resolve('data'), 5000)),
      set: () => Promise.resolve('OK'),
      del: () => Promise.resolve(1),
    };

    const cache = new RedisEscrowSummaryCache({
      client: slowClient,
      ttlSeconds: 30,
      timeoutMs: 50, // very short timeout to trigger fail-open quickly
    });

    const result = await cache.getSummary('inv_slow');

    expect(result.hit).toBe(false);
    expect(result.reason).toBe('fail_open');
  });

  it('setSummary fails open on Redis timeout (returns false, does not throw)', async () => {
    const slowClient = {
      get: () => Promise.resolve(null),
      set: () => new Promise((resolve) => setTimeout(() => resolve('OK'), 5000)),
      del: () => Promise.resolve(1),
    };

    const cache = new RedisEscrowSummaryCache({
      client: slowClient,
      ttlSeconds: 30,
      timeoutMs: 50,
    });

    const result = await cache.setSummary('inv_slow', { status: 'funded' }, 100);

    expect(result).toBe(false);
  });

  it('getSummary fails open when circuit breaker is OPEN', async () => {
    const client = new FakeRedisClient();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60000, // long recovery so it stays open
      fallbackLogic: () => null,
    });

    // Trip the breaker by forcing a failure.
    breaker.state = CircuitBreakerState.OPEN;
    breaker.nextAttemptTime = Date.now() + 60000;

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 30,
      circuitBreaker: breaker,
    });

    const result = await cache.getSummary('inv_cb');

    expect(result.hit).toBe(false);
    // CB fallback returns null → treated as a miss by getSummary.
    expect(result.reason).toBe('miss');
  });

  it('setSummary fails open when circuit breaker is OPEN', async () => {
    const client = new FakeRedisClient();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60000,
      fallbackLogic: () => null,
    });

    breaker.state = CircuitBreakerState.OPEN;
    breaker.nextAttemptTime = Date.now() + 60000;

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 30,
      circuitBreaker: breaker,
    });

    const result = await cache.setSummary('inv_cb', { status: 'funded' }, 100);

    // CB fallback returns null → setSummary returns false.
    expect(result).toBe(false);
  });

  it('getSummary fails open when Redis client.get throws', async () => {
    const errorClient = {
      get: () => Promise.reject(new Error('Connection refused')),
      set: () => Promise.resolve('OK'),
      del: () => Promise.resolve(1),
    };

    const cache = new RedisEscrowSummaryCache({
      client: errorClient,
      ttlSeconds: 30,
    });

    const result = await cache.getSummary('inv_err');

    expect(result.hit).toBe(false);
    expect(result.reason).toBe('fail_open');
  });
});
