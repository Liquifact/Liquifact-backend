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

/**
 * Circuit breaker instance for Soroban API calls.
 */
const sorobanCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  recoveryTimeout: 15000,
});

/**
 * Retry configuration used for all Soroban contract calls.
 *
 * @constant {Object} SOROBAN_RETRY_CONFIG
 * @property {number} maxRetries  - Maximum number of retry attempts (hard-capped at 10).
 * @property {number} baseDelay   - Initial back-off delay in milliseconds.
 * @property {number} maxDelay    - Maximum delay between retries in milliseconds.
 */
const SOROBAN_RETRY_CONFIG = {
  maxRetries: parseInt(process.env.SOROBAN_MAX_RETRIES || '3', 10),
  baseDelay: parseInt(process.env.SOROBAN_BASE_DELAY || '200', 10),
  maxDelay: parseInt(process.env.SOROBAN_MAX_DELAY || '5000', 10),
};

/**
 * Retryable HTTP status codes from Soroban / Horizon.
 *
 * @constant {Set<number>}
 */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

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
 * Determines whether an error from a Soroban call is transient and should
 * trigger a retry.
 *
 * @param {unknown} err - Error thrown by the operation.
 * @returns {boolean} `true` if the call should be retried.
 */
function isRetryable(err) {
  if (!err) { return false; }
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') { return true; }
  if (err.status !== null && err.status !== undefined && RETRYABLE_STATUS_CODES.has(err.status)) { return true; }
  if (err.response && RETRYABLE_STATUS_CODES.has(err.response.status)) { return true; }
  return false;
}

/**
 * Executes `operation` with automatic exponential-backoff retries for
 * transient Soroban / Horizon errors.
 *
 * Security caps (enforced regardless of `config`):
 *   - `maxRetries` ≤ 10
 *   - `maxDelay`   ≤ 60 000 ms
 *   - `baseDelay`  ≤ 10 000 ms
 *
 * @template T
 * @param {() => Promise<T>} operation - Async function to execute and retry.
 * @param {Object} [config]            - Optional retry configuration override.
 * @param {number} [config.maxRetries] - Max retry attempts (default 3).
 * @param {number} [config.baseDelay]  - Base delay in ms (default 200).
 * @param {number} [config.maxDelay]   - Max delay in ms (default 5 000).
 * @returns {Promise<T>} Resolved value of `operation`.
 * @throws {Error} The last error when all retries are exhausted or the error
 *   is not retryable.
 *
 * @example
 * const data = await withRetry(() => horizonClient.getAccount(publicKey));
 */
async function withRetry(operation, config) {
  const cfg = Object.assign({}, SOROBAN_RETRY_CONFIG, config);
  const maxRetries = Math.min(cfg.maxRetries, 10);

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxRetries;
      if (isLast || !isRetryable(err)) { throw err; }

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
 * @returns {Promise<T>} Result of the contract call.
 *
 * @example
 * const state = await callSorobanContract(() =>
 *   client.invokeContract('get_escrow_state', [invoiceId])
 * );
 */
async function callSorobanContract(operation) {
  return sorobanCircuitBreaker.execute(() => withRetry(operation, SOROBAN_RETRY_CONFIG));
}

module.exports = {
  callSorobanContract,
  withRetry,
  computeBackoff,
  isRetryable,
  SOROBAN_RETRY_CONFIG,
  RETRYABLE_STATUS_CODES,
};