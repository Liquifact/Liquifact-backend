'use strict';

const { CircuitBreaker } = require('../utils/circuitBreaker');
const metrics = require('../metrics');
const { redisCacheFailOpenTotal } = metrics;

/**
 * Best-effort metric helper. Returns a no-op counter when the
 * optional counter is not exported by the metrics module so the cache
 * layer never fails because of observability wiring.
 * @param {string} name Metric export name.
 * @returns {{inc: Function}} Counter with an `inc(labels?)` method.
 */
function counter(name) {
  const m = metrics[name];
  if (m && typeof m.inc === 'function') {
    return m;
  }
  return { inc: () => {} };
}

const redisCacheRetryTotal = counter('redisCacheRetryTotal');
const redisCacheCircuitOpenTotal = counter('redisCacheCircuitOpenTotal');
const redisCacheTimeoutTotal = counter('redisCacheTimeoutTotal');
const redisCacheCorruptTotal = counter('redisCacheCorruptTotal');

const DEFAULT_TTL_SECONDS = 30;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 300;

const DEFAULT_LEDGER_GAP_THRESHOLD = 3;
const MAX_LEDGER_GAP_THRESHOLD = 1000;

const DEFAULT_TIMEOUT_MS = 500;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 5000;

const DEFAULT_MAX_RETRIES = 2;
const MAX_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 25;
const MAX_RETRY_BASE_DELAY_MS = 500;

/**
 * Sentinel returned by the circuit breaker fallback so we can
 * distinguish a breaker trip from a genuine Redis `result (including
 * a real `null` GET result). This is the core determinism fix: the
 * failure mode is always explicit and never conflated with a miss.
 */
const CIRCUIT_OPEN_SENTINEL = Symbol('redisCache.circuitOpen');

let redis;
try {
  redis = require('redis');
} catch (_e) {
  redis = null;
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
let redisClient = null;
let isRedisConnected = false;

if (redis && (process.env.NODE_ENV !== 'test' || process.env.USE_REDIS_TEST === 'true')) {
  redisClient = redis.createClient({ url: REDIS_URL });

  redisClient.on('connect', () => {
    isRedisConnected = true;
    console.log('Redis client linked securely.');
  });

  redisClient.on('error', (err) => {
    isRedisConnected = false;
    console.warn('tedis connection degraded or broken:', err.message);
  });

  redisClient.connect().catch((err) => {
    console.warn('Initial Redis connection handshake failed:', err.message);
  });
}

/**
 * Returns the active Redis client context along with its real-time health availability flag.
 *
 * Used by [`src/middleware/rateLimit.js`](../middleware/rateLimit.js) to share
 * the cache-layer Redis client for distributed counters when the operator
 * has not passed an explicit `redisClient` to createRateLimiter(...)
 *
 * @returns {{client: object|null, isAvailable: boolean}} Active client + liveness.
 */
function getRedisClient() {
  return { client: redisClient, isAvailable: isRedisConnected };
}

/**
 * Parses a raw value into a positive integer within a specified range.
 * Boundary semantics:
 *   - non-numeric / empty / null / undefined  -> fallback
 *   - value below min                         -> min
 *   - value above max                         -> max
 *   - fractional values are truncated (parseInt)
 *
 * @param {any} rawValue The value to parse.
 * @param {number} fallback The fallback value if parsing fails.
 * @param {number} min The minimum allowed value.
 * @param {number} max The maximum allowed value.
 * @returns {number} The parsed integer or fallback.
 */
function parsePositiveInt(rawValue, fallback, min, max) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Parses Redis escrow cache configuration from environment variables.
 * @param {Object} env The environment variables object.
 * @returns {Object} The parsed configuration object.
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
    timeoutMs: parsePositiveInt(
      env.REDIS_ESCROW_CACHE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    maxRetries: parsePositiveInt(
      env.REDIS_ESCROW_CACHE_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      0,
      MAX_MAX_RETRIES
    ),
    retryBaseDelayMs: parsePositiveInt(
      env.REDIS_ESCROW_CACHE_RETRY_BASE_DELAY_MS,
      DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      MAX_RETRY_BASE_DELAY_MS
    ),
  };
}

/**
 * Creates a Redis client based on the provided configuration.
 * @param {Object} config The configuration object.
 * @param {Function} [RedisCtor] The Redis constructor for testing.
 * @returns {Object|null} The Redis client or null if not enabled.
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
 * Validates an invoice ID.
 *
 * Accepted input:
 *   - non-empty string of 1..128 characters containing only [a-zA-Z0-9:_-]
 *
 * Rejected input:
 *   - non-string values (null, undefined, numbers, objects, arrays)
 *   - empty string
 *   - strings longer than 128 characters
 *   - strings containing whitespace, slashes, or other unsafe characters
 *
 * @param {string} invoiceId The invoice ID to validate.
 * @returns {boolean} True if the invoice ID is valid.
 */
