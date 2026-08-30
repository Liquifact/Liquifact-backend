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
const crypto = require('crypto');
const { createSignatureHeader, sortKeys } = require('../services/webhooks');
const { withRetry, parseRetryAfterMs } = require('../utils/retry');
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
  if (err.code === 'LEASE_LOST') {
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

const LEASE_TTL_MS = Number(process.env.WEBHOOK_LEASE_TTL_MS || 30000);
const LEASE_RENEW_MS = Number(process.env.WEBHOOK_LEASE_RENEW_MS || 10000);

/**
 * Error thrown when a worker no longer owns the job lease.
 *
 * This is intentionally non-retryable: retrying from a fenced worker would
 * duplicate side effects after another worker has been granted the lease.
 */
class LeaseLostError extends Error {
  constructor(message = 'Job lease lost or expired') {
    super(message);
    this.name = 'LeaseLostError';
    this.code = 'LEASE_LOST';
    this.status = 409;
    this.retryable = false;
  }
}

/**
 * Acquires a fencing lease for a job.
 *
 * The lease row stores an opaque fencing token. A worker may only renew,
 * complete, or write dead-letter records while it holds the matching token.
 *
 * @param {string} jobId - Job identifier.
 * @param {string} workerId - Unique worker/run identifier.
 * @param {number} [ttlMs] - Lease lifetime in milliseconds.
 * @returns {Promise<{token: string, expiresAt: Date}>}
 */
async function acquireLease(jobId, workerId, ttlMs = LEASE_TTL_MS) {
  const token = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const trx = await db.transaction();
  try {
    const existing = await trx('job_leases')
      .where({ job_id: jobId })
      .forUpdate()
      .first();

    if (!existing) {
      await trx('job_leases').insert({
        job_id: jobId,
        worker_id: workerId,
        token,
        expires_at: expiresAt,
        created_at: now,
        updated_at: now,
      });
    } else if (new Date(existing.expires_at).getTime() <= now.getTime()) {
      await trx('job_leases')
        .where({ job_id: jobId })
        .update({
          worker_id: workerId,
          token,
          expires_at: expiresAt,
          updated_at: now,
        });
    } else {
      await trx.rollback();
      throw new LeaseLostError('Job lease is held by another worker');
    }

    await trx.commit();
    return { token, expiresAt };
  } catch (err) {
    try {
      await trx.rollback();
    } catch (_) {
      // Ignore rollback failure; original error is more useful.
    }
    throw err;
  }
}

/**
 * Renews a lease, but only while the fencing token is still current.
 *
 * The SQL update atomically rejects attempts from a worker whose token has
 * been replaced by a newer lease holder.
 *
 * @param {string} jobId - Job identifier.
 * @param {string} token - Fencing token from lease acquisition.
 * @param {number} [ttlMs] - Renewed lease lifetime in milliseconds.
 * @returns {Promise<{expiresAt: Date}>}
 */
async function renewLease(jobId, token, ttlMs = LEASE_TTL_MS) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const rows = await db('job_leases')
    .where({ job_id: jobId, token })
    .where('expires_at', '>', now)
    .update({ expires_at: expiresAt, updated_at: now });
  if (!rows) {
    throw new LeaseLostError('Job lease expired or was reassigned');
  }
  return { expiresAt };
}

/**
 * Asserts that the calling worker still holds the current, unexpired lease.
 *
 * @param {string} jobId - Job identifier.
 * @param {string} token - Fencing token from lease acquisition.
 * @returns {Promise<Object>} The current lease row.
 */
async function assertLeaseCurrent(jobId, token) {
  const row = await db('job_leases')
    .where({ job_id: jobId, token })
    .where('expires_at', '>', new Date())
    .first();
  if (!row) {
    throw new LeaseLostError('Job lease expired or was reassigned');
  }
  return row;
}

/**
 * Releases a lease after successful completion.
 *
 * The delete is conditional on the matching token, so a stale worker cannot
 * release (and thereby appear to complete) a lease that has been reassigned.
 *
 * @param {string} jobId - Job identifier.
 * @param {string} token - Fencing token from lease acquisition.
 * @returns {Promise<void>}
 */
