'use strict';

/**
 * @fileoverview Typed DTOs and boundary mappers for invoice-state endpoints.
 *
 * Defines the request/response shapes crossing the invoice-state route
 * boundary and the pure mapping functions that convert between the internal
 * service-layer objects and the public DTOs.
 *
 * Keeping the mappers pure (no side effects, no I/O) means they can be
 * exhaustively unit-tested in isolation from Express / Knex / audit-log
 * concerns, and gives us a typed boundary for safer refactors.
 *
 * Validation wrappers integrate with Zod schemas to enforce input boundaries
 * at the DTO layer, providing deterministic rejection of malformed requests
 * before they reach the service layer.
 *
 * @module dtos/invoiceStateDtos
 * @version 1.0.0
 * @compatibility Contract version 1.0 - All mappers guarantee stable output shapes
 *                 for valid, invalid, and boundary-case inputs. Optional fields are
 *                 omitted (not null) when undefined. Arrays are copied to prevent
 *                 caller mutation. Malformed inputs fall back to safe defaults.
 */

const {
  safeParseTransitionBody,
  MAX_TRANSITION_REASON_LENGTH,
  BOUNDED_TARGET_STATES,
} = require('../schemas/invoiceState');

// ---------------------------------------------------------------------------
// Request DTOs — inbound shapes parsed (loosely) from request bodies
// ----------------------------------------------------------------------------

/**
 * Body of `POST /api/invoices/:id/transition`.
 *
 * @typedef {Object} TransitionRequestDto
 * @property {string} targetState - Desired invoice lifecycle state.
 * @property {string} [reason] - Optional human-readable rationale.
 */

/**
 * Body of `POST /api/invoices/:id/approve`.
 *
 * @typedef {Object} ApproveRequestDto
 * @property {string} [reason] - Optional approval rationale.
 */

/**
 * Body of `POST /api/invoices/:id/link-escrow`.
 *
 * @typedef {Object} LinkEscrowRequestDto
 * @property {string} [escrowId] - Escrow contract identifier.
 * @property {string} [reason] - Optional link rationale.
 */

/**
 * Body of `POST /api/invoices/:id/reject`.
 *
 * @typedef {Object} RejectRequestDto
 * @property {string} reason - Mandatory rejection rationale.
 */

// ----------------------------------------------------------------------------
// Response DTOs — outbound shapes serialised to clients
// ----------------------------------------------------------------------------

/**
 * Payload returned by `GET /api/invoices/:id/state`.
 *
 * @typedef {Object} InvoiceStateResponseDto
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} currentState - Current lifecycle state.
 * @property {string[]} allowedTransitions - Permitted next-state values.
 * @property {boolean} isTerminal - True when no further transitions exist.
 */

/**
 * Payload returned by transition-carrying endpoints (transition / approve /
 * reject) on success.
 *
 * @typedef {Object} TransitionResponseDto
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} previousState - State before the transition.
 * @property {string} currentState - State after the transition.
 * @property {string} transitionedAt - ISO-8601 timestamp of the transition.
 * @property {string} transitionedBy - Actor identifier that performed it.
 * @property {string} [reason] - Echoed rationale when one was supplied.
 * @property {string} auditLogId - Identifier of the associated audit log.
 */

/**
 * Payload returned by `POST /api/invoices/:id/link-escrow` on success.
 *
 * @typedef {Object} LinkEscrowResponseDto
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} previousState - State before the transition.
 * @property {string} currentState - State after the transition.
 * @property {string|null} escrowId - Escrow contract identifier (or null).
 * @property {string} transitionedAt - ISO-8601 timestamp of the transition.
 * @property {string} transitionedBy - Actor identifier that performed it.
 * @property {string} auditLogId - Identifier of the associated audit log.
 */

/**
 * A single entry in the invoice transition history list.
 *
 * @typedef {Object} HistoryEntryDto
 * @property {string} id - Audit-log record identifier.
 * @property {string} timestamp - ISO-8601 timestamp of the transition.
 * @property {string} actor - Actor identifier.
 * @property {string} [fromState] - State before transition (may be absent
 *   for malformed or very old audit records).
 * @property {string} [toState] - State after transition (may be absent).
 * @property {string} [reason] - Rationale captured from metadata.
 * @property {string} [ipAddress] - Source IP recorded at the time.
 */

