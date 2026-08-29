'use strict';

/**
 * @fileoverview Redis-backed distributed lock, safe across clock skew and
 * renewal loss (issue #1213).
 *
 * Prior art in this codebase: `src/jobs/escrowIndexer.js` already implements
 * a single-leader fencing-token lease against Postgres — expiry compared
 * against the *database's* clock (`NOW()`), an ownership token checked
 * atomically on renew/release, and a typed `LeaseLostError` for fail-closed
 * behaviour. This module brings the same safety properties to a
 * many-resource (per-invoice, per-tenant) lock backed by Redis instead of
 * Postgres, for callers that need mutual exclusion across worker processes
 * without a Postgres round trip:
 *
 *   - **Server-side expiry, not a client-computed deadline.** `acquire()`
 *     sets the key with Redis's own `PX` TTL. No code anywhere compares a
 *     locally-stored "expires at" timestamp against `Date.now()` to decide
 *     whether a lock is still held — that comparison is exactly what breaks
 *     under clock skew between workers. Redis alone decides when a key
 *     expires.
 *   - **Ownership token, validated atomically on release AND renewal.**
 *     Every lock is stamped with a random token. `release()` and `renew()`
 *     both run a Lua script that only acts when the stored value still
 *     matches the caller's token — a worker can never release or extend a
 *     lock it does not currently hold (see the "owner token mismatch" and
 *     "late release" tests).
 *   - **Fail closed when renewal is uncertain.** If a renewal call cannot
 *     be confirmed (Redis unreachable, a timeout, a dropped connection), it
 *     is treated as failed, never as succeeded. A network blip must never
 *     be silently interpreted as "the lock is still mine" (see the
 *     "renewal timeout" and "Redis restart" tests).
 *   - **No client-side safety net required.** If a process crashes, loses
 *     network, or otherwise never calls `release()`, the lock still expires
 *     on its own via the server-side TTL — safety does not depend on any
 *     client staying alive or well-behaved.
 *
 * @module services/redisLock
 */

const crypto = require('crypto');
const logger = require('../logger');

/** Default lock lifetime if the caller does not specify one. */
const DEFAULT_TTL_MS = 30_000;
/** Hard floor on TTL — a lock shorter than this is not meaningfully safe against normal network jitter. */
const MIN_TTL_MS = 1_000;
/** Hard ceiling on TTL — bounds how long a crashed holder can block a resource before Redis reclaims it. */
const MAX_TTL_MS = 300_000;
/** Default interval between renewals for `withLock`'s background renewal loop. Well under the default TTL so at least two renewal attempts fit inside one TTL window. */
const DEFAULT_RENEW_INTERVAL_MS = 10_000;

/**
 * Atomically releases a lock only if the caller's token still matches the
 * value stored at the key.
 *
 * Returns 1 if released, 0 if the token did not
 * match (already released, expired, or held by someone else) or the key
 * did not exist.
 */
const RELEASE_SCRIPT = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

/**
 * Atomically extends a lock's TTL only if the caller's token still matches
 * the value stored at the key.
 *
 * Returns 1 if renewed, 0 if the token did not
 * match or the key did not exist (already expired or stolen).
 */
const RENEW_SCRIPT = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end';

