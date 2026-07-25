'use strict';

const { createAuditLog } = require('./auditLog');
const logger = require('../logger');

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
 * Valid state transitions for the approval/escrow lifecycle.
 * Maps each lifecycle state to the set of states it may transition to.
 * @type {Readonly<Record<string, string[]>>}
 */
const VALID_TRANSITIONS = Object.freeze({
  [INVOICE_STATES.PENDING]: [INVOICE_STATES.APPROVED, INVOICE_STATES.REJECTED, INVOICE_STATES.CANCELLED],
  [INVOICE_STATES.APPROVED]: [INVOICE_STATES.LINKED_ESCROW, INVOICE_STATES.CANCELLED],
  [INVOICE_STATES.LINKED_ESCROW]: [],
  [INVOICE_STATES.REJECTED]: [],
  [INVOICE_STATES.CANCELLED]: [],
});

/**
 * Target states that require a non-empty reason to transition into.
 * @type {readonly string[]}
 */
const TERMINAL_REASON_REQUIRED_STATES = Object.freeze([
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
]);

/**
 * Maximum permitted length (in characters) for a transition reason.
 * @type {number}
 */
const MAX_TRANSITION_REASON_LENGTH = 1024;

/**
 * Strips control characters from a transition reason and trims whitespace.
 *
 * @param {*} reason - Raw reason input.
 * @returns {string|null} Sanitized reason, or null when absent/empty.
 */
function normalizeTransitionReason(reason) {
  if (reason === null || reason === undefined) {
    return null;
  }

  const value = typeof reason === 'string' ? reason : String(reason);
  const sanitized = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  return sanitized.length === 0 ? null : sanitized;
}

/**
 * Checks whether a string is a recognized invoice status.
 *
 * @param {string} state - Status value to check.
 * @returns {boolean} `true` when the value is in {@link ALL_INVOICE_STATUSES}.
 */
function isValidState(state) {
  return ALL_INVOICE_STATUSES.includes(state);
}

/**
 * Checks whether a transition from one lifecycle state to another is allowed.
 *
 * @param {string} fromState - Current state.
 * @param {string} toState - Desired state.
 * @returns {boolean} `true` when the transition is permitted.
 */
function isTransitionAllowed(fromState, toState) {
  if (!isValidState(fromState) || !isValidState(toState)) {
    return false;
  }

  const allowedTransitions = VALID_TRANSITIONS[fromState] || [];
  return allowedTransitions.includes(toState);
}

/**
 * Checks whether a state is terminal (no further transitions allowed).
 *
 * @param {string} state - State to check.
 * @returns {boolean} `true` when terminal.
 */
function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Gets all allowed transitions from a given state.
 *
 * @param {string} fromState - Current state.
 * @returns {string[]} Array of allowed next states.
 */
function getAllowedTransitions(fromState) {
  if (!isValidState(fromState)) {
    return [];
  }
  return VALID_TRANSITIONS[fromState] || [];
}

/**
 * Validates a proposed state transition without executing it.
 *
 * @param {object} options - Validation options.
 * @param {string} options.invoiceId - Invoice identifier.
 * @param {string} options.currentState - Current invoice state.
 * @param {string} options.targetState - Desired target state.
 * @param {string} options.actor - User performing the transition.
 * @param {string} [options.reason] - Reason for the transition. Required for terminal targets.
 * @returns {{isValid: boolean, error?: string, code?: string, allowedTransitions?: string[]}} Validation result.
 */
