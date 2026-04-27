'use strict';

/**
 * @fileoverview Batched escrow read service — implements concurrent on-chain
 * lookups with resource limits, timeouts, and failure isolation.
 *
 * @module services/escrowBatchRead
 */

const { readEscrowState } = require('./escrowRead');
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
 *  - Individual timeouts per call.
 *  - Per-call failure isolation (one failure doesn't crash the batch).
 *
 * @param {string[]} invoiceIds - Array of invoice identifiers to read.
 * @param {Object} [options={}] - Batch options.
 * @param {number} [options.concurrency] - Maximum concurrent RPC calls.
 * @param {number} [options.timeout] - Timeout in ms for each individual call.
 * @param {Object} [options.readOptions={}] - Options passed to `readEscrowState`.
 * @returns {Promise<{results: Object[], errors: Object[]}>} Results and errors.
 */
async function batchReadEscrowStates(invoiceIds, options = {}) {
  let cfg;
  try {
    cfg = config.get();
  } catch (err) {
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
  } = options;

  const results = [];
  const errors = [];
  
  // Use a copy of the IDs to avoid mutating the input
  const remainingIds = [...invoiceIds];
  
  /**
   * Worker function that processes IDs from the queue.
   */
  async function worker() {
    while (remainingIds.length > 0) {
      const id = remainingIds.shift();
      if (!id) continue;

      try {
        // Isolation: Each call is wrapped in its own try/catch and timeout
        const state = await withTimeout(
          readEscrowState(id, readOptions),
          timeout,
          id
        );
        results.push(state);
      } catch (err) {
        logger.error({ invoiceId: id, err: err.message, code: err.code }, 'Batch read failure for invoice');
        errors.push({
          invoiceId: id,
          error: err.message || 'Unknown error',
          code: err.code || 'INTERNAL_ERROR',
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
