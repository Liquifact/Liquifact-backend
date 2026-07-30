'use strict';

/**
 * @fileoverview webhook_replay job — re-attempts dead-lettered webhook deliveries.
 *
 * Each job payload carries a single `deadLetterId`. The job calls
 * `replayWebhook()` which re-signs with a fresh HMAC timestamp and POSTs to
 * the stored `webhook_url`. On success the dead-letter row is resolved and a
 * Prometheus counter is incremented. On failure the counter is incremented with
 * the failure outcome and the error is re-thrown so the worker's retry
 * mechanism can apply exponential back-off.
 *
 * @module jobs/webhookReplay
 */

const { replayWebhook } = require('../services/webhooks');
const { webhookReplayTotal } = require('../metrics');
const logger = require('../logger');

/**
 * Handler for the `webhook_replay` job type.
 *
 * @param {import('../workers/jobQueue').Job} job
 * @param {string} job.payload.deadLetterId - The `webhook_dead_letters.id` to replay.
 * @returns {Promise<void>}
 */
async function webhookReplayHandler(job) {
  const { deadLetterId } = job.payload;

  if (!deadLetterId) {
    throw new Error('webhookReplayHandler: missing deadLetterId in job payload');
  }

  try {
    await replayWebhook(deadLetterId);
    webhookReplayTotal.inc({ outcome: 'success' });
    logger.info({ deadLetterId }, 'webhook_replay job succeeded');
  } catch (err) {
    const outcome = err.code === 'ALREADY_RESOLVED' ? 'already_resolved'
      : err.code === 'NOT_FOUND'                    ? 'not_found'
      : 'failure';

    webhookReplayTotal.inc({ outcome });
    logger.error({ deadLetterId, err: err.message }, 'webhook_replay job failed');
    throw err;
  }
}

module.exports = { webhookReplayHandler };
