/**
 * @fileoverview Soroban contract interaction wrappers for the LiquiFact API.
 *
 * Wraps raw Soroban / Horizon API calls with the project's exponential-backoff
 * retry utility so that all escrow and invoice state interactions are
 * fault-tolerant against transient network or rate-limit errors.
 *
 * @module services/soroban
 */

'use strict';

const { CircuitBreaker } = require('../utils/circuitBreaker');

/** @type {Object|null} Lazily-loaded metrics module reference. */
let metricsModule = null;

/**
 * Returns the metrics module, loading it at most once.
 * @returns {Object|null}
 */
function getMetrics() {
  if (metricsModule === null) {
    try {
      metricsModule = require('../metrics');
    } catch (_e) {
      metricsModule = false;
    }
  }
  return metricsModule || null;
}

/**
 * Resolves a bounded Soroban RPC method label from config or operation hints.
 *
 * Raw values are normalized through `src/metrics.js` so labels stay bounded
 * and never include payloads, contract IDs, or other request-specific data.
 *
 * @param {Function} operation - Wrapped Soroban operation.
 * @param {object} [config] - Optional retry / metric config.
 * @returns {string} Bounded metric label value.
 */
function getSorobanMetricMethod(operation, config) {
  const metrics = getMetrics();
  const rawMethod = (config && (config.metricMethod || config.method || config.rpcMethod))
    || operation.metricMethod
    || operation.sorobanMethod
    || operation.name;

  if (metrics && typeof metrics.normalizeSorobanRpcMethod === 'function') {
    return metrics.normalizeSorobanRpcMethod(rawMethod);
  }

  return 'unknown';
}

/**
 * Maps a Soroban error classification to a bounded retry-cause metric label.
 *
 * @param {SorobanErrorClassification} classification - Retry classification.
 * @returns {string} Bounded retry-cause label.
 */
function getRetryCauseLabel(classification) {
  if (!classification || !classification.retryable) {
    return 'unknown';
  }

  if (classification.category === 'rate-limit') {
    return '429';
  }

  if (classification.category === 'rpc-5xx') {
    return '5xx';
  }

  if (
    classification.reason === 'network-code:ETIMEDOUT' ||
    classification.reason === 'message:timeout'
  ) {
    return 'timeout';
  }

  return 'unknown';
}

/**
 * Maps a thrown error to a bounded Soroban outcome label.
 *
 * @param {unknown} err - Error thrown by the wrapped call.
 * @returns {string} Bounded outcome label.
 */
function getSorobanOutcomeLabel(err) {
  const metrics = getMetrics();
  const rawOutcome = err && typeof err === 'object' && err.code === 'CIRCUIT_OPEN'
    ? 'circuit_open'
    : 'error';

  if (metrics && typeof metrics.normalizeSorobanRpcOutcome === 'function') {
    return metrics.normalizeSorobanRpcOutcome(rawOutcome);
  }

  return rawOutcome;
}

/**
 * Retry configuration used for all Soroban contract calls.
 *
 * @constant {Object} SOROBAN_RETRY_CONFIG
 * @property {number} maxRetries   - Maximum number of retry attempts (hard-capped at 10).
 * @property {number} baseDelay    - Initial back-off delay in milliseconds.
 * @property {number} maxDelay     - Maximum delay between retries in milliseconds.
 * @property {number} maxElapsedMs - Cumulative elapsed-time budget in milliseconds (hard-capped at 120 000).
 */
const SOROBAN_RETRY_CONFIG = {
  maxRetries: parseInt(process.env.SOROBAN_MAX_RETRIES || '3', 10),
  baseDelay: parseInt(process.env.SOROBAN_BASE_DELAY || '200', 10),
  maxDelay: parseInt(process.env.SOROBAN_MAX_DELAY || '5000', 10),
  maxElapsedMs: parseInt(process.env.SOROBAN_MAX_ELAPSED_MS || '10000', 10),
};

/**
 * Retryable HTTP status codes from Soroban / Horizon.
 *
 * NOTE: This set is kept for backwards compatibility with consumers that
 * reference it directly. The single source of truth for "is this error
 * retryable?" is {@link classifySorobanError}.
 *
 * @constant {Set<number>}
 */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/**
 * Node.js network error codes that indicate a transient, retryable fault at
 * the transport layer (e.g. dropped sockets, DNS hiccups, refused connects).
 *
 * @constant {ReadonlyArray<string>}
 */
