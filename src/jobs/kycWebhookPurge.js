'use strict';

const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter } = require('prom-client');
const { getRegistry } = require('../metrics');
const {
  purgeExpiredSoftDeletes,
  getRetentionDays,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  getPurgeTimeoutMs,
} = require('../services/kycWebhookSoftDelete');

const JOB_TYPE = 'kyc_webhook_purge';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;

const inFlightRuns = new Map();

function _counter(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Counter({ ...config, registers: [registry] });
}

const kycWebhookPurgeRowsDeletedTotal = _counter({
  name: 'liquifact_kyc_webhook_purge_rows_deleted_total',
  help: 'Total KYC webhook tombstones hard-deleted after their retention window',
});

const kycWebhookPurgeRunsTotal = _counter({
  name: 'liquifact_kyc_webhook_purge_runs_total',
  help: 'Total KYC webhook purge job runs by outcome',
  labelNames: ['status'],
});

const kycWebhookPurgeRetriesTotal = _counter({
  name: 'liquifact_kyc_webhook_purge_retries_total',
  help: 'Total KYC webhook purge job retry attempts',
  labelNames: ['reason'],
});

function getIntervalMs() {
  const parsed = parseInt(process.env.KYC_WEBHOOK_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

function _runKey(job) {
  if (job && job.id != null) {
    return `job:${job.id}`;
  }
  return 'singleton';
}

function _isRetryable(error) {
  if (!error) {
    return false;
  }
  if (error.retryable === true) {
    return true;
  }
  const code = error.code || error.name;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFRESED' ||
    code === 'EPIPE' ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED'
  );
}

async function runKycWebhookPurge(job = {}, options = {}) {
  const startedAt = Date.now();

  try {
    const summary = await purgeExpiredSoftDeletes(options);

    kycWebhookPurgeRowsDeletedTotal.inc(summary.purged);
    if (summary.retries > 0) {
      kycWebhookPurgeRetriesTotal.inc({ reason: 'partial' }, summary.retries);
    }
    kycWebhookPurgeRunsTotal.inc({ status: 'success' });

    logger.info(
      {
        jobId: job.id,
        purged: summary.purged,
        batches: summary.batches,
        cutoff: summary.cutoff,
        retries: summary.retries,
        retentionDays: summary.retentionDays,
        maxBatchesReached: summary.maxBatchesReached,
        durationMs: Date.now() - startedAt,
      },
      'kycWebhookPurge: run completed'
    );

    return { success: true, ...summary };
  } catch (error) {
    kycWebhookPurgeRetriesTotal.inc({ reason: _isRetryable(error) ? 'retryable' : 'fatal' });
    kycWebhookPurgeRunsTotal.inc({ status: 'error' });
    logger.error(
      { jobId: job.id, err: error.message, durationMs: Date.now() - startedAt },
      'kycWebhookPurge: run failed'
    );
    throw error;
  }
}

async function runKycWebhookPurgeOnce(job = {}, options = {}) {
  const key = _runKey(job);
  const existing = inFlightRuns.get(key);
  if (existing) {
    logger.warn(
      { jobId: job.id, key },
      'kycWebhookPurge: duplicate run suppressed'
    );
    return existing;
  }

  const timeoutMs = options.timeoutMs ?? getPurgeTimeoutMs();
  const run = (async () => {
    let timer;
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error('kycWebhookPurge: run timed out');
          err.code = 'ETIMEDOUT';
          err.retryable = true;
          reject(err);
        }, timeoutMs);
        if (timer.unref) {
          timer.unref();
        }
      });
      return await Promise.race([runKycWebhookPurge(job, options), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  })();

  inFlightRuns.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlightRuns.get(key) === run) {
      inFlightRuns.delete(key);
    }
  }
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1,
  pollIntervalMs: 5000,
});

purgeWorker.registerHandler(JOB_TYPE, (job) => runKycWebhookPurgeOnce(job));

function schedulePurge(options = {}) {
  const delayMs = options.delayMs ?? getIntervalMs();
  const jobId = purgeQueue.enqueue(JOB_TYPE, {}, { delayMs });
  logger.debug({ jobId, delayMs }, 'kycWebhookPurge: scheduled run');
  return jobId;
}

function startPurgeWorker() {
  if (!purgeWorker.isRunning) {
    purgeWorker.start();
    schedulePurge();
    logger.info(
      { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
      'kycWebhookPurge: worker started'
    );
  }
}

async function stopPurgeWorker(timeoutMs = 10000) {
  await purgeWorker.stop(timeoutMs);
  logger.info('kycWebhookPurge: worker stopped');
}

function triggerPurge() {
  return schedulePurge({ delayMs: 0 });
}

function getStats() {
  return {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    config: {
      retentionDays: getRetentionDays(),
      batchSize: getPurgeBatchSize(),
      maxBatches: getPurgeMaxBatches(),
      intervalMs: getIntervalMs(),
      timeoutMs: getPurgeTimeoutMs(),
    },
  };
}

module.exports = {
  JOB_TYPE,
  runKycWebhookPurge,
  runKycWebhookPurgeOnce,
  _isRetryable,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  purgeQueue,
  purgeWorker,
};
