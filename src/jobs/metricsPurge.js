'use strict';

const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter, Gauge } = require('prom-client');
const { getRegistry } = require('../metrics');
const {
  purgeExpiredSoftDeletes,
  getRetentionDays,
  getPurgeBatchSize,
  getPurgeMaxBatches,
} = require('../services/metricsSoftDelete');

const JOB_TYPE = 'metrics_purge';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

function _counter(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Counter({ ...config, registers: [registry] });
}

function _gauge(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Gauge({ ...config, registers: [registry] });
}

const metricsPurgeRowsDeletedTotal = _counter( {
  name: 'liquifact_metrics_purge_rows_deleted_total',
  help: 'Total metric tombstones hard-deleted after their retention window',
});

const metricsPurgeRunsTotal = _counter({
  name: 'liquifact_metrics_purge_runs_total',
  help: 'Total metrics purge job runs by outcome',
  labelNames: ['status'],
});

const metricsPurgeRetriesTotal = _counter({
  name: 'liquifact_metrics_purge_retries_total',
  help: 'Total metrics purge retry attempts',
});

const metricsPurgeLastSuccessTimestamp = _gauge({
  name: 'liquifact_metrics_purge_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful metrics purge run',
});

const metricsPurgeLastFailureTimestamp = _gauge({
  name: 'liquifact_metrics_purge_last_failure_timestamp_seconds',
  help: 'Unix timestamp of the last failed metrics purge run',
});

function getIntervalMs() {
  const parsed = parseInt(process.env.METRICS_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  if (parsed > MAX_INTERVAL_MS) {
    return MAX_INTERVAL_MS;
  }
  return parsed;
}

function getMaxAttempts() {
  const parsed = parseInt(process.env.METRICS_PURGE_MAX_ATTEMPTS, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return parsed;
}

function getRetryBaseMs() {
  const parsed = parseInt(process.env.METRICS_PURGE_RETRY_BASE_MS, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETRY_BASE_MS;
  }
  return parsed;
}

function getRetryMaxMs() {
  const parsed = parseInt(process.env.METRICS_PURGE_RETRY_MAX_MS, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETRY_MAX_MS;
  }
  return parsed;
}

/**
 * Deterministic exponential backoff with full jitter.
 *
 * The jitter is derived from a pure hash of the attempt number and the
 * supplied seed, so the same input always produces the same delay. This
 * makes retry scheduling replayable and observable while still avoiding
 * thundering herds across independent job runs.
 *
 * @param {number} attempt 1-based attempt number.
 * @param {number} baseMs Base delay in milliseconds.
 * @param {number} maxMs Maximum delay in milliseconds.
 * @param {string|number} [seed] Stable seed for the jitter hash.
 * @returns {number} Delay in milliseconds.
 */
function computeBackoffMs(attempt, baseMs, maxMs, seed = 0) {
  const safeBase = Number.isFinite(baseMs) && baseMs >= 0 ? baseMs : DEFAULT_RETRY_BASE_MS;
  const safeMax = Number.isFinite(maxMs) && maxMs >= 0 ? maxMs : DEFAULT_RETRY_MAX_MS;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const exponential = safeBase * Math.pow(2, Math.max(0, safeAttempt - 1));
  const capped = Math.min(exponential, safeMax);
  const maxJitter = Math.max(1, Math.floor(capped / 4));
  const hash = _hashSeed(`${safeAttempt}:${seed}`);
  const jitter = hash % maxJitter;
  return Math.min(capped + jitter, safeMax);
}

/**
 * Deterministic FNV-1a-style hash for jitter generation.
 * @param {string} input
 * @returns {number} Unsigned 32-bit integer.
 */
function _hashSeed(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0);
}

async function runMetricsPurge(job = {}, options = {}) {
  const startedAt = Date.now();

  try {
    const summary = await purgeExpiredSoftDeletes(options);

    metricsPurgeRowsDeletedTotal.inc(summary.purged);
    metricsPurgeRunsTotal.inc({ status: 'success' });

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
      'metricsPurge: run completed'
    );

    return { success: true, ...summary };
  } catch (error) {
    metricsPurgeRunsTotal.inc({ status: 'error' });
    logger.error(
      { jobId: job.id, err: error.message, durationMs: Date.now() - startedAt },
      'metricsPurge: run failed'
    );
    throw error;
  }
  return Math.min(parsed, MAX_ATTEMPTS);
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isRetryable(error) {
  if (!error) {
    return false;
  }
  if (error.retryable === true) {
    return true;
  }
  if (error.retryable === false) {
    return false;
  }
  const code = error.code || error.code === 0 ? error.code : null;
  if (code && ['ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETCP', 'ETIMEDOUT', 'EAGAIN'].includes(code)) {
    return true;
  }
  const msg = String(error.message || '').toLowerCase();
  return /(timeout|temporar|transient|connection|deadlock|serialization|retry)/.test(msg);
}

async function runMetricsPurge(job = {}, options = {}) {
  if (_activePurge) {
    logger.warn(
      { jobId: job.id },
      'metricsPurge: run skipped, another purge is already in progress'
    );
    metricsPurgeRunsTotal.inc({ status: 'skipped' });
    return { success: false, skipped: true, reason: 'already_running' };
  }

  _activePurge = (async () => {
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, options.maxAttempts ?? getMaxAttempts());
  const baseDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const summary = await purgeExpiredSoftDeletes(options);

      metricsPurgeRowsDeletedTotal.inc(summary.purged);
      metricsPurgeRunsTotal.inc({ status: 'success' });
      metricsPurgeLastSuccessTimestamp.set(Date.now() / 1000);

      logger.info(
        {
          jobId: job.id,
          attempt,
          purged: summary.purged,
          batches: summary.batches,
          cutoff: summary.cutoff,
          retentionDays: summary.retentionDays,
          maxBatchesReached: summary.maxBatchesReached,
          durationMs: Date.now() - startedAt,
        },
        'metricsPurge: run completed'
      );

      return { success: true, attemptsAttempted: attempt, ...summary };
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !_isRetryable(error)) {
        break;
      }

      metricsPurgeRetriesTotal.inc();
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      logger.warn(
        {
          jobId: job.id,
          attempt,
          maxAttempts,
          delayMs,
          err: error.message,
        },
        'metricsPurge: attempt failed, retrying'
      );
      await _sleep(delayMs);
    }
  }

  metricsPurgeRunsTotal.inc({ status: 'error' });
  metricsPurgeLastFailureTimestamp.set(Date.now() / 1000);
  logger.error(
    {
      jobId: job.id,
      attemptsAttempted: attempt,
      err: lastError ? lastError.message : 'unknown error',
      durationMs: Date.now() - startedAt,
    },
    'metricsPurge: run failed'
  );
  throw lastError || new Error('metricsPurge: run failed');
}