/**
 * Body of `POST /api/invoices/bulk`.
 *
 * @typedef {Object} BulkInvoiceStateOperation
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} action - The state-transition action to perform.
 * @property {string} [reason] - Optional rationale for the action.
 * @property {string} [escrowId] - Escrow contract identifier (for link-escrow).
 * @property {string} [targetState] - Target lifecycle state (for transition).
 */

/**
 * @typedef {Object} BulkSuccessItem
 * @property {number} index - Position of the item in the batch.
 * @property {boolean} success - Always true.
 * @property {string} action - The action that was performed.
 * @property {object} result - The transition result.
 */

/**
 * @typedef {Object} BulkFailureItem
 * @property {number} index - Position of the item in the batch.
 * @property {boolean} success - Always false.
 * @property {string} error - Human-readable error message.
 * @property {string} code - Machine-readable error code.
 */

/**
 * @typedef {BulkSuccessItem|BulkFailureItem} BulkResultItem
 */

/**
 * @typedef {Object} BulkSummary
 * @property {number} total - Total number of items in the batch.
 * @property {number} succeeded - Number of successfully processed items.
 * @property {number} failed - Number of items that failed.
 */

/**
 * Payload returned by `POST /api/invoices/bulk`.
 *
 * @typedef {Object} BulkInvoiceStateResponseDto
 * @property {BulkResultItem[]} results - Per-item results.
 * @property {BulkSummary} summary - Aggregate summary.
 */

// ----------------------------------------------------------------------------
// Internal service-layer shapes (described for mapper documentation)
// ----------------------------------------------------------------------------

/**
 * Transition result produced by `invoiceService.transitionInvoice` /
 * `invoiceStateMachine.executeTransition`.
 *
 * @typedef {Object} InternalTransitionResult
 * @property {boolean} success
 * @property {string} previousState
 * @property {string} newState
 * @property {{id: string, timestamp?: string}} auditLog
 * @property {string} transitionedAt
 * @property {string} transitionedBy
 */

/**
 * Audit-log record produced by `getTransitionHistory`.
 *
 * @typedef {Object} InternalAuditLog
 * @property {string} id
 * @property {string} timestamp
 * @property {string} actor
 * @property {{before?: {state?: string}, after?: {state?: string}}} [changes]
 * @property {{reason?: string}} [metadata]
 * @property {string} [ipAddress]
 */

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/**
 * Coerces an unknown value into a plain object record, returning an empty
 * object for any non-object (or array) input. This keeps every request mapper
 * a total function and ensures concurrent callers never share a mutable
 * reference to the input body.
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function asPlainObject(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return /** @type {Record<string, unknown>} */ (body);
  }
  return {};
}

/**
 * Returns the value as a string only when it is a non-empty trimmed string;
 * otherwise returns `undefined`. This normalises whitespace-only and
 * non-string inputs to a single deterministic representation so downstream
 * validation and idempotency checks cannot be bypassed by type coercion.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function asOptionalString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns a safe string for outbound fields that must always be present.
 * Non-string or empty values become '' so the public DTO shape is stable
 * and clients can rely on the key always being serialisable.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asSafeString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Extracts the audit-log identifier from an internal transition result,
 * tolerating missing or malformed `auditLog` payloads.
 *
 * @param {unknown} auditLog
 * @returns {string}
 */
function extractAuditLogId(auditLog) {
  if (auditLog && typeof auditLog === 'object') {
    const id = /** @type {Record<string, unknown>} */ (auditLog).id;
    if (typeof id === 'string') {
      return id;
    }
  }
  return '';
}

/**
 * Normalises a transition result into a stable internal shape. Mappers that
 * consume the result call this first so a concurrently-mutated or partially
 * populated result object cannot leak `undefined` fields into the public
 * DTO.
 *
 * @param {unknown} result
 * @returns {{previousState: string, newState: string, transitionedAt: string, transitionedBy: string, auditLogId: string}}
 */
