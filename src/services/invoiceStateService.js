'use strict';

const {
  INVOICE_STATES,
  getAllowedTransitions,
  getTransitionHistory,
  canLinkToEscrow,
} = require('./invoiceStateMachine');
const invoiceService = require('./invoiceService');
const { getAuditLogs } = require('./auditLog');

/**
 * Custom error class for state transition errors.
 */
class StateTransitionError extends Error {
  constructor(message, code, statusCode = 400, details = null) {
    super(message);
    this.name = 'StateTransitionError';
    this.code = code;
    this.statusCode = statusCode;
    if (details) {
      Object.assign(this, details);
    }
  }
}

/**
 * Retrieves the current state and allowed transitions for an invoice.
 */
async function getState(id, tenantId) {
  const invoice = await invoiceService.resolveInvoiceForTenant(id, tenantId);
  if (!invoice) {
    throw new StateTransitionError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
  }

  const currentState = invoice.status;
  const allowedTransitions = getAllowedTransitions(currentState);

  return {
    invoiceId: id,
    currentState,
    allowedTransitions,
    isTerminal: allowedTransitions.length === 0,
  };
}

/**
 * Executes a state transition.
 */
async function transition(id, tenantId, targetState, reason, context) {
  if (!targetState) {
    throw new StateTransitionError('Target state is required', 'MISSING_TARGET_STATE', 400);
  }

  const result = await invoiceService.transitionInvoice(id, targetState, tenantId, {
    actor: context.actor,
    reason: reason,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: context.metadata,
  });

  return {
    invoiceId: id,
    previousState: result.previousState,
    currentState: result.newState,
    transitionedAt: result.transitionedAt,
    transitionedBy: result.transitionedBy,
    reason,
    auditLogId: result.auditLog.id,
  };
}

/**
 * Approves an invoice.
 */
async function approve(id, tenantId, reason, context) {
  const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.APPROVED, tenantId, {
    actor: context.actor,
    reason: reason || 'Invoice approved',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: context.metadata,
  });

  return {
    invoiceId: id,
    previousState: result.previousState,
    currentState: result.newState,
    transitionedAt: result.transitionedAt,
    transitionedBy: result.transitionedBy,
    reason,
    auditLogId: result.auditLog.id,
  };
}

/**
 * Links an approved invoice to escrow.
 */
async function linkEscrow(id, tenantId, escrowId, reason, context) {
  const invoice = await invoiceService.resolveInvoiceForTenant(id, tenantId);
  if (!invoice) {
    throw new StateTransitionError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
  }

  const linkValidation = canLinkToEscrow(invoice);
  if (!linkValidation.canLink) {
    throw new StateTransitionError(linkValidation.reason, 'CANNOT_LINK_TO_ESCROW', 400);
  }

  const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.LINKED_ESCROW, tenantId, {
    actor: context.actor,
    reason: reason || 'Invoice linked to escrow',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    escrowId: escrowId || null,
    metadata: {
      ...context.metadata,
      escrowId: escrowId || 'pending',
    },
  });

  return {
    invoiceId: id,
    previousState: result.previousState,
    currentState: result.newState,
    escrowId: escrowId || null,
    transitionedAt: result.transitionedAt,
    transitionedBy: result.transitionedBy,
    auditLogId: result.auditLog.id,
  };
}

/**
 * Rejects an invoice.
 */
async function reject(id, tenantId, reason, context) {
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new StateTransitionError('Reason is required for rejection', 'MISSING_TRANSITION_REASON', 400);
  }

  const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.REJECTED, tenantId, {
    actor: context.actor,
    reason,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: context.metadata,
  });

  return {
    invoiceId: id,
    previousState: result.previousState,
    currentState: result.newState,
    reason,
    transitionedAt: result.transitionedAt,
    transitionedBy: result.transitionedBy,
    auditLogId: result.auditLog.id,
  };
}

/**
 * Retrieves the state-transition history for an invoice.
 */
async function getHistory(id, tenantId) {
  const invoice = await invoiceService.resolveInvoiceForTenant(id, tenantId);
  if (!invoice) {
    throw new StateTransitionError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
  }

  const history = await getTransitionHistory(id, getAuditLogs);

  return {
    invoiceId: id,
    currentState: invoice.status,
    transitions: history,
    totalTransitions: history.length,
  };
}

module.exports = {
  StateTransitionError,
  getState,
  transition,
  approve,
  linkEscrow,
  reject,
  getHistory,
};
