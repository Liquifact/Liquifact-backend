"use strict";

/**
 * Bounded sliding-window rate limiter for persistence routes.
 *
 * A timestamp log is easy to write but grows with traffic and a fixed-window
 * counter permits a burst at the boundary. This store keeps one current and
 * one previous counter per identity, then weights the previous counter by the
 * fraction of its window that remains. The decision and increment are
 * synchronous, so they cannot interleave within one Node process.
 */

const crypto = require("node:crypto");

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 10;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 1_000_000;

/**
 * Validates a positive bounded integer setting.
 * @param {*} raw Candidate value.
 * @param {number} fallback Value used when raw is invalid.
 * @param {number} maximum Inclusive upper bound.
 * @returns {number} A validated value or the fallback.
 */
function positiveInteger(raw, fallback, maximum) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    return fallback;
  }
  return value;
}

/**
 * Reads and validates the persistence limiter environment configuration.
 * @param {object} [env=process.env] Environment-like settings.
 * @returns {{windowMs: number, maxRequests: number}} Validated settings.
 */
function readConfig(env = process.env) {
  return {
    windowMs: positiveInteger(
      env.PERSISTENCE_RATE_LIMIT_WINDOW_MS,
      DEFAULT_WINDOW_MS,
      MAX_WINDOW_MS,
    ),
    maxRequests: positiveInteger(
      env.PERSISTENCE_RATE_LIMIT_MAX_REQUESTS,
      DEFAULT_MAX_REQUESTS,
      MAX_REQUESTS,
    ),
  };
}

/**
 * Hashes an API key before it is used as an in-memory map key.
 * @param {string} apiKey Secret API key.
 * @returns {string} Hexadecimal SHA-256 digest.
 */
function digestApiKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Selects a stable API-key or IP identity for a persistence request.
 * @param {object} req Express request.
 * @returns {string} Namespaced identity key.
 */