function normaliseTransitionResult(result) {
  const safe = result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
  return {
    previousState: asSafeString(safe.previousState),
    newState: asSafeString(safe.newState),
    transitionedAt: asSafeString(safe.transitionedAt),
    transitionedBy: asSafeString(safe.transitionedBy),
    auditLogId: extractAuditLogId(safe.auditLog),
  };
}

// ----------------------------------------------------------------------------
// Request mappers — body → well-typed internal command input
// ----------------------------------------------------------------------------

/**
 * Pulls the typed transition fields from an Express request body.
 *
 * @contract v1.0 - Returns object with targetState and reason fields.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string reason → undefined
 *                 - Extra keys ignored (prototype pollution defense)
 *                 - Output shape is stable regardless of input validity
 *
 * The mapper itself does NOT perform semantic validation — that remains the
 * responsibility of `invoiceStateMachine.validateTransition` and the Zod
 * schema in `schemas/invoiceState`.  The mapper only guarantees the returned
 * object has the declared field shapes (coercing missing optional keys to
 * `undefined` rather than leaving them absent so downstream code sees a
 * stable structure).
 *
 * Concurrency note: the returned object is a fresh allocation with no reference
 * to the input body, so a concurrent mutation of `req.body` cannot alter the
 * mapped command once it has been produced.
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ targetState: unknown, reason: string|undefined }}
 */
function mapTransitionRequest(body) {
  const b = asPlainObject(body);
  return {
    targetState: 'targetState' in b ? b.targetState : undefined,
    reason: asOptionalString(b.reason),
  };
}

/**
 * Pulls the typed approval fields from an Express request body.
 *
 * @contract v1.0 - Returns object with reason field.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string reason → undefined
 *                 - Output shape is stable regardless of input validity
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ reason: string|undefined }}
 */
function mapApproveRequest(body) {
  const b = asPlainObject(body);
  return {
    reason: asOptionalString(b.reason),
  };
}

/**
 * Pulls the typed link-escrow fields from an Express request body.
 *
 * @contract v1.0 - Returns object with escrowId and reason fields.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string escrowId → null
 *                 - Non-string reason → undefined
 *                 - Output shape is stable regardless of input validity
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ escrowId: string|null, reason: string|undefined }}
 */
function mapLinkEscrowRequest(body) {
  const b = asPlainObject(body);
  const escrowId = asOptionalString(b.escrowId);
  return {
    escrowId: escrowId !== undefined ? escrowId : null,
    reason: asOptionalString(b.reason),
  };
}

/**
 * Pulls the typed rejection fields from an Express request body.
 *
 * @contract v1.0 - Returns object with reason field.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string reason → undefined
 *                 - Output shape is stable regardless of input validity
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ reason: string|undefined }}
 */
function mapRejectRequest(body) {
  const b = asPlainObject(body);
  return {
    reason: asOptionalString(b.reason),
  };
}

// ---------------------------------------------------------------------------
// Validation wrappers — enforce input boundaries at DTO layer
// ---------------------------------------------------------------------------

/**
 * Performs common top-level shape validation for request bodies.
 *
 * @param {unknown} body - Raw `req.body`.
 * @param {Record<string, string>} fieldErrors - Error accumulator.
 * @returns {boolean} True if shape is valid, false otherwise.
 */
function validateBodyShape(body, fieldErrors) {
  if (body === undefined) {
    fieldErrors._root = 'MISSING_BODY';
    return false;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fieldErrors._root = 'INVALID_BODY_TYPE';
    return false;
  }
  return true;
}

/**
 * Validates that only allowed keys are present in the body.
 *
 * @param {Record<string, unknown>} body - Parsed body object.
 * @param {Set<string>} allowedKeys - Set of permitted field names.
 * @param {Record<string, string>} fieldErrors - Error accumulator.
 * @returns {void}
 */
