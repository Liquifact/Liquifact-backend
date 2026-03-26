const { rateLimit } = require('express-rate-limit');

/**
 * Global rate limiter middleware — applied to all routes.
 *
 * @type {import('express').RequestHandler}
 */
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: true,
  message: { error: 'rate limit exceeded, try again later' },
});

/**
 * Sensitive rate limiter middleware — applied to sensitive routes.
 *
 * @type {import('express').RequestHandler}
 */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: true,
  message: { error: 'rate limit exceeded, try again later' },
});

module.exports = { globalLimiter, sensitiveLimiter };
