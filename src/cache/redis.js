'use strict';

const DEFAULT_TTL_SECONDS = 30;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 300;

const DEFAULT_LEDGER_GAP_THRESHOLD = 3;
const MAX_LEDGER_GAP_THRESHOLD = 1000;

/**
 *
 * @param rawValue
 * @param fallback
 * @param min
 * @param max
 */
function parsePositiveInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 *
 * @param env
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
 *
 * @param config
 * @param RedisCtor
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
 *
 * @param invoiceId
 */
function isValidInvoiceId(invoiceId) {
  return typeof invoiceId === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(invoiceId);
}

class RedisEscrowSummaryCache {
  /**
   *
   * @param root0
   * @param root0.client
   * @param root0.ttlSeconds
   * @param root0.ledgerGapThreshold
   * @param root0.keyPrefix
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
   *
   * @param invoiceId
   */
  key(invoiceId) {
    return `${this.keyPrefix}:${invoiceId}`;
  }

  /**
   *
   * @param invoiceId
   * @param currentLedger
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
   *
   * @param invoiceId
   * @param summary
   * @param currentLedger
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
 *
 * @param root0
 * @param root0.env
 * @param root0.client
 * @param root0.RedisCtor
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