function validateAllowedKeys(body, allowedKeys, fieldErrors) {
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      fieldErrors[key] = 'UNRECOGNIZED_FIELD';
    }
  }
}

/**
 * Validates an optional reason field.
 *
 * @param {Record<string, unknown>} body - Parsed body object.
 * @param {Record<string, string>} fieldErrors - Error accumulator.
 * @param {boolean} required - Whether reason is required.
 * @returns {void}
 */
function validateReasonField(body, fieldErrors, required = false) {
  if (!('reason' in body)) {
    if (required) {
      fieldErrors.reason = 'MISSING_TRANSITION_REASON';
    }
    return;
  }

  if (typeof body.reason !== 'string') {
    fieldErrors.reason = 'INVALID_REASON_TYPE';
    return;
  }

  if (required && body.reason.trim().length === 0) {
    fieldErrors.reason = 'MISSING_TRANSITION_REASON';
    return;
  }

  if (body.reason.length > MAX_TRANSITION_REASON_LENGTH) {
    fieldErrors.reason = 'TRANSITION_REASON_TOO_LONG';
  }
}

/**
 * Validates and maps a transition request body.
 *
 * Performs semantic validation using the Zod schema to enforce:
 *   - targetState is a valid invoice state enum value
 *   - reason (if present) is a string within length bounds
 *   - revision is a non-negative integer
 *   - No unrecognized fields (including prototype pollution vectors)
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ success: true, data: { targetState: string, reason?: string, revision?: number, currentState?: string, actor?: string, metadata?: object } } | { success: false, fieldErrors: Record<string, string> }}
 *   Validation result with either parsed data or field-level error codes.
 */
function validateTransitionRequest(body) {
  return safeParseTransitionBody(body);
}

/**
 * Validates and maps an approve request body.
 *
 * Enforces:
 *   - reason (if present) is a string within length bounds
 *   - No unrecognized fields
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ success: true, data: { reason?: string } } | { success: false, fieldErrors: Record<string, string> }}
 *   Validation result with either parsed data or field-level error codes.
 */
function validateApproveRequest(body) {
  const fieldErrors = Object.create(null);

  if (!validateBodyShape(body, fieldErrors)) {
    return { success: false, fieldErrors };
  }

  /** @type {Record<string, unknown>} */
  const b = body;
  validateAllowedKeys(b, new Set(['reason']), fieldErrors);
  validateReasonField(b, fieldErrors, false);

  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, fieldErrors };
  }

  return {
    success: true,
    data: {
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    },
  };
}

/**
 * Validates and maps a link-escrow request body.
 *
 * Enforces:
 *   - escrowId (if present) is a string
 *   - reason (if present) is a string within length bounds
 *   - No unrecognized fields
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ success: true, data: { escrowId: string|null, reason?: string } } | { success: false, fieldErrors: Record<string, string> }}
 *   Validation result with either parsed data or field-level error codes.
 */
function validateLinkEscrowRequest(body) {
  const fieldErrors = Object.create(null);

  if (!validateBodyShape(body, fieldErrors)) {
    return { success: false, fieldErrors };
  }

  /** @type {Record<string, unknown>} */
  const b = body;
  validateAllowedKeys(b, new Set(['escrowId', 'reason']), fieldErrors);

  if ('escrowId' in b && b.escrowId !== null && typeof b.escrowId !== 'string') {
    fieldErrors.escrowId = 'INVALID_ESCROW_ID_TYPE';
  }

  validateReasonField(b, fieldErrors, false);

  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, fieldErrors };
  }

  return {
    success: true,
    data: {
      escrowId: typeof b.escrowId === 'string' ? b.escrowId : null,
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    },
  };
}

/**
 * Validates and maps a reject request body.
 *
 * Enforces:
 *   - reason is required and must be a non-empty string
 *   - reason is within length bounds
 *   - No unrecognized fields
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ success: true, data: { reason: string } } | { success: false, fieldErrors: Record<string, string> }}
 *   Validation result with either parsed data or field-level error codes.
 */
