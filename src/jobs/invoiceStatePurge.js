'use strict';

/**
 * @fileoverview Maintenance task that hard-deletes invoice records whose
 * soft-delete retention window has elapsed (issue #866).
 *
 * Soft-deleting an invoice (see {@link module:services/invoiceStateSoftDelete})
 * leaves a tombstoned `invoices` row behind. Without a purge, tombstones
 * accumulate forever — the same unbounded-growth problem the idempotency
 * purge job solves for `idempotency_keys`, and the escrow-read purge job
 * solves for `escrow_event_projection`.
 *
 * This job runs the purge on a schedule through the shared job queue/worker
 * infrastructure, emits Prometheus counters, and exposes a manual trigger for
 * the admin API.
 *
 * ## Determinism
 * The purge is serialised through a single-concurrency worker and a per-job
 * mutex so two runs can never interleave batches. Every run is idempotent:
 * deleting a tombstone twice is a no-op, and a partial failure leaves the
 * remaining tombstones in place for the next retry to consume. The cutoff
 * is computed once per run and forwarded to the service so all batches in
 * a run observe the same retention window.
 *
 * ## Configuration
 * - `INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS` — restore/retention window (default 30).
 * - `INVOICE_STATE_PURGE_BATCH_SIZE` — rows deleted per batch (default 500).
 * - `INVOICE_STATE_PURGE_MAX_BATCHES` — batch cap per run (default 100).
 * - `INVOICE_STATE_PURGE_INTERVAL_MS` — cadence between runs (default 6 h, min 1 min).
 *
 * @module jobs/invoiceStatePurge
 */

const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter } = require('prom-client');
const { getRegistry } = require('../metrics');
const {
  purgeExpiredInvoiceStateSoftDeletes,
  getRetentionDays,
  getPurgeBatchSize,
  getPurgeMaxBatches,
} = require('../services/invoiceStateSoftDelete');

/** @constant {string} */
const JOB_TYPE = 'invoice_state_purge';
/** @constant {number} */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** @constant {number} */
const MIN_INTERVAL_MS = 60_000; // 1 minute

/**
 * Registers a counter idempotently. Jest resets the module registry between
 * suites while `prom-client`'s registry is process-global, so a bare
 * `new Counter(...)` would throw "already registered" on the second load.
 *
 * @param {object} config - `prom-client` counter configuration.
 * @returns {import('prom-client').Counter} New or previously registered counter.
 */
function _counter(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Counter({ ...config, registers: [registry] });
}

const invoiceStatePurgeRowsDeletedTotal = _counter( {
  name: 'liquifact_invoice_state_purge_rows_deleted_total',
  help: 'Total invoice tombstones hard-deleted after their retention window',
});

const invoiceStatePurgeRunsTotal = _counter({
  name: 'liquifact_invoice_state_purge_runs_total',
  help: 'Total invoice-state purge job runs by outcome',
  labelNames: ['status'],
});

/**
 * Reads the purge cadence.
 *
 * @returns {number} Interval in ms (minimum 60000; default 6 h).
 */
