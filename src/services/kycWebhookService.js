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
const { sanitizeTelemetryString, redactErrorForTelemetry } = require('../utils/telemetryRedaction');
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
 * Parse only complete, safe integer inputs so fractions and suffixes are not truncated.
 * @param {number|string} rawValue - Untrusted request value.
 * @param {number} min - Inclusive minimum accepted value.
 * @param {number} max - Inclusive maximum accepted value.
 * @returns {number|null} Parsed integer, or null when invalid.
 */
function parseBoundedInteger(rawValue, min, max) {
  if (typeof rawValue === 'number') {
    return Number.isSafeInteger(rawValue) && rawValue >= min && rawValue <= max
      ? rawValue
      : null;
  }
  if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue)) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Processes inbound KYC webhook ingestion.
 *
 * Validates secret, signature, payload JSON, tenant context, schema requirements,
 * and provider status map before persisting the record to storage.
 * Malformed or invalid payloads are safely quarantined with sensitive fields redacted.
 *
 * ## Concurrency invariant
 *
 * Two concurrent requests for the **same smeId** are serialized at the DB
 * level via a `SELECT … FOR UPDATE` advisory row-lock inside the persist
 * transaction.  This guarantees:
 *
 * - No duplicate KYC writes: the second concurrent call waits for the first
 *   to commit, then observes the already-written record and returns the
 *   same `{ success, smeId, status }` shape.
 * - No race between quarantine INSERT and KycWebhookError throw: both
 *   happen inside the same code path.  The quarantine call is intentionally
 *   outside the per-smeId transaction because quarantine is a best-effort
 *   diagnostic write that must never block or roll back the main path.
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
  const config = kycService.getKycProviderConfig() || {};
  const activeSecret = process.env.WEBHOOK_SIGNING_KEY || config.apiSecret || null;
  const retiringSecret = process.env.WEBHOOK_SIGNING_KEY_RETIRING || null;
  const sig = signatureHeader || '';
  const body = rawBody instanceof Buffer ? rawBody.toString('utf8') : String(rawBody || '');

  if (!activeSecret && !retiringSecret) {
    logger.warn({ route: KYC_WEBHOOK_ROUTES.FULL_WEBHOOK_PATH }, 'KYC webhook secret is not configured');
    throw new KycWebhookError(
      KYC_WEBHOOK_MESSAGES.MISSING_SECRET,
      503,
      KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET,
      { tenantId: requestTenantId || undefined }
    );
  }

  if (!sig) {
    throw new KycWebhookError(
      KYC_WEBHOOK_MESSAGES.MISSING_SIGNATURE,
      401,
      KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE,
      { tenantId: requestTenantId || undefined }
    );
  }

  let candidateSecrets = [];
  const kidMatch = typeof sig === 'string' ? sig.match(/(?:^|[,; ])(?:kid|keyid|key_id)=([a-zA-Z0-9_-]+)/i) : null;
  const keyId = kidMatch ? kidMatch[1] : null;

  if (keyId) {
    const currentKeyId = process.env.WEBHOOK_SIGNING_KEY_ID || 'current';
    const retiringKeyId = process.env.WEBHOOK_SIGNING_KEY_RETIRING_ID || 'retiring';

    if (keyId === currentKeyId && activeSecret) {
      candidateSecrets = [activeSecret];
    } else if (keyId === retiringKeyId && retiringSecret) {
      candidateSecrets = [retiringSecret];
    } else {
      logger.warn({ keyId }, 'Unknown KYC webhook key identifier');
      throw new KycWebhookError(
        KYC_WEBHOOK_MESSAGES.INVALID_SIGNATURE,
        401,
        KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE,
        { tenantId: requestTenantId || undefined }
      );
    }
  } else {
    if (activeSecret) {candidateSecrets.push(activeSecret);}
    if (retiringSecret) {candidateSecrets.push(retiringSecret);}
  }

  let verification = { valid: false, error: 'Signature mismatch' };
  for (const candidate of candidateSecrets) {
    if (!candidate) {continue;}
    verification = verifySignature(candidate, body, sig);
    if (verification.valid) {
      break;
    }
  }

  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'Invalid KYC webhook signature');
    throw new KycWebhookError(
      KYC_WEBHOOK_MESSAGES.INVALID_SIGNATURE,
      401,
      KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE,
      { tenantId: requestTenantId || undefined }
    );
  }

  // Envelope and payload validation before domain mapping
  const envelopeValidation = validateEnvelope(body);
  if (!envelopeValidation.valid) {
    // quarantineKycWebhook is best-effort: its DB failure must never mask
    // the primary validation error.
    try {
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
    } catch (quarantineErr) {
      logger.warn({ error: quarantineErr && quarantineErr.message }, 'quarantineKycWebhook failed (suppressed)');
    }

    throw new KycWebhookError(
      envelopeValidation.reason,
      400,
      envelopeValidation.errorCode || KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      { tenantId: requestTenantId || undefined }
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
    throw new KycWebhookError(
      KYC_WEBHOOK_MESSAGES.TENANT_MISMATCH,
      403,
      KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH,
      { tenantId: requestTenantId || undefined }
    );
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
    throw new KycWebhookError(
      KYC_WEBHOOK_MESSAGES.MISSING_TENANT_CONTEXT,
      400,
      KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT
    );
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
      throw new KycWebhookError(
        'Missing or invalid smeId',
        400,
        KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID,
        { tenantId: requestTenantId || payloadTenantId || undefined }
      );
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
      throw new KycWebhookError(
        'Missing or invalid status',
        400,
        KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS,
        {
          smeId: normalizedPayload.smeId || undefined,
          tenantId: requestTenantId || payloadTenantId || undefined,
        }
      );
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
    throw new KycWebhookError(
      'Invalid KYC webhook payload',
      400,
      KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      { tenantId: requestTenantId || payloadTenantId || undefined }
    );
  }

  const smeId = parsedPayload.data.smeId;
  const status = parsedPayload.data.status;
  const providerRecordId = parsedPayload.data.recordId || null;
  const verifiedAt = parsedPayload.data.verifiedAt || null;

  const normalised = kycService.normalizeProviderStatus(status);
  if (normalised === kycService.KYC_STATUSES.UNKNOWN) {
    // The provider fully controls `status` on this fail-closed path, and it
    // flows into a log line, a quarantine record, and the error message
    // returned to the caller — sanitize it once, up front, so all three
    // sinks inherit the same redaction rather than needing separate fixes
    // (issue #1200).
    const safeStatus = sanitizeTelemetryString(status);
    logger.warn(
      { smeId, status: safeStatus },
      'KYC webhook received status outside PROVIDER_STATUS_MAP; rejecting (fail-closed)'
    );
    await quarantineKycWebhook({
      rawBody: body,
      payload,
      event: envelopeValidation.event,
      smeId,
      reason: `Unknown provider status: ${safeStatus}`,
      errorCode: KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS,
      errorDetails: { status: safeStatus },
      tenantId: requestTenantId || payloadTenantId,
      actor,
      ipAddress,
      userAgent,
    });
    throw new KycWebhookError(
      `Unknown provider status: ${safeStatus}`,
      400,
      KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS,
      {
        smeId,
        tenantId: requestTenantId || payloadTenantId || undefined,
      }
    );
  }

  // ── Concurrency guard: serialize concurrent writes for the same smeId ──
  //
  // The guard uses a DB-level advisory row lock (SELECT … FOR UPDATE) inside
  // a short transaction, so two concurrent requests for the same smeId are
  // serialized:
  //
  //   • First caller: acquires the lock, persists the record, commits.
  //   • Second caller: blocks on FOR UPDATE, then wakes up, persists the
  //     record (an upsert — already handled by persistKycRecord's
  //     INSERT … ON CONFLICT DO MERGE), commits.
  //
  // Both callers return `{ success: true, smeId, status }` — the shape is
  // idempotent for identical payloads, and the last-writer-wins upsert
  // semantics of persistKycRecord are preserved for legitimately differing
  // statuses (e.g. provider retries a status change).
  //
  // If the `kyc_records` table does not yet have a row for this smeId the
  // SELECT FOR UPDATE returns null, which is fine — there is still no race
  // because only one writer can enter the critical section at a time.
  //
  // The DB transaction is kept as short as possible: validation is done
  // outside, only the persist call is serialized.
  try {
    const record = await db.transaction(async (trx) => {
      // Advisory row-level lock — blocks concurrent writers for the same smeId.
      // Returns null when the row does not yet exist (first write); that is fine.
      await trx('kyc_records')
        .where('sme_id', smeId)
        .forUpdate()
        .first()
        .timeout(5000); // ms — prevents a stuck lock from blocking indefinitely

      return kycService.persistKycRecord(
        { smeId, status, providerRecordId, verifiedAt },
        { actor, ipAddress, userAgent }
      );
    });

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
    // `error` here is typically a DB/persistence failure — some drivers
    // (notably Postgres unique-constraint violations) include the offending
    // column *value* in their error message (e.g. `Key (ssn)=(123-45-6789)
    // already exists`), so this is redacted the same as a provider error
    // before it is logged or reused as the KycWebhookError message that
    // flows into the HTTP response (issue #1200).
    const safeError = redactErrorForTelemetry(error);
    logger.error({ smeId, error: safeError }, KYC_WEBHOOK_MESSAGES.FAILED_INGESTION);
    throw new KycWebhookError(
      safeError && typeof safeError.message === 'string' ? safeError.message : 'KYC record persistence failed',
      500,
      KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR,
      { smeId, tenantId: requestTenantId || undefined }
    );
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
    const v = parseBoundedInteger(
      rawLimit,
      KYC_WEBHOOK_PAGINATION.MIN_LIMIT,
      MAX_LIMIT
    );
    if (v === null) {
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
    const v = parseBoundedInteger(
      rawOffset,
      KYC_WEBHOOK_PAGINATION.MIN_OFFSET,
      KYC_WEBHOOK_PAGINATION.MAX_OFFSET
    );
    if (v === null) {
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
    const v = parseBoundedInteger(
      rawLimit,
      KYC_WEBHOOK_PAGINATION.MIN_LIMIT,
      MAX_LIMIT
    );
    if (v === null) {
      throw new KycWebhookError(
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
        400,
        KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION
      );
    }
  }

  const limit = rawLimit !== undefined
    ? parseBoundedInteger(rawLimit, KYC_WEBHOOK_PAGINATION.MIN_LIMIT, MAX_LIMIT)
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
