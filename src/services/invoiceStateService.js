'use strict';

const {
  INVOICE_STATES,
  getAllowedTransitions,
  getTransitionHistory,
  canLinkToEscrow,
} = require('./invoiceStateMachine');
const invoiceService = require('./invoiceService');
const { getAuditLogs } = require('./auditLog');
const logger = require('../logger');

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

/** Maximum number of operations accepted in a single bulk batch. */
const MAX_BULK_ITEMS = 25;

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

/**
 * Processes a bounded batch of invoice-state operations sequentially,
 * collecting a per-item success/error result instead of failing the whole
 * batch when a single item errors.
 *
 * Extracted from the `POST /api/invoices/bulk` route handler (#1113) so the
 * batch-size rule, per-item validation, and action dispatch are
 * unit-testable directly, without going through HTTP/Express at all. The
 * route handler is now a thin wrapper: parse the body, call this function,
 * translate the result (or a thrown `StateTransitionError`) into an HTTP
 * response.
 *
 * @param {Array<object>} items - Raw batch payload; each item is expected to
 *   have `invoiceId`, `action` (`'approve'|'reject'|'link-escrow'|'transition'`),
 *   and action-specific fields (`reason`, `escrowId`, `targetState`).
 * @param {string} tenantId - Tenant identifier, applied to every item.
 * @param {object} baseContext - Context built once from the request (see
 *   `routes/invoiceStateRoutes.js`'s `buildContext`) — `actor`,
 *   `correlationId`, `ipAddress`, `userAgent`, and a `metadata` object
 *   (typically `{ method, path }`). Per-item `action`/`bulkIndex` are merged
 *   into a shallow copy of `metadata` for each item; `baseContext` itself is
 *   never mutated.
 * @returns {Promise<{results: Array<object>, summary: {total: number, succeeded: number, failed: number}}>}
 * @throws {StateTransitionError} `EMPTY_BATCH` if `items` is empty, or
 *   `BATCH_OVER_CAP` if `items.length` exceeds {@link MAX_BULK_ITEMS}.
 */
async function processBulkOperations(items, tenantId, baseContext) {
  if (items.length === 0) {
    throw new StateTransitionError('Batch must contain at least one invoice-state operation', 'EMPTY_BATCH', 400);
  }
  if (items.length > MAX_BULK_ITEMS) {
    throw new StateTransitionError(`Batch size exceeds maximum of ${MAX_BULK_ITEMS}`, 'BATCH_OVER_CAP', 400);
  }

  const results = [];

  for (const [index, item] of items.entries()) {
    let invoiceId;
    let action;
    let reason;
    let escrowId;
    let targetState;

    try {
      const payload = item || {};
      ({ invoiceId, action, reason, escrowId, targetState } = payload);

      if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim().length === 0) {
        throw Object.assign(new Error('invoiceId is required and must be a non-empty string'), { code: 'MISSING_INVOICE_ID' });
      }

      if (!action || typeof action !== 'string') {
        throw Object.assign(new Error('action is required and must be a string'), { code: 'MISSING_ACTION' });
      }

      const context = {
        ...baseContext,
        metadata: { ...baseContext.metadata, action, bulkIndex: index },
      };
      let result;

      switch (action) {
        case 'approve': {
          result = await approve(invoiceId.trim(), tenantId, reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'reject': {
          result = await reject(invoiceId.trim(), tenantId, reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'link-escrow': {
          result = await linkEscrow(invoiceId.trim(), tenantId, escrowId || null, reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'transition': {
          if (!targetState || typeof targetState !== 'string' || targetState.trim().length === 0) {
            throw Object.assign(new Error('targetState is required for transition action'), { code: 'MISSING_TARGET_STATE' });
          }
          result = await transition(invoiceId.trim(), tenantId, targetState.trim(), reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        default: {
          throw Object.assign(new Error(`Unknown action: ${action}`), { code: 'INVALID_ACTION' });
        }
      }
    } catch (error) {
      // Structured, PII-safe log: bounded index/action/code only — no
      // invoiceId, error message, or stack trace.
      logger.warn({ index, action, code: error.code || 'BULK_ITEM_ERROR' }, 'invoice-state bulk item failed');
      results.push({
        index,
        success: false,
        error: error.message,
        code: error.code || 'BULK_ITEM_ERROR',
      });
    }
  }

  const summary = {
    total: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
  };

  return { results, summary };
}

module.exports = {
  StateTransitionError,
  MAX_BULK_ITEMS,
  getState,
  transition,
  approve,
  linkEscrow,
  reject,
  getHistory,
  processBulkOperations,
};
