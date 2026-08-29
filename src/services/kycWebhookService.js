'use strict';

/**
 * KYC Webhook Service
 * Encapsulates business logic, validation orchestration, audit log reads,
 * and database queries for KYC webhooks.
 *
 * @module services/kycWebhookService
 */

const db = require('../db/knex');
const kycService = require('./kycService');
const logger = require('../logger');
const auditLog = require('./auditLog');
const { redactValue } = require('./auditLogStore');
const { verifySignature } = require('./webhooks');
const { kycWebhookSchema, parseValidationErrors, kycWebhookListResponseSchema } = require('../schemas/kycWebhook');
const { decodeCursor, encodeCursor, CursorError } = require('../utils/cursorPagination');
const { quarantineKycWebhook, validateEnvelope } = require('./kycQuarantineService');
const KycWebhookError = require('../errors/KycWebhookError');
const {
  HTTP_HEADERS: _HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_PAGINATION,
} = require('../constants/kycWebhooks');

const MAX_LIMIT = KYC_WEBHOOK_PAGINATION.MAX_LIMIT;
const DEFAULT_LIMIT = KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT;
const SORT_FIELD = KYC_WEBHOOK_PAGINATION.SORT_FIELD;

/**
 * Processes inbound KYC webhook ingestion.
 *
 * Validates secret, signature, payload JSON, tenant context, schema requirements,
 * and provider status map before persisting the record to storage.
 * Malformed or invalid payloads are safely quarantined with sensitive fields redacted.
 *
 * @param {Object} params
 * @param {string|Buffer} params.rawBody - Raw request body string or Buffer
 * @param {string} [params.signatureHeader] - Value of X-Signature header
 * @param {string|null} [params.requestTenantId] - Tenant ID attached to the request
 * @param {string} [params.actor] - Identity performing ingestion
 * @param {string} [params.ipAddress] - IP address of the client
 * @param {string} [params.userAgent] - User agent of the client
 * @returns {Promise<{success: boolean, smeId: string, status: string}>} Ingestion result
 */
