'use strict';

/**
 * @fileoverview Per-client rate limiting for persistence endpoints.
 *
 * Implements configurable rate limiting for persistence routes (SME invoice
 * uploads) to prevent abuse and accidental overload. Limits are applied
 * per-client using API key or IP address as the client identifier.
 *
 * Returns 429 Too Many Requests with a Retry-After header when limits
 * are exceeded. Configuration is driven by environment variables.
 *
 * @module middleware/persistenceRateLimit
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const logger = require('../logger');

/**
 * Creates a rate limiter for persistence endpoints.
 *
 * Configuration:
 * - PERSISTENCE_RATE_LIMIT_WINDOW_MS: Time window in milliseconds (default: 60000 = 1 minute)
 * - PERSISTENCE_RATE_LIMIT_MAX_REQUESTS: Max requests per window per client (default: 10)
 * - REDIS_URL: Optional Redis connection URL for distributed rate limiting
 *
 * Key derivation:
 * 1. If API key is present in request, use API key
 * 2. Otherwise, use client IP address
 *
 * @param {object} [redisClient] - Optional Redis client for distributed limiting.
 * @returns {import('express').RequestHandler} Express rate limiter middleware.
 */
function createPersistenceRateLimiter(redisClient) {
  const windowMs = parseInt(process.env.PERSISTENCE_RATE_LIMIT_WINDOW_MS, 10) || 60000; // 1 minute default
  const maxRequests = parseInt(process.env.PERSISTENCE_RATE_LIMIT_MAX_REQUESTS, 10) || 10; // 10 requests default

  const limiterConfig = {
    windowMs,
    max: maxRequests,
    // Use API key if available, otherwise use IP
    keyGenerator: (req, res) => {
      // API key takes precedence for rate limit key generation
      if (req.apiKey) {
        return `persistence:apikey:${req.apiKey}`;
      }
      // Fall back to IP address
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      return `persistence:ip:${clientIp}`;
    },
    // Custom handler for rate limit exceeded
    handler: (req, res) => {
      const retryAfter = req.rateLimit.resetTime
        ? Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
        : Math.ceil(windowMs / 1000);

      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too Many Requests',
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowMs / 1000} seconds.`,
        retryAfter,
      });
    },
    // Skip successful rate limit checks
    skip: (req, res) => false,
    // Log rate limit events for monitoring
    onLimitReached: (req, res, options) => {
      const clientId = options.keyGenerator(req, res);
      logger.warn(
        { clientId, windowMs, maxRequests },
        'Persistence endpoint rate limit reached',
      );
    },
  };

  // Use Redis store if available for distributed rate limiting
  if (redisClient) {
    limiterConfig.store = new RedisStore({
      client: redisClient,
      prefix: 'persistence-ratelimit:',
      expiry: Math.ceil(windowMs / 1000),
    });
  }

  return rateLimit(limiterConfig);
}

module.exports = {
  createPersistenceRateLimiter,
};
