'use strict';

/**
 * @fileoverview Webhook delivery job handler.
 *
 * This module exports a factory that produces a job handler function suitable
 * for registration with BackgroundWorker under the type `webhook_delivery`.
 *
 * Each job payload carries everything needed to perform (or re-perform) a
 * signed HTTP POST to the tenant's configured webhook endpoint:
 *
 * ```jsonc
 * {
 *   "invoiceId":    "inv_123",          // target invoice
 *   "tenantId":     "tenant_abc",       // owning tenant
 *   "webhookUrl":   "https://...",      // delivery target  (never logged at info)
 *   "webhookSecret":"<secret>",         // HMAC-SHA256 signing key (never logged)
 *   "event":        "invoice.approved", // event type label
 *   "transition": {                     // state-machine metadata
 *     "from": "pending",
 *     "to":   "approved",
 *     "actor": "usr_xyz",
 *     "reason": null,
 *     "transitionedAt": "2025-01-01T00:00:00.000Z"
 *   }
 * }
 * ```
 *
 * Security:
 * - Secrets and full target URLs are never logged at info level.
 * - Signatures use the v1 HMAC-SHA256 scheme from `src/services/webhooks.js`.
 * - Timestamp tolerance replay-protection is enforced on the receiving side.
 * - Constant-time signature comparison is used in `verifySignature`.
 *
 * @module jobs/webhookDelivery
 */

const logger = require('../logger');
const { createSignatureHeader, sortKeys } = require('../services/webhooks');
const { withRetry } = require('../utils/retry');
const db = require('../db/knex');

let promClient;
try {
  promClient = require('prom-client');
} catch (_e) {
  promClient = {
    Counter: class {
      /**
       * Creates a new mock Counter instance.
       */
      constructor() {}
      /**
       * Increments the mock counter.
       * @returns {void}
       */
      inc() {}
    },
  };
}

const { registry } = require('../metrics');

// ---------------------------------------------------------------------------
// Metrics (lazily initialised to avoid duplicate-registration errors in tests)
// ---------------------------------------------------------------------------

let _deliveryAttemptsTotal;
let _deliverySuccessTotal;
let _deadLetterTotal;

/**
 * Returns the shared Prometheus counter for webhook delivery attempts,
 * creating it on first call so repeated `require()` in tests does not
 * attempt to register a duplicate metric.
 *
 * @returns {import('prom-client').Counter} Prometheus counter.
 */
function deliveryAttemptsCounter() {
  if (!_deliveryAttemptsTotal) {
    _deliveryAttemptsTotal = new promClient.Counter({
      name: 'webhook_delivery_attempts_total',
      help: 'Total webhook delivery attempts (each try counts)',
      registers: [registry],
    });
  }
  return _deliveryAttemptsTotal;
}

/**
 * Returns the shared Prometheus counter for successful webhook deliveries.
 *
 * @returns {import('prom-client').Counter} Prometheus counter.
 */
function deliverySuccessCounter() {
  if (!_deliverySuccessTotal) {
    _deliverySuccessTotal = new promClient.Counter({
      name: 'webhook_delivery_success_total',
      help: 'Total webhook deliveries that completed successfully',
      registers: [registry],
    });
  }
  return _deliverySuccessTotal;
}

/**
 * Returns the shared Prometheus counter for dead-lettered webhook deliveries.
 *
 * @returns {import('prom-client').Counter} Prometheus counter.
 */
