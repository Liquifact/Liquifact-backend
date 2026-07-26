'use strict';

const { createAuditLog } = require('./auditLog');

/**
 * Canonical invoice status vocabulary shared by invoice-list and marketplace
 * query validators.
 */

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

/**
 * Maximum allowed length for a transition reason string.
 * @type {number}
 */
const MAX_TRANSITION_REASON_LENGTH = 1024;

/**
 * Map of valid state transitions. Each entry lists the allowed target states
 * from the given source state.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
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
  [INVOICE_STATES.LINKED_ESCROW]: Object.freeze([]),
  [INVOICE_STATES.REJECTED]: Object.freeze([]),
  [INVOICE_STATES.CANCELLED]: Object.freeze([]),
});

/**
 * States that require a reason when transitioning _into_ them.
 * @type {ReadonlyArray<string>}
 */
const REASON_REQUIRED_TARGETS = Object.freeze([
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
]);

/**
 * Checks whether the given value is a known invoice state.
 * @param {*} state - Value to check.
 * @returns {boolean} True when the value matches a known state.
 */
function isValidState(state) {
  return Object.values(INVOICE_STATES).includes(state);
}

/**
 * Checks whether a transition from one state to another is allowed by the
 * state machine rules.
 * @param {string} fromState - Current state.
 * @param {string} targetState - Desired target state.
 * @returns {boolean} True when the transition is permitted.
 */
function isTransitionAllowed(fromState, targetState) {
  if (!isValidState(fromState) || !isValidState(targetState)) {
    return false;
  }
  if (fromState === targetState) {
    return false;
  }
  if (TERMINAL_STATES.includes(fromState)) {
    return false;
  }
  const allowed = VALID_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.includes(targetState));
}

/**
 * Checks whether a state is terminal (no further transitions allowed).
 * @param {string} state - State to check.
 * @returns {boolean} True when the state is terminal.
 */
function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Returns the list of allowed target states from the given source state.
 * @param {string} state - Source state.
 * @returns {ReadonlyArray<string>} Allowed target states (empty when terminal or invalid).
 */
function getAllowedTransitions(state) {
  if (!isValidState(state)) {
    return [];
  }
  const transitions = VALID_TRANSITIONS[state];
  return transitions ? [...transitions] : [];
}

/**
 * Normalizes a transition reason by stripping control characters and trimming
 * whitespace.
 * @param {*} reason - Raw reason value.
 * @returns {string} Normalized reason string.
 */
function normalizeTransitionReason(reason) {
  if (reason == null) {
    return '';
  }
  const str = String(reason);
  return str.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validates a transition context object and returns either a success or error
 * result. The normalised reason is included in the result when valid.
 * @param {object} ctx - Transition context.
 * @param {string} [ctx.invoiceId] - Invoice identifier.
 * @param {string} [ctx.currentState] - Current state of the invoice.
 * @param {string} [ctx.targetState] - Desired target state.
 * @param {string} [ctx.actor] - Actor performing the transition.
 * @param {*} [ctx.reason] - Reason for the transition.
 * @returns {{isValid: true}|{isValid: false, code: string, allowedTransitions?: string[], reason?: string}}
 *   Validation result.
 */
function validateTransition(ctx) {
  const { invoiceId, currentState, targetState, actor } = ctx || {};

  if (!invoiceId) {
    return { isValid: false, code: 'MISSING_INVOICE_ID' };
  }
  if (!currentState) {
    return { isValid: false, code: 'MISSING_CURRENT_STATE' };
  }
  if (!targetState) {
    return { isValid: false, code: 'MISSING_TARGET_STATE' };
  }
  if (!actor) {
    return { isValid: false, code: 'MISSING_ACTOR' };
  }
  if (currentState === targetState) {
    return { isValid: false, code: 'ALREADY_IN_TARGET_STATE' };
  }
  if (TERMINAL_STATES.includes(currentState)) {
    return { isValid: false, code: 'TERMINAL_STATE' };
  }
  if (!isValidState(currentState)) {
    return { isValid: false, code: 'INVALID_CURRENT_STATE' };
  }
  if (!isValidState(targetState)) {
    return { isValid: false, code: 'INVALID_TARGET_STATE' };
  }

  const rawReason = ctx.reason;
  const normalisedReason = normalizeTransitionReason(rawReason);

  if (REASON_REQUIRED_TARGETS.includes(targetState)) {
    if (!normalisedReason) {
      return { isValid: false, code: 'MISSING_TRANSITION_REASON' };
    }
  }

  if (normalisedReason && normalisedReason.length > MAX_TRANSITION_REASON_LENGTH) {
    return { isValid: false, code: 'TRANSITION_REASON_TOO_LONG' };
  }

  const allowed = VALID_TRANSITIONS[currentState] || [];
  if (!allowed.includes(targetState)) {
    return {
      isValid: false,
      code: 'INVALID_TRANSITION',
      allowedTransitions: [...allowed],
    };
  }

  return { isValid: true, reason: normalisedReason };
}

/**
 * Builds an error with structured properties for the API layer.
 * @param {string} code - Machine-readable error code.
 * @param {string} message - Human-readable message.
 * @param {number} [statusCode=400] - HTTP status code.
 * @param {string[]} [allowedTransitions] - Optional hint of valid transitions.
 * @returns {Error} Configured error instance.
 */
function buildTransitionError(code, message, statusCode = 400, allowedTransitions) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (allowedTransitions) {
    err.allowedTransitions = allowedTransitions;
  }
  return err;
}

