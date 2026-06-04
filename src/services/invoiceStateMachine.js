/**
 * Invoice State Machine Service
 * Manages invoice lifecycle transitions: pending → approved → linked_escrow
 * Enforces state transition rules and prevents silent jumps.
 * 
 * @module services/invoiceStateMachine
 */

const { createAuditLog } = require('./auditLog');
const logger = require('../logger');

/**
 * Valid invoice states in the lifecycle
 */
const INVOICE_STATES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  LINKED_ESCROW: 'linked_escrow',
  REJECTED: 'rejected', // Terminal state
  CANCELLED: 'cancelled', // Terminal state
};

/**
 * Valid state transitions
 * Maps current state to allowed next states
 */
const VALID_TRANSITIONS = {
  [INVOICE_STATES.PENDING]: [INVOICE_STATES.APPROVED, INVOICE_STATES.REJECTED, INVOICE_STATES.CANCELLED],
  [INVOICE_STATES.APPROVED]: [INVOICE_STATES.LINKED_ESCROW, INVOICE_STATES.CANCELLED],
  [INVOICE_STATES.LINKED_ESCROW]: [], // Terminal state - no transitions allowed
  [INVOICE_STATES.REJECTED]: [], // Terminal state
  [INVOICE_STATES.CANCELLED]: [], // Terminal state
};

/**
 * Terminal states that cannot transition further
 */
const TERMINAL_STATES = [
  INVOICE_STATES.LINKED_ESCROW,
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
];

const TERMINAL_REASON_REQUIRED_STATES = [
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
];

const MAX_TRANSITION_REASON_LENGTH = 1024;

function normalizeTransitionReason(reason) {
  if (reason === null || reason === undefined) {
    return null;
  }

  const value = typeof reason === 'string' ? reason : String(reason);
  const sanitized = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  return sanitized.length === 0 ? null : sanitized;
}

/**
 * Validates if a state is a valid invoice state
 * 
 * @param {string} state State to validate
 * @returns {boolean} True if valid
 */
function isValidState(state) {
  return Object.values(INVOICE_STATES).includes(state);
}

/**
 * Checks if a state transition is allowed
 * 
 * @param {string} fromState Current state
 * @param {string} toState Desired state
 * @returns {boolean} True if transition is allowed
 */
function isTransitionAllowed(fromState, toState) {
  if (!isValidState(fromState) || !isValidState(toState)) {
    return false;
  }

  const allowedTransitions = VALID_TRANSITIONS[fromState] || [];
  return allowedTransitions.includes(toState);
}

/**
 * Checks if a state is terminal (no further transitions allowed)
 * 
 * @param {string} state State to check
 * @returns {boolean} True if terminal
 */
function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Gets all allowed transitions from a given state
 * 
 * @param {string} fromState Current state
 * @returns {string[]} Array of allowed next states
 */
function getAllowedTransitions(fromState) {
  if (!isValidState(fromState)) {
    return [];
  }
  return VALID_TRANSITIONS[fromState] || [];
}

/**
 * Validates transition request and returns validation result
 * 
 * @param {Object} options Validation options
 * @param {string} options.invoiceId Invoice identifier
 * @param {string} options.currentState Current invoice state
 * @param {string} options.targetState Desired target state
 * @param {string} options.actor User performing the transition
 * @param {string} [options.reason] Reason for transition. Required for terminal transitions.
 * @returns {Object} Validation result with isValid and error
 */
function validateTransition({ invoiceId, currentState, targetState, actor, reason: _reason }) {
  // Validate required fields
  if (!invoiceId) {
    return {
      isValid: false,
      error: 'Invoice ID is required',
      code: 'MISSING_INVOICE_ID',
    };
  }

  if (!currentState) {
    return {
      isValid: false,
      error: 'Current state is required',
      code: 'MISSING_CURRENT_STATE',
    };
  }

  if (!targetState) {
    return {
      isValid: false,
      error: 'Target state is required',
      code: 'MISSING_TARGET_STATE',
    };
  }

  if (!actor) {
    return {
      isValid: false,
      error: 'Actor is required',
      code: 'MISSING_ACTOR',
    };
  }

  // Validate states are valid
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

  // Check if already in target state
  if (currentState === targetState) {
    return {
      isValid: false,
      error: `Invoice is already in state: ${targetState}`,
      code: 'ALREADY_IN_TARGET_STATE',
    };
  }

  const reason = normalizeTransitionReason(_reason);

  // Check if current state is terminal (must be before transition check)
  if (isTerminalState(currentState)) {
    return {
      isValid: false,
      error: `Cannot transition from terminal state: ${currentState}`,
      code: 'TERMINAL_STATE',
    };
  }

  // Require a validated reason for terminal target states
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

  // Check if transition is allowed
  if (!isTransitionAllowed(currentState, targetState)) {
    const allowed = getAllowedTransitions(currentState);
    return {
      isValid: false,
      error: `Invalid state transition from ${currentState} to ${targetState}. Allowed transitions: ${allowed.join(', ') || 'none'}`,
      code: 'INVALID_TRANSITION',
      allowedTransitions: allowed,
    };
  }

  return {
    isValid: true,
  };
}

/**
 * Executes a state transition with audit logging
 * 
 * @param {Object} options Transition options
 * @param {string} options.invoiceId Invoice identifier
 * @param {string} options.currentState Current invoice state
 * @param {string} options.targetState Desired target state
 * @param {string} options.actor User performing the transition
 * @param {string} [options.reason] Reason for transition
 * @param {string} [options.ipAddress] IP address of requester
 * @param {string} [options.userAgent] User agent of requester
 * @param {Object} [options.metadata] Additional metadata
 * @returns {Object} Transition result with success status and audit log
 * @throws {Error} If transition validation fails
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
  // Validate transition
  const validation = validateTransition({
    invoiceId,
    currentState,
    targetState,
    actor,
    reason,
  });

  if (!validation.isValid) {
    const error = new Error(validation.error);
    error.code = validation.code;
    error.allowedTransitions = validation.allowedTransitions;
    throw error;
  }

  const normalizedReason = normalizeTransitionReason(reason);

  // Create audit log for state transition
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
    transition: `${currentState} → ${targetState}`,
    reason,
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
 * Gets the state transition history for an invoice
 * 
 * @param {string} invoiceId Invoice identifier
 * @param {Function} getAuditLogsFn Function to retrieve audit logs
 * @returns {Array<Object>} Array of state transitions
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
 * Validates if an invoice can be linked to escrow
 * Additional business rules beyond state machine
 * 
 * @param {Object} invoice Invoice object
 * @returns {Object} Validation result
 */
function canLinkToEscrow(invoice) {
  if (!invoice) {
    return {
      canLink: false,
      reason: 'Invoice not found',
    };
  }

  if (invoice.status !== INVOICE_STATES.APPROVED) {
    return {
      canLink: false,
      reason: `Invoice must be in approved state. Current state: ${invoice.status}`,
    };
  }

  // Additional business rules can be added here
  // e.g., check if invoice amount is valid, due date is in future, etc.

  return {
    canLink: true,
  };
}

module.exports = {
  INVOICE_STATES,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  isValidState,
  isTransitionAllowed,
  isTerminalState,
  getAllowedTransitions,
  validateTransition,
  executeTransition,
  getTransitionHistory,
  canLinkToEscrow,
};
