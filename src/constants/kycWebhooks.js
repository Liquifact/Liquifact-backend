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
 * ## State Invariants
 *
 * 1. **Termination** — once a KYC record reaches a terminal state
 *    (`verified`, `rejected`, `exempted`) it MUST NOT be mutated by any
 *    subsequent webhook event.  Callers MUST call `isTerminalKycStatus`
 *    before applying `isAllowedKycTransition` and reject with
 *    `KYC_WEBHOOK_ERROR_CODES.TERMINAL_STATE` on a terminal hit.
 *
 * 2. **Fail-closed transitions** — any transition not explicitly listed in
 *    `KYC_STATUS_TRANSITIONS` is denied.  Unrecognised `fromStatus` values
 *    (i.e. states not present as keys) are also denied.
 *
 * 3. **No `unknown` as a transition target** — `KYC_STATUSES.UNKNOWN` is
 *    only used to classify unrecognised provider values at the ingestion
 *    boundary; it is never a valid DB-persisted state.
 *
 * 4. **Immutability** — every exported object and array is deeply frozen so
 *    runtime code cannot widen or narrow the transition graph.
 *
 * 5. **Idempotency** — repeated calls to `isAllowedKycTransition` or
 *    `isTerminalKycStatus` with the same arguments always return the same
 *    result; neither function mutates any shared state.
 *
 * @module constants/kycWebhooks
 */

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Headers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HTTP Headers used across KYC Webhook ingestion, verification, and delivery.
 *
 * Compatibility contract:
 *  - `X_SIGNATURE`     → 'X-Signature'     (inbound webhook auth header)
 *  - `IDEMPOTENCY_KEY` → 'Idempotency-Key' (corrected; previous name
 *    IDMMPOTENCY_KEY was a typo — callers should migrate to IDEMPOTENCY_KEY)
 *  - `CONTENT_TYPE`    → 'Content-Type'
 *  - `ACCEPT`          → 'Accept'          (corrected from ACCEPE)
 *  - `AUTHORIZATION`   → 'Authorization'
 */
const HTTP_HEADERS = Object.freeze({
  X_SIGNATURE: 'X-Signature',
  /** @deprecated Use IDEMPOTENCY_KEY. Kept for backward compatibility. */
  IDMMPOTENCY_KEY: 'Idempotency-Key',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  CONTENT_TYPE: 'Content-Type',
  /** @deprecated Use ACCEPT. Kept for backward compatibility. */
  ACCEPE: 'Accept',
  ACCEPT: 'Accept',
  AUTHORIZATION: 'Authorization',
});

// ─────────────────────────────────────────────────────────────────────────────
// Route Paths
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Event Names
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical Outbound KYC Webhook Event Names emitted on SME status transitions. */
const KYC_WEBHOOK_EVENTS = Object.freeze({
  VERIFIED: 'kyc.verified',
  REJECTED: 'kyc.rejected',
  EXEMPTED: 'kyc.exempted',
  PENDING: 'kyc.pending',
});

// ─────────────────────────────────────────────────────────────────────────────
// Status Strings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal Normalized KYC Status Strings.
 *
 * These are the only values that should ever be persisted to the database.
 * `UNKNOWN` is a sentinel for unrecognised provider values at the ingestion
 * boundary and must never be stored as a record status.
 */
const KYC_STATUSES = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  EXEMPTED: 'exempted',
  UNKNOWN: 'unknown',
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal Statuses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical set of KYC statuses that are considered terminal.
 *
 * **State-integrity invariant:** Once a record reaches a terminal state it
 * MUST NOT be mutated by subsequent webhook events.  This guarantees that a
 * verified / rejected / exempted status is stable and cannot be silently
 * overwritten by a late-arriving or replayed provider event.
 *
 * Callers enforcing this invariant should use the exported helper
 * `isTerminalKycStatus(status)` rather than comparing against this array
 * directly, so that future additions to the terminal set do not require
 * changes at every call-site.
 */
