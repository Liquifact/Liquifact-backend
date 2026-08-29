'use strict';

/**
 * KYC Webhook Quarantine Service
 *
 * Implements quarantine persistence, redaction, envelope validation,
 * and authorized administrative inspection for malformed, invalid,
 * or oversized KYC webhook payloads (issue #1197).
 *
 * @module services/kycQuarantineService
 */

const crypto = require('crypto');
const db = require('../db/knex');
const logger = require('../logger');
const {
  KYC_WEBHOOK_DB,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_PAGINATION,
} = require('../constants/kycWebhooks');
const {
  parseValidationErrors,
  ALLOWED_KYC_WEBHOOK_EVENTS,
  kycQuarantineListResponseSchema,
} = require('../schemas/kycWebhook');
const { decodeCursor, encodeCursor } = require('../utils/cursorPagination');

const REDACTED = '***REDACTED***';
const MAX_STORED_BODY_LENGTH = 10000;
const DEFAULT_MAX_INGESTION_PAYLOAD_BYTES = 65536; // 64 KB default

const SENSITIVE_KEY_PATTERNS = Object.freeze([
  /password/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /auth(orization)?/i,
  /private[-_]?key/i,
  /seed/i,
  /mnemonic/i,
  /ssn/i,
  /social[-_]?security/i,
  /tax[-_]?id/i,
  /national[-_]?id/i,
  /card[-_]?number/i,
  /cvv/i,
  /cvc/i,
  /passport/i,
  /credential/i,
  /signature/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
]);

/**
 * Recursively redacts sensitive values from any JavaScript object or array.
 *
 * @param {*} value - The input value to sanitize.
 * @returns {*} Sanitized copy of the value with secrets replaced by '***REDACTED***'.
 */
function redactQuarantineValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactQuarantineValue(item));
  }

  if (typeof value !== 'object') {
    return value;
  }

  const sanitized = {};
  for (const [key, currentValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      sanitized[key] = REDACTED;
      continue;
    }
    sanitized[key] = redactQuarantineValue(currentValue);
  }
  return sanitized;
}

/**
 * Sanitizes a raw string (e.g. invalid JSON or oversized text) by masking
 * patterns that resemble sensitive key-value pairs, and bounding total length.
 *
 * @param {string} str - Raw string.
 * @returns {string} Sanitized and bounded string.
 */
