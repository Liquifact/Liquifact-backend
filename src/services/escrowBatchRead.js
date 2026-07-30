'use strict';

/**
 * @fileoverview Batched escrow read service — implements concurrent on-chain
 * lookups with resource limits, timeouts, and failure isolation.
 *
 * @module services/escrowBatchRead
 */

const { readEscrowState } = require('./escrowRead');
const { classifySorobanError, withRetry, SOROBAN_RETRY_CONFIG } = require('./soroban');
const logger = require('../logger');
const config = require('../config');

/**
 * Executes a promise with a timeout.
 *
 * @param {Promise<T>} promise - The promise to wrap.
 * @param {number} ms - Timeout in milliseconds.
 * @param {string} [id] - Identifier for logging.
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, id) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`On-chain read timed out after ${ms}ms${id ? ` for ${id}` : ''}`);
      err.code = 'ETIMEDOUT';
      err.status = 504;
      reject(err);
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Performs batched on-chain reads for a list of invoice IDs.
 *
 * Implements:
 *  - Concurrency limits to prevent RPC flooding.
 *  - Individual timeouts per call (including retries).
 *  - Per-call failure isolation (one failure doesn't crash the batch).
 *  - Automatic retry of transient errors (timeouts, 5xx, rate limits) using
 *    the unified Soroban error classifier.
 *
 * @param {string[]} invoiceIds - Array of invoice identifiers to read.
 * @param {Object} [options={}] - Batch options.
 * @param {number} [options.concurrency] - Maximum concurrent RPC calls.
 * @param {number} [options.timeout] - Timeout in ms for each individual call
 *   (including all retry attempts).
 * @param {Object} [options.readOptions={}] - Options passed to `readEscrowState`.
 * @param {Object} [options.retryConfig={}] - Optional retry configuration overrides.
 *   If not provided, uses the global SOROBAN_RETRY_CONFIG. The retry budget
 *   is automatically capped to respect the per-invoice timeout.
 * @returns {Promise<{results: Object[], errors: Object[]}>} Results and errors.
 */
async function batchReadEscrowStates(invoiceIds, options = {}) {
  let cfg;
  try {
    cfg = config.get();
  } catch (_err) {
    // Fallback for tests or before config is validated
    cfg = {
      SOROBAN_BATCH_CONCURRENCY: 5,
      SOROBAN_BATCH_TIMEOUT_MS: 5000,
    };
  }

  const {
    concurrency = cfg.SOROBAN_BATCH_CONCURRENCY,
    timeout = cfg.SOROBAN_BATCH_TIMEOUT_MS,
    readOptions = {},
    retryConfig = {},
  } = options;

  const results = [];
  const errors = [];
  
  // Use a copy of the IDs to avoid mutating the input
  const remainingIds = [...invoiceIds];
  
  /**
   * Worker function that processes IDs from the queue.
   *
   * For each invoice ID:
   * 1. Wraps the read operation with retry logic for transient errors using
   *    the unified Soroban error classifier (`classifySorobanError`).
   * 2. Applies a timeout to the entire operation (including all retries).
   * 3. Isolates failures so one error doesn't stop the batch.
   *
   * The retry budget is automatically capped to respect the per-invoice timeout,
   * preventing retries from blowing the batch budget. This ensures that even under
   * sustained failure, the service cannot amplify load into a self-DoS.
   *
   * Error classification and retry behavior:
   * - Transient errors (timeouts, 5xx, rate limits) are retried with exponential
   *   backoff before being recorded as failed.
   * - Permanent errors (e.g., 400 Bad Request) are not retried and immediately
   *   recorded as failed.
   * - All errors are classified using `classifySorobanError` for consistent
   *   behavior across the codebase.
   *
   * @returns {Promise<void>}
   */
  async function worker() {
    while (remainingIds.length > 0) {
      const id = remainingIds.shift();
      if (!id) { continue; }

      try {
        // Cap the retry budget to respect the per-invoice timeout.
        // This prevents retries from blowing the batch budget.
        const cappedRetryConfig = {
          ...SOROBAN_RETRY_CONFIG,
          ...retryConfig,
          maxElapsedMs: Math.min(
            retryConfig.maxElapsedMs ?? SOROBAN_RETRY_CONFIG.maxElapsedMs,
            timeout * 0.9 // Reserve 10% of timeout for final call overhead
          ),
        };

        // Isolation: Each call is wrapped in its own try/catch, timeout, and retry logic
        const state = await withTimeout(
          withRetry(() => readEscrowState(id, readOptions), cappedRetryConfig),
          timeout,
          id
        );
        results.push(state);
      } catch (err) {
        const classification = classifySorobanError(err);
        logger.error(
          { 
            invoiceId: id, 
            err: err.message, 
            code: err.code, 
            retryable: classification.retryable,
            category: classification.category,
            reason: classification.reason 
          }, 
          'Batch read failure for invoice'
        );
        errors.push({
          invoiceId: id,
          error: err.message || 'Unknown error',
          code: err.code || 'INTERNAL_ERROR',
          retryable: classification.retryable,
          category: classification.category,
          reason: classification.reason,
        });
      }
    }
  }

  // Launch initial workers up to the concurrency limit
  const workers = [];
  const workerCount = Math.min(concurrency, invoiceIds.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return {
    results,
    errors,
  };
}

module.exports = {
  batchReadEscrowStates,
};