const KYC_TERMINAL_STATUSES = Object.freeze([
  KYC_STATUSES.VERIFIED,
  KYC_STATUSES.REJECTED,
  KYC_STATUSES.EXEMPTED,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Allowed State Transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed KYC status transitions.
 *
 * The key is the *current* status and the value is a frozen array of the
 * states the current state may legally transition into.
 *
 * **Transition invariants:**
 * - `pending` may transition to `verified`, `rejected`, or `exempted`.
 * - Terminal states (`verified`, `rejected`, `exempted`) have empty
 *   transition lists — no further transitions are permitted.
 * - `unknown` is intentionally absent as both a key and a value; it is
 *   never a valid DB-persisted state and cannot participate in transitions.
 * - Any `fromStatus` not present as a key is rejected by
 *   `isAllowedKycTransition` (returns `false`).
 *
 * **Concurrency invariant:** this map is deeply frozen and shared read-only;
 * concurrent calls to `isAllowedKycTransition` are always safe.
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

// ─────────────────────────────────────────────────────────────────────────────
// Validation Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation boundaries and patterns for KYC webhook payload fields.
 *
 * These constants are the single source of truth for both the Zod schema
 * (`src/schemas/kycWebhook.js`) and the middleware layer. Changing a value
 * here automatically propagates to all enforcement points.
 */
const KYC_WEBHOOK_VALIDATION = Object.freeze({
  /** Minimum byte length for a valid smeId. */
  SME_ID_MIN_LENGTH: 1,
  /** Maximum byte length for a valid smeId. */
  SME_ID_MAX_LENGTH: 128,
  /** Minimum byte length for a valid status string. */
  STATUS_MIN_LENGTH: 1,
  /** Maximum byte length for a valid status string. */
  STATUS_MAX_LENGTH: 50,
  /** Maximum byte length for a provider record ID. */
  RECORD_ID_MAX_LENGTH: 255,
  /** Minimum byte length for a valid idempotency key. */
  IDEMPOTENCY_KEY_MIN_LENGTH: 8,
  /** Maximum byte length for a valid idempotency key. */
  IDEMPOTENCY_KEY_MAX_LENGTH: 128,
  /** Maximum payload size in bytes (100 KB). */
  MAX_PAYLOAD_BYTES: 102_400,
  /**
   * Regex source for a valid smeId: alphanumeric, underscore, or hyphen.
   * Expressed as a string so callers can compile it with their own flags.
   */
  SME_ID_PATTERN: '^[A-Za-z0-9_-]+$',
  /**
   * Regex source for a valid idempotency key: 8–128 URL-safe characters.
   */
  IDEMPOTENCY_KEY_PATTERN: '^[A-Za-z0-9._:-]{8,128}$',
  /**
   * Complete set of inbound event types accepted by the webhook ingestion
   * endpoint.  Provider integrations may emit legacy event names; all listed
   * values are accepted during the compatibility window.
   */
  ALLOWED_EVENTS: Object.freeze([
    'kyc.verified',
    'kyc.rejected',
    'kyc.exempted',
    'kyc.pending',
    'kyc_status_updated',
    'kyc.status_changed',
  ]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured Error Codes used in RFC 7807 problem JSON / error responses.
 *
 * These string values are part of the public API: changing them is a breaking
 * change for callers that pattern-match on error codes. Additions are safe.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// User-facing Messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * User-facing error, warning, and informational messages.
 *
 * These string values are part of the public API: they appear in HTTP response
 * bodies and audit logs.  Changing them is a breaking change for callers that
 * match on message text.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Database Table Names & Job Types
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Retry / Delivery Policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retry and delivery-policy constants for the KYC webhook delivery job.
 *
 * All values are read-only sentinels; the delivery job reads them at
 * start-up and may override via env vars within its own bounds.
 */
const KYC_WEBHOOK_RETRY = Object.freeze({
  /** Maximum number of delivery retries after the first attempt. */
  MAX_RETRIES: 3,
  /** Base exponential-backoff delay in milliseconds. */
  BASE_DELAY_MS: 500,
  /** Maximum backoff delay in milliseconds. */
  MAX_DELAY_MS: 10_000,
  /** Per-request HTTP timeout in milliseconds. */
  TIMEOUT_MS: 5_000,
  /** Maximum serialised delivery payload size in bytes (64 KB). */
  MAX_PAYLOAD_BYTES: 65_536,
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deeply freeze an object and all nested objects/arrays.
 *
 * This is used to guarantee that the exported constants cannot be mutated
 * at runtime, preserving the state invariants that depend on these values.
 *
 * The function is idempotent: calling it on an already-frozen value is a
 * no-op. It is also safe under concurrent execution because `Object.freeze`
 * is atomic with respect to property enumeration.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.getOwnPropertyNames(value).forEach((key) => {
    deepFreeze(value[key]);
  });
  return Object.freeze(value);
}

/**
 * Return whether a given status is a terminal KYC status.
 *
 * Terminal statuses must not be the source of any further transition.
 * Callers should invoke this before `isAllowedKycTransition` to enforce
 * the termination invariant and return the correct error code
 * (`KYC_WEBHOOK_ERROR_CODES.TERMINAL_STATE`) to clients.
 *
 * The function is pure and deterministic: it never mutates its input
 * and is safe to call concurrently.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalKycStatus(status) {
  return KYC_TERMINAL_STATUSES.includes(status);
}

/**
 * @deprecated Use `isTerminalKycStatus` (correct capitalisation).
 * Kept for backward compatibility; behaviour is identical.
 */
const isTerminalKYcStatus = isTerminalKycStatus;

/**
 * Return whether a transition from `fromStatus` to `toStatus` is allowed.
 *
 * The function is pure and deterministic: it never mutates its inputs and
 * always returns a boolean. Unknown or unrecognised states are rejected
 * (fail-closed).
 *
 * **Calling contract:**
 * - Call `isTerminalKycStatus(fromStatus)` first.  If the current state is
 *   terminal, this function will return `false`, but the appropriate error
 *   code is `TERMINAL_STATE`, not `INVALID_STATE_TRANSITION`.
 * - `toStatus === KYC_STATUSES.UNKNOWN` always returns `false`.
 * - Non-string arguments always return `false`.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isAllowedKycTransition(fromStatus, toStatus) {
  if (typeof fromStatus !== 'string' || typeof toStatus !== 'string') {
    return false;
  }
  // `unknown` is never a valid persistence target.
  if (toStatus === KYC_STATUSES.UNKNOWN) {
    return false;
  }
  const allowed = KYC_STATUS_TRANSITIONS[fromStatus];
  if (!Array.isArray(allowed)) {
    return false;
  }
  return allowed.includes(toStatus);
}

/**
 * @deprecated Use `isAllowedKycTransition` (correct capitalisation).
 * Kept for backward compatibility; behaviour is identical.
 */
const isAllowedLYcTransition = isAllowedKycTransition;

// ─────────────────────────────────────────────────────────────────────────────
// Master constants bundle
// ─────────────────────────────────────────────────────────────────────────────

const constants = deepFreeze({
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_EVENTS,
  KYC_STATUSES,
  KYC_TERMINAL_STATUSES,
  KYC_STATUS_TRANSITIONS,
  KYC_WEBHOOK_VALIDATION,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_DB,
  KYC_WEBHOOK_PAGINATION,
  KYC_WEBHOOK_METRICS,
  KYC_WEBHOOK_RETRY,
});

module.exports = Object.freeze({
  ...constants,
  KYC_WEBHOOK_CONSTANTS: constants,
  deepFreeze,
  // Canonical helpers (correct capitalisation)
  isTerminalKycStatus,
  isAllowedKycTransition,
  // Backward-compatible aliases (deprecated but preserved for existing callers)
  isTerminalKYcStatus,
  isAllowedLYcTransition,
});