function deadLetterCounter() {
  if (!_deadLetterTotal) {
    _deadLetterTotal = new promClient.Counter({
      name: 'webhook_delivery_dead_letter_total',
      help: 'Total webhook deliveries that exhausted retries and were dead-lettered',
      registers: [registry],
    });
  }
  return _deadLetterTotal;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Determines whether a delivery error is transient and therefore eligible for
 * retry.  Only network/socket errors and HTTP 5xx responses are retried;
 * 4xx responses are treated as permanent failures.
 *
 * @param {Error} err - Error thrown by the delivery attempt.
 * @returns {boolean} True if the request should be retried.
 */
function shouldRetry(err) {
  if (!err) {
    return false;
  }
  // Check name first (AbortError may not have a code)
  if (err.name === 'AbortError') {
    return true;
  }
  if (err.code) {
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(
      err.code
    );
  }
  if (err.status) {
    const s = Number(err.status);
    return s >= 500 && s < 600;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Delivery helpers
// ---------------------------------------------------------------------------

/**
 * Sends a single signed HTTP POST to the configured webhook URL.
 *
 * @param {Object} params
 * @param {string} params.webhookUrl    - Delivery target URL.
 * @param {string} params.webhookSecret - HMAC-SHA256 signing secret.
 * @param {Object} params.body          - Pre-serialised payload object.
 * @param {string} params.rawBody       - JSON string of body (for signing).
 * @param {number} [params.timeoutMs=5000] - Per-request timeout in ms.
 * @returns {Promise<{ok: boolean, status: number}>}
 * @throws {Error} On non-2xx response or network failure.
 */
async function sendWebhookRequest({ webhookUrl, webhookSecret, rawBody, timeoutMs = 5000 }) {
  const signatureHeader = createSignatureHeader(webhookSecret, rawBody);

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signatureHeader,
      },
      body: rawBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = new Error(`Webhook responded with ${response.status}`);
      err.status = response.status;
      throw err;
    }

    return { ok: true, status: response.status };
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Writes a dead-letter record to the database for an exhausted delivery job.
 *
 * @param {Object} params
 * @param {string} params.tenantId  - Tenant identifier.
 * @param {string} params.invoiceId - Invoice identifier.
 * @param {string} params.event     - Event type string.
 * @param {Object} params.payload   - The payload object that failed delivery.
 * @param {string} params.lastError - Error message from final attempt.
 * @param {number} params.attempts  - Total attempts made.
 * @returns {Promise<void>}
 */
async function writeDeadLetter({ tenantId, invoiceId, event, payload, lastError, attempts }) {
  try {
    await db('webhook_dead_letters').insert({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      event,
      payload: JSON.stringify(payload),
      last_error: lastError,
      attempts,
      created_at: new Date(),
    });
  } catch (dbErr) {
    logger.warn({ err: dbErr.message }, 'Failed to persist webhook dead-letter record');
  }

  // Increment Prometheus dead-letter counter
  try {
    deadLetterCounter().inc();
  } catch (_error) {
    // Ignore metric errors
  }
}

// ---------------------------------------------------------------------------
// Job handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a job handler for `webhook_delivery` jobs.
 *
 * The returned handler is an `async function(job)` that satisfies the
 * BackgroundWorker handler contract.  It reads retry configuration from
 * environment variables so that they can be tuned per deployment without a
 * code change:
 *
 * | Variable              | Default | Description                          |
 * |-----------------------|---------|--------------------------------------|
 * | `WEBHOOK_MAX_RETRIES` | 3       | Max delivery attempts (excluding 1st)|
 * | `WEBHOOK_BASE_DELAY`  | 500     | Base exponential-backoff delay (ms)  |
 * | `WEBHOOK_MAX_DELAY`   | 10000   | Backoff cap (ms)                     |
 * | `WEBHOOK_TIMEOUT_MS`  | 5000    | Per-request HTTP timeout (ms)        |
 *
 * @param {Object} [deps={}] - Optional dependency overrides (for testing).
 * @param {Function} [deps.send] - Override for `sendWebhookRequest`.
 * @param {Function} [deps.dead] - Override for `writeDeadLetter`.
 * @returns {Function} Async job handler: `async (job) => void`.
 */
function createWebhookDeliveryHandler(deps = {}) {
  const send = deps.send || sendWebhookRequest;
  const dead = deps.dead || writeDeadLetter;

  /**
   * Processes a `webhook_delivery` job: signs the payload, delivers it with
   * bounded exponential-backoff retry, and dead-letters on final failure.
   *
   * @param {Object} job - Job object from JobQueue.
   * @param {string} job.id - Unique job identifier.
   * @param {Object} job.payload - Delivery payload (see module JSDoc above).
   * @param {number} job.attempts - Current attempt count (1-based).
   * @returns {Promise<void>}
   */
  return async function webhookDeliveryHandler(job) {
    const {
      invoiceId,
      tenantId,
      webhookUrl,
      webhookSecret,
      event,
      transition = {},
    } = job.payload;

    const maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);
    const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);

    // Build deterministically-sorted payload
    const payload = sortKeys({
      event,
      invoiceId,
      tenantId,
      timestamp: new Date().toISOString(),
      transition: {
        from: transition.from,
        to: transition.to,
        actor: transition.actor,
        reason: transition.reason || null,
        transitionedAt: transition.transitionedAt,
      },
    });

    const rawBody = JSON.stringify(payload);

    // Log at debug level only — never log secret or full URL at info level
    logger.info(
      { invoiceId, tenantId, event, jobId: job.id, attempt: job.attempts },
      'webhook_delivery: starting delivery attempt'
    );

    let attemptCount = 0;

    const operation = async () => {
      attemptCount += 1;
      try {
        deliveryAttemptsCounter().inc();
      } catch (_) {
        /* ignore */
      }

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
              invoiceId,
              tenantId,
              event,
              jobId: job.id,
              attempt,
              errorCode: error && error.code ? error.code : undefined,
              errorMessage: error && error.message ? error.message : String(error),
            },
            'webhook_delivery: transient failure, will retry'
          );
        },
      });

      // Success
      try {
        deliverySuccessCounter().inc();
      } catch (_) {
        /* ignore */
      }

      logger.info(
        { invoiceId, tenantId, event, jobId: job.id, totalAttempts: attemptCount },
        'webhook_delivery: delivered successfully'
      );
    } catch (finalErr) {
      // Exhausted retries → dead-letter
      logger.error(
        {
          invoiceId,
          tenantId,
          event,
          jobId: job.id,
          totalAttempts: attemptCount,
          error: finalErr && finalErr.message ? finalErr.message : String(finalErr),
        },
        'webhook_delivery: exhausted retries, dead-lettering'
      );

      try {
        await dead({
          tenantId,
          invoiceId,
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
  createWebhookDeliveryHandler,
  // Exported for unit testing
  shouldRetry,
  sendWebhookRequest,
  writeDeadLetter,
};