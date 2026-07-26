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

/**
 * Returns true when the KYC webhook endpoint is enabled.
 * Reads KYC_WEBHOOK_ENABLED at call-time so the flag can be toggled
 * without a process restart.
 *
 * Safe default: disabled — any value other than the exact string "true"
 * leaves the endpoint off.
 *
 * @returns {boolean}
 */
function isKycWebhookEnabled() {
  return process.env.KYC_WEBHOOK_ENABLED === 'true';
}

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

  const payloadTenantId = payload.tenantId || payload.tenant_id || null;
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

  if (payloadTenantId && !requestTenantId) {
    return res.status(400).json({ error: 'Missing tenant context.' });
  }

  // Normalise provider aliases (snake_case / legacy field names) into the
  // canonical shape, then validate declaratively against kycWebhookSchema
  // instead of ad hoc typeof checks (issue #905).
  const normalizedPayload = {
    smeId: payload.smeId ?? payload.sme_id,
    status: payload.status ?? payload.kycStatus ?? payload.kyc_status,
    recordId: payload.recordId ?? payload.providerRecordId ?? payload.provider_record_id ?? undefined,
    verifiedAt: payload.verifiedAt ?? payload.verified_at ?? undefined,
  };

  const parsedPayload = kycWebhookSchema.safeParse(normalizedPayload);
  if (!parsedPayload.success) {
    const fieldErrors = parseValidationErrors(parsedPayload.error);

    // Preserve the pre-existing smeId/status error contract (message + bounded
    // metrics cause) that other tests/consumers already depend on, while still
    // gaining schema-driven validation of length, format, and unknown fields.
    if (fieldErrors.smeId) {
      finish(400, 'missing_sme_id');
      return res.status(400).json({ error: 'Missing or invalid smeId', details: fieldErrors });
    }
    if (fieldErrors.status) {
      finish(400, 'missing_status');
      return res.status(400).json({ error: 'Missing or invalid status', details: fieldErrors });
    }

    finish(400, 'invalid_payload');
    return res.status(400).json({ error: 'Invalid KYC webhook payload', details: fieldErrors });
  }

  const smeId = parsedPayload.data.smeId;
  const status = parsedPayload.data.status;
  const providerRecordId = parsedPayload.data.recordId || null;
  const verifiedAt = parsedPayload.data.verifiedAt || null;

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

    const responseBody = {
      data: pageRows,
      meta: {
        limit,
        hasMore,
        nextCursor,
      },
    };

    // Validate the outgoing shape at the boundary (issue #905) — a shape
    // drift here reflects a bug in the query projection above, not a client
    // error, so it is logged and surfaced as a 500 rather than shipped as-is.
    const parsedResponse = kycWebhookListResponseSchema.safeParse(responseBody);
    if (!parsedResponse.success) {
      logger.error(
        { errors: parseValidationErrors(parsedResponse.error) },
        'KYC webhooks list response failed schema validation',
      );
      return res.status(500).json(
        responseHelper.error('Failed to build KYC webhooks response', 'INTERNAL_ERROR')
      );
    }

    return res.status(200).json(parsedResponse.data);
  } catch (error) {
    logger.error({ err: error.message }, 'Failed to list KYC webhooks');
    return next(error);
  }
});

module.exports = router;
module.exports.isKycWebhookEnabled = isKycWebhookEnabled;
