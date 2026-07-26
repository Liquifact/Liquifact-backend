'use strict';

/**
 * @fileoverview KYC webhook emitter service.
 *
 * Responsible for enqueueing signed outbound webhook delivery jobs whenever an
 * SME's KYC status changes. Works in conjunction with `kycWebhookDelivery.js`
 * (the job handler) and the shared `BackgroundWorker`.
 *
 * ## Tenant lookup strategy
 * KYC records are SME-scoped, not invoice-scoped. To find which tenants should
 * receive a KYC event for a given SME we query the `invoices` table for any
 * invoice that belongs to the SME, then retrieve webhook configuration from the
 * `tenants` table for each distinct tenant found. This is consistent with the
 * existing invoice-centric data model and avoids adding a direct SME→tenant
 * foreign key.
 *
 * ## Payload size bounding
 * The serialised JSON payload is checked against `KYC_WEBHOOK_MAX_PAYLOAD_BYTES`
 * (default 64 KB) before enqueueing. Oversized payloads are rejected with a
 * logged warning; they are never enqueued.
 *
 * ## Fire-and-forget safety
 * `emitKycWebhookForSme` is designed to be called as fire-and-forget from
 * `kycService.persistKycRecord`. It never throws — all errors are caught
 * internally and logged. This ensures that webhook emission can never prevent a
 * KYC status update from completing.
 *
 * @module services/kycWebhookEmitter
 */

const db = require('../db/knex');
const logger = require('../logger');
const { sortKeys } = require('./webhooks');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum serialised payload size in bytes (64 KB). */
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Canonical KYC event names emitted on status transitions.
 *
 * @readonly
 * @enum {string}
 */
const KYC_WEBHOOK_EVENTS = {
  VERIFIED: 'kyc.verified',
  REJECTED: 'kyc.rejected',
  EXEMPTED: 'kyc.exempted',
  PENDING: 'kyc.pending',
};

/**
 * Maps a normalised KYC status string to its corresponding webhook event name.
 *
 * @param {string} status - Normalised KYC status (e.g. `'verified'`).
 * @returns {string|null} The event name, or `null` for unknown statuses.
 */
function statusToEvent(status) {
  const map = {
    verified: KYC_WEBHOOK_EVENTS.VERIFIED,
    rejected: KYC_WEBHOOK_EVENTS.REJECTED,
    exempted: KYC_WEBHOOK_EVENTS.EXEMPTED,
    pending: KYC_WEBHOOK_EVENTS.PENDING,
  };
  return map[status] || null;
}

// ---------------------------------------------------------------------------
// Shared worker reference (injected at startup, same pattern as webhooks.js)
// ---------------------------------------------------------------------------

let _sharedWorker = null;

/**
 * Injects the BackgroundWorker instance used by `enqueueKycWebhookDelivery`.
 * Call this once at application startup after the worker has been created and
 * the `kyc_webhook_delivery` handler has been registered.
 *
 * @param {import('../workers/worker')} worker - Configured BackgroundWorker.
 * @returns {void}
 */
function setSharedWorker(worker) {
  _sharedWorker = worker;
}

// ---------------------------------------------------------------------------
// Payload size guard
// ---------------------------------------------------------------------------

/**
 * Returns the maximum allowed KYC webhook payload size in bytes.
 * Reads from `KYC_WEBHOOK_MAX_PAYLOAD_BYTES`; falls back to 64 KB.
 *
 * @returns {number}
 */
