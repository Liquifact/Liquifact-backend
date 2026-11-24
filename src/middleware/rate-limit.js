'use strict';

/**
 * In-memory per-client sliding-window rate limiter.
 *
 * Uses a two-counter sliding-window approximation (current + weighted previous
 * window) with bounded client state (LRU eviction + lazy expiry pruning).
 *
 * Identity precedence:
 *   1. Authenticated API key (Authorization: Bearer <key> or X-API-Key: <key>),
 *      hashed with SHA-256 so raw secrets never appear in limiter state.
 *   2. Client IP (req.ip, falling back to socket remoteAddress).
 *
 * For failed admin/cron authentication attempts, a separate stricter bucket
 * keyed strictly by IP prevents brute-forcing with rotating tokens.
 */

const crypto = require('crypto');
const config = require('../config');
const { sendProblem } = require('../errors');
const { extractKey } = require('./auth');

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 1_000_000;
const MAX_CLIENTS_UPPER = 1_000_000;

/**
 * Hashes a raw secret with SHA-256 hex.
 *
 * @param {string} value raw value
 * @returns {string} 64-char lowercase hex digest
 */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Normalizes a positive integer option with upper/lower bounds.
 *
 * @param {number|undefined} value candidate value
 * @param {number} fallback default value
 * @param {number} max maximum allowed value
 * @returns {number} bounded positive integer
 */
function normalizePositiveInt(value, fallback, max) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max) {
    return value;
  }
  return fallback;
}

/**
 * Derives a namespaced client key from an Express request.
 * Raw API keys are always SHA-256 hashed before being returned.
 *
 * @param {import('express').Request} req incoming request
 * @param {{ namespace?: string, keyBy?: 'apikey-or-ip' | 'ip' }} [options]
 * @returns {string} client identity key
 */
