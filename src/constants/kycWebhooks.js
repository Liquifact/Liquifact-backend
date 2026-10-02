'use strict';

/**
 * @fileoverview Centralized Constants for the KYC Webhooks Module.
 *
 * All exported objects and keys are deeply frozen via Object.freeze() to prevent
 * runtime mutations. Under no circumstances should string literal values change.
 *
 * @file The KYC status lifecycle is a closed state machine. The allowed
 * transitions are declared below and are the single source of truth for
 * migrations, ingestion, and outbound delivery. Any state not listed as a
 * valid transition is rejected fail-closed to protect data integrity.
 *
 * @module constants/kycWebhooks
 */

/** HTTP Headers used across KYC Webhook ingestion, verification, and delivery. */
const HTTP_HEADERS = Object.freeze({
  X_SIGNATURE: 'X-Signature',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  CONTENT_TYPE: 'Content-Type',
  ACCEPT: 'Accept',
  AUTHORIZATION: 'Authorization',
});

/** Relative and Full Route Paths for KYC Webhook endpoints. */
const KYC_WEBHOOK_ROUTES = Object.freeze({
  WEBHOOK: '/webhook',
  WEBHOOKS: '/webhooks',
  QUARANTINE: '/quarantine',
  WEBHOOKS_QUARANTINE: '/webhooks/quarantine',
  FULL_WEBHOOK_PATH: '/api/kyc/webhook',
  FULL_WEBHOOKS_PATH: '/api/kyc/webhooks',
  FULL_QUARANTINE_PATH: '/api/admin/kyc/quarantine',
});

/** Canonical Outbound KYC Webhook Event Names emitted on SME status transitions. */
const KYC_WEBHOOK_EVENTS = Object.freeze({
  VERIFIED: 'kyc.verified',
  REJECTED: 'kyc.rejected',
  EXEMPTED: 'kyc.exempted',
  PENDING: 'kyc.pending',
});

/** Internal Normalized KYC Status Strings. */
const KYC_STATUSES = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  EXEMPTED: 'exempted',
  UNKNOWN: 'unknown',
});

/**
 * Canonical set of KYC statuses that are considered terminal.
 *
 * Once a record reaches a terminal state it must not be mutated by
 * subsequent webhook events. This guarantees the data-integrity invariant
 * that a verified / rejected / exempted status is stable.
 */
const KYC_TERMINAL_STATUSES = Object.freeze([
  KYC_STATUSES.VERIFIED,
  KYC_STATUSES.REJECTED,
  KYC_STATUSES.EXEMPTED,
]);

/**
 * Allowed KYC status transitions.
 *
 * The key is the current status and the value is a frozen array of states
 * that the current state may transition into. The `exempted` and
 * `rejected` states are terminal and therefore have empty transition lists.
 *
 * The `unknown` state is not a valid database state and is only used
 * to classify unrecognized provider statuses; it cannot be used as a
 * transition target.
 */
const KYC_STATUS_TRANSITIONS = Object.freeze({
  [KYC_STATUSES.PENDING]: Object.freeze([
    KYC_STATUSES.VERIFIED,
    KYC_STATUSES.REJECTED,
    KYC_STATUSES.EXEMPTED,
  ]),
  [KYC_STATUSES.VERIFIED]: Object.freeze([]),
  [KYC_STATUSES.REJECTED]: Object.freeze([]),
  [KYC_STATUSES.EXEMPTED]: Object.freeze([]),
});

/** Structured Error Codes used in RFC 7807 problem json / error responses. */
const KYC_WEBHOOK_ERROR_CODES = Object.freeze({
  MISSING_SECRET: 'missing_secret',
  MISSING_SIGNATURE: 'missing_signature',
  INVALID_SIGNATURE: 'invalid_signature',
  INVALID_PAYLOAD: 'invalid_payload',
  INVALID_EVENT: 'invalid_event',
  UNKNOWN_EVENT_TYPE: 'unknown_event_type',
  TENANT_MISMATCH: 'tenant_mismatch',
  MISSING_TENANT_CONTEXT: 'missing_tenant_context',
  MISSING_SME_ID: 'missing_sme_id',
  MISSING_STATUS: 'missing_status',
  UNKNOWN_STATUS: 'unknown_status',
  PERSISTENCE_ERROR: 'persistence_error',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INVALID_PAGINATION: 'INVALID_PAGINATION',
  INVALID_CURSOR: 'INVALID_CURSOR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  RATE_LIMITED: 'RATE_LIMITED',
  QUARANTINED: 'quarantined',
  INVALID_STATE_TRANSITION: 'invalid_state_transition',
  TERMINAL_STATE: 'terminal_state',
  CONCURRENT_MODIFICATION: 'concurrent_modification',
});