async function processWebhookIngestion({
  rawBody,
  signatureHeader = '',
  requestTenantId = null,
  actor = 'kyc-provider',
  ipAddress = 'unknown',
  userAgent = 'unknown',
} = {}) {
  const config = kycService.getKycProviderConfig();
  const secret = config.apiSecret;
  const sig = signatureHeader || '';
  const body = rawBody instanceof Buffer ? rawBody.toString('utf8') : String(rawBody || '');

  if (!secret) {
    logger.warn({ route: KYC_WEBHOOK_ROUTES.FULL_WEBHOOK_PATH }, 'KYC webhook secret is not configured');
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.MISSING_SECRET, 503, KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
  }

  if (!sig) {
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.MISSING_SIGNATURE, 401, KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE);
  }

  const verification = verifySignature(secret, body, sig);
  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'Invalid KYC webhook signature');
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.INVALID_SIGNATURE, 401, KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
  }

  // Envelope and payload validation before domain mapping
  const envelopeValidation = validateEnvelope(body);
  if (!envelopeValidation.valid) {
    await quarantineKycWebhook({
      rawBody: body,
      payload: envelopeValidation.payload || null,
      event: envelopeValidation.event || 'unknown',
      reason: envelopeValidation.reason,
      errorCode: envelopeValidation.errorCode || KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      errorDetails: envelopeValidation.errorDetails || null,
      tenantId: requestTenantId,
      actor,
      ipAddress,
      userAgent,
    });

    throw new KycWebhookError(
      envelopeValidation.reason,
      400,
      envelopeValidation.errorCode || KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD
    );
  }

  const payload = envelopeValidation.payload;
  const payloadTenantId = envelopeValidation.domainData.tenantId;

  if (payloadTenantId && requestTenantId && payloadTenantId !== requestTenantId) {
    await quarantineKycWebhook({
      rawBody: body,
      payload,
      event: envelopeValidation.event,
      reason: KYC_WEBHOOK_MESSAGES.TENANT_MISMATCH,
      errorCode: KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH,
      tenantId: requestTenantId,
      actor,
      ipAddress,
      userAgent,
    });
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.TENANT_MISMATCH, 403, KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
  }

  if (payloadTenantId && !requestTenantId) {
    await quarantineKycWebhook({
      rawBody: body,
      payload,
      event: envelopeValidation.event,
      reason: KYC_WEBHOOK_MESSAGES.MISSING_TENANT_CONTEXT,
      errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT,
      tenantId: null,
      actor,
      ipAddress,
      userAgent,
    });
    throw new KycWebhookError(KYC_WEBHOOK_MESSAGES.MISSING_TENANT_CONTEXT, 400, KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT);
  }

  const normalizedPayload = {
    smeId: envelopeValidation.domainData.smeId ?? undefined,
    status: envelopeValidation.domainData.status ?? undefined,
    recordId: envelopeValidation.domainData.recordId ?? undefined,
    verifiedAt: envelopeValidation.domainData.verifiedAt ?? undefined,
  };

  const parsedPayload = kycWebhookSchema.safeParse(normalizedPayload);
  if (!parsedPayload.success) {
    const fieldErrors = parseValidationErrors(parsedPayload.error);

    if (fieldErrors.smeId) {
      await quarantineKycWebhook({
        rawBody: body,
        payload,
        event: envelopeValidation.event,
        smeId: normalizedPayload.smeId || null,
        reason: KYC_WEBHOOK_MESSAGES.MISSING_SME_ID,
        errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID,
        errorDetails: fieldErrors,
        tenantId: requestTenantId || payloadTenantId,
        actor,
        ipAddress,
        userAgent,
      });
      throw new KycWebhookError('Missing or invalid smeId', 400, KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
    }
    if (fieldErrors.status) {
      await quarantineKycWebhook({
        rawBody: body,
        payload,
        event: envelopeValidation.event,
        smeId: normalizedPayload.smeId || null,
        reason: KYC_WEBHOOK_MESSAGES.MISSING_STATUS,
        errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS,
        errorDetails: fieldErrors,
        tenantId: requestTenantId || payloadTenantId,
        actor,
        ipAddress,
        userAgent,
      });
      throw new KycWebhookError('Missing or invalid status', 400, KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
    }

    await quarantineKycWebhook({
      rawBody: body,
      payload,
      event: envelopeValidation.event,
      smeId: normalizedPayload.smeId || null,
      reason: 'Invalid KYC webhook payload',
      errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      errorDetails: fieldErrors,
      tenantId: requestTenantId || payloadTenantId,
      actor,
      ipAddress,
      userAgent,
    });
    throw new KycWebhookError('Invalid KYC webhook payload', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
  }

  const smeId = parsedPayload.data.smeId;
  const status = parsedPayload.data.status;
  const providerRecordId = parsedPayload.data.recordId || null;
  const verifiedAt = parsedPayload.data.verifiedAt || null;

  const normalised = kycService.normalizeProviderStatus(status);
  if (normalised === kycService.KYC_STATUSES.UNKNOWN) {
    logger.warn(
      { smeId, status },
      'KYC webhook received status outside PROVIDER_STATUS_MAP; rejecting (fail-closed)'
    );
    await quarantineKycWebhook({
      rawBody: body,
      payload,
      event: envelopeValidation.event,
      smeId,
      reason: `Unknown provider status: ${status}`,
      errorCode: KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS,
      errorDetails: { status },
      tenantId: requestTenantId || payloadTenantId,
      actor,
      ipAddress,
      userAgent,
    });
    throw new KycWebhookError(`Unknown provider status: ${status}`, 400, KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS);
  }

  try {
    const record = await kycService.persistKycRecord(
      {
        smeId,
        status,
        providerRecordId,
        verifiedAt,
      },
      {
        actor,
        ipAddress,
        userAgent,
      }
    );

    logger.info(
      {
        smeId: record.smeId,
        status: record.status,
        providerRecordId: record.recordId,
      },
      KYC_WEBHOOK_MESSAGES.SUCCESS_INGESTION
    );

    return { success: true, smeId: record.smeId, status: record.status };
  } catch (error) {
    logger.error({ smeId, error: error.message }, KYC_WEBHOOK_MESSAGES.FAILED_INGESTION);
    throw new KycWebhookError(error.message, 500, KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
  }
}

/**
 * Retrieves audit log records for KYC webhooks with bounded pagination.
 *
 * @param {Object} params
 * @param {number|string} [params.rawLimit] - Raw limit query param
 * @param {number|string} [params.rawOffset] - Raw offset query param
 * @param {string|null} [params.smeId] - Optional SME ID / resource ID filter
 * @param {string|null} [params.action] - Optional action filter
 * @returns {Promise<{data: Array, meta: {limit: number, offset: number, count: number}}>}
 */
async function getWebhookAuditLogs({
  rawLimit,
  rawOffset,
  smeId = null,
  action = null,
} = {}) {
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const v = parseInt(rawLimit, 10);
    if (isNaN(v) || v < 1 || v > MAX_LIMIT) {
      throw new KycWebhookError(
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
        400,
        KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION
      );
    }
    limit = v;
  }

  let offset = 0;
  if (rawOffset !== undefined) {
    const v = parseInt(rawOffset, 10);
    if (isNaN(v) || v < 0) {
      throw new KycWebhookError(
        'offset must be a non-negative integer',
        400,
        KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION
      );
    }
    offset = v;
  }

  const logs = await auditLog.getAuditLogs({
    resourceType: 'kyc-webhook',
    resourceId: smeId,
    action,
    limit,
    offset,
  });

  const safeLogs = redactValue(logs);

  return {
    data: safeLogs,
    meta: {
      limit,
      offset,
      count: safeLogs.length,
    },
  };
}

/**
 * Cursor-paginated listing of active (non soft-deleted) KYC records.
 *
 * @param {Object} params
 * @param {string} [params.cursor] - Opaque pagination cursor
 * @param {string} [params.status] - Status filter
 * @param {number|string} [params.rawLimit] - Limit requested
 * @returns {Promise<{data: Array, meta: {limit: number, hasMore: boolean, nextCursor: string|null}}>}
 */
async function listWebhooks({
  cursor,
  status,
  rawLimit,
} = {}) {
  if (rawLimit !== undefined) {
    const v = parseInt(rawLimit, 10);
    if (isNaN(v) || v < 1 || v > MAX_LIMIT) {
      throw new KycWebhookError(
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
        400,
        KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION
      );
    }
  }

  const limit = rawLimit !== undefined
    ? Math.min(parseInt(rawLimit, 10), MAX_LIMIT)
    : DEFAULT_LIMIT;

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

  const parsedResponse = kycWebhookListResponseSchema.safeParse(responseBody);
  if (!parsedResponse.success) {
    logger.error(
      { errors: parseValidationErrors(parsedResponse.error) },
      'KYC webhooks list response failed schema validation'
    );
    throw new KycWebhookError('Failed to build KYC webhooks response', 500, 'INTERNAL_ERROR');
  }

  return parsedResponse.data;
}

module.exports = {
  processWebhookIngestion,
  getWebhookAuditLogs,
  listWebhooks,
};