class RedisLockError extends Error {
  /**
   * Creates a typed distributed-lock error.
   *
   * @param {string} code - Stable machine-readable code (see class doc for the set used by this module).
   * @param {string} message - Human-readable, secret-free description.
   * @param {unknown} [cause] - Underlying error, if any. Never included in `message`.
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'RedisLockError';
    this.code = code;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/**
 * Clamps a caller-supplied TTL into the safe [MIN_TTL_MS, MAX_TTL_MS] range.
 *
 * @param {number} ttlMs - Caller-requested TTL.
 * @returns {number} Bounded TTL in milliseconds.
 */
function boundTtl(ttlMs) {
  const numeric = Number(ttlMs);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(Math.max(Math.trunc(numeric), MIN_TTL_MS), MAX_TTL_MS);
}

/**
 * Builds a tenant-scoped resource key. Tenant isolation is structural, not
 * conventional: two tenants can never contend for, release, or renew each
 * other's lock, because their keys never collide in the keyspace.
 *
 * @param {string} namespace - Logical resource type, e.g. `'invoice'`.
 * @param {string} tenantId - Owning tenant.
 * @param {string} resourceId - Resource identifier within that tenant.
 * @returns {string} Redis key.
 */
function buildResourceKey(namespace, tenantId, resourceId) {
  if (!namespace || !tenantId || !resourceId) {
    throw new RedisLockError('INVALID_LOCK_KEY', 'namespace, tenantId, and resourceId are all required to build a lock key.');
  }
  return `lock:${namespace}:${tenantId}:${resourceId}`;
}

/**
 * Creates a Redis lock service.
 *
 * @param {object} [options]
 * @param {{sendCommand: Function}} [options.client] - Injectable Redis
 *   client (must expose `sendCommand`, matching the low-level calling
 *   convention already used by `src/middleware/rateLimit.js`). Defaults to
 *   the shared client from `src/cache/redis.js`. Tests should always inject
 *   a fake client rather than relying on the default.
 * @returns {{acquire: Function, renew: Function, release: Function, withLock: Function, buildResourceKey: Function}}
 */
function createRedisLockService({ client: injectedClient } = {}) {
  /**
   * Resolves the Redis client to use for this call — the injected client if
   * one was provided, otherwise the shared client from `src/cache/redis.js`.
   *
   * @returns {{sendCommand: Function}} Client exposing the low-level `sendCommand` interface.
   */
  function getClient() {
    if (injectedClient) {
      return injectedClient;
    }
    const { getRedisClient } = require('../cache/redis');
    const { client, isAvailable } = getRedisClient();
    if (!client || !isAvailable) {
      throw new RedisLockError('LOCK_UNAVAILABLE', 'Redis is not available for distributed locking.');
    }
    return client;
  }

  /**
   * Attempts to acquire a lock. Never blocks or retries — a caller that
   * wants retry-with-backoff composes that on top of this (see
   * `withLock`'s single-attempt-then-report-failure default, which callers
   * can wrap in `src/utils/retry.js` if they want retries).
   *
   * @param {string} resourceKey - Key from {@link buildResourceKey}.
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=30000] - Lock lifetime, clamped to [1000, 300000]ms.
   * @returns {Promise<{acquired: boolean, token: string|null, resourceKey: string, ttlMs: number}>}
   */
  async function acquire(resourceKey, { ttlMs = DEFAULT_TTL_MS } = {}) {
    const boundedTtl = boundTtl(ttlMs);
    const token = crypto.randomUUID();
    let client;
    try {
      client = getClient();
    } catch (error) {
      if (error instanceof RedisLockError) {
        throw error;
      }
      throw new RedisLockError('LOCK_UNAVAILABLE', 'Redis is not available for distributed locking.', error);
    }
    let result;
    try {
      result = await client.sendCommand(['SET', resourceKey, token, 'PX', String(boundedTtl), 'NX']);
    } catch (error) {
      throw new RedisLockError('LOCK_UNAVAILABLE', 'Failed to acquire distributed lock due to a Redis error.', error);
    }
    const acquired = result === 'OK';
    return acquired
      ? { acquired: true, token, resourceKey, ttlMs: boundedTtl }
      : { acquired: false, token: null, resourceKey, ttlMs: boundedTtl };
  }

  /**
   * Attempts to extend a held lock's TTL. Fails closed: any error reaching
   * Redis (timeout, connection drop, restart) is reported as NOT renewed —
   * this function never assumes success when it cannot confirm it.
   *
   * @param {string} resourceKey - Key from {@link buildResourceKey}.
   * @param {string} token - Ownership token returned by {@link acquire}.
   * @param {number} [ttlMs=30000] - New TTL to set, clamped to [1000, 300000]ms.
   * @returns {Promise<{renewed: boolean, uncertain: boolean}>} `uncertain: true` means the renewal could not be confirmed at all (Redis error) rather than being confirmed as lost (token mismatch/expired).
   */
  async function renew(resourceKey, token, ttlMs = DEFAULT_TTL_MS) {
    const boundedTtl = boundTtl(ttlMs);
    let client;
    try {
      client = getClient();
    } catch (error) {
      logger.warn({ resourceKey, err: error.message }, 'Distributed lock renewal uncertain: Redis unavailable.');
      return { renewed: false, uncertain: true };
    }
    try {
      const result = await client.sendCommand(['EVAL', RENEW_SCRIPT, '1', resourceKey, token, String(boundedTtl)]);
      return { renewed: Number(result) === 1, uncertain: false };
    } catch (error) {
      // Fail closed: an error here means we cannot tell whether the PEXPIRE
      // landed before the connection dropped, so the safe assumption is
      // that it did not.
      logger.warn({ resourceKey, err: error.message }, 'Distributed lock renewal uncertain: Redis call failed.');
      return { renewed: false, uncertain: true };
    }
  }

  /**
   * Releases a held lock. Best-effort: if Redis is unreachable, this simply
   * logs and returns — the lock still expires on its own via the
   * server-side TTL set at {@link acquire} time, so no caller needs a
   * fallback deadline to stay safe.
   *
   * @param {string} resourceKey - Key from {@link buildResourceKey}.
   * @param {string} token - Ownership token returned by {@link acquire}.
   * @returns {Promise<{released: boolean, uncertain: boolean}>}
   */
  async function release(resourceKey, token) {
    let client;
    try {
      client = getClient();
    } catch (error) {
      logger.warn({ resourceKey, err: error.message }, 'Failed to release distributed lock; it will expire naturally via TTL.');
      return { released: false, uncertain: true };
    }
    try {
      const result = await client.sendCommand(['EVAL', RELEASE_SCRIPT, '1', resourceKey, token]);
      return { released: Number(result) === 1, uncertain: false };
    } catch (error) {
      logger.warn({ resourceKey, err: error.message }, 'Failed to release distributed lock; it will expire naturally via TTL.');
      return { released: false, uncertain: true };
    }
  }

  /**
   * Runs `fn` while holding a lock, renewing it in the background so a
   * critical section that runs longer than one TTL window stays protected
   * ("long critical section"). If a renewal is ever lost or uncertain, the
   * lock is considered lost for the remainder of this call.
   *
   * Cancellation is **cooperative, not preemptive**: this function cannot
   * forcibly interrupt `fn` mid-execution (JS has no safe primitive for
   * that). Instead, `fn` receives a `{ checkLock }` helper — a long-running
   * `fn` should call `checkLock()` between steps of its own work; it throws
   * a `RedisLockError('LOCK_LOST', ...)` the moment the background renewal
   * loop has detected loss. `fn` implementations that do not call
   * `checkLock()` are still protected on the way out: if the lock was lost
   * at any point during the call, `withLock` throws after `fn` resolves
   * rather than returning its result, so a caller can never silently treat
   * unprotected work as having completed safely.
   *
   * @param {object} params
   * @param {string} params.resourceKey - Key from {@link buildResourceKey}.
   * @param {number} [params.ttlMs=30000] - Lock TTL per acquire/renew cycle.
   * @param {number} [params.renewIntervalMs=10000] - How often to renew; should be well under `ttlMs`.
   * @param {(ctx: {checkLock: () => void}) => Promise<*>} fn - Critical-section work.
   * @returns {Promise<{executed: true, result: *} | {executed: false, reason: 'lock_held'}>}
   * @throws {RedisLockError} `LOCK_LOST` if the lock was lost or its status became uncertain at any point during `fn`.
   */
  async function withLock({ resourceKey, ttlMs = DEFAULT_TTL_MS, renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS }, fn) {
    const acquireResult = await acquire(resourceKey, { ttlMs });
    if (!acquireResult.acquired) {
      return { executed: false, reason: 'lock_held' };
    }
    const { token } = acquireResult;

    let lockLost = false;
    let lockLostReason = null;
    const renewTimer = setInterval(() => {
      renew(resourceKey, token, ttlMs)
        .then(({ renewed, uncertain }) => {
          if (!renewed) {
            lockLost = true;
            lockLostReason = uncertain ? 'renewal_uncertain' : 'lost';
          }
        })
        .catch(() => {
          // renew() already fails closed internally and never rejects in
          // normal operation; this catch exists only so an unforeseen
          // rejection can't produce an unhandled promise rejection.
          lockLost = true;
          lockLostReason = 'renewal_uncertain';
        });
    }, renewIntervalMs);
    if (typeof renewTimer.unref === 'function') {
      renewTimer.unref();
    }

    const checkLock = () => {
      if (lockLost) {
        throw new RedisLockError('LOCK_LOST', `Distributed lock lost during critical section (${lockLostReason}).`);
      }
    };

    try {
      const result = await fn({ checkLock });
      checkLock();
      return { executed: true, result };
    } finally {
      clearInterval(renewTimer);
      await release(resourceKey, token);
    }
  }

  return { acquire, renew, release, withLock, buildResourceKey };
}

module.exports = {
  RedisLockError,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  DEFAULT_RENEW_INTERVAL_MS,
  buildResourceKey,
  createRedisLockService,
};