async function completeLease(jobId, token) {
  const rows = await db('job_leases')
    .where({ job_id: jobId, token })
    .del();
  if (!rows) {
    throw new LeaseLostError('Cannot complete a stale job lease');
  }
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
async function sendWebhookRequest({ webhookUrl, webhookSecret, rawBody, timeoutMs = 5000, signal }) {
  const signatureHeader = createSignatureHeader(webhookSecret, rawBody);

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort);
    }
  }

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
      err.retryAfterMs = parseRetryAfterMs(response.headers && response.headers.get
        ? response.headers.get('retry-after')
        : null);
      throw err;
    }

    return { ok: true, status: response.status };
  } finally {
    clearTimeout(timerId);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
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
 * @param {string} [params.jobId]   - Job ID used for lease fencing.
 * @param {string} [params.leaseToken] - Current lease token used for fencing.
 * @returns {Promise<void>}
 */
async function writeDeadLetter({ tenantId, invoiceId, event, payload, lastError, attempts, jobId, leaseToken }) {
  const trx = await db.transaction();
  try {
    if (jobId && leaseToken) {
      const lease = await trx('job_leases')
        .where({ job_id: jobId, token: leaseToken })
        .where('expires_at', '>', new Date())
        .forUpdate()
        .first();
      if (!lease) {
        throw new LeaseLostError('Cannot dead-letter with a stale job lease');
      }
    }

    await trx('webhook_dead_letters').insert({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      event,
      payload: JSON.stringify(payload),
      last_error: lastError,
      attempts,
      created_at: new Date(),
    });
    await trx.commit();
  } catch (dbErr) {
    try {
      await trx.rollback();
    } catch (_) {
      // Ignore rollback failure.
    }
    if (dbErr && dbErr.code === 'LEASE_LOST') {
      logger.warn({ err: dbErr.message }, 'Skipped webhook dead-letter write because lease is stale');
      throw dbErr;
    }
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
 * | `WEBHOOK_LEASE_TTL_MS` | 30000  | Job lease TTL (ms) before fencing   |
 * | `WEBHOOK_LEASE_RENEW_MS` | 10000 | Lease renewal interval (ms)       |
 *
 * @param {Object} [deps={}] - Optional dependency overrides (for testing).
 * @param {Function} [deps.send] - Override for `sendWebhookRequest`.
 * @param {Function} [deps.dead] - Override for `writeDeadLetter`.
 * @param {Object} [deps.lease] - Override lease operations
 *   (`acquire`, `renew`, `assertCurrent`, `complete`).
 * @returns {Function} Async job handler: `async (job) => void`.
 */
function createWebhookDeliveryHandler(deps = {}) {
  const send = deps.send || sendWebhookRequest;
  const dead = deps.dead || writeDeadLetter;
  const leaseProvider = deps.lease || {};
  const acquireLeaseFn = leaseProvider.acquire || acquireLease;
  const renewLeaseFn = leaseProvider.renew || renewLease;
  const assertLeaseCurrentFn = leaseProvider.assertCurrent || assertLeaseCurrent;
  const completeLeaseFn = leaseProvider.complete || completeLease;

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
    const tenantRetryBudget = Number.isFinite(Number(job.payload.tenantRetryBudget))
      ? Number(job.payload.tenantRetryBudget)
      : Number(process.env.WEBHOOK_TENANT_RETRY_BUDGET || maxRetries);
    const effectiveMaxRetries = Math.max(0, Math.min(maxRetries, tenantRetryBudget));
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);
    const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
    const leaseTtlMs = Number(process.env.WEBHOOK_LEASE_TTL_MS || 30000);
    const leaseRenewMs = Number(process.env.WEBHOOK_LEASE_RENEW_MS || 10000);

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

    const workerId = crypto.randomBytes(16).toString('hex');
    const lease = await acquireLeaseFn(job.id, workerId, leaseTtlMs);
    const leaseAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let leaseLost = false;
    let leaseRenewTimer = null;

    const renewLeaseForJob = async () => {
      try {
        await renewLeaseFn(job.id, lease.token, leaseTtlMs);
        logger.debug(
          { invoiceId, tenantId, event, jobId: job.id },
          'webhook_delivery: lease renewed'
        );
      } catch (err) {
        leaseLost = true;
        if (leaseRenewTimer) {
          clearInterval(leaseRenewTimer);
        }
        if (leaseAbortController) {
          leaseAbortController.abort();
        }
        logger.warn(
          {
            invoiceId,
            tenantId,
            event,
            jobId: job.id,
            errorCode: err && err.code ? err.code : undefined,
            errorMessage: err && err.message ? err.message : String(err),
          },
          'webhook_delivery: lease renewal failed; fencing worker'
        );
      }
    };

    leaseRenewTimer = setInterval(renewLeaseForJob, leaseRenewMs);
    if (leaseRenewTimer.unref) {
      leaseRenewTimer.unref();
    }

    // Log at debug level only — never log secret or full URL at info level
    logger.info(
      { invoiceId, tenantId, event, jobId: job.id, workerId, attempt: job.attempts },
      'webhook_delivery: lease acquired; starting delivery attempt'
    );

    let attemptCount = 0;

    const operation = async () => {
      if (leaseLost) {
        throw new LeaseLostError('Job lease lost before webhook attempt');
      }

      await assertLeaseCurrentFn(job.id, lease.token);

      attemptCount += 1;
      try {
        deliveryAttemptsCounter().inc();
      } catch (_) {
        /* ignore */
      }

      try {
        const result = await send({
          webhookUrl,
          webhookSecret,
          rawBody,
          timeoutMs,
          signal: leaseAbortController ? leaseAbortController.signal : undefined,
        });
        await assertLeaseCurrentFn(job.id, lease.token);
        return result;
      } catch (err) {
        if (leaseLost || (leaseAbortController && leaseAbortController.signal.aborted)) {
          throw new LeaseLostError('Job lease lost during webhook attempt');
        }
        throw err;
      }
    };

    try {
      await withRetry(operation, {
        maxRetries: effectiveMaxRetries,
        baseDelay,
        maxDelay,
        shouldRetry,
        retryDelay: (error) => error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null,
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
      // Stop renewing before the final fence check; the lease only needs to
      // outlive the remaining success-path statements.
      if (leaseRenewTimer) {
        clearInterval(leaseRenewTimer);
        leaseRenewTimer = null;
      }

      if (leaseLost) {
        throw new LeaseLostError('Job lease lost before completion');
      }

      await assertLeaseCurrentFn(job.id, lease.token);
      await completeLeaseFn(job.id, lease.token);

      try {
        deliverySuccessCounter().inc();
      } catch (_) {
        /* ignore */
      }

      logger.info(
        { invoiceId, tenantId, event, jobId: job.id, totalAttempts: attemptCount },
        'webhook_delivery: delivered successfully and lease released'
      );
    } catch (finalErr) {
      if (leaseRenewTimer) {
        clearInterval(leaseRenewTimer);
        leaseRenewTimer = null;
      }

      if (finalErr && finalErr.code === 'LEASE_LOST') {
        logger.warn(
          {
            invoiceId,
            tenantId,
            event,
            jobId: job.id,
            error: finalErr && finalErr.message ? finalErr.message : String(finalErr),
          },
          'webhook_delivery: lease lost; not dead-lettering'
        );
        throw finalErr;
      }

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
        await assertLeaseCurrentFn(job.id, lease.token);
      } catch (leaseErr) {
        logger.warn(
          {
            invoiceId,
            tenantId,
            event,
            jobId: job.id,
            error: leaseErr && leaseErr.message ? leaseErr.message : String(leaseErr),
          },
          'webhook_delivery: lease lost before dead-letter; skipping'
        );
        throw leaseErr;
      }

      try {
        await dead({
          tenantId,
          invoiceId,
          event,
          payload,
          lastError: finalErr && finalErr.message ? finalErr.message : String(finalErr),
          attempts: attemptCount,
          jobId: job.id,
          leaseToken: lease.token,
        });
      } catch (deadErr) {
        if (deadErr && deadErr.code === 'LEASE_LOST') {
          throw deadErr;
        }
        // dead() failures must not shadow the original delivery error
      }

      // Re-throw so BackgroundWorker can mark the job as failed
      throw finalErr;
    } finally {
      if (leaseRenewTimer) {
        clearInterval(leaseRenewTimer);
      }
    }
  };
}

module.exports = {
  createWebhookDeliveryHandler,
  // Exported for unit testing
  acquireLease,
  renewLease,
  assertLeaseCurrent,
  completeLease,
  LeaseLostError,
  shouldRetry,
  sendWebhookRequest,
  writeDeadLetter,
};