function isValidInvoiceId(invoiceId) {
  return typeof invoiceId === 'string' && INVOICE_ID_PATTERN.test(invoiceId);
}

/**
 * Validates a cache key prefix.
 *
 * Accepted input:
 *   - non-empty string of 1..64 characters containing only [a-zA-Z0-9:.-]
 *
 * Rejected input:
 *   - non-string values
 *   - empty string
 *   - stings longer than 64 characters
 *   - strings containing whitespace or other unsafe characters
 *
 * @param {string} keyPrefix The key prefix to validate.
 * @returns {boolean} True if the key prefix is valid.
 */
function isValidKeyPrefix(keyPrefix) {
  return typeof keyPrefix === 'string' && KEY_PREFIX_PATTERN.test(keyPrefix);
}

/**
 * Validates a ledger sequence number.
 *
 * Accepted input:
 *   - finite non-negative integer
 *
 * Rejected input:
 *   - NaN, Infinity, fractional values, negative values, non-numbers
 *
 * @param {number} ledger The ledger sequence to validate.
 * @returns {boolean} True if the ledger is valid.
 */
function isValidLedger(ledger) {
  return Number.isInteger(ledger) && ledger >= 0 && ledger <= MAX_CURRENT_LEGGER;
}

/**
 * Validates a summary object for caching.
 *
 * Accepted input:
 *   - non-null object that is not an array
 *   - JSON-serializable with a payload below the maximum byte size
 *
 * Rejected input:
 *   - null, undefined, arrays, primitives
 *   - objects that cannot be serialized or exceed the size limit
 *
 * @param {Object} summary The summary object to validate.
 * @returns {boolean} True if the summary is valid.
 */
function isValidSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return false;
  }
  try {
    const serialized = JSON.stringify(summary);
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= MAX_SUMMARY_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

/**
 * Races a promise against a timeout. Rejects with a timeout error if
 * the promise does not settle within `ms` milliseconds.
 * @param {Promise<any>} promise The promise to race.
 * @param {number} ms Timeout in milliseconds.
 * @returns {Promise<any>} The result of the promise or a timeout rejection.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((r, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Redis operation timed out');
      err.code = 'REDIS_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Deterministic sleep. Used for bounded retry backoff.
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classifies an error into a deterministic failure reason.
 * @param {Error} err The error to classify.
 * @returns {string} One of `timeout`, `circuit_open`, or `error`.
 */
function classifyError(err) {
  if (err && err.code === 'REDIS_TIMEOUT') {
    return 'timeout';
  }
  if (err && (err.code === 'CIRCUIT_BREAKER_OPEN' || err.name === 'CircuitBreakerError')) {
    return 'circuit_open';
  }
  return 'error';
}

/**
 * Records a failure observability event for a given reason.
 * @param {string} reason The failure reason.
 * @returns {void}
 */
function recordFailure(reason) {
  try {
    redisCacheFailOpenTotal.inc();
  } catch {
    /* ignore metric failures */
  }
  if (reason === 'timeout') {
    redisCacheTimeoutTotal.inc();
  } else if (reason === 'circuit_open') {
    redisCacheCircuitOpenTotal.inc();
  }
}

class RedisEscrowSummaryCache {
  /**
   * Initializes the RedisEscrowSummaryCache.
   *
   * @param {Object} root0 Configuration object.
   * @param {Object} root0.client The Redis client.
   * @param {number} [root0.ttlSeconds] Time-to-live in seconds.
   * @param {number} [root0.ledgerGapThreshold] Maximum allowed ledger gap.
   * @param {string} [root0.keyPrefix] Prefix for Redis keys.
   * @param {number} [root0.timeoutMs] Per-operation timeout in milliseconds.
   * @param {Object} [root0.circuitBreaker] Optional CircuitBreaker instance for DI.
   * @param {number} [root0.maxRetries] Maximum retries for transient failures.
   * @param {number} [root0.retryBaseDelayMs] Base delay for exponential retry backoff.
   * @param {Function} [root0.sleepFn] Optional sleep function for deterministic tests.
   */
  constructor({
    client,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    ledgerGapThreshold = DEFAULT_LEDGER_GAP_THRESHOLD,
    keyPrefix = 'escrow:summary',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    circuitBreaker,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    sleepFn = sleep,
  }) {
    this.client = client;
    this.ttlSeconds = ttlSeconds;
    this.ledgerGapThreshold = ledgerGapThreshold;
    this.keyPrefix = keyPrefix;
    this.timeoutMs = timeoutMs;
    this.maxRetries = Math.max(0, maxRetries);
    this.retryBaseDelayMs = Math.max(0, retryBaseDelayMs);
    this.sleepFn = sleepFn;

    /** @type {CircuitBreaker} Shared breaker — falls back to a sentinel so trips are distinguishable. */
    this.circuitBreaker = circuitBreaker || new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeout: 10000,
      fallbackLogic: () => CIRCUIT_OPEN_SENTINEL,
    });
  }

  /**
   * Generates a Redis key for a given invoice ID.
   * @param {string} invoiceId The invoice ID.
   * @returns {string} The Redis key.
   */
  key(invoiceId) {
    return `${this.keyPrefix}:${invoiceId}`;
  }

  /**
   * Executes an operation through the circuit breaker with a bounded
   * timeout and deterministic exponential retry for transient failures.
   *
   * Retries are only attempted for timeout/error failures. A circuit
   * breaker trip is never retried because the breaker is already open
   * and retrying would only add latency without changing the outcome.
   *
   * @param {Function} op Operation factory returning a promise.
   * @returns {Promise<{ok: boolean, value?: any, reason?: string}>}
   */
  async _execute(op) {
    let lastReason = 'error';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        redisCacheRetryTotal.inc();
        // Deterministic exponential backoff: base * 2 ^ (attempt - 1).
        await this.sleepFn(this.retryBaseDelayMs * Math.pow(2, attempt - 1));
      }

      try {
        const value = await this.circuitBreaker.execute(() =>
          withTimeout(op(), this.timeoutMs)
        );

        // Circuit breaker fallback returns the sentinel — not a Redis miss.
        if (value === CIRCUIT_OPEN_SENTINEL) {
          recordFailure('circuit_open');
          return { ok: false, reason: 'circuit_open' };
        }

        return { ok: true, value };
      } catch (err) {
        lastReason = classifyError(err);
        // Circuit open is not retryable.
        if (lastReason === 'circuit_open') {
          recordFailure('circuit_open');
          return { ok: false, reason: 'circuit_open' };
        }
        // Last attempt failed — stop retrying.
        if (attempt >= this.maxRetries) {
          break;
        }
      }
    }

    recordFailure(lastReason);
    return { ok: false, reason: lastReason };
  }

  /**
   * Retrieves an escrow summary from the cache.
   * Wraps the Redis GET in a bounded timeout and circuit breaker.
   * On any Redis/timeout/CB failure, fails open by returning a cache miss
   * so the caller falls through to the DB/RPC layer. The reason is always
   * explicit so callers can distinguish a miss from a degraded dependency.
   *
   * @param {string} invoiceId The invoice ID.
   * @param {number} [currentLedger] The current ledger sequence.
   * @returns {Promise<Object>} The cache result including hit status and value.
   */
  async getSummary(invoiceId, currentLedger) {
    if (!this.client) {
      return { hit: false, reason: 'unavailable' };
    }
    if (!isValidInvoiceId(invoiceId)) {
      return { hit: false, reason: 'invalid_input' };
    }

    const key = this.key(invoiceId);
    const result = await this._execute(() => this.client.get(key));

    try {
      const raw = await this.circuitBreaker.execute(() =>
        withTimeout(this.client.get(key), this.timeoutMs)
      );

      // Circuit breaker fallback returns null — treat as fail-open miss.
      if (raw === null) {
        return { hit: false, reason: 'miss' };
      }

      const entry = JSON.parse(raw);
      if (
        entry === null ||
        typeof entry !== 'object' ||
        !Object.prototype.hasOwnProperty.call(entry, 'summary')
      ) {
        throw new Error('Invalid Redis escrow summary entry');
      }
      if (
        Number.isFinite(currentLedger) &&
        Number.isFinite(entry.cachedLedger) &&
        Math.abs(currentLedger - entry.cachedLedger) > this.ledgerGapThreshold
      ) {
        // Best-effort eviction — failures here are non-critical.
        try {
          await withTimeout(this.client.del(key), this.timeoutMs);
        } catch {
          // Ignore eviction errors; the TTL will handle cleanup.
        }
        return { hit: false, reason: 'ledger_gap' };
      }

      return { hit: true, value: entry.summary };
    } catch {
      // Redis error, timeout, or circuit breaker exception — fail open.
      redisCacheFailOpenTotal.inc();
      return { hit: false, reason: 'fail_open' };
    }

    const raw = result.value;
    if (raw === null || raw === undefined) {
      return { hit: false, reason: 'miss' };
    }

    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      // Corrupt payload — evict it so we do not repeatedly pay the cost.
      redisCacheCorruptTotal.inc();
      try {
        await withTimeout(this.client.del(key), this.timeoutMs);
      } catch {
        /* best-effort eviction */
      }
      return { hit: false, reason: 'corrupt' };
    }

    if (
      !Number.isFinite(currentLedger) && currentLedger !== undefined
    ) {
      // Non-numeric ledger is ignored for gap checking.
    }

    if (
      Number.isFinite(currentLedger) &&
      Number.isFinite(entry.cachedLedger) &&
      Math.abs(currentLedger - entry.cachedLedger) > this.ledgerGapThreshold
    ) {
      // Best-effort eviction — failures here are non-critical.
      try {
        await withTimeout(this.client.del(key), this.timeoutMs);
      } catch {
        // Ignore eviction errors; the TTL will handle cleanup.
      }
      return { hit: false, reason: 'ledger_gap' };
    }

    return { hit: true, value: entry.summary };
  }

  /**
   * Sets an escrow summary in the cache.
   * Wraps the Redis SET in a bounded timeout and circuit breaker.
   * On any failure, fails open by returning false so the caller
   * proceeds without caching. Never throws.
   *
   * Concurrency guarantee: the write is guarded by a monotonic ledger
   * compare-and-set using a Lua script. A concurrent writer cannot clobber
   * a fresher entry with a staler one, and a duplicate retry of the same
   * ledger is a no-op. When the client does not expose `eval`, we fall back
   * to a plain SET so existing callers remain compatible.
   *
   * @param {string} invoiceId The invoice ID.
   * @param {Object} summary The summary object to cache.
   * @param {number} [currentLedger] The current ledger sequence.
   * @returns {Promise<boolean>} True if the summary was successfully cached.
   */
  async setSummary(invoiceId, summary, currentLedger) {
    if (!this.client || !isValidInvoiceId(invoiceId) || summary === undefined) {
      return false;
    }

    const key = this.key(invoiceId);
    try {
      const payload = JSON.stringify({
        summary,
        cachedLedger: Number.isFinite(currentLedger) ? currentLedger : null,
        cachedAt: new Date().toISOString(),
      });
      const result = await this.circuitBreaker.execute(() =>
        withTimeout(this.client.set(key, payload, 'EX', this.ttlSeconds), this.timeoutMs)
      );
    }

    // Keys and ARGV:
    //   KEY1 = cache key
    //    ARGV1 = payload
    //    ARGV2 = ttl seconds
    //    ARGV3 = new ledger (or '' when unknown)
    // Returns 1 on write, 0 on stale/duplicate skip.
    const script = [
      'local existing = redis.call("GET", KEY[1])',
      'if existing then',
      '  local ok = pcall("cjson.decode", existing)',
      '  if ok and ok["cachedLedger"] ~= nil then',
      '    local incoming = tonumber(ARGV[3])',
      '    if incoming and incoming <= tonumber(ok["cachedLedger"]) then',
      '      return 0',
      '    end',
      '  end',
      'end',
      'redis.call("SET", KEY[1], ARGV1, "EX", ARGV[2])',
      'return 1',
    ].join('\\n');

    return withTimeout(
      this.client.eval(script, 1, key, payload, String(this.ttlSeconds), ledger === null ? '' : String(ledger)),
      this.timeoutMs
    );
  }

  /**
   * Deletes an invoice summary after a successful escrow write.
   * Failures are non-fatal because callers can still invalidate their local cache.
   * Idlempotent: deleting a missing key returns 0 and is treated as success.
   * @param {string} invoiceId The invoice ID.
   * @returns {Promise<boolean}> Whether Redis accepted the deletion.
   */
  async deleteSummary(invoiceId) {
    if (!this.client) {
      return false;
    }
    const result = await this._execute(() => this.client.del(this.key(invoiceId)));
    return result.ok;
  }

  /**
   * Best-effort delete that never throws. Used for invalidating corrupt or stale
   * entries during reads; failures are swallowed because the TTL will eventually
   * clean the key up.
   * @param {string} key The Redis key.
   * @returns {Promise<void>}
   * @private
   */
  async _safeDelete(key) {
    try {
      await withTimeout(this.client.del(key), this.timeoutMs);
    } catch {
      // Best-effort only — TTL will reclaim the key.
    }
  }

  return new RedisEscrowSummaryCache({
    client: redisClient,
    ttlSeconds: config.ttlSeconds,
    ledgerGapThreshold: config.ledgerGapThreshold,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    retryBaseDelayMs: config.retryBaseDelayMs,
  });
}

module.exports = {
  RedisEscrowSummaryCache,
  getRedisClient,
  parseRedisEscrowCacheConfig,
  createRedisClient,
  isValidInvoiceId,
  withTimeout,
  isCacheableSummary,
  parseCacheEnvelope,
};
