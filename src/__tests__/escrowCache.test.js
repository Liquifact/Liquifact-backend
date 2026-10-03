'use strict';

const {
  RedisEscrowSummaryCache,
  isCacheableSummary,
  parseCacheEnvelope,
} = require('../cache/redis');
const { CircuitBreaker, CircuitBreakerState } = require('../utils/circuitBreaker');

/**
 * Minimal in-memory Redis stub used for integration-style cache tests.
 */
class FakeRedisClient {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.get(key) || null;
  }

  async set(key, value, _mode, _ttl) {
    this.map.set(key, value);
    return 'OK';
  }

  async del(key) {
    this.map.delete(key);
    return 1;
  }

  async eval(script, numberOfKeys, ...values) {
    const keys = values.slice(0, numberOfKeys);
    const args = values.slice(numberOfKeys);
    if (script.includes('redis-cache:read')) {
      let generation = this.map.get(keys[1]);
      if (!generation) {
        generation = args[0];
        this.map.set(keys[1], generation);
      }
      return [this.map.get(keys[0]) ?? null, generation];
    }
    if (script.includes('redis-cache:write')) {
      this.map.set(keys[0], args[1]);
      return 1;
    }
    if (script.includes('redis-cache:compare-delete')) {
      if (this.map.get(keys[0]) === args[0]) {
        this.map.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    if (script.includes('redis-cache:invalidate')) {
      this.map.set(keys[0], args[0]);
      this.map.delete(keys[1]);
      return 1;
    }
    throw new Error('Unsupported Redis script');
  }
}

describe('Escrow Cache Integration', () => {
  it('serves cached response on second request for same invoiceId', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    // First call — miss.
    const miss = await cache.getSummary('inv_100');
    expect(miss.hit).toBe(false);
    expect(miss.reason).toBe('miss');

    // Populate the cache.
    const summary = { invoiceId: 'inv_100', status: 'funded', fundedAmount: 500 };
    await cache.setSummary('inv_100', summary, 200);

    // Second call — hit.
    const hit = await cache.getSummary('inv_100', 201);
    expect(hit.hit).toBe(true);
    expect(hit.value).toEqual(summary);
  });

  it('caches different invoiceIds independently', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    await cache.setSummary('inv_200', { invoiceId: 'inv_200', status: 'a' }, 100);
    await cache.setSummary('inv_300', { invoiceId: 'inv_300', status: 'b' }, 100);

    const r1 = await cache.getSummary('inv_200', 101);
    expect(r1.hit).toBe(true);
    expect(r1.value.invoiceId).toBe('inv_200');

    const r2 = await cache.getSummary('inv_300', 101);
    expect(r2.hit).toBe(true);
    expect(r2.value.invoiceId).toBe('inv_300');
  });

  it('fails open when a summary cannot be serialized', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });
    const summary = {};
    summary.self = summary;

    await expect(cache.setSummary('inv_circular', summary)).resolves.toBe(false);
    await expect(cache.setSummary('inv_missing', undefined)).resolves.toBe(false);
    expect(client.map.size).toBe(0);
  });

  it('fails open for a cached entry without a summary field', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });
    client.map.set('escrow:summary:inv_malformed', JSON.stringify({ cachedLedger: 10 }));

    await expect(cache.getSummary('inv_malformed')).resolves.toMatchObject({
      hit: false,
      reason: 'fail_open',
    });
  });

  it('simulated Redis timeout fails open and falls through', async () => {
    const slowClient = {
      get: () => new Promise((resolve) => setTimeout(() => resolve('data'), 5000)),
      set: () => new Promise((resolve) => setTimeout(() => resolve('OK'), 5000)),
      del: () => Promise.resolve(1),
      eval: (script) => new Promise((resolve) => setTimeout(() => {
        resolve(script.includes('redis-cache:read') ? [null, '0'] : 1);
      }, 5000)),
    };

    const cache = new RedisEscrowSummaryCache({
      client: slowClient,
      ttlSeconds: 30,
      timeoutMs: 50,
      maxRetries: 0,
    });

    // getSummary should not throw — it should return a miss.
    const getResult = await cache.getSummary('inv_timeout');
    expect(getResult.hit).toBe(false);
    expect(getResult.reason).toBe('timeout');

    // setSummary should not throw — it should return false.
    const setResult = await cache.setSummary('inv_timeout', { status: 'funded' });
    expect(setResult).toBe(false);
  });

  it('falls through when circuit breaker trips open', async () => {
    const client = new FakeRedisClient();
    const breaker = new CircuitBreaker( {
      failureThreshold: 1,
      recoveryTimeout: 60000,
      fallbackLogic: () => null,
    });

    // Force breaker to OPEN state.
    breaker.state = CircuitBreakerState.OPEN;
    breaker.nextAttemptTime = Date.now() + 60000;

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 30,
      circuitBreaker: breaker,
    });

    // Even though the underlying client is healthy, the breaker is open
    // so the cache should degrade silently.
    const result = await cache.getSummary('inv_breaker');
    expect(result.hit).toBe(false);

    const setResult = await cache.setSummary('inv_breaker', { status: 'funded' });
    expect(setResult).toBe(false);
  });

  it('returns invalid_input for malformed invoice IDs', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    for (const bad of [' ', 'inv_100 ; del', 'a'.repeat(129), '', null, undefined, 42]) {
      const res = await cache.getSummary(bad);
      expect(res.hit).toBe(false);
      expect(res.reason).toBe('invalid_input');
      expect(await cache.setSummary(bad, {})).toBe(false);
    }
  });

  it('evicts corrupt entries and reports corrupt reason', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    await client.set(cache.key('inv_corrupt'), '{lots of bad json');
    const res = await cache.getSummary('inv_corrupt');
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('corrupt');
    // Evicted from Redis.
    expect(await client.get(cache.key('inv_corrupt'))).toBe(null);
  });

  it('retries transient errors up to maxRetries and then succeeds', async () => {
    let calls = 0;
    const client = {
      get: async () => {
        calls += 1;
        if (calls < 3) {
          const e = new Error('connection reset');
          e.code = 'ECONNRESET';
          throw e;
        }
        return JSON.stringify({ summary: { id: 'inv_retry' }, cachedLedger: 100 });
      },
      set: async () => 'OK',
      del: async () => 1,
    };

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      maxRetries: 3,
      retryBaseDelayMs: 0,
    });

    const res = await cache.getSummary('inv_retry', 101);
    expect(res.hit).toBe(true);
    expect(res.value.id).toBe('inv_retry');
    expect(calls).toBe(3);
  });

  it('gives up after maxRetries and reports error reason', async () => {
    let calls = 0;
    const client = {
      get: async () => {
        calls += 1;
        const e = new Error('connection refused');
        e.code = 'ECONNREFUSED';
        throw e;
      },
      set: async () => 'OK',
      del: async () => 1,
    };

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    const res = await cache.getSummary('inv_dead');
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('error');
    // 1 initial + 2 retries.
    expect(calls).toBe(3);
  });

  it('does not retry when the circuit breaker is open', async () => {
    let calls = 0;
    const client = {
      get: async () => {
        calls += 1;
        return null;
      },
      set: async () => 'OK',
      del: async () => 1,
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60000,
      fallbackLogic: () => null,
    });
    breaker.state = CircuitBreakerState.OPEN;
    breaker.nextAttemptTime = Date.now() + 60000;

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      circuitBreaker: breaker,
      maxRetries: 5,
      retryBaseDelayMs: 0,
    });

    const res = await cache.getSummary('inv_open');
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('circuit_open');
    expect(calls).toBe(0);
  });

  it('deleteSummary returns true on success and false on failure', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });
    await cache.setSummary('inv_del', { id: 'inv_del' });
    expect(await cache.deleteSummary('inv_del')).toBe(true);

    const failingClient = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => { throw new Error('del failed'); },
    };
    const cache2 = new RedisEscrowSummaryCache({
      client: failingClient,
      ttlSeconds: 60,
      maxRetries: 0,
    });
    expect(await cache2.deleteSummary('inv_del')).toBe(false);
  });

  it('ledger gap evicts the entry and reports ledger_gap', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      ledgerGapThreshold: 3,
    });
    await cache.setSummary('inv_gap', { id: 'inv_gap' }, 100);
    const res = await cache.getSummary('inv_gap', 200);
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('ledger_gap');
    expect(await client.get(cache.key('inv_gap'))).toBe(null);
  });

  it('boundary: ledger gap equal to threshold is a hit', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      ledgerGapThreshold: 3,
    });
    await cache.setSummary('inv_bound', { id: 'inv_bound' }, 100);
    const res = await cache.getSummary('inv_bound', 103);
    expect(res.hit).toBe(true);
  });

  it('concurrent gets do not corrupt cache state', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });
    await cache.setSummary('inv_concurrent', { id: 'inv_concurrent' }, 100);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.getSummary('inv_concurrent', 101))
    );
    for (const r of results) {
      expect(r.hit).toBe(true);
      expect(r.value.id).toBe('inv_concurrent');
    }
  });
});

