'use strict';

/**
 * @fileoverview Manual Jest mock for src/services/redisLock.js.
 *
 * Activated by `jest.mock('../src/services/redisLock')` with no factory
 * (Jest resolves to this file automatically because it lives in a sibling
 * `__mocks__` directory — the same convention already used for
 * `src/db/__mocks__/knex.js`).
 *
 * Default behaviour: every lock is always acquired, renewed, and released
 * successfully, and `withLock` just runs `fn` directly. This lets tests
 * that exercise code *using* a lock (e.g. `src/jobs/retentionPurge.js`)
 * run without needing a real or fake Redis connection, while
 * `tests/redisLock.test.js` (the module's own test suite) explicitly does
 * NOT use this mock — it exercises the real implementation against a
 * fully-controlled fake Redis client, which is where the actual
 * locking-safety behaviour (issue #1213) is verified.
 *
 * Tests that need to verify *lock-contention* behavior in a consuming
 * module (e.g. "a second worker is skipped while the first holds the
 * lock") should override specific methods on the object this factory
 * returns — see `tests/retentionPurge.lock.test.js` for the pattern.
 */

const RedisLockError = jest.requireActual('../redisLock').RedisLockError;

function buildResourceKey(namespace, tenantId, resourceId) {
  return `lock:${namespace}:${tenantId}:${resourceId}`;
}

function createRedisLockService() {
  return {
    acquire: jest.fn().mockImplementation(async (resourceKey) => ({
      acquired: true,
      token: 'mock-token',
      resourceKey,
      ttlMs: 30_000,
    })),
    renew: jest.fn().mockResolvedValue({ renewed: true, uncertain: false }),
    release: jest.fn().mockResolvedValue({ released: true, uncertain: false }),
    withLock: jest.fn().mockImplementation(async (_params, fn) => {
      const result = await fn({ checkLock: () => {} });
      return { executed: true, result };
    }),
    buildResourceKey,
  };
}

module.exports = {
  RedisLockError,
  DEFAULT_TTL_MS: 30_000,
  MIN_TTL_MS: 1_000,
  MAX_TTL_MS: 300_000,
  DEFAULT_RENEW_INTERVAL_MS: 10_000,
  buildResourceKey,
  createRedisLockService,
};
