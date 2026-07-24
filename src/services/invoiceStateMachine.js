'use strict';

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
 * Valid transition matrix defining allowed from→to pairs.
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
  [INVOICE_STATES.LINKED_ESCROW]: Object.freeze([]),
  [INVOICE_STATES.REJECTED]: Object.freeze([]),
  [INVOICE_STATES.CANCELLED]: Object.freeze([]),
});

/**
 * Checks whether a value is a recognised lifecycle state.
 * @param {*} state
 * @returns {boolean}
 */
function isValidState(state) {
  return Object.values(INVOICE_STATES).includes(state);
}

/**
 * Checks whether a transition from one state to another is allowed.
 * Same-state transitions are always disallowed.
 * @param {string} fromState
 * @param {string} toState
 * @returns {boolean}
 */
function isTransitionAllowed(fromState, toState) {
  if (!isValidState(fromState) || !isValidState(toState)) {return false;}
  if (fromState === toState) {return false;}
  if (TERMINAL_STATES.includes(fromState)) {return false;}
  return (VALID_TRANSITIONS[fromState] || []).includes(toState);
}

/**
 * Checks whether a state is terminal.
 * @param {string} state
 * @returns {boolean}
 */
function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Returns the list of states that can be transitioned to from the given state.
 * @param {string} state
 * @returns {string[]}
 */
function getAllowedTransitions(state) {
  if (!isValidState(state)) {return [];}
  if (TERMINAL_STATES.includes(state)) {return [];}
  return [...(VALID_TRANSITIONS[state] || [])];
}

/**
 * Normalizes a reason string by coercing to string and stripping control
 * characters (U+0000–U+001F, U+007F).
 * @param {*} reason
 * @returns {string}
 */
function normalizeTransitionReason(reason) {
  if (reason === null || reason === undefined) {return '';}
  const str = String(reason);
  return str.replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * Validates a state transition request and returns a structured result.
 * @param {object} opts
 * @param {string} [opts.invoiceId]
 * @param {string} [opts.currentState]
 * @param {string} [opts.targetState]
 * @param {string} [opts.actor]
 * @param {*} [opts.reason]
 * @returns {{ isValid: boolean, code?: string, error?: string, allowedTransitions?: string[] }}
 */
function validateTransition({ invoiceId, currentState, targetState, actor, reason } = {}) {
  if (!invoiceId) {
    return { isValid: false, code: 'MISSING_INVOICE_ID', error: 'invoiceId is required' };
  }
  if (!currentState) {
    return { isValid: false, code: 'MISSING_CURRENT_STATE', error: 'currentState is required' };
  }
  if (!targetState) {
    return { isValid: false, code: 'MISSING_TARGET_STATE', error: 'targetState is required' };
  }
  if (!actor) {
    return { isValid: false, code: 'MISSING_ACTOR', error: 'actor is required' };
  }
  if (currentState === targetState) {
    return { isValid: false, code: 'ALREADY_IN_TARGET_STATE', error: 'Invoice is already in the target state' };
  }
  if (isTerminalState(currentState)) {
    return { isValid: false, code: 'TERMINAL_STATE', error: 'Invoice is in a terminal state' };
  }
  if (!isValidState(currentState)) {
    return { isValid: false, code: 'INVALID_CURRENT_STATE', error: `Invalid current state: ${currentState}` };
  }
  if (!isValidState(targetState)) {
    return { isValid: false, code: 'INVALID_TARGET_STATE', error: `Invalid target state: ${targetState}` };
  }
  const reasonStr = normalizeTransitionReason(reason);
  if (reason !== undefined && reason !== null && String(reason).length > 1024) {
    return { isValid: false, code: 'TRANSITION_REASON_TOO_LONG', error: 'Reason must be 1024 characters or fewer' };
  }
  if ((targetState === INVOICE_STATES.REJECTED || targetState === INVOICE_STATES.CANCELLED) && !reasonStr.trim()) {
    return { isValid: false, code: 'MISSING_TRANSITION_REASON', error: 'Reason is required when transitioning to a terminal state' };
  }
  const allowed = getAllowedTransitions(currentState);
  if (!allowed.includes(targetState)) {
    return { isValid: false, code: 'INVALID_TRANSITION', error: `Invalid state transition from '${currentState}' to '${targetState}'`, allowedTransitions: allowed };
  }
  return { isValid: true };
}

/**
 * Executes a state transition and creates an audit log entry.
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function executeTransition(opts = {}) {
  const { invoiceId, currentState, targetState, actor, reason, ipAddress, userAgent, metadata } = opts;
  const validation = validateTransition({ invoiceId, currentState, targetState, actor, reason });
  if (!validation.isValid) {
    const err = new Error(validation.error || 'Invalid state transition');
    err.code = validation.code;
    err.allowedTransitions = validation.allowedTransitions;
    throw err;
  }

  const { createAuditLog } = require('./auditLog');
  const normalizedReason = normalizeTransitionReason(reason);
  const auditLog = await createAuditLog({
    actor,
    action: 'STATE_TRANSITION',
    resourceType: 'invoice',
    resourceId: invoiceId,
    before: { state: currentState },
    after: { state: targetState },
    ipAddress: ipAddress || 'unknown',
    userAgent: userAgent || 'unknown',
    metadata: {
      reason: normalizedReason,
      transitionType: `${currentState}_to_${targetState}`,
      ...(metadata || {}),
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
 * Retrieves the transition history for an invoice from audit logs.
 * @param {string} invoiceId
 * @returns {Promise<Array>}
 */
async function getTransitionHistory(invoiceId) {
  const { getAuditLogs } = require('./auditLog');
  const logs = await getAuditLogs({ resourceId: invoiceId, action: 'STATE_TRANSITION' });
  return logs.map((log) => ({
    fromState: (log.changes && log.changes.before && log.changes.before.state) || '',
    toState: (log.changes && log.changes.after && log.changes.after.state) || '',
    transitionedBy: log.actor,
    reason: (log.metadata && log.metadata.reason) || '',
    timestamp: log.timestamp,
  }));
}

/**
 * Checks whether an invoice can be linked to escrow.
 * @param {object|null} invoice
 * @returns {{ canLink: boolean, reason?: string }}
 */
function canLinkToEscrow(invoice) {
  if (!invoice) {
    return { canLink: false, reason: 'Invoice not found' };
  }
  if (invoice.status !== INVOICE_STATES.APPROVED) {
    return { canLink: false, reason: 'Invoice must be in approved state to link to escrow' };
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
  normalizeTransitionReason,
  executeTransition,
  getTransitionHistory,
  canLinkToEscrow,
};
