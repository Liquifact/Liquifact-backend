'use strict';

/**
 * Invoice State Machine
 *
 * Owns the complete lifecycle of an invoice's state, including:
 *  - The authoritative transition graph (VALID_TRANSITIONS)
 *  - Validation helpers (isValidState, isTransitionAllowed, isTerminalState, …)
 *  - Input normalisation for transition reasons
 *  - Synchronous validateTransition (pure; no side-effects)
 *  - Asynchronous executeTransition (validates + emits immutable audit log)
 *  - getTransitionHistory (queries audit log by invoiceId)
 *  - canLinkToEscrow business-rule check
 *
 * Redaction of sensitive fields is handled automatically by
 * `createAuditLog` → `auditLogStore.redactValue`.
 *
 * @module services/invoiceStateMachine
 */

const { createAuditLog, getAuditLogs } = require('./auditLog');

// ---------------------------------------------------------------------------
// State vocabulary
// ---------------------------------------------------------------------------

/**
 * Lifecycle states used by invoice transition endpoints.
 * @type {Readonly<Record<string, string>>}
 */
const INVOICE_STATES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  LINKED_ESCROW: 'linked_escrow',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

/**
 * Legacy payment-facing statuses accepted by GET /api/invoices.
 * @type {readonly string[]}
 */
const PAYMENT_STATUSES = Object.freeze(['paid', 'pending', 'overdue']);

/**
 * Funding and settlement statuses surfaced by marketplace and escrow flows.
 * @type {readonly string[]}
 */
const FUNDING_PROGRESS_STATUSES = Object.freeze([
  'pending_verification',
  'verified',
  'partially_funded',
  'funded',
  'settled',
  'completed',
  'defaulted',
]);

/**
 * Authoritative invoice status list for query-parameter validation.
 * @type {readonly string[]}
 */
const ALL_INVOICE_STATUSES = Object.freeze([
  ...new Set([
    ...PAYMENT_STATUSES,
    ...FUNDING_PROGRESS_STATUSES,
    ...Object.values(INVOICE_STATES),
  ]),
]);

/**
 * Statuses visible in public investable invoice flows.
 * @type {readonly string[]}
 */
const INVESTABLE_STATUSES = Object.freeze(['verified', 'partially_funded']);

/**
 * Terminal states that should not become investable.
 * Terminal states reject ALL further transitions.
 * @type {readonly string[]}
 */
const TERMINAL_STATES = Object.freeze([
  INVOICE_STATES.LINKED_ESCROW,
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
  'completed',
  'defaulted',
  'settled',
]);

/**
 * Authoritative set of invoice states that involve capital movement.
 * Any state included in this set automatically triggers KYC gating.
 * @type {Set<string>}
 */
const CAPITAL_MOVING_STATES = new Set(['funded', 'settled']);

// ---------------------------------------------------------------------------
// Transition graph
// ---------------------------------------------------------------------------

/**
 * Authoritative allowed-transition map.
 * Keys are source states; values are arrays of valid destination states.
 * Terminal states are absent (no outbound edges).
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const VALID_TRANSITIONS = Object.freeze({
  [INVOICE_STATES.PENDING]: Object.freeze([
    INVOICE_STATES.APPROVED,
    INVOICE_STATES.REJECTED,
    INVOICE_STATES.CANCELLED,
  ]),
  [INVOICE_STATES.APPROVED]: Object.freeze([
    INVOICE_STATES.LINKED_ESCROW,
    INVOICE_STATES.CANCELLED,
  ]),
});

// ---------------------------------------------------------------------------
// Transition-reason constraints
// ---------------------------------------------------------------------------

/**
 * States that require a non-empty reason when they are the *target* of a
 * transition (REJECTED and CANCELLED carry an audit obligation).
 * @type {Set<string>}
 */
const REASON_REQUIRED_TARGET_STATES = new Set([
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
]);

/**
 * Maximum character length for a transition reason.
 * Reasons exceeding this length are rejected rather than silently truncated.
 */
const MAX_TRANSITION_REASON_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Reason normalisation
// ---------------------------------------------------------------------------

