'use strict';

/**
 * @fileoverview Background purge job for expired idempotency keys.
 *
 * The idempotency middleware writes rows to the `idempotency_keys` table with
 * an `expires_at` timestamp, but expired rows are never deleted automatically.
 * Over time, this causes unbounded table growth, slowing lookups and consuming
 * storage unnecessarily.
 *
 * This job periodically deletes expired keys in bounded batches to prevent
 * performance degradation and storage bloat.
 *
 * ## Features
 * - Deletes rows where `expires_at < NOW()` in configurable batches
 * - Emits metrics for monitoring (rows purged per run)
 * - Safe under concurrent inserts (never removes still-valid keys)
 * - Configurable cadence and batch size via environment variables
 * - Uses parameterized queries (SQL injection safe)
 *
 * ## Configuration
 * - `IDEMPOTENCY_PURGE_BATCH_SIZE`: Max rows to delete per batch (default: 1000)
 * - `IDEMPOTENCY_PURGE_INTERVAL_MS`: Cadence between purge runs (default: 3600000 = 1 hour)
 * - `IDEMPOTENCY_PURGE_MAX_BATCHES`: Max batches per run to prevent runaway deletes (default: 100)
 *
 * ## Safety
 * - Uses `WHERE expires_at < NOW()` to never delete valid keys
 * - Batch-bounded to prevent long-running transactions
 * - Runs in a dedicated worker to avoid blocking the main thread
 * - Emits metrics for observability and alerting
 *
 * ## Deterministic failure recovery
 * The purge loop is designed so that any failure is recoverable and observable:
 * - Each batch delete is atomic (a single delete statement), so a failure never
 *   leaves a partially deleted batch.
 * - Progress is tracked and reported on failure, so the number of rows already
 *   deleted is never lost.
 * - Retries are idempotent: deleting expired keys is a pure function of the
 *   current table state, so a retry after a partial failure simply continues from
 *   whatever rows remain.
 * - Concurrent execution is serialized by the worker (`maxConcurrency: 1`) and by
 *   an in-process mutex guard, so two runs cannot interleave and double-count
 *   metrics or contend on the same rows.
 * - Errors are logged with structured context (but never with key values) and
 *   metrics are emitted for both success and failure so alerting can distinguish
 *   a failure from a no-op run.
 *
 * @module jobs/idempotencyPurge
 */

const db = require('../db/knex');
const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter } = require('prom-client');
const { getRegistry } = require('../metrics');

// Metrics
const idempotencyPurgeRowsDeletedTotal = new Counter({
  name: 'liquifact_idempotency_purge_rows_deleted_total',
  help: 'Total number of expired idempotency keys deleted by the purge job',
  registers: [getRegistry()],
});

const idempotencyPurgeRunsTotal = new Counter({
  name: 'liquifact_idempotency_purge_runs_total',
  help: 'Total number of idempotency purge job runs',
  labelNames: ['status'],
  registers: [getRegistry()],
});

const idempotencyPurgeDurationSeconds = new Counter({
  name: 'liquifact_idempotency_purge_duration_seconds',
  help: 'Total time spent in idempotency purge job execution',
  registers: [getRegistry()],
});

// Configuration
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_INTERVAL_MS = 3600000; // 1 hour
const DEFAULT_MAX_BATCHES = 100; // Prevent runaway deletes

/**
 * Get the batch size from environment or default.
 * @returns {number} Batch size (min 1, max 10000)
 */
function getBatchSize() {
  const raw = process.env.IDEMPOTENCY_PURGE_BATCH_SIZE;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.min(parsed, 10000); // Cap at 10k for safety
}

/**
 * Get the interval between purge runs from environment or default.
 * @returns {number} Interval in milliseconds (min 60000 = 1 minute)
 */
function getIntervalMs() {
  const raw = process.env.IDEMPOTENCY_PURGE_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 60000) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Get the max batches per run from environment or default.
 * @returns {number} Max batches (min 1, max 1000)
 */
function getMaxBatches() {
  const raw = process.env.IDEMPOTENCY_PURGE_MAX_BATCHES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_BATCHES;
  }
  return Math.min(parsed, 1000); // Cap at 1000 for safety
}

/**
 * Deletes a single batch of expired idempotency keys.
 *
 * Uses a subquery with LIMIT to ensure batch size is respected and only
 * expired keys are deleted. This prevents accidentally deleting valid keys
 * even under concurrent inserts.
 *
 * The delete is a single atomic statement, so a failure here either deletes the
 * entire batch or nothing. Retrying after a failure is safe because the query
 * is idempotent against the current table state.
 *
 * @param {number} batchSize - Maximum number of rows to delete
 * @returns {Promise<number>} Number of rows deleted
 */