/** User-facing error, warning, and informational messages. */
const KYC_WEBHOOK_MESSAGES = Object.freeze({
  MISSING_SECRET: 'KYC webhook ingestion is not configured',
  MISSING_SIGNATURE: 'Missing X-Signature header',
  INVALID_SIGNATURE: 'Invalid webhook signature',
  INVALID_PAYLOAD: 'Invalid JSON payload',
  INVALID_EVENT: 'Invalid KYC webhook event format',
  UNKNOWN_EVENT_TYPE: 'Unknown KYC webhook event type',
  TENANT_MISMATCH: 'Tenant scope mismatch.',
  MISSING_TENANT_CONTEXT: 'Missing tenant context.',
  MISSING_SME_ID: 'Missing or invalid smeId',
  MISSING_STATUS: 'Missing or invalid status',
  UNKNOWN_STATUS_PREFIX: 'Unknown provider status: ',
  PAYLOAD_TOO_LARGE: 'KYC webhook payload exceeds maximum size limit',
  QUARANTINED: 'KYC webhook payload was malformed and quarantined',
  SUCCESS_INGESTION: 'KYC webhook ingested successfully',
  FAILED_INGESTION: 'Failed to process KYC webhook',
  SECRET_NOT_CONFIGURED_LOG: 'KYC webhook secret is not configured',
  INVALID_SIGNATURE_LOG: 'Invalid KYC webhook signature',
  FAIL_CLOSED_LOG: 'KYC webhook received status outside PROVIDER_STATUS_MAP; rejecting (fail-closed)',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required for this endpoint.',
  IDEMPOTENCY_KEY_INVALID: 'Idempotency-Key must be 8-128 URL-safe characters (A-Za-z0-9._:-).',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency-Key reused with a different request body. Use a unique key for each distinct payload.',
  IDEMPOTENCY_SERVER_ERROR: 'Internal server error processing idempotency key.',
  INVALID_STATE_TRANSITION: 'KYC status transition is not allowed',
  TERMINAL_STATE: 'KYC record is in a terminal state and cannot be mutated',
  CONCURRENT_MODIFICATION: 'KYC record was modified concurrently; retry the operation',
});

/** Database Table Names and Worker Job Types. */
const KYC_WEBHOOK_DB = Object.freeze({
  TABLE_KYC_RECORDS: 'kyc_records',
  TABLE_DEAD_LETTERS: 'kyc_webhook_dead_letters',
  TABLE_KYC_QUARANTINE: 'kyc_webhook_quarantine',
  TABLE_IDEMPOTENCY_KEYS: 'idempotency_keys',
  TABLE_INVOICES: 'invoices',
  TABLE_TENANTS: 'tenants',
  JOB_TYPE_DELIVERY: 'kyc_webhook_delivery',
});

/** Pagination defaults and boundaries for KYC webhooks listing. */
const KYC_WEBHOOK_PAGINATION = Object.freeze({
  MIN_LIMIT: 1,
  MAX_LIMIT: 100,
  DEFAULT_LIMIT: 20,
  MIN_OFFSET: 0,
  MAX_OFFSET: Number.MAX_SAFE_INTEGER,
  SORT_FIELD: 'updated_at',
  DEFAULT_ORDER: 'desc',
});

