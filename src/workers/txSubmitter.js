'use strict';

const JobQueue = require('./jobQueue');
const BackgroundWorker = require('./worker');
const logger = require('../logger');

const DEFAULT_CONFIG = {
  maxRetries: Math.min(parseInt(process.env.SOROBAN_TX_SUBMIT_MAX_RETRIES || '3', 10), 10),
  baseDelayMs: Math.min(parseInt(process.env.SOROBAN_TX_SUBMIT_BASE_DELAY_MS || '500', 10), 10000),
  maxDelayMs: Math.min(parseInt(process.env.SOROBAN_TX_SUBMIT_MAX_DELAY_MS || '20000', 10), 60000),
  feeBumpMultiplier: Math.min(parseFloat(process.env.SOROBAN_TX_FEE_BUMP_MULTIPLIER || '2'), 10),
};

/**
 * Determines if a transaction submission error is retryable.
 * @param {Error} err - Error to check
 * @returns {boolean} True if error is retryable
 */
function isRetryableSubmitError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const code = String(err.code || '').toLowerCase();
  if (['etimedout', 'econnreset', 'eai_again', 'enotfound'].includes(code)) {
    return true;
  }

  const message = String(err.message || err).toLowerCase();
  if (message.includes('tx_bad_seq') || message.includes('timeout') || message.includes('timed out') || message.includes('transaction_timeout')) {
    return true;
  }

  const resultCode = err.result?.code || err.result?.result?.code;
  if (typeof resultCode === 'string' && resultCode.toLowerCase().includes('tx_bad_seq')) {
    return true;
  }

  return false;
}

/**
 * Computes exponential backoff delay for transaction retries.
 * @param {number} attempt - Current attempt number
 * @param {number} baseDelay - Base delay in milliseconds
 * @param {number} maxDelay - Maximum delay in milliseconds
 * @returns {number} Delay in milliseconds
 */
function computeTxBackoff(attempt, baseDelay, maxDelay) {
  const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
  return Math.max(0, delay);
}

/**
 * Executes a transaction submission operation with retry logic.
 * @param {Function} operation - Operation to execute
 * @param {Object} [config] - Retry configuration
 * @returns {Promise<*>} Operation result
 */
async function submitWithRetry(operation, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    try {
      return await operation({ attempt, feeBumpMultiplier: cfg.feeBumpMultiplier });
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === cfg.maxRetries;
      if (isLastAttempt || !isRetryableSubmitError(err)) {
        throw err;
      }
      const delayMs = computeTxBackoff(attempt, cfg.baseDelayMs, cfg.maxDelayMs);
      logger.warn({ attempt, delayMs, error: err.message || err, retryable: true }, 'Retrying Soroban transaction submission after transient failure');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Handles a transaction submission job from the queue.
 * @param {Object} job - Job payload
 * @param {Function} submitTransactionFn - Transaction submission function
 * @param {Object} [config] - Retry configuration
 * @returns {Promise<Object>} Job result
 */
async function handleTxSubmitJob(job, submitTransactionFn, config = {}) {
  if (!job || typeof job.payload !== 'object' || job.payload === null) {
    throw new Error('Invalid tx submit job payload');
  }
  if (typeof submitTransactionFn !== 'function') {
    throw new Error('submitTransactionFn must be supplied');
  }

  const payload = job.payload;
  if (typeof payload.signedTransactionXdr !== 'string' || payload.signedTransactionXdr.trim() === '') {
    throw new Error('signedTransactionXdr is required for transaction submission');
  }

  return submitWithRetry(async (context) => {
    return submitTransactionFn(payload, context);
  }, config);
}

/**
 * Creates a transaction submitter worker instance.
 * @param {Function} submitTransactionFn - Transaction submission function
 * @param {Object} [options] - Worker configuration options
 * @returns {Object} Transaction submitter worker
 */
function createTxSubmitterWorker(submitTransactionFn, options = {}) {
  const txQueue = new JobQueue({ maxRetries: 0 });
  const txWorker = new BackgroundWorker({ jobQueue: txQueue, pollIntervalMs: options.pollIntervalMs ?? 100, maxConcurrency: options.maxConcurrency ?? 1 });

  txWorker.registerHandler('submit_soroban_tx', async (job) => {
    return handleTxSubmitJob(job, submitTransactionFn, options.retryConfig);
  });

  return {
    txQueue,
    txWorker,
    enqueueTxSubmission: (payload, enqueueOptions = {}) => txQueue.enqueue('submit_soroban_tx', payload, enqueueOptions),
  };
}

module.exports = {
  createTxSubmitterWorker,
  submitWithRetry,
  isRetryableSubmitError,
  computeTxBackoff,
  handleTxSubmitJob,
  DEFAULT_CONFIG,
};