function getClientKey(req, { namespace = 'api', keyBy = 'apikey-or-ip' } = {}) {
  if (keyBy !== 'ip') {
    const extracted = extractKey(req);
    if (extracted.state === 'ok' && extracted.key) {
      return `${namespace}:apikey:${sha256Hex(extracted.key)}`;
    }
  }
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${namespace}:ip:${ip}`;
}

/**
 * Creates a bounded in-memory sliding-window counter store.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs=60000] window duration in ms
 * @param {number} [options.max=60] max requests per sliding window
 * @param {number} [options.maxClients=10000] max tracked client identities
 * @param {() => number} [options.now] clock function returning ms since epoch
 */
function createSlidingWindowStore(options = {}) {
  const windowMs = normalizePositiveInt(options.windowMs, config.rateLimit.windowMs, MAX_WINDOW_MS);
  const max = normalizePositiveInt(options.max, config.rateLimit.max, MAX_REQUESTS);
  const maxClients = normalizePositiveInt(options.maxClients, config.rateLimit.maxClients, MAX_CLIENTS_UPPER);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** @type {Map<string, { currentWindowStart: number, currentCount: number, previousWindowStart: number, previousCount: number }>} */
  const clients = new Map();

  /**
   * Removes expired client records whose current and previous windows have elapsed.
   *
   * @param {number} [nowMs] current timestamp in ms
   * @returns {number} number of removed records
   */
  function prune(nowMs = now()) {
    const currentWindowStart = Math.floor(nowMs / windowMs) * windowMs;
    let removed = 0;
    for (const [key, record] of clients.entries()) {
      if (currentWindowStart - record.currentWindowStart >= 2 * windowMs) {
        clients.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Rolls a record's counters forward to the window containing `nowMs`.
   *
   * @param {object} record existing client record
   * @param {number} windowStart aligned start of the current window
   */
  function rollRecord(record, windowStart) {
    if (record.currentWindowStart === windowStart) {
      return;
    }
    if (windowStart - record.currentWindowStart === windowMs) {
      record.previousWindowStart = record.currentWindowStart;
      record.previousCount = record.currentCount;
      record.currentWindowStart = windowStart;
      record.currentCount = 0;
      return;
    }
    record.previousWindowStart = windowStart - windowMs;
    record.previousCount = 0;
    record.currentWindowStart = windowStart;
    record.currentCount = 0;
  }

  /**
   * Computes sliding-window state for a record at `nowMs`.
   *
   * @param {object} record rolled client record
   * @param {number} nowMs current timestamp in ms
   * @param {number} windowStart aligned start of the current window
   */
  function evaluate(record, nowMs, windowStart) {
    const elapsed = Math.max(0, Math.min(windowMs, nowMs - windowStart));
    const weight = 1 - elapsed / windowMs;
    const estimated = record.currentCount + record.previousCount * weight;

    if (estimated >= max) {
      let waitMs;
      if (record.currentCount < max && record.previousCount > 0) {
        const neededWeight = (max - record.currentCount) / record.previousCount;
        const targetElapsed = windowMs * (1 - neededWeight);
        waitMs = Math.max(1, targetElapsed - elapsed);
      } else {
        waitMs = Math.max(1, windowMs - elapsed);
      }
      const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
      return {
        allowed: false,
        limit: max,
        remaining: 0,
        resetSeconds: retryAfter,
        retryAfter,
        estimated,
        weight,
        elapsed,
      };
    }

    const resetSeconds = Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
    return {
      allowed: true,
      limit: max,
      remaining: Math.max(0, Math.floor(max - estimated)),
      resetSeconds,
      retryAfter: 0,
      estimated,
      weight,
      elapsed,
    };
  }

  /**
   * Checks whether a key is currently allowed without incrementing its counter.
   *
   * @param {string} key client key
   * @param {number} [nowMs] current timestamp in ms
   */
  function peek(key, nowMs = now()) {
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const record = clients.get(key);
    if (!record) {
      return {
        allowed: true,
        limit: max,
        remaining: max,
        resetSeconds: Math.max(1, Math.ceil((windowMs - (nowMs - windowStart)) / 1000)),
        retryAfter: 0,
      };
    }
    rollRecord(record, windowStart);
    const res = evaluate(record, nowMs, windowStart);
    return {
      allowed: res.allowed,
      limit: res.limit,
      remaining: res.remaining,
      resetSeconds: res.resetSeconds,
      retryAfter: res.retryAfter,
    };
  }

  /**
   * Synchronously checks and (if allowed) consumes one request slot for `key`.
   *
   * @param {string} key client key
   * @param {number} [nowMs] current timestamp in ms
   */
  function consume(key, nowMs = now()) {
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    let record = clients.get(key);

    if (record) {
      // Refresh LRU position
      clients.delete(key);
      rollRecord(record, windowStart);
      clients.set(key, record);
    } else {
      if (clients.size >= maxClients) {
        prune(nowMs);
        while (clients.size >= maxClients) {
          const oldestKey = clients.keys().next().value;
          if (oldestKey === undefined) {
            break;
          }
          clients.delete(oldestKey);
        }
      }
      record = {
        currentWindowStart: windowStart,
        currentCount: 0,
        previousWindowStart: windowStart - windowMs,
        previousCount: 0,
      };
      clients.set(key, record);
    }

    const check = evaluate(record, nowMs, windowStart);
    if (!check.allowed) {
      return {
        allowed: false,
        limit: check.limit,
        remaining: 0,
        resetSeconds: check.resetSeconds,
        retryAfter: check.retryAfter,
      };
    }

    record.currentCount += 1;
    const afterEstimated = record.currentCount + record.previousCount * check.weight;
    return {
      allowed: true,
      limit: max,
      remaining: Math.max(0, Math.floor(max - afterEstimated)),
      resetSeconds: check.resetSeconds,
      retryAfter: 0,
    };
  }

  return {
    windowMs,
    max,
    maxClients,
    consume,
    peek,
    prune,
    clear: () => clients.clear(),
    size: () => clients.size,
    keys: () => Array.from(clients.keys()),
  };
}

/**
 * Sets standard RateLimit-* headers on a response.
 *
 * @param {import('express').Response} res response
 * @param {{ limit: number, remaining: number, resetSeconds: number }} result limiter result
 */
function setRateLimitHeaders(res, result) {
  res.set('RateLimit-Limit', String(result.limit));
  res.set('RateLimit-Remaining', String(result.remaining));
  res.set('RateLimit-Reset', String(result.resetSeconds));
}

/**
 * Sends a 429 application/problem+json response with Retry-After and RateLimit-* headers.
 *
 * @param {import('express').Request} req request
 * @param {import('express').Response} res response
 * @param {{ limit: number, remaining: number, resetSeconds: number, retryAfter: number }} result limiter result
 * @param {number} windowMs window duration in ms
 */
function sendRateLimitExceeded(req, res, result, windowMs) {
  setRateLimitHeaders(res, result);
  res.set('Retry-After', String(result.retryAfter));
  return sendProblem(req, res, 'RATE_LIMIT_EXCEEDED', {
    detail: `Rate limit exceeded. Maximum ${result.limit} requests per ${Math.ceil(windowMs / 1000)} seconds.`,
    extra: { retryAfter: result.retryAfter },
  });
}

/**
 * Creates an Express rate-limiting middleware backed by a sliding-window store.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs] window duration in ms
 * @param {number} [options.max] max requests per window
 * @param {number} [options.maxClients] max tracked clients
 * @param {string} [options.namespace='api'] key namespace
 * @param {'apikey-or-ip' | 'ip'} [options.keyBy='apikey-or-ip'] identity strategy
 * @param {() => number} [options.now] clock function
 */
function createRateLimiter(options = {}) {
  const namespace = options.namespace || 'api';
  const keyBy = options.keyBy || 'apikey-or-ip';
  const store = options.store || createSlidingWindowStore(options);

  const middleware = function rateLimitMiddleware(req, res, next) {
    const key = getClientKey(req, { namespace, keyBy });
    const result = store.consume(key);
    setRateLimitHeaders(res, result);

    if (!result.allowed) {
      return sendRateLimitExceeded(req, res, result, store.windowMs);
    }
    return next();
  };

  middleware.store = store;
  middleware.prune = (nowMs) => store.prune(nowMs);
  middleware.reset = () => store.clear();
  return middleware;
}

// Default shared limiters
const mutatingLimiter = createRateLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  maxClients: config.rateLimit.maxClients,
  namespace: 'mutating',
  keyBy: 'apikey-or-ip',
});

const adminAuthFailureStore = createSlidingWindowStore({
  windowMs: config.rateLimit.adminAuthWindowMs,
  max: config.rateLimit.adminAuthMax,
  maxClients: config.rateLimit.maxClients,
});

/**
 * Checks whether the caller's IP is currently blocked by the failed-admin-auth
 * limiter. If blocked, sends 429 problem+json and returns false.
 *
 * @param {import('express').Request} req request
 * @param {import('express').Response} res response
 * @returns {boolean} true if allowed to attempt auth, false if 429 was sent
 */
function checkAdminAuthLimit(req, res) {
  const key = getClientKey(req, { namespace: 'admin-auth-fail', keyBy: 'ip' });
  const status = adminAuthFailureStore.peek(key);
  if (!status.allowed) {
    sendRateLimitExceeded(req, res, status, adminAuthFailureStore.windowMs);
    return false;
  }
  return true;
}

/**
 * Records a failed admin/cron authentication attempt for the caller's IP.
 *
 * @param {import('express').Request} req request
 * @param {import('express').Response} res response
 */
function recordAdminAuthFailure(req, res) {
  const key = getClientKey(req, { namespace: 'admin-auth-fail', keyBy: 'ip' });
  const result = adminAuthFailureStore.consume(key);
  setRateLimitHeaders(res, result);
  return result;
}

/**
 * Clears all default in-memory limiter stores (intended for tests).
 */
function resetAllLimiters() {
  mutatingLimiter.reset();
  adminAuthFailureStore.clear();
}

module.exports = {
  createRateLimiter,
  createSlidingWindowStore,
  getClientKey,
  mutatingLimiter,
  adminAuthFailureStore,
  checkAdminAuthLimit,
  recordAdminAuthFailure,
  resetAllLimiters,
};
