'use strict';

/**
 * @fileoverview Centralized Constants for the KYC Webhooks Module.
 *
 * All exported objects and keys are deeply frozen via Object.freeze() to prevent
 * runtime mutations. Under no circumstances should string literal values change.
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
  FULL_WEBHOOK_PATH: '/api/kyc/webhook',
  FULL_WEBHOOKS_PATH: '/api/kyc/webhooks',
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

/** Structured Error Codes used in RFC 7807 problem json / error responses. */
const KYC_WEBHOOK_ERROR_CODES = Object.freeze({
  MISSING_SECRET: 'missing_secret',
  MISSING_SIGNATURE: 'missing_signature',
  INVALID_SIGNATURE: 'invalid_signature',
  INVALID_PAYLOAD: 'invalid_payload',
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
});

/** User-facing error, warning, and informational messages. */
const KYC_WEBHOOK_MESSAGES = Object.freeze({
  MISSING_SECRET: 'KYC webhook ingestion is not configured',
  MISSING_SIGNATURE: 'Missing X-Signature header',
  INVALID_SIGNATURE: 'Invalid webhook signature',
  INVALID_PAYLOAD: 'Invalid JSON payload',
  TENANT_MISMATCH: 'Tenant scope mismatch.',
  MISSING_TENANT_CONTEXT: 'Missing tenant context.',
  MISSING_SME_ID: 'Missing or invalid smeId',
  MISSING_STATUS: 'Missing or invalid status',
  UNKNOWN_STATUS_PREFIX: 'Unknown provider status: ',
  SUCCESS_INGESTION: 'KYC webhook ingested successfully',
  FAILED_INGESTION: 'Failed to process KYC webhook',
  SECRET_NOT_CONFIGURED_LOG: 'KYC webhook secret is not configured',
  INVALID_SIGNATURE_LOG: 'Invalid KYC webhook signature',
  FAIL_CLOSED_LOG: 'KYC webhook received status outside PROVIDER_STATUS_MAP; rejecting (fail-closed)',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required for this endpoint.',
  IDEMPOTENCY_KEY_INVALID: 'Idempotency-Key must be 8–128 URL-safe characters (A-Za-z0-9._:-).',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency-Key reused with a different request body. Use a unique key for each distinct payload.',
  IDEMPOTENCY_SERVER_ERROR: 'Internal server error processing idempotency key.',
});

/** Database Table Names and Worker Job Types. */
const KYC_WEBHOOK_DB = Object.freeze({
  TABLE_KYC_RECORDS: 'kyc_records',
  TABLE_DEAD_LETTERS: 'kyc_webhook_dead_letters',
  TABLE_IDEMPOTENCY_KEYS: 'idempotency_keys',
  TABLE_INVOICES: 'invoices',
  TABLE_TENANTS: 'tenants',
  JOB_TYPE_DELIVERY: 'kyc_webhook_delivery',
});

/** Pagination defaults and boundaries for KYC webhooks listing. */
const KYC_WEBHOOK_PAGINATION = Object.freeze({
  MAX_LIMIT: 100,
  DEFAULT_LIMIT: 20,
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

const constants = Object.freeze({
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_EVENTS,
  KYC_STATUSES,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_DB,
  KYC_WEBHOOK_PAGINATION,
  KYC_WEBHOOK_METRICS,
});

module.exports = Object.freeze({
  ...constants,
  KYC_WEBHOOK_CONSTANTS: constants,
});