function redactQuarantineString(str) {
  if (typeof str !== 'string') {
    return '';
  }

  const bounded = str.slice(0, MAX_STORED_BODY_LENGTH);
  return bounded.replace(
    /(["']?(?:password|secret|token|api[-_]?key|authorization|private[-_]?key|ssn|card[-_]?number|cvv|cvc|signature)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
    `$1${REDACTED}`
  );
}

/**
 * Resolves maximum allowed inbound webhook payload byte length.
 *
 * @returns {number}
 */
function getMaxIngestionPayloadBytes() {
  const parsed = parseInt(process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_INGESTION_PAYLOAD_BYTES;
  }
  return parsed;
}

/**
 * Stores a malformed, invalid, or oversized KYC webhook payload in quarantine.
 *
 * Guaranteed to sanitize all sensitive fields before persisting.
 * Side effects are bounded and fail-safe: failures during DB insertion are
 * logged but will not mask the underlying webhook validation error.
 *
 * @param {Object} params
 * @param {string|Buffer} [params.rawBody] - Raw request body
 * @param {Object} [params.payload] - Parsed payload (if parseable)
 * @param {string} params.reason - Quarantine reason description
 * @param {string} [params.errorCode] - Machine-readable error code
 * @param {Object} [params.errorDetails] - Detailed validation or field errors
 * @param {string} [params.smeId] - Associated SME ID (if known)
 * @param {string} [params.tenantId] - Associated tenant ID (if known)
 * @param {string} [params.event] - Associated event name (if known)
 * @param {string} [params.actor] - Request actor
 * @param {string} [params.ipAddress] - Request client IP
 * @param {string} [params.userAgent] - Request User-Agent
 * @param {Object} [params.dbClient] - Knex client override
 * @returns {Promise<Object>} Created quarantine record representation
 */
async function quarantineKycWebhook({
  rawBody = '',
  payload = null,
  reason = 'Malformed KYC webhook payload',
  errorCode = KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
  errorDetails = null,
  smeId = null,
  tenantId = null,
  event = 'unknown',
  actor = 'kyc-provider',
  ipAddress = 'unknown',
  userAgent = 'unknown',
  dbClient = null,
} = {}) {
  const knex = dbClient || db;
  const id = crypto.randomUUID ? crypto.randomUUID() : `quar_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date();
  const rawBodyStr = rawBody instanceof Buffer ? rawBody.toString('utf8') : String(rawBody || '');

  let sanitizedPayload;
  if (payload && typeof payload === 'object') {
    sanitizedPayload = redactQuarantineValue(payload);
  } else if (rawBodyStr) {
    try {
      const parsed = JSON.parse(rawBodyStr);
      sanitizedPayload = redactQuarantineValue(parsed);
    } catch (_) {
      sanitizedPayload = {
        raw: redactQuarantineString(rawBodyStr),
        malformed: true,
      };
    }
  } else {
    sanitizedPayload = { empty: true };
  }

  const sanitizedRawPayload = rawBodyStr ? redactQuarantineString(rawBodyStr) : null;

  const resolvedSmeId = smeId
    || (payload && (payload.smeId || payload.sme_id || payload.data?.smeId || payload.data?.sme_id))
    || null;

  const resolvedTenantId = tenantId
    || (payload && (payload.tenantId || payload.tenant_id))
    || 'unknown';

  const resolvedEvent = event !== 'unknown'
    ? event
    : (payload && (payload.event || payload.type || payload.eventType)) || 'unknown';

  const record = {
    id,
    tenant_id: String(resolvedTenantId),
    sme_id: resolvedSmeId ? String(resolvedSmeId) : null,
    event: String(resolvedEvent),
    payload: JSON.stringify(sanitizedPayload),
    raw_payload: sanitizedRawPayload,
    reason: String(reason),
    error_code: String(errorCode),
    error_details: errorDetails ? JSON.stringify(redactQuarantineValue(errorDetails)) : null,
    actor: String(actor || 'kyc-provider'),
    ip_address: String(ipAddress || 'unknown'),
    user_agent: String(userAgent || 'unknown'),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  try {
    await knex(KYC_WEBHOOK_DB.TABLE_KYC_QUARANTINE || 'kyc_webhook_quarantine').insert(record);
    logger.warn(
      {
        quarantineId: id,
        tenantId: record.tenant_id,
        smeId: record.sme_id,
        event: record.event,
        reason: record.reason,
        errorCode: record.error_code,
      },
      KYC_WEBHOOK_MESSAGES.QUARANTINED || 'KYC webhook payload quarantined'
    );
  } catch (err) {
    logger.error(
      {
        quarantineId: id,
        tenantId: record.tenant_id,
        smeId: record.sme_id,
        err: err && err.message,
      },
      'Failed to persist KYC webhook quarantine record'
    );
  }

  return {
    id: record.id,
    tenantId: record.tenant_id,
    smeId: record.sme_id,
    event: record.event,
    payload: sanitizedPayload,
    rawPayload: sanitizedRawPayload,
    reason: record.reason,
    errorCode: record.error_code,
    errorDetails: errorDetails ? redactQuarantineValue(errorDetails) : null,
    actor: record.actor,
    ipAddress: record.ip_address,
    userAgent: record.user_agent,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

/**
 * Retrieves a paginated list of quarantined KYC webhook records.
 * Strictly enforces tenant isolation: only returns records matching `tenantId`.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Authenticated tenant context
 * @param {string} [params.smeId] - Optional SME ID filter
 * @param {string} [params.event] - Optional event filter
 * @param {string} [params.reason] - Optional reason filter
 * @param {string} [params.errorCode] - Optional error code filter
 * @param {string} [params.createdAfter] - ISO 8601 lower bound
 * @param {string} [params.createdBefore] - ISO 8601 upper bound
 * @param {string} [params.cursor] - Opaque cursor
 * @param {number|string} [params.rawLimit] - Page size requested
 * @param {number|string} [params.rawOffset] - Offset requested
 * @param {Object} [params.dbClient] - Knex client override
 * @returns {Promise<{data: Array, meta: Object}>}
 */
async function listQuarantinedWebhooks({
  tenantId,
  smeId,
  event,
  reason,
  errorCode,
  createdAfter,
  createdBefore,
  cursor,
  rawLimit,
  rawOffset,
  dbClient = null,
} = {}) {
  const knex = dbClient || db;
  const maxLimit = KYC_WEBHOOK_PAGINATION.MAX_LIMIT || 100;
  const defaultLimit = KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT || 20;

  const limit = rawLimit !== undefined
    ? Math.min(Math.max(parseInt(rawLimit, 10) || defaultLimit, 1), maxLimit)
    : defaultLimit;

  let cursorData = null;
  if (cursor) {
    cursorData = decodeCursor(cursor, 'created_at');
  }

  let query = knex(KYC_WEBHOOK_DB.TABLE_KYC_QUARANTINE || 'kyc_webhook_quarantine')
    .where('tenant_id', String(tenantId));

  if (smeId) {
    query = query.where('sme_id', smeId);
  }
  if (event) {
    query = query.where('event', event);
  }
  if (reason) {
    query = query.where('reason', reason);
  }
  if (errorCode) {
    query = query.where('error_code', errorCode);
  }
  if (createdAfter) {
    query = query.where('created_at', '>=', new Date(createdAfter).toISOString());
  }
  if (createdBefore) {
    query = query.where('created_at', '<', new Date(createdBefore).toISOString());
  }

  if (cursorData) {
    query = query.where(function () {
      this.where('created_at', '<', cursorData.sortValue)
        .orWhere(function () {
          this.where('created_at', cursorData.sortValue)
            .andWhere('id', '<', cursorData.id);
        });
    });
  } else if (rawOffset !== undefined) {
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);
    query = query.offset(offset);
  }

  query = query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1);

  const rows = await query;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      sortField: 'created_at',
      sortValue: last.created_at instanceof Date ? last.created_at.toISOString() : last.created_at,
      id: String(last.id),
    });
  }

  const safeRows = pageRows.map((row) => {
    let parsedPayload = row.payload;
    if (typeof parsedPayload === 'string') {
      try {
        parsedPayload = JSON.parse(parsedPayload);
      } catch (_) {}
    }
    let parsedErrorDetails = row.error_details;
    if (typeof parsedErrorDetails === 'string') {
      try {
        parsedErrorDetails = JSON.parse(parsedErrorDetails);
      } catch (_) {}
    }

    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      smeId: row.sme_id ? String(row.sme_id) : null,
      event: String(row.event),
      payload: redactQuarantineValue(parsedPayload),
      rawPayload: row.raw_payload ? redactQuarantineString(row.raw_payload) : null,
      reason: String(row.reason),
      errorCode: String(row.error_code),
      errorDetails: parsedErrorDetails ? redactQuarantineValue(parsedErrorDetails) : null,
      actor: row.actor ? String(row.actor) : null,
      ipAddress: row.ip_address ? String(row.ip_address) : null,
      userAgent: row.user_agent ? String(row.user_agent) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  });

  const response = {
    data: safeRows,
    meta: {
      limit,
      hasMore,
      nextCursor,
      offset: rawOffset !== undefined ? Math.max(parseInt(rawOffset, 10) || 0, 0) : undefined,
      count: safeRows.length,
    },
  };

  const validated = kycQuarantineListResponseSchema.safeParse(response);
  if (!validated.success) {
    logger.warn({ errors: parseValidationErrors(validated.error) }, 'Quarantine list response schema warning');
  }

  return response;
}

/**
 * Retrieves a single quarantined record by ID with tenant scope protection.
 *
 * @param {string} id - Quarantine record ID
 * @param {Object} options
 * @param {string} options.tenantId - Authenticated tenant ID
 * @param {Object} [options.dbClient] - Knex client override
 * @returns {Promise<Object|null>}
 */
async function getQuarantinedWebhookById(id, { tenantId, dbClient = null } = {}) {
  const knex = dbClient || db;
  let query = knex(KYC_WEBHOOK_DB.TABLE_KYC_QUARANTINE || 'kyc_webhook_quarantine');

  if (tenantId) {
    query = query.where({ id: String(id), tenant_id: String(tenantId) });
  } else {
    query = query.where({ id: String(id) });
  }

  const row = await query.first();
  if (!row) {
    return null;
  }

  let parsedPayload = row.payload;
  if (typeof parsedPayload === 'string') {
    try {
      parsedPayload = JSON.parse(parsedPayload);
    } catch (_) {}
  }
  let parsedErrorDetails = row.error_details;
  if (typeof parsedErrorDetails === 'string') {
    try {
      parsedErrorDetails = JSON.parse(parsedErrorDetails);
    } catch (_) {}
  }

  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    smeId: row.sme_id ? String(row.sme_id) : null,
    event: String(row.event),
    payload: redactQuarantineValue(parsedPayload),
    rawPayload: row.raw_payload ? redactQuarantineString(row.raw_payload) : null,
    reason: String(row.reason),
    errorCode: String(row.error_code),
    errorDetails: parsedErrorDetails ? redactQuarantineValue(parsedErrorDetails) : null,
    actor: row.actor ? String(row.actor) : null,
    ipAddress: row.ip_address ? String(row.ip_address) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

/**
 * Validates the envelope and payload structure before domain mapping.
 *
 * Checks:
 *   1. Payload size guardrail (oversized payload protection)
 *   2. Valid JSON structure
 *   3. Plain object shape (rejects primitives / arrays)
 *   4. Event type validity (when event/type is present)
 *   5. Extracts unwrapped domain fields
 *
 * @param {string|Buffer} rawBody - Raw request body
 * @returns {{valid: boolean, payload?: Object, domainData?: Object, event?: string, reason?: string, errorCode?: string, errorDetails?: Object}}
 */
function validateEnvelope(rawBody) {
  const bodyStr = rawBody instanceof Buffer ? rawBody.toString('utf8') : String(rawBody || '');
  const byteLength = Buffer.byteLength(bodyStr, 'utf8');
  const maxBytes = getMaxIngestionPayloadBytes();

  // 1. Oversized payload guard
  if (byteLength > maxBytes) {
    return {
      valid: false,
      reason: KYC_WEBHOOK_MESSAGES.PAYLOAD_TOO_LARGE || 'KYC webhook payload exceeds maximum size limit',
      errorCode: KYC_WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE || 'PAYLOAD_TOO_LARGE',
      errorDetails: { byteLength, maxBytes },
    };
  }

  // 2. JSON syntax validation
  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (parseError) {
    return {
      valid: false,
      reason: KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD || 'Invalid JSON payload',
      errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      errorDetails: { message: parseError.message },
    };
  }

  // 3. Object shape check
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      reason: 'Invalid KYC webhook payload structure (must be an object)',
      errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      payload: parsed,
    };
  }

  // 4. Event type check
  const rawEvent = parsed.event || parsed.type || parsed.eventType || null;
  if (rawEvent !== null) {
    if (typeof rawEvent !== 'string' || !rawEvent.trim()) {
      return {
        valid: false,
        reason: KYC_WEBHOOK_MESSAGES.INVALID_EVENT || 'Invalid KYC webhook event format',
        errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_EVENT || 'invalid_event',
        payload: parsed,
      };
    }

    const eventName = rawEvent.trim().toLowerCase();
    const isAllowed = ALLOWED_KYC_WEBHOOK_EVENTS.some((ev) => ev.toLowerCase() === eventName);
    if (!isAllowed) {
      return {
        valid: false,
        reason: `${KYC_WEBHOOK_MESSAGES.UNKNOWN_EVENT_TYPE || 'Unknown KYC webhook event type'}: ${rawEvent}`,
        errorCode: KYC_WEBHOOK_ERROR_CODES.UNKNOWN_EVENT_TYPE || 'unknown_event_type',
        event: rawEvent,
        payload: parsed,
      };
    }
  }

  // 5. Extract domain payload (unwrap data / payload envelope if present)
  let domainData = parsed;
  if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
    domainData = parsed.data;
  } else if (parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)) {
    domainData = parsed.payload;
  } else if (parsed.record && typeof parsed.record === 'object' && !Array.isArray(parsed.record)) {
    domainData = parsed.record;
  } else if (parsed.data !== undefined && (typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data))) {
    return {
      valid: false,
      reason: 'Invalid event data format in webhook envelope',
      errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      event: rawEvent || 'unknown',
      payload: parsed,
    };
  }

  const smeId = domainData.smeId ?? domainData.sme_id ?? parsed.smeId ?? parsed.sme_id ?? null;
  const status = domainData.status ?? domainData.kycStatus ?? domainData.kyc_status ?? parsed.status ?? parsed.kycStatus ?? parsed.kyc_status ?? null;
  const recordId = domainData.recordId ?? domainData.providerRecordId ?? domainData.provider_record_id ?? parsed.recordId ?? parsed.providerRecordId ?? parsed.provider_record_id ?? null;
  const verifiedAt = domainData.verifiedAt ?? domainData.verified_at ?? parsed.verifiedAt ?? parsed.verified_at ?? null;
  const tenantId = domainData.tenantId ?? domainData.tenant_id ?? parsed.tenantId ?? parsed.tenant_id ?? null;

  return {
    valid: true,
    payload: parsed,
    event: rawEvent || 'unknown',
    domainData: {
      smeId,
      status,
      recordId,
      verifiedAt,
      tenantId,
    },
  };
}

module.exports = {
  quarantineKycWebhook,
  listQuarantinedWebhooks,
  getQuarantinedWebhookById,
  validateEnvelope,
  redactQuarantineValue,
  redactQuarantineString,
  getMaxIngestionPayloadBytes,
  REDACTED,
  SENSITIVE_KEY_PATTERNS,
};
