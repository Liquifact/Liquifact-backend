'use strict';

const express = require('express');
const { verifySignature } = require('../services/webhooks');
const kycService = require('../services/kycService');
const logger = require('../logger');
const {
  kycWebhookRequestDurationSeconds,
  kycWebhookRequestsTotal,
  kycWebhookErrorsTotal,
  normalizeKycWebhookStatusClass,
  normalizeKycWebhookCause,
} = require('../metrics');

const router = express.Router();

// Per-client (API key / IP) rate limit on the kyc-webhooks endpoints (#729).
const { kycWebhookLimiter } = require('../middleware/rateLimit');
router.use(kycWebhookLimiter);

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const SORT_FIELD = 'updated_at';

/**
 * Parse JSON from a raw request body.
 */
function parseJsonPayload(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (_e) {
    throw new Error('Invalid JSON payload');
  }
}

/**
 * POST /api/kyc/webhook
 * (existing ingestion endpoint – unchanged)
 */
router.post('/webhook', async (req, res) => {
  const startTime = process.hrtime.bigint();
  let statusClass = '2xx';
  let cause = 'none';

  const finish = (httpStatus, errorCode) => {
    const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
    statusClass = normalizeKycWebhookStatusClass(httpStatus);
    cause = normalizeKycWebhookCause({ status: httpStatus, errorCode });
    kycWebhookRequestDurationSeconds.observe({ status_class: statusClass }, elapsed);
    kycWebhookRequestsTotal.inc({ status_class: statusClass });
    if (cause !== 'none') {
      kycWebhookErrorsTotal.inc({ cause });
    }
  };

  const config = kycService.getKycProviderConfig();
  const secret = config.apiSecret;
  const signatureHeader = req.header('X-Signature');
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');

  if (!secret) {
    logger.warn({ route: '/api/kyc/webhook' }, 'KYC webhook secret is not configured');
    finish(503, 'missing_secret');
    return res.status(503).json({ error: 'KYC webhook ingestion is not configured' });
  }

  if (!signatureHeader) {
    finish(401, 'missing_signature');
    return res.status(401).json({ error: 'Missing X-Signature header' });
  }

  const verification = verifySignature(secret, rawBody, signatureHeader);
  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'Invalid KYC webhook signature');
    finish(401, 'invalid_signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = parseJsonPayload(rawBody);
  } catch (error) {
    finish(400, 'invalid_payload');
    return res.status(400).json({ error: error.message });
  }

  const smeId = payload.smeId || payload.sme_id;
  const status = payload.status || payload.kycStatus || payload.kyc_status;
  const providerRecordId = payload.recordId || payload.providerRecordId || payload.provider_record_id || null;
  const verifiedAt = payload.verifiedAt || payload.verified_at || null;
  const payloadTenantId = payload.tenantId || payload.tenant_id || null;
  const requestTenantId = req.tenantId;

  if (payloadTenantId && requestTenantId && payloadTenantId !== requestTenantId) {
    return res.status(403).json({ error: 'Tenant scope mismatch.' });
  }

  if (payloadTenantId && !requestTenantId) {
    return res.status(400).json({ error: 'Missing tenant context.' });
  }

  if (!smeId || typeof smeId !== 'string') {
    finish(400, 'missing_sme_id');
    return res.status(400).json({ error: 'Missing or invalid smeId' });
  }

  if (!status || typeof status !== 'string') {
    finish(400, 'missing_status');
    return res.status(400).json({ error: 'Missing or invalid status' });
  }

  // Reject unsigned payloads that include a status we don't recognise. The
  // signed webhook is the provider's authoritative signal — if it sends a
  // status string outside {@link kycService.PROVIDER_STATUS_MAP} we must not
  // silently normalise it to 'unknown'. Fail-closed (issue #592).
  const normalised = kycService.normalizeProviderStatus(status);
  if (normalised === kycService.KYC_STATUSES.UNKNOWN) {
    logger.warn(
      { smeId, status },
      'KYC webhook received status outside PROVIDER_STATUS_MAP; rejecting (fail-closed)',
    );
    finish(400, 'unknown_status');
    return res.status(400).json({ error: `Unknown provider status: ${status}` });
  }

  try {
    const record = await kycService.persistKycRecord({
      smeId,
      status,
      providerRecordId,
      verifiedAt,
    });

    logger.info(
      {
        smeId: record.smeId,
        status: record.status,
        providerRecordId: record.recordId,
      },
      'KYC webhook ingested successfully'
    );

    finish(200);
    return res.status(200).json({ success: true, smeId: record.smeId, status: record.status });
  } catch (error) {
    logger.error({ smeId, error: error.message }, 'Failed to process KYC webhook');
    finish(500, 'persistence_error');
    return res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/kyc/webhooks
 *
 * Cursor-paginated listing of KYC records (the kyc-webhooks listing endpoint).
 */
router.get('/webhooks', async (req, res, next) => {
  try {
    const { cursor, status } = req.query;
    const rawLimit = req.query.limit;

    // Validate limit
    if (rawLimit !== undefined) {
      const v = parseInt(rawLimit, 10);
      if (isNaN(v) || v < 1 || v > MAX_LIMIT) {
        return res.status(400).json(
          responseHelper.error(
            `limit must be an integer between 1 and ${MAX_LIMIT}`,
            'INVALID_PAGINATION'
          )
        );
      }
    }

    const limit = rawLimit !== undefined
      ? Math.min(parseInt(rawLimit, 10), MAX_LIMIT)
      : DEFAULT_LIMIT;

    // Decode cursor
    let cursorData = null;
    if (cursor) {
      try {
        cursorData = decodeCursor(cursor, SORT_FIELD);
      } catch (err) {
        if (err instanceof CursorError) {
          return res.status(400).json(
            responseHelper.error(err.message, 'INVALID_CURSOR')
          );
        }
        return next(err);
      }
    }

    // Build query
    let query = db('kyc_records')
      .select(
        'sme_id as smeId',
        'status',
        'provider_record_id as recordId',
        'verified_at as verifiedAt',
        'updated_at as updatedAt'
      )
      .orderBy('updated_at', 'desc')
      .orderBy('sme_id', 'desc')
      .limit(limit + 1);

    if (status) {
      query = query.where('status', status);
    }

    if (cursorData) {
      query = query.where(function () {
        this.where('updated_at', '<', cursorData.sortValue)
          .orWhere(function () {
            this.where('updated_at', cursorData.sortValue)
              .andWhere('sme_id', '<', cursorData.id);
          });
      });
    }

    const rows = await query;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor({
        sortField: SORT_FIELD,
        sortValue: last.updatedAt instanceof Date
          ? last.updatedAt.toISOString()
          : last.updatedAt,
        id: String(last.smeId),
      });
    }

    return res.status(200).json({
      data: pageRows,
      meta: {
        limit,
        hasMore,
        nextCursor,
      },
    });
  } catch (error) {
    logger.error({ err: error.message }, 'Failed to list KYC webhooks');
    return next(error);
  }
});

module.exports = router;