const RETRYABLE_NETWORK_CODES = Object.freeze([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
]);

/**
 * Word-boundary regexes for transient signals that appear in error messages.
 *
 * Security note: the previous implementation used raw substring checks like
 * `.includes('503')` which had no defenses against attacker-controlled text.
 * Even a word-boundary regex like `/\b503\b/` is insufficient because it
 * matches in whitespace contexts (e.g. a user-controlled "User 503 not
 * found" payload would coerce a permanent failure into a retry storm).
 *
 * To prevent message-injection retries while preserving signal coverage we
 * rely exclusively on **multi-word phrase patterns** (rate-limit phrases,
 * "service unavailable", "bad gateway", "gateway timeout", "timeout",
 * network names). An attacker would need to forge one of these canonical
 * phrases in a user-controlled field to coerce a retry — substantially
 * harder than slipping the literal digit "503" into a user ID.
 *
 * Bare-numeric matches (`'503'`, `'429'`, …) are intentionally NOT included
 * so that the only path to retrying on a status code is via {@link
 * RETRYABLE_STATUS_CODES} (authoritative `err.status` /
 * `err.response.status`).
 *
 * @constant {Readonly<Record<string, RegExp>>}
 */
const TRANSIENT_MESSAGE_PATTERNS = Object.freeze({
  // Multi-word phrases only; bare digit status codes are deliberately omitted
  // to prevent message-injection retries. See the security note above.
  rateLimit: /\b(?:too many requests|rate[- ]limit(?:ed)?|rate exceeded)\b/i,
  serviceUnavailable: /\bservice unavailable\b/i,
  badGateway: /\bbad gateway\b/i,
  gatewayTimeout: /\bgateway timeout\b/i,
  // Generic transport phrases
  timeout: /\b(?:timeout|timed out|etimedout)\b/i,
  network: /\b(?:network|econnrefused|econnreset)\b/i,
});

/**
 * Shared Circuit Breaker instance for all Soroban RPC reads.
 * Protects against cascading failures by failing fast during sustained outages.
 * State-transition metrics are emitted automatically by the breaker, labeled with name 'soroban'.
 */
const sharedBreaker = new CircuitBreaker({
  name: 'soroban',
  failureThreshold: parseInt(process.env.SOROBAN_CB_FAILURE_THRESHOLD || '5', 10),
  recoveryTimeout: parseInt(process.env.SOROBAN_CB_RECOVERY_TIMEOUT || '10000', 10),
});

/**
 * Sleeps for `ms` milliseconds.
 *
 * @param {number} ms - Duration to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes the next back-off delay using exponential backoff with ±20% jitter.
 *
 * The result is clamped to `[0, maxDelay]`.
 *
 * @param {number} attempt    - Zero-based attempt index.
 * @param {number} baseDelay  - Base delay in ms.
 * @param {number} maxDelay   - Ceiling in ms (hard-capped at 60 000 ms).
 * @returns {number} Delay in milliseconds.
 */
function computeBackoff(attempt, baseDelay, maxDelay) {
  const safeCap = Math.min(maxDelay, 60_000);
  const safeBase = Math.min(baseDelay, 10_000);
  const exp = safeBase * 2 ** attempt;
  const jitter = exp * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.min(Math.max(0, Math.round(exp + jitter)), safeCap);
}

