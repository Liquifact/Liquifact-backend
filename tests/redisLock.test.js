'use strict';

/**
 * @fileoverview Unit tests for src/services/redisLock.js (issue #1213).
 *
 * Uses a fully in-memory fake Redis client (a Map plus the same Lua-script
 * semantics the real EVAL scripts implement) rather than a real Redis
 * connection, so these tests are fast and hermetic. Every edge case listed
 * in the issue is covered directly:
 *  - renewal timeout
 *  - owner token mismatch
 *  - late release
 *  - Redis restart
 *  - long critical section
 */

const {
  RedisLockError,
  MIN_TTL_MS,
  MAX_TTL_MS,
  buildResourceKey,
  createRedisLockService,
} = require('../src/services/redisLock');

/**
 * A minimal fake Redis client implementing just enough of `sendCommand` to
 * exercise SET NX PX and the two EVAL scripts this module uses, with the
 * same atomicity guarantees the real Lua scripts provide (single-threaded
 * JS execution makes this trivially atomic without extra work).
 */
function makeFakeRedis() {
  const store = new Map(); // key -> { value, expiresAt }
  let downUntil = 0; // simulated outage window, epoch ms
  let clock = () => Date.now();

  function isExpired(entry) {
    return !entry || entry.expiresAt <= clock();
  }

  const fake = {
    async sendCommand(args) {
      if (clock() < downUntil) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      }
      const [cmd] = args;
      if (cmd === 'SET') {
        const [, key, value, , ttlStr, nxFlag] = args;
        const existing = store.get(key);
        if (nxFlag === 'NX' && existing && !isExpired(existing)) {
          return null;
        }
        store.set(key, { value, expiresAt: clock() + Number(ttlStr) });
        return 'OK';
      }
      if (cmd === 'EVAL') {
        const script = args[1];
        const key = args[3];
        const token = args[4];
        const entry = store.get(key);
        const alive = entry && !isExpired(entry);
        if (script.includes('DEL')) {
          if (alive && entry.value === token) {
            store.delete(key);
            return 1;
          }
          return 0;
        }
        if (script.includes('PEXPIRE')) {
          if (alive && entry.value === token) {
            const ttl = Number(args[5]);
            entry.expiresAt = clock() + ttl;
            return 1;
          }
          return 0;
        }
      }
      throw new Error(`fake redis: unsupported command ${cmd}`);
    },
    // Test-only controls, not part of the real client's interface.
    __simulateOutage(durationMs) {
      downUntil = clock() + durationMs;
    },
    __setClock(fn) {
      clock = fn;
    },
    __store: store,
  };
  return fake;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('buildResourceKey', () => {
  it('scopes the key by namespace, tenant, and resource id', () => {
    expect(buildResourceKey('invoice', 'tenant-a', 'inv-1')).toBe('lock:invoice:tenant-a:inv-1');
  });

  it('produces different keys for different tenants (tenant isolation)', () => {
    const keyA = buildResourceKey('invoice', 'tenant-a', 'inv-1');
    const keyB = buildResourceKey('invoice', 'tenant-b', 'inv-1');
    expect(keyA).not.toBe(keyB);
  });

  it.each([
    ['', 'tenant-a', 'inv-1'],
    ['invoice', '', 'inv-1'],
    ['invoice', 'tenant-a', ''],
  ])('rejects a missing namespace/tenantId/resourceId (%p, %p, %p)', (namespace, tenantId, resourceId) => {
    expect(() => buildResourceKey(namespace, tenantId, resourceId)).toThrow(RedisLockError);
  });
});