function validateTransition({ invoiceId, currentState, targetState, actor, reason: rawReason }) {
  if (!invoiceId) {
    return { isValid: false, error: 'Invoice ID is required', code: 'MISSING_INVOICE_ID' };
  }

  if (!currentState) {
    return { isValid: false, error: 'Current state is required', code: 'MISSING_CURRENT_STATE' };
  }

  if (!targetState) {
    return { isValid: false, error: 'Target state is required', code: 'MISSING_TARGET_STATE' };
  }

  if (!actor) {
    return { isValid: false, error: 'Actor is required', code: 'MISSING_ACTOR' };
  }

  if (!isValidState(currentState)) {
    return {
      isValid: false,
      error: `Invalid current state: ${currentState}`,
      code: 'INVALID_CURRENT_STATE',
    };
  }

  if (!isValidState(targetState)) {
    return {
      isValid: false,
      error: `Invalid target state: ${targetState}`,
      code: 'INVALID_TARGET_STATE',
    };
  }

  if (currentState === targetState) {
    return {
      isValid: false,
      error: `Invoice is already in state: ${targetState}`,
      code: 'ALREADY_IN_TARGET_STATE',
    };
  }

  const reason = normalizeTransitionReason(rawReason);

  if (isTerminalState(currentState)) {
    return {
      isValid: false,
      error: `Cannot transition from terminal state: ${currentState}`,
      code: 'TERMINAL_STATE',
    };
  }

  if (TERMINAL_REASON_REQUIRED_STATES.includes(targetState)) {
    if (!reason) {
      return {
        isValid: false,
        error: `Reason is required for terminal transition to ${targetState}`,
        code: 'MISSING_TRANSITION_REASON',
      };
    }

    if (reason.length > MAX_TRANSITION_REASON_LENGTH) {
      return {
        isValid: false,
        error: `Transition reason must be ${MAX_TRANSITION_REASON_LENGTH} characters or fewer`,
        code: 'TRANSITION_REASON_TOO_LONG',
      };
    }
  }

  if (!isTransitionAllowed(currentState, targetState)) {
    const allowed = getAllowedTransitions(currentState);
    return {
      isValid: false,
      error: `Invalid state transition from ${currentState} to ${targetState}. Allowed transitions: ${allowed.join(', ') || 'none'}`,
      code: 'INVALID_TRANSITION',
      allowedTransitions: allowed,
    };
  }

  return { isValid: true };
}

/**
 * Validates and executes a state transition, persisting an audit log entry.
 *
 * @param {object} options - Transition options.
 * @param {string} options.invoiceId - Invoice identifier.
 * @param {string} options.currentState - Current invoice state.
 * @param {string} options.targetState - Desired target state.
 * @param {string} options.actor - User performing the transition.
 * @param {string} [options.reason] - Reason for the transition.
 * @param {string} [options.ipAddress] - IP address of the requester.
 * @param {string} [options.userAgent] - User agent of the requester.
 * @param {object} [options.metadata] - Additional audit metadata.
 * @returns {Promise<{success: boolean, previousState: string, newState: string, auditLog: object, transitionedAt: string, transitionedBy: string}>}
 * @throws {Error} With `.code` (and `.allowedTransitions` when applicable) when validation fails.
 */
async function executeTransition({
  invoiceId,
  currentState,
  targetState,
  actor,
  reason = null,
  ipAddress = 'unknown',
  userAgent = 'unknown',
  metadata = {},
}) {
  const validation = validateTransition({ invoiceId, currentState, targetState, actor, reason });

  if (!validation.isValid) {
    const error = new Error(validation.error);
    error.code = validation.code;
    error.allowedTransitions = validation.allowedTransitions;
    throw error;
  }

  const normalizedReason = normalizeTransitionReason(reason);

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
      ...(normalizedReason ? { reason: normalizedReason } : {}),
      transitionType: `${currentState}_to_${targetState}`,
      timestamp: new Date().toISOString(),
    },
  });

  logger.info({
    invoiceId,
    actor,
    transition: `${currentState} -> ${targetState}`,
    reason: normalizedReason,
    auditLogId: auditLog.id,
  }, 'Invoice state transition executed');

  return {
    success: true,
    previousState: currentState,
    newState: targetState,
    auditLog,
    transitionedAt: auditLog.timestamp,
    transitionedBy: actor,
  };
}

/**
 * Retrieves the state-transition history for an invoice, most recent first.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {Function} getAuditLogsFn - Function used to retrieve audit logs (injected for testability).
 * @returns {Promise<Array<object>>} Array of transition records.
 */
async function getTransitionHistory(invoiceId, getAuditLogsFn) {
  const logs = await getAuditLogsFn({
    resourceId: invoiceId,
    resourceType: 'invoice',
    action: 'STATE_TRANSITION',
    limit: 1000,
  });

  return logs.map((log) => ({
    id: log.id,
    timestamp: log.timestamp,
    actor: log.actor,
    fromState: log.changes.before?.state,
    toState: log.changes.after?.state,
    reason: log.metadata?.reason,
    ipAddress: log.ipAddress,
  }));
}

/**
 * Validates additional business rules for linking an invoice to escrow.
 *
 * @param {object} invoice - Invoice object.
 * @returns {{canLink: boolean, reason?: string}} Validation result.
 */
function canLinkToEscrow(invoice) {
  if (!invoice) {
    return { canLink: false, reason: 'Invoice not found' };
  }

  if (invoice.status !== INVOICE_STATES.APPROVED) {
    return {
      canLink: false,
      reason: `Invoice must be in approved state. Current state: ${invoice.status}`,
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
  isValidState,
  isTransitionAllowed,
  isTerminalState,
  getAllowedTransitions,
  validateTransition,
  executeTransition,
  getTransitionHistory,
  canLinkToEscrow,
};
