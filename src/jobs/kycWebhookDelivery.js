'use strict';

/**
 * @fileoverview KYC webhook delivery job handler.
 *
 * This module exports a factory that produces a job handler suitable for
 * registration with BackgroundWorker under the type `kyc_webhook_delivery`.
 *
 * Each job payload carries everything needed to perform a signed HTTP POST to
 * the tenant's configured webhook endpoint:
 *
 * ```jsonc
 * {
 *   "smeId":        "sme_123",       // subject SME
 *   "tenantId":     "tenant_abc",    // owning tenant
 *   "webhookUrl":   "https://...",   // delivery target  (never logged at info)
 *   "webhookSecret":"<secret>",      // HMAC-SHA256 signing key (never logged)
 *   "event":        "kyc.verified",  // KYC event type
 *   "kycData": {                     // KYC state snapshot
 *     "status":     "verified",
 *     "recordId":   "rec_xyz",
 *     "verifiedAt": "2025-01-01T00:00:00.000Z"
 *   }
 * }
 * ```
 *
 * Security:
 * - Secrets and full target URLs are never logged at info level.
 * - Signatures use the v1 HMAC-SHA256 scheme from `src/services/webhooks.js`.
 * - Timestamp tolerance replay-protection is enforced on the receiving side.
 * - Constant-time signature comparison is used in `verifySignature`.
 * - Payload size is bounded by `KYC_WEBHOOK_MAX_PAYLOAD_BYTES` (default 64 KB).
 *
 * @module jobs/kycWebhookDelivery
 */

const logger = require('../logger');
const { sortKeys } = require('../services/webhooks');
const { sendWebhookRequest } = require('./webhookDelivery');
const { withRetry } = require('../utils/retry');
const db = require('../db/knex');

let promClient;
try {
  promClient = require('prom-client');
} catch (_e) {
  promClient = {
    Counter: class {
      /** No-op constructor shim for test environments without prom-client. */
      constructor() {}
      /** No-op increment shim for test environments without prom-client. */
      inc() {}
    },
  };
}

const { registry } = require('../metrics');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum serialised payload size in bytes (64 KB). */
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Metrics (lazily initialised to avoid duplicate-registration errors in tests)
// ---------------------------------------------------------------------------

let _kycDeliveryAttemptsTotal;
let _kycDeliverySuccessTotal;
let _kycDeadLetterTotal;

/**
 * Returns (creating on first call) the KYC delivery-attempts Prometheus counter.
 * Lazy initialisation avoids duplicate-registration errors across test suites.
 * @returns {import('prom-client').Counter}
 */
function kycDeliveryAttemptsCounter() {
  if (!_kycDeliveryAttemptsTotal) {
    _kycDeliveryAttemptsTotal = new promClient.Counter({
      name: 'kyc_webhook_delivery_attempts_total',
      help: 'Total KYC webhook delivery attempts (each try counts)',
      registers: [registry],
    });
  }
  return _kycDeliveryAttemptsTotal;
}

/**
 * Returns (creating on first call) the KYC delivery-success Prometheus counter.
 * Lazy initialisation avoids duplicate-registration errors across test suites.
 * @returns {import('prom-client').Counter}
 */
function kycDeliverySuccessCounter() {
  if (!_kycDeliverySuccessTotal) {
    _kycDeliverySuccessTotal = new promClient.Counter({
      name: 'kyc_webhook_delivery_success_total',
      help: 'Total KYC webhook deliveries that completed successfully',
      registers: [registry],
    });
  }
  return _kycDeliverySuccessTotal;
}

/**
 * Returns (creating on first call) the KYC dead-letter Prometheus counter.
 * Lazy initialisation avoids duplicate-registration errors across test suites.
 * @returns {import('prom-client').Counter}
 */