describe('acquire', () => {
  it('acquires an unheld lock and returns a token', async () => {
    const lock = createRedisLockService({ client: makeFakeRedis() });
    const result = await lock.acquire('lock:invoice:t1:inv-1', { ttlMs: 5000 });
    expect(result.acquired).toBe(true);
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);
  });

  it('fails to acquire a lock already held by someone else', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    await lock.acquire(key, { ttlMs: 5000 });
    const second = await lock.acquire(key, { ttlMs: 5000 });
    expect(second.acquired).toBe(false);
    expect(second.token).toBeNull();
  });

  it('succeeds once the previous holder\'s TTL has expired', async () => {
    const client = makeFakeRedis();
    let now = 1_000_000;
    client.__setClock(() => now);
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    await lock.acquire(key, { ttlMs: MIN_TTL_MS });
    now += MIN_TTL_MS + 100; // past TTL
    const second = await lock.acquire(key, { ttlMs: MIN_TTL_MS });
    expect(second.acquired).toBe(true);
  });

  it('clamps an out-of-range TTL into [MIN_TTL_MS, MAX_TTL_MS]', async () => {
    const lock = createRedisLockService({ client: makeFakeRedis() });
    const tooLow = await lock.acquire('lock:invoice:t1:a', { ttlMs: 1 });
    expect(tooLow.ttlMs).toBe(MIN_TTL_MS);
    const tooHigh = await lock.acquire('lock:invoice:t1:b', { ttlMs: 999_999_999 });
    expect(tooHigh.ttlMs).toBe(MAX_TTL_MS);
  });

  it('throws a structured RedisLockError, not a raw Redis error, when the client is unavailable', async () => {
    const client = { sendCommand: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
    const lock = createRedisLockService({ client });
    await expect(lock.acquire('lock:invoice:t1:inv-1', { ttlMs: 5000 })).rejects.toMatchObject({
      name: 'RedisLockError',
      code: 'LOCK_UNAVAILABLE',
    });
  });

  it('the structured error never leaks the raw Redis error message as the primary message', async () => {
    const client = { sendCommand: jest.fn().mockRejectedValue(new Error('password authentication failed for user "prod_admin"')) };
    const lock = createRedisLockService({ client });
    try {
      await lock.acquire('lock:invoice:t1:inv-1', { ttlMs: 5000 });
      throw new Error('expected acquire to throw');
    } catch (error) {
      expect(error.message).not.toContain('prod_admin');
      expect(error.message).not.toContain('password authentication');
    }
  });
});

describe('edge case: owner token mismatch', () => {
  it('release() does not delete a lock held by a different token', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    const { token } = await lock.acquire(key, { ttlMs: 5000 });

    const result = await lock.release(key, 'not-the-real-token');
    expect(result.released).toBe(false);
    // The real holder can still release it — proves the lock was never touched.
    const realRelease = await lock.release(key, token);
    expect(realRelease.released).toBe(true);
  });

  it('renew() does not extend a lock held by a different token', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    await lock.acquire(key, { ttlMs: 5000 });

    const result = await lock.renew(key, 'not-the-real-token', 5000);
    expect(result.renewed).toBe(false);
    expect(result.uncertain).toBe(false); // this is a confirmed mismatch, not an uncertain outcome
  });

  it('two acquirers racing for the same key: only one gets a token, and only that token controls the lock', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    const [first, second] = await Promise.all([
      lock.acquire(key, { ttlMs: 5000 }),
      lock.acquire(key, { ttlMs: 5000 }),
    ]);
    const winner = first.acquired ? first : second;
    const loser = first.acquired ? second : first;
    expect(winner.acquired).toBe(true);
    expect(loser.acquired).toBe(false);

    // The loser never got a token, so it has nothing to (mis)use — but even
    // a fabricated guess must not work.
    const fakeRelease = await lock.release(key, 'guessed-token');
    expect(fakeRelease.released).toBe(false);
  });
});

describe('edge case: late release', () => {
  it('a release sent after the lock naturally expired and was reacquired by someone else does not steal it back', async () => {
    const client = makeFakeRedis();
    let now = 1_000_000;
    client.__setClock(() => now);
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    const first = await lock.acquire(key, { ttlMs: MIN_TTL_MS });
    now += MIN_TTL_MS + 100; // first's lock has now expired
    const second = await lock.acquire(key, { ttlMs: 5000 });
    expect(second.acquired).toBe(true);

    // first's release arrives late, after second has taken over.
    const lateRelease = await lock.release(key, first.token);
    expect(lateRelease.released).toBe(false);

    // second's lock must still be intact.
    const stillHeld = await lock.acquire(key, { ttlMs: 5000 });
    expect(stillHeld.acquired).toBe(false);
  });
});

describe('edge case: renewal timeout', () => {
  it('renew() reports uncertain (not renewed) when the Redis call rejects', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    const { token } = await lock.acquire(key, { ttlMs: 5000 });

    client.sendCommand = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await lock.renew(key, token, 5000);
    expect(result.renewed).toBe(false);
    expect(result.uncertain).toBe(true);
  });

  it('renew() never throws — a timeout is reported, not propagated as an exception', async () => {
    const client = { sendCommand: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) };
    const lock = createRedisLockService({ client });
    await expect(lock.renew('lock:invoice:t1:inv-1', 'some-token', 5000)).resolves.toMatchObject({ renewed: false, uncertain: true });
  });
});