/**
 * Strips ASCII control characters from a reason string and returns a clean
 * value.  Non-string values are coerced to a string first.
 * Control characters are replaced with a single space, then multiple
 * consecutive spaces are collapsed to a single space.
 *
 * Control chars replaced: U+0000–U+001F and U+007F (DEL).
 *
 * @param {*} raw - Raw reason value (any type).
 * @returns {string} Cleaned reason string (may be empty).
 */
function normalizeTransitionReason(raw) {
  if (raw === null || raw === undefined) {
    return '';
  }
  // Coerce non-strings (e.g. numbers) to string
  const str = typeof raw === 'string' ? raw : String(raw);
  // Replace ASCII control characters (0x00–0x1F and 0x7F) with a space,
  // then collapse multiple spaces to preserve word boundaries.
   
  return str.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/  +/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `state` is a recognised invoice lifecycle state.
 *
 * @param {*} state - Value to test.
 * @returns {boolean}
 */
function isValidState(state) {
  if (!state || typeof state !== 'string') {
    return false;
  }
  return Object.values(INVOICE_STATES).includes(state);
}

/**
 * Returns true when transitioning from `fromState` to `targetState` is
 * permitted by VALID_TRANSITIONS.
 *
 * Same-state transitions always return false.
 * Transitions *from* a terminal state always return false.
 *
 * @param {string} fromState   - Current invoice state.
 * @param {string} targetState - Desired target state.
 * @returns {boolean}
 */
function isTransitionAllowed(fromState, targetState) {
  if (fromState === targetState) {
    return false;
  }
  if (TERMINAL_STATES.includes(fromState)) {
    return false;
  }
  const allowed = VALID_TRANSITIONS[fromState];
  if (!allowed) {
    return false;
  }
  return allowed.includes(targetState);
}

/**
 * Returns true when `state` is a terminal (irreversible) lifecycle state.
 *
 * @param {string} state - Invoice state to test.
 * @returns {boolean}
 */
function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Returns the array of states reachable from `state` according to
 * VALID_TRANSITIONS.  Returns an empty array for terminal or unknown states.
 *
 * @param {string|null|undefined} state - Current invoice state.
 * @returns {string[]} Mutable copy of the allowed-transition array.
 */
function getAllowedTransitions(state) {
  if (!state) {
    return [];
  }
  const transitions = VALID_TRANSITIONS[state];
  if (!transitions) {
    return [];
  }
  return [...transitions];
}

// ---------------------------------------------------------------------------
// Synchronous validateTransition
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ValidationResult
 * @property {boolean}         isValid           - Whether the transition is permitted.
 * @property {string}          [code]            - Machine-readable error code (absent when valid).
 * @property {string}          [error]           - Human-readable error message (absent when valid).
 * @property {string[]}        [allowedTransitions] - Allowed targets from the current state
 *                                                    (present when code === 'INVALID_TRANSITION').
 */

/**
 * Synchronously validates a proposed state transition.
 *
 * Does NOT write any records; purely informational.
 * Normalises the reason string so callers see the cleaned value.
 *
 * @param {object} ctx
 * @param {string}  ctx.invoiceId    - Invoice ID (required for completeness checks).
 * @param {string}  ctx.currentState - Current lifecycle state of the invoice.
 * @param {string}  ctx.targetState  - Desired lifecycle state.
 * @param {string}  ctx.actor        - Actor performing the transition.
 * @param {*}       [ctx.reason]     - Human-readable reason (required for terminal targets).
 * @returns {ValidationResult}
 */
function validateTransition({ invoiceId, currentState, targetState, actor, reason } = {}) {
  // -- Required field checks --------------------------------------------------
  if (!invoiceId) {
    return { isValid: false, code: 'MISSING_INVOICE_ID', error: 'Invoice ID is required' };
  }
  if (!currentState) {
    return { isValid: false, code: 'MISSING_CURRENT_STATE', error: 'Current state is required' };
  }
  if (!targetState) {
    return { isValid: false, code: 'MISSING_TARGET_STATE', error: 'Target state is required' };
  }
  if (!actor) {
    return { isValid: false, code: 'MISSING_ACTOR', error: 'Actor is required' };
  }

  // -- Same-state guard (checked FIRST, even for terminal states, so that
  //    e.g. linked_escrow → linked_escrow returns ALREADY_IN_TARGET_STATE) ---
  if (currentState === targetState) {
    return {
      isValid: false,
      code: 'ALREADY_IN_TARGET_STATE',
      error: `Invoice is already in state '${targetState}'`,
    };
  }

  // -- Terminal-state guard (checked BEFORE validity so extended terminal
  //    states like 'completed', 'settled', 'defaulted' get TERMINAL_STATE,
  //    not INVALID_CURRENT_STATE) -------------------------------------------
  if (isTerminalState(currentState)) {
    return {
      isValid: false,
      code: 'TERMINAL_STATE',
      error: `State '${currentState}' is terminal; no further transitions are allowed`,
    };
  }

  // -- State validity ---------------------------------------------------------
  if (!isValidState(currentState)) {
    return { isValid: false, code: 'INVALID_CURRENT_STATE', error: `Unknown current state: ${currentState}` };
  }
  if (!isValidState(targetState)) {
    return { isValid: false, code: 'INVALID_TARGET_STATE', error: `Unknown target state: ${targetState}` };
  }

  // -- Reason requirements checked BEFORE transition-graph so that even
  //    disallowed transitions (e.g. approved → rejected) return
  //    MISSING_TRANSITION_REASON rather than INVALID_TRANSITION when the
  //    target state inherently requires a reason. ---------------------------
  if (REASON_REQUIRED_TARGET_STATES.has(targetState)) {
    const normalised = normalizeTransitionReason(reason);
    if (!normalised.trim()) {
      return {
        isValid: false,
        code: 'MISSING_TRANSITION_REASON',
        error: `Reason is required when transitioning to '${targetState}'`,
      };
    }
    if (normalised.length > MAX_TRANSITION_REASON_LENGTH) {
      return {
        isValid: false,
        code: 'TRANSITION_REASON_TOO_LONG',
        error: `Reason must be ${MAX_TRANSITION_REASON_LENGTH} characters or fewer`,
      };
    }
  } else if (reason !== null && reason !== undefined) {
    // Validate length even for non-terminal targets if a reason was supplied
    const normalised = normalizeTransitionReason(reason);
    if (normalised.length > MAX_TRANSITION_REASON_LENGTH) {
      return {
        isValid: false,
        code: 'TRANSITION_REASON_TOO_LONG',
        error: `Reason must be ${MAX_TRANSITION_REASON_LENGTH} characters or fewer`,
      };
    }
  }

  // -- Transition-graph check -------------------------------------------------
  if (!isTransitionAllowed(currentState, targetState)) {
    return {
      isValid: false,
      code: 'INVALID_TRANSITION',
      error: `Transition from '${currentState}' to '${targetState}' is not permitted`,
      allowedTransitions: getAllowedTransitions(currentState),
    };
  }

  return { isValid: true };
}

// ---------------------------------------------------------------------------
// Asynchronous executeTransition — validates + emits audit log
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TransitionResult
 * @property {boolean} success        - Always true on a successful execution.
 * @property {string}  previousState  - State before the transition.
 * @property {string}  newState       - State after the transition.
 * @property {string}  transitionedBy - Actor who performed the transition.
 * @property {object}  auditLog       - Frozen audit log entry returned by createAuditLog.
 */

/**
 * Validates and executes a state transition, then appends an immutable audit
 * log entry.  Throws on validation failure so the caller's DB update is
 * never reached.
 *
 * @param {object}  ctx
 * @param {string}  ctx.invoiceId   - Invoice identifier.
 * @param {string}  ctx.currentState
 * @param {string}  ctx.targetState
 * @param {string}  ctx.actor       - Actor performing the transition.
 * @param {*}       [ctx.reason]    - Transition reason.
 * @param {string}  [ctx.ipAddress='unknown']
 * @param {string}  [ctx.userAgent='unknown']
 * @param {object}  [ctx.metadata={}] - Additional metadata persisted in the audit log.
 * @returns {Promise<TransitionResult>}
 * @throws {Error} With `.code` and `.allowedTransitions` on validation failure.
 */
async function executeTransition({
  invoiceId,
  currentState,
  targetState,
  actor,
  reason,
  ipAddress = 'unknown',
  userAgent = 'unknown',
  metadata = {},
} = {}) {
  const validation = validateTransition({ invoiceId, currentState, targetState, actor, reason });

  if (!validation.isValid) {
    const err = new Error(`Invalid state transition: ${validation.error}`);
    err.code = validation.code;
    if (validation.allowedTransitions) {
      err.allowedTransitions = validation.allowedTransitions;
    }
    throw err;
  }

  // Normalise reason *after* validation so the audit log stores the clean value
  const cleanReason = reason !== null && reason !== undefined
    ? normalizeTransitionReason(reason)
    : undefined;

  const transitionType = `${currentState}_to_${targetState}`;

  const auditLog = await createAuditLog({
    actor,
    action: 'STATE_TRANSITION',
    resourceType: 'invoice',
    resourceId: invoiceId,
    before: { state: currentState },
    after: { state: targetState },
    statusCode: 200,
    ipAddress,
    userAgent,
    metadata: {
      ...metadata,
      transitionType,
      ...(cleanReason !== undefined && { reason: cleanReason }),
    },
  });

  return Object.freeze({
    success: true,
    previousState: currentState,
    newState: targetState,
    transitionedBy: actor,
    auditLog,
  });
}

// ---------------------------------------------------------------------------
// getTransitionHistory
// ---------------------------------------------------------------------------

/**
 * Retrieves the ordered transition history for a specific invoice from the
 * audit log.
 *
 * Returns entries newest-first (most recent transition at index 0).
 *
 * @param {string}   invoiceId        - Invoice identifier.
 * @param {Function} getAuditLogsFn   - Injected `getAuditLogs` function (allows
 *                                      testing without real DB).
 * @returns {Promise<Array<{fromState: string, toState: string, actor: string, timestamp: string, reason?: string}>>}
 */
async function getTransitionHistory(invoiceId, getAuditLogsFn) {
  const queryFn = getAuditLogsFn || getAuditLogs;

  const logs = await queryFn({
    resourceId: invoiceId,
    resourceType: 'invoice',
    action: 'STATE_TRANSITION',
    limit: 500,
  });

  return logs.map((log) => ({
    fromState: log.changes && log.changes.before ? log.changes.before.state : null,
    toState: log.changes && log.changes.after ? log.changes.after.state : null,
    actor: log.actor,
    timestamp: log.timestamp,
    ...(log.metadata && log.metadata.reason ? { reason: log.metadata.reason } : {}),
    ...(log.metadata && log.metadata.transitionType ? { transitionType: log.metadata.transitionType } : {}),
  }));
}

// ---------------------------------------------------------------------------
// canLinkToEscrow
// ---------------------------------------------------------------------------

/**
 * Business-rule guard: only approved invoices may be linked to an escrow.
 *
 * @param {object|null} invoice - Invoice document (must have a `status` field).
 * @returns {{ canLink: boolean, reason?: string }}
 */
function canLinkToEscrow(invoice) {
  if (!invoice) {
    return { canLink: false, reason: 'Invoice not found' };
  }
  if (invoice.status !== INVOICE_STATES.APPROVED) {
    return {
      canLink: false,
      reason: `Invoice must be in approved state to link to escrow (current: '${invoice.status}')`,
    };
  }
  return { canLink: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // State vocabulary
  INVOICE_STATES,
  ALL_INVOICE_STATUSES,
  INVESTABLE_STATUSES,
  TERMINAL_STATES,
  CAPITAL_MOVING_STATES,
  PAYMENT_STATUSES,
  FUNDING_PROGRESS_STATUSES,

  // Transition graph
  VALID_TRANSITIONS,
  REASON_REQUIRED_TARGET_STATES,
  MAX_TRANSITION_REASON_LENGTH,

  // Helpers
  normalizeTransitionReason,
  isValidState,
  isTransitionAllowed,
  isTerminalState,
  getAllowedTransitions,

  // Core API
  validateTransition,
  executeTransition,
  getTransitionHistory,
  canLinkToEscrow,
};