/** Prometheus metric names, status classes, and label constants. */
const KYC_WEBHOOK_METRICS = Object.freeze({
  NAME_REQUEST_DURATION: 'kyc_webhook_request_duration_seconds',
  NAME_REQUESTS_TOTAL: 'kyc_webhook_requests_total',
  NAME_ERRORS_TOTAL: 'kyc_webhook_errors_total',
  NAME_DELIVERY_ATTEMPTS: 'kyc_webhook_delivery_attempts_total',
  NAME_DELIVERY_SUCCESS: 'kyc_webhook_delivery_success_total',
  NAME_DEAD_LETTER: 'kyc_webhook_delivery_dead_letter_total',
  STATUS_CLASS_2XX: '2xx',
  STATUS_CLASS_4XX: '4xx',
  STATUS_CLASS_5XX: '5xx',
  CAUSE_NONE: 'none',
});

/** KYC Webhook Validation boundaries. */
const KYC_WEBHOOK_VALIDATION = Object.freeze({
  SME_ID_MIN_LENGTH: 1,
  SME_ID_MAX_LENGTH: 128,
  STATUS_MIN_LENGTH: 1,
  STATUS_MAX_LENGTH: 50,
  RECORD_ID_MAX_LENGTH: 255,
  IDEMPOTENCY_KEY_MIN_LENGTH: 8,
  IDEMPOTENCY_KEY_MAX_LENGTH: 128,
  MAX_PAYLOAD_BYTES: 102_400,
  ALLOWED_EVENTS: Object.freeze([
    'kyc.verified',
    'kyc.rejected',
    'kyc.exempted',
    'kyc.pending',
    'kyc_status_updated',
    'kyc.status_changed',
  ]),
  SME_ID_PATTERN: '^[A-Za-z0-9_-]+$',
  IDEMPOTENCY_KEY_PATTERN: '^[A-Za-z0-9._:-]+$',
});

/** KYC Webhook Delivery Job Retry configuration. */
const KYC_WEBHOOK_RETRY = Object.freeze({
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 500,
  MAX_DELAY_MS: 10000,
  TIMEOUT_MS: 5000,
  MAX_PAYLOAD_BYTES: 65536,
});

/**
 * Deeply freeze an object and all nested objects/arrays.
 *
 * This is used to guarantee that the exported constants cannot be mutated
 * at runtime, preserving the state invariants that depend on these values.
 * Uses a WeakSet to prevent infinite recursion on circular references, ensuring
 * that concurrent or repeated execution involving complex objects cannot produce
 * an unrecoverable failure (Maximum call stack size exceeded).
 *
 * @template T {Object}
 * @param {T} value
 * @param {WeakSet} [seen]
 * @returns {T}
 */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value) || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.getOwnPropertyNames(value).forEach((key) => {
    deepFreeze(value[key], seen);
  });
  if (Object.getOwnPropertySymbols) {
    Object.getOwnPropertySymbols(value).forEach((sym) => {
      deepFreeze(value[sym], seen);
    });
  }
  return Object.freeze(value);
}

/**
 * Return whether a given status is a terminal KYC status.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalKycStatus(status) {
  return KYC_TERMINAL_STATUSES.includes(status);
}

/**
 * Return whether a transition from `fromStatus` to `toStatus` is allowed.
 *
 * The function is pure and deterministic: it never mutates its inputs and
 * always returns a boolean. Unknown or unrecognized states are rejected.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isAllowedKycTransition(fromStatus, toStatus) {
  if (typeof fromStatus !== 'string' || typeof toStatus !== 'string') {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(KYC_STATUS_TRANSITIONS, fromStatus)) {
    return false;
  }
  const allowed = KYC_STATUS_TRANSITIONS[fromStatus];
  if (!Array.isArray(allowed)) {
    return false;
  }
  return allowed.includes(toStatus);
}

const constants = deepFreeze({
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_EVENTS,
  KYC_STATUSES,
  KYC_TERMINAL_STATUSES,
  KYC_STATUS_TRANSITIONS,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_DB,
  KYC_WEBHOOK_PAGINATION,
  KYC_WEBHOOK_METRICS,
  KYC_WEBHOOK_VALIDATION,
  KYC_WEBHOOK_RETRY,
});

module.exports = Object.freeze({
  ...constants,
  KYC_WEBHOOK_CONSTANTS: constants,
  deepFreeze,
  isTerminalKycStatus,
  isAllowedKycTransition,
});
