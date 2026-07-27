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
} = require('../services/kycWebhookSoftDelete');

const JOB_TYPE = 'kyc_webhook_purge';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;

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

function getIntervalMs() {
  const parsed = parseInt(process.env.KYC_WEBHOOK_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

async function runKycWebhookPurge(job = {}, options = {}) {
  const startedAt = Date.now();

  try {
    const summary = await purgeExpiredSoftDeletes(options);

    kycWebhookPurgeRowsDeletedTotal.inc(summary.purged);
    kycWebhookPurgeRunsTotal.inc({ status: 'success' });

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
      'kycWebhookPurge: run completed'
    );

    return { success: true, ...summary };
  } catch (error) {
    kycWebhookPurgeRunsTotal.inc({ status: 'error' });
    logger.error(
      { jobId: job.id, err: error.message, durationMs: Date.now() - startedAt },
      'kycWebhookPurge: run failed'
    );
    throw error;
  }
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1,
  pollIntervalMs: 5000,
});

purgeWorker.registerHandler(JOB_TYPE, (job) => runKycWebhookPurge(job));

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
    },
  };
}

module.exports = {
  JOB_TYPE,
  runKycWebhookPurge,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  purgeQueue,
  purgeWorker,
};