function getIntervalMs() {
  const parsed = parseInt(process.env.INVOICE_STATE_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Serialises purge runs within this process. The worker is already
 * single-concurrency, but the admin trigger and the scheduled run can both
 * be enqueued and the mutex guarantees they never interleave batches.
 *
 * @returns {Promise<void>} Resolves once the mutex is held.
 */
let _purgeChain = Promise.resolve();

function _withPurgeMutex(fn) {
  const run = _purgeChain.then(fn, fn);
  // Keep the chain alive even if the run rejects.
  _purgeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Job handler: purges expired invoice tombstones and records metrics.
 *
 * The cutoff is computed once and forwarded to the service so every batch
 * in the run observes the same retention window. Runs are serialised by a
 * per-process mutex so concurrent triggers cannot contend on the same rows.
 *
 * @param {object} [job={}] - Job envelope from the queue (`id` used for logs).
 * @param {object} [options={}] - Forwarded to
 *   {@link module:services/invoiceStateSoftDelete.purgeExpiredInvoiceStateSoftDeletes}
 *   (`dbClient`, `now`, `batchSize`, `maxBatches`) -- used by tests.
 * @returns {Promise<object>} Purge summary plus `success: true`.
 * @throws {Error} Re-throws the underlying failure after recording metrics so
 *   the worker's retry policy applies.
 */
async function runInvoiceStatePurge(job = {}, options = {}) {
  const startedAt = Date.now();

  return _withPurgeMutex(async () => {
    try {
      const summary = await purgeExpiredInvoiceStateSoftDeletes(options);

      invoiceStatePurgeRowsDeletedTotal.inc(summary.purged);
      invoiceStatePurgeRunsTotal.inc({ status: 'success' });

      logger.info(
        {
          jobId: job.id,
          purged: summary.purged,
          batches: summary.batches,
          cutoff: summary.cutoff,
          retentionDays: summary.retentionDays,
          maxBatchesReached: summary.maxBatchesReached,
          durationMs: Date.now() - startedAt,
        },
        'invoiceStatePurge: run completed'
      );

      return { success: true, ...summary };
    } catch (error) {
      invoiceStatePurgeRunsTotal.inc({ status: 'error' });
      logger.error(
        { jobId: job.id, err: error.message, durationMs: Date.now() - startedAt },
        'invoiceStatePurge: run failed'
      );
      throw error;
    }
  });
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1, // Serialised: concurrent purges would contend on the same rows.
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
  logger.info({ token: token.substring(0, 8) + '...' }, '[invoiceStatePurge] Fencing token set');
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
    logger.warn({ jobId: job.id }, '[invoiceStatePurge] Job missing fencing token, rejecting');
    return false;
  }
  
  if (jobToken !== currentFencingToken) {
    logger.warn(
      { jobId: job.id, jobToken: jobToken.substring(0, 8) + '...', currentToken: currentFencingToken.substring(0, 8) + '...' },
      '[invoiceStatePurge] Job fencing token mismatch, rejecting stale job'
    );
    return false;
  }
  
  return true;
}

purgeWorker.registerHandler(JOB_TYPE, (job) => {
  if (!validateFencingToken(job)) {
    throw new Error('Job rejected: fencing token mismatch (stale process)');
  }
  return runInvoiceStatePurge(job);
});

/**
 * Enqueues a purge run.
 *
 * @param {object} [options={}]
 * @param {number} [options.delayMs=getIntervalMs()] - Delay before execution.
 * @param {string} [options.fencingToken] - Fencing token for lease validation.
 * @returns {string} Job ID.
 */
function schedulePurge(options = {}) {
  const delayMs = options.delayMs ?? getIntervalMs();
  const payload = options.fencingToken ? { fencingToken: options.fencingToken } : {};
  const jobId = purgeQueue.enqueue(JOB_TYPE, payload, { delayMs });
  logger.debug({ jobId, delayMs }, 'invoiceStatePurge: scheduled run');
  return jobId;
}

/**
 * Stable UUID v4 pattern used to validate the fencing token.
 *
 * @param {object} [options] - Startup options.
 * @param {string} [options.fencingToken] - Fencing token for lease validation.
 * @returns {void}
 */
function startPurgeWorker(options = {}) {
  if (!purgeWorker.isRunning) {
    if (options.fencingToken) {
      setFencingToken(options.fencingToken);
    }
    purgeWorker.start();
    schedulePurge({ fencingToken: options.fencingToken });
    logger.info(
      { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
      'invoiceStatePurge: worker started'
    );
  }
}

/**
 * Starts the worker and schedules the first run. Safe to call twice.
 *
 * @returns {Promise<void>}
 */
function startPurgeWorker() {
  if (startPromise) {
    return startPromise;
  }
  if (purgeWorker.isRunning) {
    return Promise.resolve();
  }

  startPromise = (async () => {
    try {
      await purgeWorker.start();
      schedulePurge();
      logger.info(
        { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
        'invoiceStatePurge: worker started'
      );
    } catch (error) {
      try {
        await purgeWorker.stop();
      } catch (stopError) {
        logger.error(
          { component: JOB_TYPE, errorName: stopError && stopError.name },
          'invoiceStatePurge: worker failed to stop after startup failure'
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
 * Stops the worker, allowing in-flight runs to finish.
 *
 * @param {number} [timeoutMs=10000] - Grace period.
 * @returns {Promise<void>}
 */
async function stopPurgeWorker(timeoutMs = 10000) {
  await purgeWorker.stop(timeoutMs);
  logger.info('invoiceStatePurge: worker stopped');
}

/**
 * Triggers a purge immediately (admin endpoint / operational runbooks).
 *
 * @returns {string} Job ID.
 */
function triggerPurge() {
  return schedulePurge({ delayMs: 0 });
}

/**
 * Worker/queue/config snapshot for monitoring.
 *
 * @returns {object} `{ worker, queue, config }`.
 */
function getStats() {
  return {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    config: {
      retentionDays: getRetentionDays(),
      batchSize: getPurgeBatchSize(),
      maxBatches: getPurgeMaxBatches(),
      intervalMs: getIntervalMs(),
    },
  };
}

module.exports = {
  JOB_TYPE,
  runInvoiceStatePurge,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  purgeQueue,
  purgeWorker,
  setFencingToken,
  validateFencingToken,
};
