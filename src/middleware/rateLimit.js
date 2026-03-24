const { AppError } = require('../errors/AppError');

/**
 * In-memory store for deterministic rate-limit accounting.
 */
class MemoryRateLimitStore {
  constructor() {
    this.entries = new Map();
  }

  /**
   * Increment the request counter for a key inside the current time window.
   *
   * @param {string} key Identifier for the caller.
   * @param {number} nowMs Current timestamp in milliseconds.
   * @param {number} windowMs Window size in milliseconds.
   * @returns {{ count: number, resetTimeMs: number }}
   */
  increment(key, nowMs, windowMs) {
    const current = this.entries.get(key);

    if (!current || current.resetTimeMs <= nowMs) {
      const nextEntry = { count: 1, resetTimeMs: nowMs + windowMs };
      this.entries.set(key, nextEntry);
      return nextEntry;
    }

    current.count += 1;
    return current;
  }
}

/**
 * Create a small in-memory rate limiter for abuse-path testing.
 *
 * @param {{ windowMs?: number, maxRequests?: number, store?: MemoryRateLimitStore, now?: () => number, keyGenerator?: (req: import('express').Request) => string }} [options]
 * @returns {import('express').RequestHandler}
 */
function createRateLimitMiddleware(options = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const maxRequests = options.maxRequests ?? 5;
  const store = options.store ?? new MemoryRateLimitStore();
  const now = options.now ?? (() => Date.now());
  const keyGenerator =
    options.keyGenerator ??
    ((req) => req.ip || req.header('x-forwarded-for') || 'unknown');

  return (req, res, next) => {
    const key = String(keyGenerator(req) || 'unknown');
    const state = store.increment(key, now(), windowMs);
    const remaining = Math.max(maxRequests - state.count, 0);
    const retryAfterSeconds = Math.max(Math.ceil((state.resetTimeMs - now()) / 1000), 0);

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetTimeMs / 1000)));

    if (state.count > maxRequests) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      next(
        new AppError({
          status: 429,
          code: 'RATE_LIMITED',
          message: 'Too many requests were sent to this endpoint.',
          retryable: true,
          retryHint: 'Wait for the rate-limit window to reset before retrying.',
        }),
      );
      return;
    }

    next();
  };
}

module.exports = {
  MemoryRateLimitStore,
  createRateLimitMiddleware,
};