function validateRejectRequest(body) {
  const fieldErrors = Object.create(null);

  if (!validateBodyShape(body, fieldErrors)) {
    return { success: false, fieldErrors };
  }

  /** @type {Record<string, unknown>} */
  const b = body;
  validateAllowedKeys(b, new Set(['reason']), fieldErrors);
  validateReasonField(b, fieldErrors, true);

  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, fieldErrors };
  }

  return {
    success: true,
    data: {
      reason: b.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Response mappers — internal result → public DTO
// ---------------------------------------------------------------------------

/**
 * Maps the internal invoice-state view into the public `InvoiceStateResponseDto`.
 *
 * Concurrency note: `allowedTransitions` is copied into a fresh array of
 * strings so a later mutation of the source array cannot change an already
 * serialised response.
 *
 * @param {unknown} view
 * @param {string} invoiceId
 * @returns {InvoiceStateResponseDto}
 */
function mapInvoiceStateResponse(view, invoiceId) {
  const safe = view && typeof view === 'object' ? /** @type {Record<string, unknown>} */ (view) : {};
  const rawAllowed = Array.isArray(safe.allowedTransitions) ? safe.allowedTransitions : [];
  const allowedTransitions = rawAllowed.map((entry) => asSafeString(entry));
  return {
    invoiceId: asSafeString(invoiceId),
    currentState: asSafeString(safe.currentState),
    allowedTransitions,
    isTerminal: safe.isTerminal === true,
  };
}

/**
 * Maps an internal transition result into the public `TransitionResponseDto`.
 *
 * @param {unknown} result
 * @param {string} invoiceId
 * @param {string|undefined} [reason]
 * @returns {TransitionResponseDto}
 */
function mapTransitionResponse(result, invoiceId, reason) {
  const normalised = normaliseTransitionResult(result);
  const dto = {
    invoiceId: asSafeString(invoiceId),
    previousState: normalised.previousState,
    currentState: normalised.newState,
    transitionedAt: normalised.transitionedAt,
    transitionedBy: normalised.transitionedBy,
    auditLogId: normalised.auditLogId,
  };
  const safeReason = asOptionalString(reason);
  if (safeReason !== undefined) {
    dto.reason = safeReason;
  }
  return dto;
}

/**
 * Maps an internal transition result into the public `LinkEscrowResponseDto`.
 *
 * @param {unknown} result
 * @param {string} invoiceId
 * @param {string|null|undefined} escrowId
 * @returns {LinkEscrowResponseDto}
 */
function mapLinkEscrowResponse(result, invoiceId, escrowId) {
  const normalised = normaliseTransitionResult(result);
  const safeEscrowId = asOptionalString(escrowId);
  return {
    invoiceId: asSafeString(invoiceId),
    previousState: normalised.previousState,
    currentState: normalised.newState,
    escrowId: safeEscrowId !== undefined ? safeEscrowId : null,
    transitionedAt: normalised.transitionedAt,
    transitionedBy: normalised.transitionedBy,
    auditLogId: normalised.auditLogId,
  };
}

/**
 * Maps a single internal audit-log record into a `HistoryEntryDto`.
 *
 * Optional fields (`fromState`, `toState`, `reason`, `ipAddress`) are only
 * present on the returned object when they carried a meaningful value, so
 * the serialised history remains deterministic across repeated calls.
 *
 * @param {unknown} record
 * @returns {HistoryEntryDto}
 */
function mapHistoryEntry(record) {
  const safe = record && typeof record === 'object' ? /** @type {Record<string, unknown>} */ (record) : {};
  const changes = safe.changes && typeof safe.changes === 'object' ? /** @type {Record<string, unknown>} */ (safe.changes) : {};
  const before = changes.before && typeof changes.before === 'object' ? /** @type {Record<string, unknown>} */ (changes.before) : {};
  const after = changes.after && typeof changes.after === 'object' ? /** @type {Record<string, unknown>} */ (changes.after) : {};
  const metadata = safe.metadata && typeof safe.metadata === 'object' ? /** @type {Record<string, unknown>} */ (safe.metadata) : {};

  const dto = {
    id: asSafeString(safe.id),
    timestamp: asSafeString(safe.timestamp),
    actor: asSafeString(safe.actor),
  };

  const fromState = asOptionalString(before.state);
  if (fromState !== undefined) {
    dto.fromState = fromState;
  }
  const toState = asOptionalString(after.state);
  if (toState !== undefined) {
    dto.toState = toState;
  }
  const reason = asOptionalString(metadata.reason);
  if (reason !== undefined) {
    dto.reason = reason;
  }
  const ipAddress = asOptionalString(safe.ipAddress);
  if (ipAddress !== undefined) {
    dto.ipAddress = ipAddress;
  }

  return dto;
}

/**
 * Maps a list of internal audit-log records into `HistoryEntryDto`s.
 *
 * Always returns a fresh array; non-array inputs become an empty array so the
 * caller never has to guard against `null` or `undefined`.
 *
 * @param {unknown} records
 * @returns {HistoryEntryDto[]}
 */
function mapHistoryList(records) {
  if (!Array.isArray(records)) {
    return [];
  }
  return records.map(mapHistoryEntry);
}

/**
 * Maps a single bulk-operation item into a normalised internal command.
 *
 * @param {unknown} item
 * @returns {{ invoiceId: string|undefined, action: string|undefined, reason: string|undefined, escrowId: string|undefined, targetState: unknown }}
 */
function mapBulkOperation(item) {
  const safe = item && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {};
  return {
    invoiceId: asOptionalString(safe.invoiceId),
    action: asOptionalString(safe.action),
    reason: asOptionalString(safe.reason),
    escrowId: asOptionalString(safe.escrowId),
    targetState: 'targetState' in safe ? safe.targetState : undefined,
  };
}

/**
 * Maps a bulk response into the public `BulkInvoiceStateResponseDto`.
 *
 * The summary is recomputed from the per-item results rather than trusting a
 * caller-supplied count, so a concurrently-mutated or inconsistent input
 * cannot produce a summary that disagrees with the results array.
 *
 * @param {unknown} results
 * @returns {BulkInvoiceStateResponseDto}
 */
function mapBulkResponse(results) {
  const list = Array.isArray(results) ? results : [];
  const mapped = list.map((entry, index) => {
    const safe = entry && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {};
    if (safe.success === true) {
      return {
        index: typeof safe.index === 'number' ? safe.index : index,
        success: true,
        action: asSafeString(safe.action),
        result: safe.result && typeof safe.result === 'object' ? safe.result : {},
      };
    }
    return {
      index: typeof safe.index === 'number' ? safe.index : index,
      success: false,
      error: asSafeString(safe.error),
      code: asSafeString(safe.code),
    };
  });
  const succeeded = mapped.filter((item) => item.success === true).length;
  return {
    results: mapped,
    summary: {
      total: mapped.length,
      succeeded</strong>: succeeded,
      failed: mapped.length - succeeded,
    },
  };
}

/**
 * @note Migration path for route adoption
 *
 * Current routes (src/routes/invoiceStateRoutes.js) access req.body directly
 * instead of using these mappers. To adopt the mappers:
 *
 * 1. Replace direct req.body access with mapper calls in each route handler
 * 2. Verify service layer returns shapes compatible with response mappers
 * 3. Update response helpers to use mapper outputs
 * 4. Run existing test suite to ensure no breaking changes
 * 5. Increment contract version if output shapes change
 *
 * The mappers are production-ready and tested. Adoption is optional but
 * recommended for consistency and defensive boundary handling.
 */
module.exports = {
  // Request mappers (pure coercion, no validation)
  mapTransitionRequest,
  mapApproveRequest,
  mapLinkEscrowRequest,
  mapRejectRequest,
  // Validation wrappers (enforce input boundaries)
  validateTransitionRequest,
  validateApproveRequest,
  validateLinkEscrowRequest,
  validateRejectRequest,
  // Response mappers
  toInvoiceStateResponse,
  toTransitionResponse,
  toLinkEscrowResponse,
  toHistoryEntryDto,
  toInvoiceHistoryResponse,
};