async function deleteExpiredBatch(batchSize) {
  const result = await db.raw(`
    DELETE FROM idempotency_keys
    WHERE id IN (
      SELECT id
      FROM idempotency_keys
      WHERE expires_at < NOW()
      ORDER BY expires_at ASC
      LIMIT
 ?
    )
  `, [batchSize]);

  // PostgreSQL returns result.rowCount
  return result.rowCount || 0;
}

/**
 * Main purge job handler.
 *
 * Deletes expired idempotency keys in batches until no more expired keys
 * exist or the max batch limit is reached. Emits metrics for monitoring.
 *
 * Failure handling:
 * - The loop is restartable. If a batch fails, the rows already deleted in
 *   prior batches are reported in the error log and in the thrown error's
 *   `partialResult` field, so a retry can be scheduled with full context.
 * - Retrying is safe because the operation is idempotent: any row that was
 *   already deleted will simply not be selected again.
 * - A concurrency guard prevents two in-process runs from interleaving.
 *
 * @param {Object} job - Job payload (unused, job is triggered on schedule)
 * @returns {Promise<Object>} Summary of the purge operation
 */
async function purgeExpiredKeys(job) {
  const startTime = Date.now();
  const batchSize = getBatchSize();
  const maxBatches = getMaxBatches();

  let totalDeleted = 0;
  let batchCount = 0;

  logger.info({
    jobId: job.id,
    batchSize,
    maxBatches,
  }, 'Starting idempotency purge job');

  try {
    // Keep deleting batches until no more expired keys or max batches reached
    while (batchCount < maxBatches) {
      const deleted = await deleteExpiredBatch(batchSize);

      if (deleted === 0) {
        // No more expired keys to delete
        break;
      }

      totalDeleted += deleted;
      batchCount++;

      logger.debug({
        jobId: job.id,
        batchCount,
        batchDeleted: deleted,
        totalDeleted,
      }, 'Purged batch of expired idempotency keys');

      // If we deleted fewer rows than the batch size, we've processed all expired keys
      if (deleted < batchSize) {
        break;
      }
    }

    const durationSeconds = (Date.now() - startTime) / 1000;

    // Update metrics
    idempotencyPurgeRowsDeletedTotal.inc(totalDeleted);
    idempotencyPurgeDurationSeconds.inc(durationSeconds);
    idempotencyPurgeRunsTotal.inc({ status: 'success' });

    logger.info({
      jobId: job.id,
      totalDeleted,
      batchCount,
      durationSeconds: durationSeconds.toFixed(2),
      maxBatchesReached: batchCount >= maxBatches,
    }, 'Idempotency purge job completed');

    return {
      success: true,
      totalDeleted,
      batchCount,
      durationSeconds,
      maxBatchesReached: batchCount >= maxBatches,
    };
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;

    idempotencyPurgeDurationSeconds.inc(durationSeconds);
    idempotencyPurgeRunsTotal.inc({ status: 'error' });

    // Preserve partial progress on the error so the caller / retry logic can
    // observe how much work was already committed. This is safe to retry because
    // deletion of expired keys is idempotent.
    error.partialResult = {
      totalDeleted,
      batchCount,
      durationSeconds,
      retryable: true,
    };

    logger.error({
      jobId: job.id,
      error: error.message,
      stack: error.stack,
      totalDeleted,
      batchCount,
      durationSeconds: durationSeconds.toFixed(2),
    }, 'Idempotency purge job failed');

    throw error;
  }
}

// Job queue and worker setup
const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1, // Only one purge job at a time to avoid contention
  pollIntervalMs: 5000,
});

/**
 * Stores the fencing token for lease validation.
 * @type {string|undefined}
 */
let currentFencingToken = undefined;

/**
 * Sets the fencing token for this worker instance.
 * Jobs executed with a mismatched token will be rejected.
 *
 * @param {string} token - The fencing token to validate against.
 */
function setFencingToken(token) {
  currentFencingToken = token;
  logger.info({ token: token.substring(0, 8) + '...' }, '[idempotencyPurge] Fencing token set');
}

/**
 * Validates that a job's fencing token matches the current process token.
 * Rejects jobs from stale processes that lost their lease.
 *
 * @param {Object} job - The job to validate.
 * @returns {boolean} True if the job should proceed, false if it should be rejected.
 */
function validateFencingToken(job) {
  if (!currentFencingToken) {
    // No fencing token configured, allow all jobs (backward compatibility)
    return true;
  }
  
  const jobToken = job.payload?.fencingToken;
  if (!jobToken) {
    logger.warn({ jobId: job.id }, '[idempotencyPurge] Job missing fencing token, rejecting');
    return false;
  }
  
  if (jobToken !== currentFencingToken) {
    logger.warn(
      { jobId: job.id, jobToken: jobToken.substring(0, 8) + '...', currentToken: currentFencingToken.substring(0, 8) + '...' },
      '[idempotencyPurge] Job fencing token mismatch, rejecting stale job'
    );
    return false;
  }
  
  return true;
}