describe('edge case: Redis restart', () => {
  it('acquire fails structurally (not a crash) during a simulated outage, then succeeds again after recovery', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    client.__simulateOutage(50);
    await expect(lock.acquire(key, { ttlMs: 5000 })).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' });

    await sleep(60);
    const afterRecovery = await lock.acquire(key, { ttlMs: 5000 });
    expect(afterRecovery.acquired).toBe(true);
  });

  it('a held lock does not survive a Redis restart that clears the keyspace (no client-side fallback pretends otherwise)', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    const { token } = await lock.acquire(key, { ttlMs: 5000 });

    // Simulate a Redis restart: the in-memory keyspace is gone.
    client.__store.clear();

    const renewAfterRestart = await lock.renew(key, token, 5000);
    expect(renewAfterRestart.renewed).toBe(false);

    // Another worker can now legitimately acquire the same resource.
    const other = await lock.acquire(key, { ttlMs: 5000 });
    expect(other.acquired).toBe(true);
  });

  it('renew reports uncertain (fails closed) during the outage itself, not renewed-false-but-safe', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    const { token } = await lock.acquire(key, { ttlMs: 5000 });

    client.__simulateOutage(9999);
    const result = await lock.renew(key, token, 5000);
    expect(result.renewed).toBe(false);
    expect(result.uncertain).toBe(true);
  });
});

describe('withLock: edge case: long critical section', () => {
  it('renews the lock in the background so work longer than one TTL window stays protected', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    let renewCallCount = 0;
    const originalSendCommand = client.sendCommand.bind(client);
    client.sendCommand = async (args) => {
      if (args[0] === 'EVAL' && args[1].includes('PEXPIRE')) {
        renewCallCount += 1;
      }
      return originalSendCommand(args);
    };

    const outcome = await lock.withLock({ resourceKey: key, ttlMs: 80, renewIntervalMs: 20 }, async ({ checkLock }) => {
      await sleep(150); // several multiples of both ttlMs and renewIntervalMs
      checkLock();
      return 'done';
    });

    expect(outcome).toEqual({ executed: true, result: 'done' });
    expect(renewCallCount).toBeGreaterThanOrEqual(2);
  });

  it('releases the lock when the critical section completes, allowing immediate reacquisition', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    await lock.withLock({ resourceKey: key, ttlMs: 5000, renewIntervalMs: 1000 }, async () => 'ok');

    const after = await lock.acquire(key, { ttlMs: 5000 });
    expect(after.acquired).toBe(true);
  });

  it('a second worker cannot enter the critical section while the first holds it', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    const firstPromise = lock.withLock({ resourceKey: key, ttlMs: 200, renewIntervalMs: 40 }, async () => {
      await sleep(80);
      return 'first';
    });
    await sleep(10); // let the first worker win the race to acquire
    const second = await lock.withLock({ resourceKey: key, ttlMs: 200, renewIntervalMs: 40 }, async () => 'second');

    expect(second).toEqual({ executed: false, reason: 'lock_held' });
    await expect(firstPromise).resolves.toEqual({ executed: true, result: 'first' });
  });
});

describe('withLock: lock loss during the critical section', () => {
  it('throws LOCK_LOST rather than returning a result when renewal is lost mid-section', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    const promise = lock.withLock({ resourceKey: key, ttlMs: 50, renewIntervalMs: 20 }, async ({ checkLock }) => {
      // Steal the lock out from under withLock partway through, simulating
      // an expiry the renewal loop fails to keep ahead of.
      await sleep(15);
      client.__store.clear();
      await sleep(60); // give the renewal loop time to notice and fail
      checkLock(); // should throw here
      return 'should-not-reach';
    });

    await expect(promise).rejects.toMatchObject({ name: 'RedisLockError', code: 'LOCK_LOST' });
  });

  it('throws LOCK_LOST even if fn never calls checkLock and returns normally', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    const promise = lock.withLock({ resourceKey: key, ttlMs: 50, renewIntervalMs: 20 }, async () => {
      await sleep(15);
      client.__store.clear();
      await sleep(60);
      return 'unprotected-result'; // never checks checkLock itself
    });

    await expect(promise).rejects.toMatchObject({ code: 'LOCK_LOST' });
  });

  it('returns {executed: false} without ever running fn when the lock cannot be acquired at all', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';
    await lock.acquire(key, { ttlMs: 5000 }); // held by someone else

    const fn = jest.fn().mockResolvedValue('should-not-run');
    const outcome = await lock.withLock({ resourceKey: key, ttlMs: 5000, renewIntervalMs: 1000 }, fn);

    expect(outcome).toEqual({ executed: false, reason: 'lock_held' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('releases the lock even when fn throws', async () => {
    const client = makeFakeRedis();
    const lock = createRedisLockService({ client });
    const key = 'lock:invoice:t1:inv-1';

    await expect(
      lock.withLock({ resourceKey: key, ttlMs: 5000, renewIntervalMs: 1000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await lock.acquire(key, { ttlMs: 5000 });
    expect(after.acquired).toBe(true); // released despite fn throwing
  });
});
