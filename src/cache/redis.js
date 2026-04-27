'use strict';

const DEFAULT_TTL_SECONDS = 30;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 300;

const DEFAULT_LEDGER_GAP_THRESHOLD = 3;
const MAX_LEDGER_GAP_THRESHOLD = 1000;

/**
 * Parses and validates a positive integer from environment variable.
 * @param {string|number} rawValue - Raw value to parse
 * @param {number} fallback - Fallback value if parsing fails
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number} Parsed and clamped integer value
 */
function parsePositiveInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Parses Redis escrow cache configuration from environment variables.
 * @param {Object} [env=process.env] - Environment variables object
 * @returns {Object} Redis cache configuration
 */
function parseRedisEscrowCacheConfig(env = process.env) {
  const enabled = String(env.REDIS_ESCROW_CACHE_ENABLED || '').toLowerCase() === 'true';
  const redisUrl = env.REDIS_URL || '';

  return {
    enabled: enabled && Boolean(redisUrl),
    redisUrl,
    ttlSeconds: parsePositiveInt(
      env.REDIS_ESCROW_CACHE_TTL_SECONDS,
      DEFAULT_TTL_SECONDS,
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS
    ),
    ledgerGapThreshold: parsePositiveInt(
      env.REDIS_ESCROW_LEDGER_GAP_THRESHOLD,
      DEFAULT_LEDGER_GAP_THRESHOLD,
      1,
      MAX_LEDGER_GAP_THRESHOLD
    ),
  };
}

/**
 * Creates a Redis client instance for escrow caching.
 * @param {Object} config - Redis configuration
 * @param {Function} [RedisCtor] - Redis constructor (for testing)
 * @returns {Object|null} Redis client instance or null if disabled
 */
function createRedisClient(config = parseRedisEscrowCacheConfig(), RedisCtor) {
  if (!config.enabled) {
    return null;
  }

  const Redis = RedisCtor || require('ioredis');
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

/**
 * Validates invoice ID format.
 * @param {string} invoiceId - Invoice ID to validate
 * @returns {boolean} True if invoice ID is valid
 */
function isValidInvoiceId(invoiceId) {
  return typeof invoiceId === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(invoiceId);
}

class RedisEscrowSummaryCache {
  /**
   * Creates Redis escrow cache instance.
   * @param {Object} root0 - Configuration object
   * @param {Object} root0.client - Redis client instance
   * @param {number} root0.ttlSeconds - Cache TTL in seconds
   * @param {number} root0.ledgerGapThreshold - Ledger gap threshold
   * @param {string} root0.keyPrefix - Cache key prefix
   */
  constructor({
    client,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    ledgerGapThreshold = DEFAULT_LEDGER_GAP_THRESHOLD,
    keyPrefix = 'escrow:summary',
  }) {
    this.client = client;
    this.ttlSeconds = ttlSeconds;
    this.ledgerGapThreshold = ledgerGapThreshold;
    this.keyPrefix = keyPrefix;
  }

  /**
   * Generates cache key for invoice.
   * @param {string} invoiceId - Invoice ID
   * @returns {string} Cache key
   */
  key(invoiceId) {
    return `${this.keyPrefix}:${invoiceId}`;
  }

  /**
   * Retrieves escrow summary from cache.
   * @param {string} invoiceId - Invoice ID
   * @param {number} currentLedger - Current ledger sequence
   * @returns {Promise<Object>} Cache result with hit status and value
   */
  async getSummary(invoiceId, currentLedger) {
    if (!this.client || !isValidInvoiceId(invoiceId)) {
      return { hit: false, reason: 'invalid_input' };
    }

    const key = this.key(invoiceId);

    try {
      const raw = await this.client.get(key);
      if (!raw) {
        return { hit: false, reason: 'miss' };
      }

      const entry = JSON.parse(raw);
      if (
        Number.isFinite(currentLedger) &&
        Number.isFinite(entry.cachedLedger) &&
        Math.abs(currentLedger - entry.cachedLedger) > this.ledgerGapThreshold
      ) {
        await this.client.del(key);
        return { hit: false, reason: 'ledger_gap' };
      }

      return { hit: true, value: entry.summary };
    } catch (_error) {
      return { hit: false, reason: 'cache_error' };
    }
  }

  /**
   * Stores escrow summary in cache.
   * @param {string} invoiceId - Invoice ID
   * @param {Object} summary - Escrow summary data
   * @param {number} currentLedger - Current ledger sequence
   * @returns {Promise<boolean>} True if successfully cached
   */
  async setSummary(invoiceId, summary, currentLedger) {
    if (!this.client || !isValidInvoiceId(invoiceId)) {
      return false;
    }

    const key = this.key(invoiceId);
    const payload = JSON.stringify({
      summary,
      cachedLedger: Number.isFinite(currentLedger) ? currentLedger : null,
      cachedAt: new Date().toISOString(),
    });

    try {
      await this.client.set(key, payload, 'EX', this.ttlSeconds);
      return true;
    } catch (_error) {
      return false;
    }
  }
}

/**
 * Factory function to create Redis escrow summary cache.
 * @param {Object} root0 - Configuration object
 * @param {Object} root0.env - Environment variables
 * @param {Object} root0.client - Redis client instance
 * @param {Function} root0.RedisCtor - Redis constructor
 * @returns {Object|null} Cache instance or null
 */
function createRedisEscrowSummaryCache({ env = process.env, client, RedisCtor } = {}) {
  const config = parseRedisEscrowCacheConfig(env);
  const redisClient = client || createRedisClient(config, RedisCtor);

  if (!redisClient) {
    return null;
  }

  return new RedisEscrowSummaryCache({
    client: redisClient,
    ttlSeconds: config.ttlSeconds,
    ledgerGapThreshold: config.ledgerGapThreshold,
  });
}

module.exports = {
  RedisEscrowSummaryCache,
  createRedisClient,
  createRedisEscrowSummaryCache,
  isValidInvoiceId,
  parseRedisEscrowCacheConfig,
};