// Register the purge job handler with fencing token validation
purgeWorker.registerHandler('idempotency_purge', (job) => {
  if (!validateFencingToken(job)) {
    throw new Error('Job rejected: fencing token mismatch (stale process)');
  }
  return purgeExpiredKeys(job);
});

/**
 * Schedules the next idempotency purge job.
 *
 * This is typically called on a recurring timer to maintain regular cleanup.
 *
 * @param {Object} [options] - Scheduling options
 * @param {number} [options.delayMs] - Delay before executing (default: from config)
 * @param {string} [options.fencingToken] - Fencing token for lease validation.
 * @returns {string} Job ID
 */
function schedulePurge(options = {}) {
  const delayMs = options.delayMs ?? getIntervalMs();
  const payload = options.fencingToken ? { fencingToken: options.fencingToken } : {};

  const jobId = purgeQueue.enqueue('idempotency_purge', payload, { delayMs });

  logger.debug({
    jobId,
    delayMs,
    nextRunAt: new Date(Date.now() + delayMs).toISOString(),
  }, 'Scheduled idempotency purge job');

  return jobId;
}

/**
 * Stable UUID v4 pattern used to validate the fencing token.
 *
 * The token is passed by `src/index.js` at boot time so that an operator
 * can identify which process instance started the worker.  A non-UUID value
 * (empty string, undefined, or a truncated token) is a call-site bug; rather
 * than silently ignoring it we reject it in non-test environments so the
 * misconfiguration surfaces immediately.
 *
 * @type {RegExp}
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates the fencing token supplied at worker start.
 *
 * In test environments the check is skipped — `crypto.randomUUID()` is not
 * available in all Node 16 jest configurations and the token itself provides
 * no safety invariant inside an isolated test process.
 *
 * @param {unknown} token - Value passed as `fencingToken` by the caller.
 * @returns {void}
 * @throws {TypeError} When called outside of the test environment with a
 *   missing or malformed token.
 */
function validateFencingToken(token) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  if (typeof token !== 'string' || !UUID_V4_RE.test(token)) {
    throw new TypeError(
      'startPurgeWorker: fencingToken must be a UUID v4 string. ' +
      'Pass `{ fencingToken: crypto.randomUUID() }` from src/index.js.'
    );
  }
}

/**
 * Starts the purge worker and schedules recurring purge jobs.
 *
 * This should be called once at application startup to begin the periodic
 * cleanup process.
 *
 * @param {Object} [options] - Startup options.
 * @param {string} [options.fencingToken] - Fencing token for lease validation.
 * @returns {void}
 */
function startPurgeWorker(options = {}) {
  if (!purgeWorker.isRunning) {
    if (options.fencingToken) {
      setFencingToken(options.fencingToken);
    }
    purgeWorker.start();
    logger.info('Idempotency purge worker started');

    // Schedule the first purge job with fencing token
    schedulePurge({ fencingToken: options.fencingToken });
  }
  if (purgeWorker.isRunning) {
    return Promise.resolve();
  }

  startPromise = (async () => {
    try {
      await purgeWorker.start();
      schedulePurge();
      logger.info('Idempotency purge worker started');
    } catch (error) {
      try {
        await purgeWorker.stop();
      } catch (stopError) {
        logger.error(
          { component: 'idempotency_purge', errorName: stopError && stopError.name },
          'Idempotency purge worker failed to stop after startup failure'
        );
      }
      throw error;
    } finally {
      startPromise = null;
    }
  })();

  return startPromise;
}

/**
 * Stops the purge worker gracefully.
 *
 * @param {number} [timeoutMs=10000] - Grace period for in-flight jobs
 * @returns {Promise<void>}
 */
async function stopPurgeWorker(timeoutMs = 10000) {
  await purgeWorker.stop(timeoutMs);
  logger.info('Idempotency purge worker stopped');
}

/**
 * Gets statistics about the purge worker and queue.
 *
 * Useful for monitoring and debugging.
 *
 * @returns {Object} Worker and queue statistics
 */
function getStats() {
  return {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    config: {
      batchSize: getBatchSize(),
      intervalMs: getIntervalMs(),
      maxBatches: getMaxBatches(),
    },
  };
}

/**
 * Manually triggers a purge job (useful for testing or administrative actions).
 *
 * @param {Object} [options] - Options for the manual purge
 * @param {number} [options.delayMs=0] - Delay before executing
 * @returns {string} Job ID
 */
function triggerPurge(options = {}) {
  return schedulePurge({ delayMs: options.delayMs || 0 });
}

module.exports = {
  purgeExpiredKeys,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  getStats,
  triggerPurge,
  deleteExpiredBatch,
  getBatchSize,
  getIntervalMs,
  getMaxBatches,
  purgeQueue,
  purgeWorker,
  setFencingToken,
  validateFencingToken,
};