describe('Escrow Cache Invariants', () => {
  it('rejects invalid invoice IDs on read and write', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });

    for (const bad of ['', ' ', 'inv 100', 'inv_100!', 'a'.repeat(129), null, undefined, 42]) {
      const r = await cache.getSummary(bad);
      expect(r.hit).toBe(false);
      expect(r.reason).toBe('invalid_input');
      expect(await cache.setSummary(bad, { a: 1 })).toBe(false);
      expect(await cache.deleteSummary(bad)).toBe(false);
    }
  });

  it('rejects uncacheable summaries without touching Redis', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });

    const circular = {};
    circular.self = circular;

    for (const bad of [null, undefined, 'string', 123, [1, 2], circular]) {
      expect(await cache.setSummary('inv_ok', bad)).toBe(false);
    }
    expect(client.map.size).toBe(0);
  });

  it('treats corrupt cache payloads as misses and evicts them', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });
    const key = cache.key('inv_corrupt');

    const corruptPayloads = [
      '{ not json ',
      'null',
      'true',
      '123',
      '[1,2,3]',
      JSON.stringify({ cachedLedger: 1, cachedAt: 'now' }),
      JSON.stringify({ summary: 'not-an-object', cachedLedger: 1 }),
      JSON.stringify({ summary: { a: 1 }, cachedLedger: 'not-a-number' }),
    ];

    for (const payload of corruptPayloads) {
      client.map.set(key, payload);
      const result = await cache.getSummary('inv_corrupt');
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('corrupt');
      expect(client.map.has(key)).toBe(false);
    }
  });

  it('evicts and reports ledger_gap at the threshold boundary', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ledgerGapThreshold: 3 });

    await cache.setSummary('inv_gap', { a: 1 }, 100);

    // Exactly at threshold — still a hit.
    const atThreshold = await cache.getSummary('inv_gap', 103);
    expect(atThreshold.hit).toBe(true);

    // One past threshold — evicted and reported as gap.
    const over = await cache.getSummary('inv_gap', 104);
    expect(over.hit).toBe(false);
    expect(over.reason).toBe('ledger_gap');
    expect(client.map.has(cache.key('inv_gap'))).toBe(false);

    // Negative direction also evicts.
    await cache.setSummary('inv_gap', { a: 1 }, 100);
    const negative = await cache.getSummary('inv_gap', 96);
    expect(negative.hit).toBe(false);
    expect(negative.reason).toBe('ledger_gap');
  });

  it('serves hits when ledger is missing or non-finite', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });

    await cache.setSummary('inv_no_ledger', { a: 1 });
    const noLedger = await cache.getSummary('inv_no_ledger');
    expect(noLedger.hit).toBe(true);

    const naLedger = await cache.getSummary('inv_no_ledger', NaN);
    expect(naLedger.hit).toBe(true);
  });

  it('returns invalid_input when no client is configured', async () => {
    const cache = new RedisEscrowSummaryCache({ client: null });
    const r = await cache.getSummary('inv_1');
    expect(r.hit).toBe(false);
    expect(r.reason).toBe('invalid_input');
    expect(await cache.setSummary('inv_1', { a: 1 })).toBe(false);
  });

  it('treats a circuit-breaker fallback null as a miss, not a hit', async () => {
    const client = new FakeRedisClient();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60000,
      fallbackLogic: () => null,
    });
    breaker.state = CircuitBreakerState.OPEN;
    breaker.nextAttemptTime = Date.now() + 60000;

    const cache = new RedisEscrowSummaryCache({ client, circuitBreaker: breaker });
    const r = await cache.getSummary('inv_cb');
    expect(r.hit).toBe(false);
    expect(r.reason).toBe('miss');
  });

  it('survives concurrent reads and writes without interference', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });

    const writes = [];
    for (let i = 0; i < 20; i++) {
      writes.push(cache.setSummary(`inv_${i}`, { i: i }, i));
    }
    const results = await Promise.all(writes);
    expect(results.every(Boolean)).toBe(true);

    const reads = [];
    for (let i = 0; i < 20; i++) {
      reads.push(cache.getSummary(`inv_${i}`, i));
    }
    const readResults = await Promise.all(reads);
    for (let i = 0; i < 20; i++) {
      expect(readResults[i].hit).toBe(true);
      expect(readResults[i].value).toEqual({ i: i });
    }
  });

  it('deleteSummary is idempotent and fails open on error', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });

    await cache.setSummary('inv_del', { a: 1 });
    expect(await cache.deleteSummary('inv_del')).toBe(true);
    expect(await cache.deleteSummary('inv_del')).toBe(true);

    const failingClient = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
      del: () => Promise.reject(new Error('boom')),
    };
    const failingCache = new RedisEscrowSummaryCache({ client: failingClient });
    expect(await failingCache.deleteSummary('inv_del')).toBe(false);
  });
});

