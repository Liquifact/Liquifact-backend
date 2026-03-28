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
  /**
   * Generates a rate-limit key per user ID or IP address.
   * @param {import('express').Request} req - Express request object
   * @returns {string} The rate-limit key
   */
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise fallback to safe IP generator
    return req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip);
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
  /**
   * Generates a rate-limit key per user ID or IP address.
   * @param {import('express').Request} req - Express request object
   * @returns {string} The rate-limit key
   */
  keyGenerator: (req) => {
    return req.user ? `user_${req.user.id}` : ipKeyGenerator(req.ip);
  },
});

module.exports = {
  globalLimiter,
  sensitiveLimiter,
};