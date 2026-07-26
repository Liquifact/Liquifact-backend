'use strict';

const express = require('express');
const db = require('../db/knex');
const kycService = require('../services/kycService');
const logger = require('../logger');
const responseHelper = require('../utils/responseHelper');
const { decodeCursor, encodeCursor, CursorError } = require('../utils/cursorPagination');
const {
  kycWebhookRequestDurationSeconds,
  kycWebhookRequestsTotal,
  kycWebhookErrorsTotal,
  normalizeKycWebhookStatusClass,
  normalizeKycWebhookCause,
} = require('../metrics');
const { validateKycWebhookRequest } = require('../middleware/kycWebhookValidation');
const {
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_DB,
  KYC_WEBHOOK_PAGINATION,
  KYC_WEBHOOK_METRICS,
} = require('../constants/kycWebhooks');

const router = express.Router();

// Per-client (API key / IP) rate limit on the kyc-webhooks endpoints (#729).
const { kycWebhookLimiter } = require('../middleware/rateLimit');
router.use(kycWebhookLimiter);

const MAX_LIMIT = KYC_WEBHOOK_PAGINATION.MAX_LIMIT;
const DEFAULT_LIMIT = KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT;
const SORT_FIELD = KYC_WEBHOOK_PAGINATION.SORT_FIELD;

/**
 * POST /api/kyc/webhook
 * Inbound KYC webhook ingestion endpoint.
 */
router.post(KYC_WEBHOOK_ROUTES.WEBHOOK, async (req, res) => {
  const startTime = process.hrtime.bigint();
  let statusClass = KYC_WEBHOOK_METRICS.STATUS_CLASS_2XX;
  let cause = KYC_WEBHOOK_METRICS.CAUSE_NONE;

  const finish = (httpStatus, errorCode) => {
    const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
    statusClass = normalizeKycWebhookStatusClass(httpStatus);
    cause = normalizeKycWebhookCause({ status: httpStatus, errorCode });
    kycWebhookRequestDurationSeconds.observe({ status_class: statusClass }, elapsed);
    kycWebhookRequestsTotal.inc({ status_class: statusClass });
    if (cause !== KYC_WEBHOOK_METRICS.CAUSE_NONE) {
      kycWebhookErrorsTotal.inc({ cause });
    }
  };

  const config = kycService.getKycProviderConfig();
  const secret = config.apiSecret;
  const signatureHeader = req.header(HTTP_HEADERS.X_SIGNATURE) || '';
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  const requestTenantId = req.tenantId;

  // Delegate all pre-ingestion validation to the shared helper
  const validation = validateKycWebhookRequest(rawBody, signatureHeader, secret, requestTenantId, kycService);

  if (!validation.valid) {
    const { status: errStatus, body: errBody, errorCode } = validation.error;

    // Emit warning logs for validation failures that produce them upstream
    if (errorCode === KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET) {
      logger.warn({ route: KYC_WEBHOOK_ROUTES.FULL_WEBHOOK_PATH }, KYC_WEBHOOK_MESSAGES.SECRET_NOT_CONFIGURED_LOG);
    } else if (errorCode === KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE) {
      logger.warn(
        { error: validation.error.verificationError || KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE },
        KYC_WEBHOOK_MESSAGES.INVALID_SIGNATURE_LOG
      );
    } else if (errorCode === KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS) {
      logger.warn(
        { smeId: validation.error.smeId || '(unknown)', status: validation.error.providerStatus || validation.error.status || '(unknown)' },
        KYC_WEBHOOK_MESSAGES.FAIL_CLOSED_LOG
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
      KYC_WEBHOOK_MESSAGES.SUCCESS_INGESTION
    );

    finish(200);
    return res.status(200).json({ success: true, smeId: record.smeId, status: record.status });
  } catch (error) {
    logger.error({ smeId, error: error.message }, KYC_WEBHOOK_MESSAGES.FAILED_INGESTION);
    finish(500, KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/kyc/webhooks
 *
 * Cursor-paginated listing of KYC records (the kyc-webhooks listing endpoint).
 */
router.get(KYC_WEBHOOK_ROUTES.WEBHOOKS, async (req, res, next) => {
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
            KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION
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
            responseHelper.error(err.message, KYC_WEBHOOK_ERROR_CODES.INVALID_CURSOR)
          );
        }
        return next(err);
      }
    }

    // Build query
    let query = db(KYC_WEBHOOK_DB.TABLE_KYC_RECORDS)
      .select(
        'sme_id as smeId',
        'status',
        'provider_record_id as recordId',
        'verified_at as verifiedAt',
        'updated_at as updatedAt'
      )
      .orderBy('updated_at', KYC_WEBHOOK_PAGINATION.DEFAULT_ORDER)
      .orderBy('sme_id', KYC_WEBHOOK_PAGINATION.DEFAULT_ORDER)
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
