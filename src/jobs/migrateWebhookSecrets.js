'use strict';

/**
 * @fileoverview Background job that runs the legacy webhook-secret → one-way
 * hash migration. The migration is idempotent, so a retried job simply
 * continues with any remaining legacy records; already-hashed and invalid rows
 * are skipped safely.
 *
 * Register under the job type `webhook_secret_migration` with a
 * {@link createMigrateWebhookSecretsHandler} returned handler.
 *
 * @module jobs/migrateWebhookSecrets
 */

const { runMigration } = require('../services/webhookSecretMigration');
const { withRetry } = require('../utils/retry');
const logger = require('../logger');

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 300;
const DEFAULT_MAX_DELAY = 5000;

/**
 * Retry predicate: only transient errors should be retried.
 *
 * @param {Error} err - Error thrown by `runMigration`.
 * @returns {boolean} True when retryable.
 */function shouldRetry(err) {
  if (!err) {
    return false;
  }
  // Deterministic, non-transient failure modes never retry.
  if (err.code === 'SECRET_TOO_LONG') {
    return false;
  }
  if (err.code && /^((NO_)|(INVALID_)|(BAD_)|(NOT_))/i.test(err.code)) {
    return false;
  }
  return true;
}

/**
 * Factory producing a job handler (`async (job) => void`) suitable for
 * registration with BackgroundWorker.
 *
 * @param {Object} [deps] - Optional dependency overrides (for testing).
 * @param {Object} [deps.runner] - `runMigration`-compatible function.
 * @returns {Function} Async job handler.
 */
function createMigrateWebhookSecretsHandler(deps = {}) {
  const runner = deps.runner || runMigration;

  /**
   * Handles a `webhook_secret_migration` job, retrying transient failures.
   *
   * @param {Object} job - Job object from JobQueue.
   * @returns {Promise<{hashed: number, invalid: number, errored: number}>} Summary.
   */
  return async function migrateWebhookSecretsHandler() {
    const maxRetries = Number(process.env.WEBHOOK_SECRET_MIGRATION_MAX_RETRIES || DEFAULT_MAX_RETRIES);
    const baseDelay = Number(process.env.WEBHOOK_SECRET_MIGRATION_BASE_DELAY || DEFAULT_BASE_DELAY);
    const maxDelay = Number(process.env.WEBHOOK_SECRET_MIGRATION_MAX_DELAY || DEFAULT_MAX_DELAY);

    try {
      const summary = await withRetry(runner, {
        maxRetries,
        baseDelay,
        maxDelay,
        shouldRetry,
      });
      logger.info({ summary }, 'webhook_secret_migration job completed');
      return summary;
    } catch (err) {
      logger.error(
        { error: err && err.message ? err.message : String(err) },
        'webhook_secret_migration job failed',
      );
      throw err;
    }
  };
}

module.exports = {
  createMigrateWebhookSecretsHandler,
  shouldRetry,
};