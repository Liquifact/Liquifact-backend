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
 *
 * @invariant Returns `revision` from the underlying row so callers can supply it
 *   back on the next mutation — this closes the read-then-write race window by
 *   giving the client a token that must match the current optimistic-concurrency
 *   version before any state-changing write is allowed.
 *
 * @param {string} id       - Invoice identifier (public invoice_id).
 * @param {string} tenantId - Tenant identifier from middleware.
 * @returns {Promise<{invoiceId: string, currentState: string, allowedTransitions: string[], isTerminal: boolean, revision: number|undefined}>}
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
    // Expose the optimistic-concurrency revision so callers can supply it on the
    // next mutation.  Omitted (undefined) when the row pre-dates the versioning
    // migration so that legacy paths are not broken.
    revision: invoice.revision !== undefined ? invoice.revision : invoice.version,
  };
}

/**
 * Resolves an invoice for a tenant or throws the canonical not-found error.
 */
async function resolveInvoiceForMutation(id, tenantId) {
  const invoice = await invoiceService.resolveInvoiceForTenant(id, tenantId);
  if (!invoice) {
    throw new StateTransitionError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
  }
  return invoice;
}

/**
 * Ensures the requested target state is a valid transition from the invoice's
 * current state. All state-changing handlers go through this single guard so
 * transition rules are not duplicated across mutation paths.
 */
function assertTransitionAllowed(invoice, targetState) {
  const allowedTransitions = getAllowedTransitions(invoice.status);
  if (!allowedTransitions.includes(targetState)) {
    throw new StateTransitionError(
      `Transition from ${invoice.status} to ${targetState} is not allowed`,
      'INVALID_STATE_TRANSITION',
      400,
      { currentState: invoice.status, targetState }
    );
  }
}

/**
 * Executes a state transition.
 *
 * @invariant `revision` must match the invoice's current optimistic-concurrency
 *   version.  If it is omitted the call is forwarded without an expectedRevision
 *   guard so the underlying `transitionInvoice` applies its own CAS check.
 *   Callers that obtain `revision` from `getState` and supply it here are
 *   protected against concurrent writers: a stale revision is rejected with
 *   `STALE_REVISION` or `TRANSITION_CONFLICT` (409) before any side effects occur.
 *
 * @param {string}      id          - Invoice identifier.
 * @param {string}      tenantId    - Tenant identifier.
 * @param {string}      targetState - Desired target state.
 * @param {string}      [reason]    - Human-readable reason.
 * @param {number|string} [revision] - Optimistic-concurrency token from getState.
 * @param {object}      context     - Request context (actor, ipAddress, etc.).
 * @returns {Promise<object>} Transition result.
 */
async function transition(id, tenantId, targetState, reason, revision, context) {
  if (!targetState) {
    throw new StateTransitionError('Target state is required', 'MISSING_TARGET_STATE', 400);
  }

  const invoice = await resolveInvoiceForMutation(id, tenantId);
  assertTransitionAllowed(invoice, targetState);

  const result = await invoiceService.transitionInvoice(id, targetState, tenantId, {
    actor: context.actor,
    reason: reason,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: context.metadata,
    expectedRevision: revision !== undefined ? revision : invoice.revision,
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
 *
 * @invariant `revision` must match the invoice's current optimistic-concurrency
 *   version so two concurrent approvals cannot both succeed.  When omitted, the
 *   invoice's stored revision is used as the expected version.
 *
 * @param {string}      id       - Invoice identifier.
 * @param {string}      tenantId - Tenant identifier.
 * @param {string}      [reason] - Optional approval reason.
 * @param {number|string} [revision] - Optimistic-concurrency token from getState.
 * @param {object}      context  - Request context.
 * @returns {Promise<object>} Transition result.
 */
async function approve(id, tenantId, reason, revision, context) {
  const invoice = await resolveInvoiceForMutation(id, tenantId);
  assertTransitionAllowed(invoice, INVOICE_STATES.APPROVED);

  const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.APPROVED, tenantId, {
    actor: context.actor,
    reason: reason || 'Invoice approved',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: context.metadata,
    expectedRevision: revision !== undefined ? revision : invoice.revision,
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
 *
 * @invariant Invoice must be in `approved` state (enforced by `canLinkToEscrow`
 *   and `assertTransitionAllowed`). `revision` guards against concurrent
 *   escrow-link attempts from duplicate requests.
 *
 * @param {string}      id       - Invoice identifier.
 * @param {string}      tenantId - Tenant identifier.
 * @param {string}      [escrowId] - Escrow contract identifier.
 * @param {string}      [reason]   - Optional reason.
 * @param {number|string} [revision] - Optimistic-concurrency token from getState.
 * @param {object}      context    - Request context.
 * @returns {Promise<object>} Transition result.
 */
async function linkEscrow(id, tenantId, escrowId, reason, revision, context) {
  const invoice = await resolveInvoiceForMutation(id, tenantId);

  const linkValidation = canLinkToEscrow(invoice);
  if (!linkValidation.canLink) {
    throw new StateTransitionError(linkValidation.reason, 'CANNOT_LINK_TO_ESCROW', 400);
  }

  assertTransitionAllowed(invoice, INVOICE_STATES.LINKED_ESCROW);

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
    expectedRevision: revision !== undefined ? revision : invoice.revision,
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
 *
 * @invariant Reason is mandatory for the `rejected` terminal state so there is
 *   always a traceable justification in the audit log.  `revision` prevents two
 *   concurrent rejection calls from both succeeding — only the writer whose
 *   token matches the current version wins.
 *
 * @param {string}      id       - Invoice identifier.
 * @param {string}      tenantId - Tenant identifier.
 * @param {string}      reason   - Mandatory rejection reason.
 * @param {number|string} [revision] - Optimistic-concurrency token from getState.
 * @param {object}      context  - Request context.
 * @returns {Promise<object>} Transition result.
 */
async function reject(id, tenantId, reason, revision, context) {
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new StateTransitionError('Reason is required for rejection', 'MISSING_TRANSITION_REASON', 400);
  }

  const invoice = await resolveInvoiceForMutation(id, tenantId);
  assertTransitionAllowed(invoice, INVOICE_STATES.REJECTED);

  const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.REJECTED, tenantId, {
    actor: context.actor,
    reason,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: context.metadata,
    expectedRevision: revision !== undefined ? revision : invoice.revision,
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
    let revision;

    try {
      const payload = item || {};
      ({ invoiceId, action, reason, escrowId, targetState, revision } = payload);

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
          result = await approve(invoiceId.trim(), tenantId, reason, revision, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'reject': {
          result = await reject(invoiceId.trim(), tenantId, reason, revision, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'link-escrow': {
          result = await linkEscrow(invoiceId.trim(), tenantId, escrowId || null, reason, revision, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'transition': {
          if (!targetState || typeof targetState !== 'string' || targetState.trim().length === 0) {
            throw Object.assign(new Error('targetState is required for transition action'), { code: 'MISSING_TARGET_STATE' });
          }
          result = await transition(invoiceId.trim(), tenantId, targetState.trim(), reason, revision, context);
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
