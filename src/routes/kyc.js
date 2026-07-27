'use strict';

const express = require('express');
const db = require('../db/knex');
const kycService = require('../services/kycService');
const logger = require('../logger');
const { verifySignature, parseJsonPayload } = require('../middleware/kycWebhookValidation');
const { kycWebhookSchema, parseValidationErrors, kycWebhookListResponseSchema } = require('../schemas/kycWebhook');
const { decodeCursor, encodeCursor, CursorError } = require('../utils/cursorPagination');
const asyncHandler = require('../utils/asyncHandler');
const KycWebhookError = require('../errors/KycWebhookError');
const kycWebhookErrorHandler = require('../middleware/kycWebhookErrorHandler');
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
router.post(KYC_WEBHOOK_ROUTES.WEBHOOK, asyncHandler(async (req, res) => {
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

  res.on('finish', () => {
    finish(res.statusCode, req._kycErrorCode || null);
  });

  const config = kycService.getKycProviderConfig();
  const secret = config.apiSecret;
  const signatureHeader = req.header(HTTP_HEADERS.X_SIGNATURE) || '';
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');

  if (!secret) {
    logger.warn({ route: '/api/kyc/webhook' }, 'KYC webhook secret is not configured');
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.MISSING_SECRET, 503, KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
  }

  if (!signatureHeader) {
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.MISSING_SIGNATURE, 401, KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE);
  }

  const verification = verifySignature(secret, rawBody, signatureHeader);
  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'Invalid KYC webhook signature');
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.INVALID_SIGNATURE, 401, KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
  }

  let payload;
  try {
    payload = parseJsonPayload(rawBody);
  } catch (error) {
    throw new KycWebhookError(error.message, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
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

    throw new KycWebhookError(errBody.error || 'Validation failed', errStatus, errorCode);
  }

  if (payloadTenantId && !requestTenantId) {
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.MISSING_TENANT_CONTEXT, 400, KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT);
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
      throw new KycWebhookError('Missing or invalid smeId', 400, KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
    }
    if (fieldErrors.status) {
      throw new KycWebhookError('Missing or invalid status', 400, KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
    }

    throw new KycWebhookError('Invalid KYC webhook payload', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
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
    throw new KycWebhookError(`Unknown provider status: ${status}`, 400, KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS);
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

    return res.status(200).json({ success: true, smeId: record.smeId, status: record.status });
  } catch (error) {
    logger.error({ smeId, error: error.message }, KYC_WEBHOOK_MESSAGES.FAILED_INGESTION);
    throw new KycWebhookError(error.message, 500, KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
  }
}));

/**
 * GET /api/kyc/webhooks
 *
 * Cursor-paginated listing of KYC records (the kyc-webhooks listing endpoint).
 */
router.get(KYC_WEBHOOK_ROUTES.WEBHOOKS, asyncHandler(async (req, res) => {
  const { cursor, status } = req.query;
  const rawLimit = req.query.limit;

  // Validate limit
  if (rawLimit !== undefined) {
    const v = parseInt(rawLimit, 10);
    if (isNaN(v) || v < 1 || v > MAX_LIMIT) {
      throw new KycWebhookError(
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
        400,
        KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION,
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
        throw new KycWebhookError(err.message, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_CURSOR);
      }
      throw err;
    }
  }

    // Build query — exclude soft-deleted records
    let query = db('kyc_records')
      .select(
        'sme_id as smeId',
        'status',
        'provider_record_id as recordId',
        'verified_at as verifiedAt',
        'updated_at as updatedAt'
      )
      .whereNull('deleted_at')
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
    throw new KycWebhookError('Failed to build KYC webhooks response', 500, 'INTERNAL_ERROR');
  }

  return res.status(200).json(parsedResponse.data);
}));

router.use(kycWebhookErrorHandler);

module.exports = router;
module.exports.isKycWebhookEnabled = isKycWebhookEnabled;