/**
 * Unified classifier for Soroban / Horizon errors — single source of truth.
 *
 * Replaces the previous `isRetryable()` + `isTransientError()` pair, which
 * could disagree on the same error: e.g. a `new Error('timeout')` was non-
 * retryable under the old `isRetryable` because it only inspects code/status,
 * but retryable under `isTransientError` because of a substring match. Two
 * classifiers with overlapping coverage meant behavior depended on which
 * function a given code path happened to call. {@link classifySorobanError}
 * inspects all three signals (structured code, HTTP status, message) under a
 * single set of rules so the verdict is consistent across the codebase.
 *
 * Signal priority (first match wins):
 *   1. Object shape guard — primitives, `null`, `undefined` → permanent.
 *   2. Transport error codes (ETIMEDOUT / ECONNRESET / ECONNREFUSED).
 *   3. HTTP status (top-level `err.status` or `err.response.status`):
 *        - 429                       → retryable, category 'rate-limit'
 *        - 502 / 503 / 504           → retryable, category 'rpc-5xx'
 *   4. Message pattern (only when an `err.message` string exists). All
 *      message patterns use word-boundary regexes so attacker-controlled
 *      text such as user IDs, account numbers, or echoed payload fields
 *      cannot coerce a permanent error into a transient classification.
 *
 * @typedef {Object} SorobanErrorClassification
 * @property {boolean} retryable  - Whether the call should be retried.
 * @property {'network'|'rate-limit'|'rpc-5xx'|'permanent'} category
 *           - Coarse classification used for metrics and logs.
 * @property {string}  reason     - Stable identifier for the matched signal
 *                                  (e.g. 'status:503', 'network-code:ETIMEDOUT',
 *                                  'message:rate-limit'). 'no-transient-signal'
 *                                  when the error is permanent.
 *
 * @param {unknown} err - Error thrown by a Soroban / Horizon call.
 * @returns {SorobanErrorClassification} Stable classification result.
 */
function classifySorobanError(err) {
  if (!err || typeof err !== 'object') {
    return { retryable: false, category: 'permanent', reason: 'invalid-error-shape' };
  }

  // 1. Transport-level network codes (Node.js style). Case-insensitive because
  // the Stellar SDK and Axios sometimes lowercase these.
  const code = typeof err.code === 'string' ? err.code.toUpperCase() : '';
  for (const transientCode of RETRYABLE_NETWORK_CODES) {
    if (transientCode === code) {
      return {
        retryable: true,
        category: 'network',
        reason: `network-code:${transientCode}`,
      };
    }
  }

  // 2. Structured HTTP status (top-level or wrapped in `.response`).
  const rawStatus = err.status ?? (err.response && err.response.status);
  if (rawStatus !== null && rawStatus !== undefined && Number.isInteger(rawStatus)) {
    if (rawStatus === 429) {
      return { retryable: true, category: 'rate-limit', reason: 'status:429' };
    }
    if (rawStatus === 502 || rawStatus === 503 || rawStatus === 504) {
      return { retryable: true, category: 'rpc-5xx', reason: `status:${rawStatus}` };
    }
  }

  // 3. Message patterns. Only consulted when no structured signal fired so the
  // classifier behaves deterministically and prioritizes authoritative data
  // (status / code) over attacker-influenced free text. Bare-digit status codes
  // are intentionally NOT matched here — see {@link TRANSIENT_MESSAGE_PATTERNS}
  // for the security rationale.
  const message = typeof err.message === 'string' ? err.message : '';
  if (message) {
    if (TRANSIENT_MESSAGE_PATTERNS.rateLimit.test(message)) {
      return { retryable: true, category: 'rate-limit', reason: 'message:rate-limit' };
    }
    if (
      TRANSIENT_MESSAGE_PATTERNS.serviceUnavailable.test(message) ||
      TRANSIENT_MESSAGE_PATTERNS.badGateway.test(message) ||
      TRANSIENT_MESSAGE_PATTERNS.gatewayTimeout.test(message)
    ) {
      return { retryable: true, category: 'rpc-5xx', reason: 'message:rpc-5xx' };
    }
    if (TRANSIENT_MESSAGE_PATTERNS.timeout.test(message)) {
      return { retryable: true, category: 'network', reason: 'message:timeout' };
    }
    if (TRANSIENT_MESSAGE_PATTERNS.network.test(message)) {
      return { retryable: true, category: 'network', reason: 'message:network' };
    }
  }

  return { retryable: false, category: 'permanent', reason: 'no-transient-signal' };
}

/**
 * Boolean convenience wrapper around {@link classifySorobanError} kept for
 * backwards compatibility with existing call sites and external consumers.
 *
 * @param {unknown} err - Error to inspect.
 * @returns {boolean} `true` when {@link classifySorobanError} reports the
 *   error is retryable, `false` otherwise.
 */
function isRetryable(err) {
  return classifySorobanError(err).retryable;
}