function kycDeadLetterCounter() {
  if (!_kycDeadLetterTotal) {
    _kycDeadLetterTotal = new promClient.Counter({
      name: 'kyc_webhook_delivery_dead_letter_total',
      help: 'Total KYC webhook deliveries that exhausted retries and were dead-lettered',
      registers: [registry],
    });
  }
  return _kycDeadLetterTotal;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Determines whether a KYC delivery error is transient and eligible for retry.
 * Only network/socket errors and HTTP 5xx responses are retried; 4xx is permanent.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function shouldRetry(err) {
  if (!err) {return false;}
  if (err.name === 'AbortError') {return true;}
  if (err.code) {
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code);
  }
  if (err.status) {
    const s = Number(err.status);
    return s >= 500 && s < 600;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dead-letter helper
// ---------------------------------------------------------------------------

/**
 * Writes a dead-letter record to `kyc_webhook_dead_letters` for an exhausted job.
 *
 * @param {Object} params
 * @param {string} params.tenantId  - Tenant identifier.
 * @param {string} params.smeId     - SME identifier.
 * @param {string} params.event     - KYC event type string.
 * @param {Object} params.payload   - Payload object that failed delivery.
 * @param {string} params.lastError - Error message from final attempt.
 * @param {number} params.attempts  - Total attempts made.
 * @returns {Promise<void>}
 */
async function writeKycDeadLetter({ tenantId, smeId, event, payload, lastError, attempts }) {
  try {
    await db('kyc_webhook_dead_letters').insert({
      tenant_id: tenantId,
      sme_id: smeId,
      event,
      payload: JSON.stringify(payload),
      last_error: lastError,
      attempts,
      created_at: new Date(),
    });
  } catch (dbErr) {
    logger.warn({ err: dbErr.message }, 'kyc_webhook_delivery: failed to persist dead-letter record');
  }

  try {
    kycDeadLetterCounter().inc();
  } catch (_) {
    // ignore metric errors
  }
}

// ---------------------------------------------------------------------------
// Payload size guard
// ---------------------------------------------------------------------------

/**
 * Returns the maximum allowed KYC webhook payload size in bytes.
 * Reads from `KYC_WEBHOOK_MAX_PAYLOAD_BYTES` env var; falls back to 64 KB.
 *
 * @returns {number}
 */
function getMaxPayloadBytes() {
  const raw = Number(process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PAYLOAD_BYTES;
}

// ---------------------------------------------------------------------------
// Job handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a job handler for `kyc_webhook_delivery` jobs.
 *
 * The returned handler is an `async function(job)` satisfying the
 * BackgroundWorker handler contract. Retry configuration is read from
 * environment variables:
 *
 * | Variable                       | Default | Description                           |
 * |--------------------------------|---------|---------------------------------------|
 * | `WEBHOOK_MAX_RETRIES`          | 3       | Max delivery attempts (excluding 1st) |
 * | `WEBHOOK_BASE_DELAY`           | 500     | Base exponential-backoff delay (ms)   |
 * | `WEBHOOK_MAX_DELAY`            | 10000   | Backoff cap (ms)                      |
 * | `WEBHOOK_TIMEOUT_MS`           | 5000    | Per-request HTTP timeout (ms)         |
 * | `KYC_WEBHOOK_MAX_PAYLOAD_BYTES`| 65536   | Maximum serialised payload size       |
 *
 * @param {Object} [deps={}] - Optional dependency overrides (for testing).
 * @param {Function} [deps.send] - Override for `sendWebhookRequest`.
 * @param {Function} [deps.dead] - Override for `writeKycDeadLetter`.
 * @returns {Function} Async job handler: `async (job) => void`.
 */
function createKycWebhookDeliveryHandler(deps = {}) {
  const send = deps.send || sendWebhookRequest;
  const dead = deps.dead || writeKycDeadLetter;

  /**
   * Processes a `kyc_webhook_delivery` job.
   *
   * @param {Object} job              - Job object from JobQueue.
   * @param {string} job.id           - Unique job identifier.
   * @param {Object} job.payload      - Delivery payload (see module JSDoc above).
   * @param {number} job.attempts     - Current attempt count (1-based).
   * @returns {Promise<void>}
   */
  return async function kycWebhookDeliveryHandler(job) {
    const {
      smeId,
      tenantId,
      webhookUrl,
      webhookSecret,
      event,
      kycData = {},
    } = job.payload;

    const maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);
    const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
    const maxPayloadBytes = getMaxPayloadBytes();

    // Build deterministically-sorted payload
    const payload = sortKeys({
      event,
      smeId,
      tenantId,
      timestamp: new Date().toISOString(),
      kyc: {
        status: kycData.status || null,
        recordId: kycData.recordId || null,
        verifiedAt: kycData.verifiedAt || null,
      },
    });

    const rawBody = JSON.stringify(payload);

    // Enforce payload size bound
    const payloadBytes = Buffer.byteLength(rawBody, 'utf8');
    if (payloadBytes > maxPayloadBytes) {
      const sizeError = new Error(
        `KYC webhook payload exceeds size limit: ${payloadBytes} > ${maxPayloadBytes} bytes`
      );
      sizeError.code = 'PAYLOAD_TOO_LARGE';
      logger.error(
        { smeId, tenantId, event, payloadBytes, maxPayloadBytes },
        'kyc_webhook_delivery: payload too large, dead-lettering without retry'
      );
      await dead({
        tenantId,
        smeId,
        event,
        payload,
        lastError: sizeError.message,
        attempts: 1,
      });
      throw sizeError;
    }

    logger.info(
      { smeId, tenantId, event, jobId: job.id, attempt: job.attempts },
      'kyc_webhook_delivery: starting delivery attempt'
    );

    let attemptCount = 0;

    const operation = async () => {
      attemptCount += 1;
      try {
        kycDeliveryAttemptsCounter().inc();
      } catch (_) { /* ignore */ }

      return send({ webhookUrl, webhookSecret, rawBody, timeoutMs });
    };

    try {
      await withRetry(operation, {
        maxRetries,
        baseDelay,
        maxDelay,
        shouldRetry,
        onRetry: ({ attempt, error }) => {
          logger.warn(
            {
              smeId,
              tenantId,
              event,
              jobId: job.id,
              attempt,
              errorCode: error && error.code ? error.code : undefined,
              errorMessage: error && error.message ? error.message : String(error),
            },
            'kyc_webhook_delivery: transient failure, will retry'
          );
        },
      });

      // Success
      try {
        kycDeliverySuccessCounter().inc();
      } catch (_) { /* ignore */ }

      logger.info(
        { smeId, tenantId, event, jobId: job.id, totalAttempts: attemptCount },
        'kyc_webhook_delivery: delivered successfully'
      );
    } catch (finalErr) {
      // Exhausted retries → dead-letter
      logger.error(
        {
          smeId,
          tenantId,
          event,
          jobId: job.id,
          totalAttempts: attemptCount,
          error: finalErr && finalErr.message ? finalErr.message : String(finalErr),
        },
        'kyc_webhook_delivery: exhausted retries, dead-lettering'
      );

      try {
        await dead({
          tenantId,
          smeId,
          event,
          payload,
          lastError: finalErr && finalErr.message ? finalErr.message : String(finalErr),
          attempts: attemptCount,
        });
      } catch (_deadErr) {
        // dead() failures must not shadow the original delivery error
      }

      // Re-throw so BackgroundWorker can mark the job as failed
      throw finalErr;
    }
  };
}

module.exports = {
  createKycWebhookDeliveryHandler,
  // Exported for unit testing
  shouldRetry,
  writeKycDeadLetter,
  getMaxPayloadBytes,
  DEFAULT_MAX_PAYLOAD_BYTES,
};
