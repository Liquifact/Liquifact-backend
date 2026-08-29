"use strict";

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

const { createSlidingWindowRateLimiter } = require("./slidingWindowRateLimit");

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
 * @param {object} [_redisClient] - Optional Redis client for distributed limiting.
 * @returns {import('express').RequestHandler} Express rate limiter middleware.
 */
function createPersistenceRateLimiter(_redisClient) {
  // The issue's scope is the in-memory implementation. The argument remains
  // accepted for source compatibility while callers migrate to an explicit
  // shared-store adapter when distributed quotas are needed.
  return createSlidingWindowRateLimiter();
}

module.exports = {
  createPersistenceRateLimiter,
};