describe('Escrow Cache State Invariants', () => {
  it('key() is deterministic and namespaced per invoiceId', () => {
    const cache = new RedisEscrowSummaryCache({ client: new FakeRedisClient() });
    expect(cache.key('inv_1')).toBe(cache.key('inv_1'));
    expect(cache.key('inv_1')).not.toBe(cache.key('inv_2'));
  });

  it('default ledgerGapThreshold evicts on large forward jumps', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client });
    await cache.setSummary('inv_default_gap', { a: 1 }, 1);
    const far = await cache.getSummary('inv_default_gap', 1_000_000);
    expect(far.hit).toBe(false);
    expect(far.reason).toBe('ledger_gap');
  });
});

describe('Escrow Cache Helpers', () => {
  it('isCacheableSummary accepts only plain objects', () => {
    expect(isCacheableSummary({ a: 1 })).toBe(true);
    expect(isCacheableSummary(null)).toBe(false);
    expect(isCacheableSummary(undefined)).toBe(false);
    expect(isCacheableSummary('x')).toBe(false);
    expect(isCacheableSummary([])).toBe(false);
    const c = {};
    c.self = c;
    expect(isCacheableSummary(c)).toBe(false);
  });

  it('parseCacheEnvelope rejects malformed payloads', () => {
    expect(parseCacheEnvelope(null)).toBeNull();
    expect(parseCacheEnvelope('')).toBeNull();
    expect(parseCacheEnvelope('not-json')).toBeNull();
    expect(parseCacheEnvelope('null')).toBeNull();
    expect(parseCacheEnvelope('[1,2]')).toBeNull();
    expect(parseCacheEnvelope(JSON.stringify({ summary: 'x' }))).toBeNull();
    expect(parseCacheEnvelope(JSON.stringify({ summary: { a: 1 }, cachedLedger: 'nope' }))).toBeNull();
    expect(parseCacheEnvelope(JSON.stringify({ summary: { a: 1 }, cachedLedger: 5 }))).toEqual({ summary: { a: 1 }, cachedLedger: 5 });
  });
});