/**
 * Executes `operation` with automatic exponential-backoff retries for
 * transient Soroban / Horizon errors.
 *
 * Security caps (enforced regardless of `config`):
 *   - `maxRetries`  ≤ 10
 *   - `maxDelay`    ≤ 60 000 ms
 *   - `baseDelay`   ≤ 10 000 ms
 *   - `maxElapsedMs` ≤ 120 000 ms
 *
 * @template T
 * @param {() => Promise<T>} operation - Async function to execute and retry.
 * @param {Object} [config]             - Optional retry configuration override.
 * @param {number} [config.maxRetries]  - Max retry attempts (default 3).
 * @param {number} [config.baseDelay]   - Base delay in ms (default 200).
 * @param {number} [config.maxDelay]    - Max delay in ms (default 5 000).
 * @param {number} [config.maxElapsedMs] - Cumulative elapsed-time budget in ms
 *   (default 10 000). Retries stop once this budget is consumed.
 * @returns {Promise<T>} Resolved value of `operation`.
 * @throws {Error} The last error when all retries are exhausted, when the
 *   elapsed-time budget is exhausted, or when the error is not retryable.
 *
 * @example
 * const data = await withRetry(() => horizonClient.getAccount(publicKey));
 */
async function withRetry(operation, config) {
  const cfg = Object.assign({}, SOROBAN_RETRY_CONFIG, config);
  const maxRetries = Math.min(cfg.maxRetries, 10);
  const maxElapsedMs = Math.min(cfg.maxElapsedMs, 120_000);

  const startTime = Date.now();
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      const classification = classifySorobanError(err);
      const isLast = attempt === maxRetries;
      if (isLast || !classification.retryable) {
        throw err;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= maxElapsedMs) {
        const metrics = getMetrics();
        if (metrics && metrics.sorobanRetryBudgetExhaustedTotal) {
          metrics.sorobanRetryBudgetExhaustedTotal.inc();
        }
        throw err;
      }

      const metrics = getMetrics();
      if (metrics && metrics.sorobanRpcRetryCausesTotal) {
        const cause = typeof metrics.normalizeSorobanRetryCause === 'function'
          ? metrics.normalizeSorobanRetryCause(getRetryCauseLabel(classification))
          : getRetryCauseLabel(classification);
        metrics.sorobanRpcRetryCausesTotal.labels({ cause }).inc();
      }

      const delay = computeBackoff(attempt, cfg.baseDelay, cfg.maxDelay);
      await sleep(delay);
    }
  }

  // Unreachable, but satisfies linters.
  throw lastErr;
}

/**
 * Calls a Soroban contract operation with automatic retry on transient errors.
 *
 * This is the primary entry point used by route handlers.  It delegates to
 * {@link withRetry} using the project-wide {@link SOROBAN_RETRY_CONFIG}.
 *
 * @template T
 * @param {() => Promise<T>} operation - Async function wrapping the contract call.
 * @param {Object} [config] - Optional retry configuration overrides.
 * @returns {Promise<T>} Result of the contract call.
 *
 * @example
 * const state = await callSorobanContract(() =>
 *   client.invokeContract('get_escrow_state', [invoiceId])
 * );
 */
async function callSorobanContract(operation, config) {
  const cfg = config ? { ...SOROBAN_RETRY_CONFIG, ...config } : SOROBAN_RETRY_CONFIG;
  const metrics = getMetrics();
  const method = getSorobanMetricMethod(operation, cfg);
  const endTimer = metrics && metrics.sorobanRpcCallDurationSeconds
    ? metrics.sorobanRpcCallDurationSeconds.startTimer({ method })
    : null;

  try {
    const result = await sharedBreaker.execute(() => withRetry(operation, cfg));
    if (typeof endTimer === 'function') {
      endTimer({ outcome: 'success' });
    }
    return result;
  } catch (err) {
    if (typeof endTimer === 'function') {
      endTimer({ outcome: getSorobanOutcomeLabel(err) });
    }
    throw err;
  }
}

module.exports = {
  callSorobanContract,
  withRetry,
  computeBackoff,
  // Unified classifier (single source of truth). New code should call this.
  classifySorobanError,
  // Back-compat boolean wrapper around classifySorobanError.retryable.
  isRetryable,
  // Exposed for legacy consumers / tests that introspect the allowlist directly.
  RETRYABLE_STATUS_CODES,
  SOROBAN_RETRY_CONFIG,
  sharedBreaker,
  getRetryCauseLabel,
  getSorobanMetricMethod,
  getSorobanOutcomeLabel,
};