function identityFor(req) {
  const apiKey = req.apiKey || req.headers?.["x-api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return `persistence:apikey:${digestApiKey(apiKey)}`;
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return `persistence:ip:${ip}`;
}

/**
 * Creates the bounded counter state for a new identity.
 * @param {number} now Current epoch time.
 * @returns {object} Empty current and previous window counters.
 */
function newBucket(now) {
  return {
    currentWindowStart: now,
    currentCount: 0,
    previousWindowStart: now,
    previousCount: 0,
  };
}

/**
 * Rolls a counter into the previous window when its window boundary passes.
 * @param {object} bucket Identity counter state.
 * @param {number} now Current epoch time.
 * @param {number} windowMs Window duration.
 * @returns {void}
 */
function roll(bucket, now, windowMs) {
  if (now < bucket.currentWindowStart + windowMs) {
    return;
  }
  if (now < bucket.currentWindowStart + 2 * windowMs) {
    bucket.previousWindowStart = bucket.currentWindowStart;
    bucket.previousCount = bucket.currentCount;
    bucket.currentWindowStart += windowMs;
  } else {
    bucket.previousWindowStart = now;
    bucket.previousCount = 0;
    bucket.currentWindowStart = now;
  }
  bucket.currentCount = 0;
}

/**
 * Calculates the weighted request count for the current point in time.
 * @param {object} bucket Identity counter state.
 * @param {number} now Current epoch time.
 * @param {number} windowMs Window duration.
 * @returns {number} Weighted request count.
 */
function estimate(bucket, now, windowMs) {
  const elapsed = Math.max(
    0,
    Math.min(windowMs, now - bucket.currentWindowStart),
  );
  return bucket.currentCount + bucket.previousCount * (1 - elapsed / windowMs);
}

/**
 * Calculates when the current pressure should allow another request.
 * @param {object} bucket Identity counter state.
 * @param {number} now Current epoch time.
 * @param {number} windowMs Window duration.
 * @param {number} maxRequests Request ceiling.
 * @returns {number} Epoch time at which pressure decays.
 */
function resetAt(bucket, now, windowMs, maxRequests) {
  if (bucket.currentCount >= maxRequests) {
    const decay = windowMs * (1 - maxRequests / bucket.currentCount);
    return bucket.currentWindowStart + windowMs + Math.max(0, decay);
  }
  if (
    bucket.previousCount > 0 &&
    bucket.currentCount + bucket.previousCount >= maxRequests
  ) {
    const needed = maxRequests - bucket.currentCount;
    return (
      bucket.currentWindowStart +
      Math.max(0, windowMs * (1 - needed / bucket.previousCount))
    );
  }
  return Math.max(now + 1, bucket.currentWindowStart + windowMs);
}

/**
 * Rolls a bucket and returns its weighted count and reset timestamp.
 * @param {object} bucket Identity counter state.
 * @param {number} now Current epoch time.
 * @param {object} config Limiter settings.
 * @returns {{estimated: number, resetAt: number}} Current state.
 */
function compactState(bucket, now, config) {
  roll(bucket, now, config.windowMs);
  const estimated = estimate(bucket, now, config.windowMs);
  return {
    estimated,
    resetAt: resetAt(bucket, now, config.windowMs, config.maxRequests),
  };
}

/**
 * Removes empty buckets after both counter windows have expired.
 * @param {Map} store Identity counter store.
 * @param {number} now Current epoch time.
 * @param {object} config Limiter settings.
 * @returns {number} Number of removed buckets.
 */
function prune(store, now, config) {
  let removed = 0;
  for (const [key, bucket] of store.entries()) {
    roll(bucket, now, config.windowMs);
    if (bucket.currentCount === 0 && bucket.previousCount === 0) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Creates an Express middleware backed by a bounded sliding-window store.
 * @param {object} [options] Limiter and testability options.
 * @returns {import('express').RequestHandler} Express middleware.
 */
function createSlidingWindowRateLimiter(options = {}) {
  const {
    clock: providedClock,
    env,
    store: providedStore,
    ...overrides
  } = options;
  const clock = typeof providedClock === "function" ? providedClock : Date.now;
  const config = {
    ...readConfig(env || process.env),
    ...overrides,
  };
  const store = providedStore || new Map();

  const limiter = (req, res, next) => {
    const now = clock();
    prune(store, now, config);
    const key = identityFor(req);
    const bucket = store.get(key) || newBucket(now);
    const state = compactState(bucket, now, config);
    const limited = state.estimated >= config.maxRequests;

    if (limited) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.set("RateLimit-Limit", String(config.maxRequests));
      res.set("RateLimit-Remaining", "0");
      res.set("RateLimit-Reset", String(retryAfter));
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Too Many Requests",
        type: "rate_limited",
        code: "RATE_LIMIT_EXCEEDED",
        message: `Rate limit exceeded. Maximum ${config.maxRequests} requests per ${config.windowMs / 1000} seconds.`,
        retryAfter,
      });
      return;
    }

    bucket.currentCount += 1;
    store.set(key, bucket);
    const after = compactState(bucket, now, config);
    res.set("RateLimit-Limit", String(config.maxRequests));
    res.set(
      "RateLimit-Remaining",
      String(Math.max(0, Math.floor(config.maxRequests - after.estimated))),
    );
    res.set(
      "RateLimit-Reset",
      String(Math.max(1, Math.ceil((after.resetAt - now) / 1000))),
    );
    next();
  };

  limiter.store = store;
  limiter.config = Object.freeze({ ...config });
  limiter.keyGenerator = identityFor;
  limiter.prune = (now = clock()) => prune(store, now, config);
  return limiter;
}

module.exports = {
  DEFAULT_MAX_REQUESTS,
  DEFAULT_WINDOW_MS,
  createSlidingWindowRateLimiter,
  identityFor,
  readConfig,
};
