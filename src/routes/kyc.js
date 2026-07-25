'use strict';

const express = require('express');
const kycService = require('../services/kycService');
const logger = require('../logger');
const {
  kycWebhookRequestDurationSeconds,
  kycWebhookRequestsTotal,
  kycWebhookErrorsTotal,
  normalizeKycWebhookStatusClass,
  normalizeKycWebhookCause,
} = require('../metrics');
const { validateKycWebhookRequest } = require('../middleware/kycWebhookValidation');

const router = express.Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const SORT_FIELD = 'updated_at';

/**
 * POST /api/kyc/webhook
 * (existing ingestion endpoint – unchanged behaviour)
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
  const signatureHeader = req.header('X-Signature') || '';
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  const requestTenantId = req.tenantId;

  // Delegate all pre-ingestion validation to the shared helper
  const validation = validateKycWebhookRequest(rawBody, signatureHeader, secret, requestTenantId, kycService);

  if (!validation.valid) {
    const { status: errStatus, body: errBody, errorCode } = validation.error;

    // Emit warning logs for validation failures that produce them upstream
    if (errorCode === 'missing_secret') {
      logger.warn({ route: '/api/kyc/webhook' }, 'KYC webhook secret is not configured');
    } else if (errorCode === 'invalid_signature') {
      logger.warn({ error: validation.error.verificationError || 'invalid_signature' }, 'Invalid KYC webhook signature');
    } else if (errorCode === 'unknown_status') {
      logger.warn(
        { smeId: validation.error.smeId || '(unknown)', status: validation.error.status || '(unknown)' },
        'KYC webhook received status outside PROVIDER_STATUS_MAP; rejecting (fail-closed)',
      );
    }

    finish(errStatus, errorCode);
    return res.status(errStatus).json(errBody);
  }

  const { smeId, status, providerRecordId, verifiedAt } = validation.payload;

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