function getMaxPayloadBytes() {
  const raw = Number(process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PAYLOAD_BYTES;
}

// ---------------------------------------------------------------------------
// Tenant lookup
// ---------------------------------------------------------------------------

/**
 * Finds all tenants that have webhook configuration and are associated with the
 * given SME (via the `invoices` table). Returns an array of objects containing
 * `tenantId`, `webhookUrl`, and `webhookSecret`.
 *
 * Returns an empty array (never throws) if the lookup fails.
 *
 * @param {string} smeId - SME identifier.
 * @returns {Promise<Array<{tenantId: string, webhookUrl: string, webhookSecret: string}>>}
 */
async function findTenantsForSme(smeId) {
  try {
    // Fetch distinct tenant IDs that have at least one invoice for this SME
    const rows = await db('invoices')
      .select('tenant_id')
      .where('sme_id', smeId)
      .distinct('tenant_id');

    if (!rows || rows.length === 0) {
      return [];
    }

    const tenantIds = rows.map((r) => r.tenant_id);

    // Fetch webhook settings for those tenants
    const tenants = await db('tenants')
      .select('id', 'settings')
      .whereIn('id', tenantIds);

    const result = [];
    for (const tenant of tenants) {
      if (!tenant.settings) {continue;}
      const { webhook_url: webhookUrl, webhook_secret: webhookSecret } = tenant.settings;
      if (!webhookUrl || !webhookSecret) {continue;}
      result.push({
        tenantId: tenant.id,
        webhookUrl,
        webhookSecret,
      });
    }

    return result;
  } catch (err) {
    logger.error(
      { smeId, error: err && err.message ? err.message : String(err) },
      'kycWebhookEmitter: failed to look up tenants for SME'
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Enqueue helper
// ---------------------------------------------------------------------------

/**
 * Enqueues a `kyc_webhook_delivery` job for a KYC status change.
 *
 * Looks up all tenants associated with the SME and enqueues one job per
 * tenant that has a configured webhook. Returns an array of enqueued job IDs.
 *
 * Returns `[]` (and never throws) when:
 *  - The shared worker has not been initialised.
 *  - No tenants are associated with the SME.
 *  - No tenant has a configured webhook.
 *  - The serialised payload exceeds `KYC_WEBHOOK_MAX_PAYLOAD_BYTES`.
 *  - Any other unexpected error occurs.
 *
 * @param {Object} options
 * @param {string} options.smeId      - SME identifier.
 * @param {string} options.event      - KYC event name (use `KYC_WEBHOOK_EVENTS`).
 * @param {Object} [options.kycData]  - KYC state snapshot included in the payload.
 * @param {string} [options.kycData.status]     - Normalised KYC status.
 * @param {string|null} [options.kycData.recordId]   - Provider record ID.
 * @param {string|null} [options.kycData.verifiedAt] - ISO timestamp when verified.
 * @returns {Promise<string[]>} Enqueued job IDs.
 */
async function enqueueKycWebhookDelivery({ smeId, event, kycData = {} }) {
  if (!_sharedWorker) {
    logger.info({ smeId, event }, 'kycWebhookEmitter: shared worker not set, skipping enqueue');
    return [];
  }

  const maxPayloadBytes = getMaxPayloadBytes();

  // Pre-validate payload size using a representative payload
  const samplePayload = sortKeys({
    event,
    smeId,
    tenantId: '',
    timestamp: new Date().toISOString(),
    kyc: {
      status: kycData.status || null,
      recordId: kycData.recordId || null,
      verifiedAt: kycData.verifiedAt || null,
    },
  });
  const sampleBody = JSON.stringify(samplePayload);
  const payloadBytes = Buffer.byteLength(sampleBody, 'utf8');

  if (payloadBytes > maxPayloadBytes) {
    logger.warn(
      { smeId, event, payloadBytes, maxPayloadBytes },
      'kycWebhookEmitter: payload too large, skipping enqueue'
    );
    return [];
  }

  const tenants = await findTenantsForSme(smeId);

  if (tenants.length === 0) {
    logger.info({ smeId, event }, 'kycWebhookEmitter: no tenants with webhooks configured for SME');
    return [];
  }

  const jobIds = [];
  for (const { tenantId, webhookUrl, webhookSecret } of tenants) {
    try {
      const jobId = _sharedWorker.enqueue('kyc_webhook_delivery', {
        smeId,
        tenantId,
        webhookUrl,
        webhookSecret,
        event,
        kycData,
      });

      logger.info(
        { smeId, tenantId, event, jobId },
        'kycWebhookEmitter: delivery job enqueued'
      );

      jobIds.push(jobId);
    } catch (err) {
      logger.error(
        {
          smeId,
          tenantId,
          event,
          error: err && err.message ? err.message : String(err),
        },
        'kycWebhookEmitter: failed to enqueue delivery job for tenant'
      );
    }
  }

  return jobIds;
}

// ---------------------------------------------------------------------------
// Fire-and-forget top-level emitter
// ---------------------------------------------------------------------------

/**
 * Emits KYC webhook events for all tenants associated with the given SME,
 * based on the new KYC status. This is the primary integration point called
 * from `kycService.persistKycRecord`.
 *
 * This function is **fire-and-forget**: it never throws. All errors are caught
 * internally so that a webhook failure can never prevent a KYC status update.
 *
 * @param {Object} params
 * @param {string} params.smeId                  - SME identifier.
 * @param {string} params.status                 - Normalised KYC status.
 * @param {string|null} [params.recordId]        - Provider record ID.
 * @param {string|null} [params.verifiedAt]      - ISO timestamp when verified.
 * @returns {Promise<void>}
 */
async function emitKycWebhookForSme({ smeId, status, recordId = null, verifiedAt = null }) {
  try {
    if (!smeId || typeof smeId !== 'string') {
      logger.warn({ smeId }, 'kycWebhookEmitter: invalid smeId, skipping emission');
      return;
    }

    const event = statusToEvent(status);
    if (!event) {
      logger.warn({ smeId, status }, 'kycWebhookEmitter: unknown status, skipping emission');
      return;
    }

    await enqueueKycWebhookDelivery({
      smeId,
      event,
      kycData: {
        status,
        recordId,
        verifiedAt,
      },
    });
  } catch (err) {
    // Must never propagate — KYC persistence must not be blocked by webhook errors
    logger.error(
      {
        smeId,
        status,
        error: err && err.message ? err.message : String(err),
      },
      'kycWebhookEmitter: unexpected error during webhook emission (suppressed)'
    );
  }
}

module.exports = {
  KYC_WEBHOOK_EVENTS,
  statusToEvent,
  setSharedWorker,
  findTenantsForSme,
  enqueueKycWebhookDelivery,
  emitKycWebhookForSme,
  getMaxPayloadBytes,
  DEFAULT_MAX_PAYLOAD_BYTES,
};
