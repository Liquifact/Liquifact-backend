/**
 * Rate Limiting Middleware
 * Protects endpoints from abuse and DoS using IP and token-based limiting.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Standard global rate limiter for all API endpoints.
 * Limits each IP to 100 requests per 15 minutes.
 */
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  message: {
    error: 'Too many requests from this IP, please try again after 15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise fallback to safe IP generator
    return req.user ? `user_${req.user.id}` : ipKeyGenerator(req);
  },
});

/**
 * Stricter limiter for sensitive operations (Invoices, Escrow).
 * Limits each IP or user to 10 requests per hour.
 */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: {
    error: 'Strict rate limit exceeded for sensitive operations. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user ? `user_${req.user.id}` : ipKeyGenerator(req);
  },
});

module.exports = {
  globalLimiter,
  sensitiveLimiter,
};