async function runMetricsPurgeWithRetry(job = {}, options = {}) {
  const maxAttempts = options.maxAttempts ?? getMaxAttempts();
  const baseMs = options.retryBaseMs ?? getRetryBaseMs();
  const maxMs = options.retryMaxMs ?? getRetryMaxMs();
  const seed = options.retrySeed ?? job.id ?? JOB_TYPE;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runMetricsPurge(job, options);
      if (attempt > 1) {
        logger.info(
          { jobId: job.id, attempt, maxAttempts },
          'metricsPurge: retry succeeded'
        );
      }
      return { ...result, attempts };
    } catch (error) {
      lastError = error;
      const isLast = attempt >= maxAttempts;
      logger.warn(
        {
          jobId: job.id,
          attempt,
          maxAttempts,
          err: error.message,
          willRetry: !isLast,
        },
        'metricsPurge: attempt failed'
      );
      if (isLast) {
        break;
      }
      const delayMs = computeBackoffMs(attempt, baseMs, maxMs, seed);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  metricsPurgeRunsTotal.inc({ status: 'exhausted' });
  logger.error(
    { jobId: job.id, maxAttempts, err: lastError && lastError.message },
    'metricsPurge: retries exhausted'
  );
  throw lastError;
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: MAX_CONCURRENT_PURGES,
  pollIntervalMs: 5000,
});

purgeWorker.registerHandler(JOB_TYPE, (job) => runMetricsPurgeWithRetry(job));

function schedulePurge(options = {}) {
  const delayMs = options.delayMs ?? getIntervalMs();
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError('schedulePurge: delayMs must be a non-negative finite number');
  }
  const jobId = purgeQueue.enqueue(JOB_TYPE, {}, { delayMs });
  logger.debug({ jobId, delayMs }, 'metricsPurge: scheduled run');
  return jobId;
}

function startPurgeWorker() {
  if (!purgeWorker.isRunning) {
    purgeWorker.start();
    schedulePurge();
    logger.info(
      { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
      'metricsPurge: worker started'
    );
  }
}

async function stopPurgeWorker(timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  await purgeWorker.stop(timeoutMs);
  _activePurge = null;
  logger.info('metricsPurge: worker stopped');
}

function triggerPurge() {
  return schedulePurge({ delayMs: 0 });
}

function getStats() {
  return {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    activePurge: _activePurge !== null,
    config: {
      retentionDays: getRetentionDays(),
      batchSize: getPurgeBatchSize(),
      maxBatches: getPurgeMaxBatches(),
      intervalMs: getIntervalMs(),
      maxAttempts: getMaxAttempts(),
      retryBaseMs: getRetryBaseMs(),
      retryMaxMs: getRetryMaxMs(),
    },
  };
}

module.exports = {
  JOB_TYPE,
  runMetricsPurge,
  runMetricsPurgeWithRetry,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  getMaxAttempts,
  getRetryBaseMs,
  getRetryMaxMs,
  computeBackoffMs,
  purgeQueue,
  purgeWorker,
  MAX_INTERVAL_MS,
};