/**
 * Executes a validated state transition and persists an audit log entry.
 * Throws on validation failure with structured error properties.
 * @param {object} ctx - Transition context.
 * @param {string} ctx.invoiceId - Invoice identifier.
 * @param {string} ctx.currentState - Current state of the invoice.
 * @param {string} ctx.targetState - Desired target state.
 * @param {string} ctx.actor - Actor performing the transition.
 * @param {*} [ctx.reason] - Reason for the transition.
 * @param {string} [ctx.ipAddress] - Request source IP address.
 * @param {string} [ctx.userAgent] - Request user agent.
 * @param {object} [ctx.metadata] - Additional metadata for the audit log.
 * @returns {Promise<{success: boolean, previousState: string, newState: string, transitionedBy: string, auditLog: object}>}
 *   Transition result with audit log entry.
 */
async function executeTransition(ctx) {
  const validation = validateTransition(ctx);

  if (!validation.isValid) {
    const messageMap = {
      MISSING_INVOICE_ID: 'Invoice ID is required.',
      MISSING_CURRENT_STATE: 'Current state is required.',
      MISSING_TARGET_STATE: 'Target state is required.',
      MISSING_ACTOR: 'Actor is required.',
      INVALID_CURRENT_STATE: 'Current state is not recognised.',
      INVALID_TARGET_STATE: 'Target state is not recognised.',
      ALREADY_IN_TARGET_STATE: 'Invoice is already in the target state.',
      TERMINAL_STATE: 'Invoice is in a terminal state and cannot transition.',
      MISSING_TRANSITION_REASON: 'Reason is required for this transition.',
      TRANSITION_REASON_TOO_LONG: `Transition reason must be ${MAX_TRANSITION_REASON_LENGTH} characters or fewer.`,
      INVALID_TRANSITION: 'Invalid state transition.',
    };

    const message = messageMap[validation.code] || 'Invalid state transition.';
    throw buildTransitionError(
      validation.code,
      message,
      validation.code === 'INVOICE_NOT_FOUND' ? 404 : 400,
      validation.allowedTransitions,
    );
  }

  const { invoiceId, currentState, targetState, actor, ipAddress = 'unknown', userAgent = 'unknown', metadata = {} } = ctx;
  const reason = ctx.reason != null ? normalizeTransitionReason(ctx.reason) : undefined;

  const auditLog = await createAuditLog({
    actor,
    action: 'STATE_TRANSITION',
    resourceType: 'invoice',
    resourceId: invoiceId,
    before: { state: currentState },
    after: { state: targetState },
    ipAddress,
    userAgent,
    metadata: {
      ...metadata,
      reason: reason || null,
      transitionType: `${currentState}_to_${targetState}`,
    },
  });

  return {
    success: true,
    previousState: currentState,
    newState: targetState,
    transitionedBy: actor,
    auditLog,
  };
}

/**
 * Retrieves the transition history for a given invoice, ordered newest first.
 * @param {string} invoiceId - Invoice identifier.
 * @param {Function} getAuditLogsFn - Reference to the getAuditLogs function for dependency injection.
 * @returns {Promise<Array<{fromState: string, toState: string, timestamp: string, actor: string, reason: string|null}>>}
 *   Ordered transition list.
 */
async function getTransitionHistory(invoiceId, getAuditLogsFn) {
  const logs = await getAuditLogsFn({ resourceId: invoiceId, resourceType: 'invoice', action: 'STATE_TRANSITION' });

  return logs.map((log) => ({
    fromState: log.changes?.before?.state || 'unknown',
    toState: log.changes?.after?.state || 'unknown',
    timestamp: log.timestamp,
    actor: log.actor,
    reason: log.metadata?.reason || null,
  }));
}

/**
 * Checks whether an invoice can be linked to an escrow contract.
 * @param {object|null} invoice - Invoice object with at least a `status` field.
 * @returns {{canLink: boolean, reason?: string}} Result with optional explanation.
 */
function canLinkToEscrow(invoice) {
  if (!invoice) {
    return { canLink: false, reason: 'Invoice not found' };
  }
  if (invoice.status !== INVOICE_STATES.APPROVED) {
    return {
      canLink: false,
      reason: `Invoice must be in ${INVOICE_STATES.APPROVED} state to link to escrow.`,
    };
  }
  return { canLink: true };
}

module.exports = {
  INVOICE_STATES,
  ALL_INVOICE_STATUSES,
  INVESTABLE_STATUSES,
  TERMINAL_STATES,
  CAPITAL_MOVING_STATES,
  VALID_TRANSITIONS,
  MAX_TRANSITION_REASON_LENGTH,
  REASON_REQUIRED_TARGETS,
  isValidState,
  isTransitionAllowed,
  isTerminalState,
  getAllowedTransitions,
  normalizeTransitionReason,
  validateTransition,
  executeTransition,
  getTransitionHistory,
  canLinkToEscrow,
};
