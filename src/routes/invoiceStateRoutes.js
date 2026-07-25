/**
 * Invoice State Transition Routes
 * Handles invoice lifecycle state transitions with audit logging.
 *
 * Invoices are resolved and persisted through invoiceService (Knex), scoped
 * to the authenticated tenant from extractTenant middleware. Status is never
 * taken from the client â€” it is always derived from the state machine result
 * of a validated transition.
 *
 * The capital-movement link-escrow route is protected by the KYC gate.
 *
 * @module routes/invoiceStateRoutes
 */

'use strict';

const express = require('express');
const router = express.Router();
const {
  INVOICE_STATES,
  getAllowedTransitions,
  getTransitionHistory,
  canLinkToEscrow,
} = require('../services/invoiceStateMachine');
const invoiceService = require('../services/invoiceService');
const { getAuditLogs } = require('../services/auditLog');
const { requireKycForFunding, auditKycAccess } = require('../middleware/kycGating');
const { authenticatedTenantStack } = require('../middleware/stacks');
const responseHelper = require('../utils/responseHelper');

router.use(...authenticatedTenantStack);

// Per-client (API key / IP) rate limit on the invoice-state endpoints (#739).
const { invoiceStateLimiter } = require('../middleware/rateLimit');
router.use(invoiceStateLimiter);

/**
 * Resolves the acting principal identifier from the authenticated request.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} Actor identifier.
 */
function getActorFromRequest(req) {
  if (req.user && req.user.id) {
    return req.user.id;
  }
  if (req.user && req.user.sub) {
    return req.user.sub;
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Sends a standardized 404 when an invoice is unknown or belongs to another tenant.
 *
 * @param {import('express').Response} res - Express response object.
 * @returns {import('express').Response} The 404 response.
 */
function sendInvoiceNotFound(res) {
  return res.status(404).json(responseHelper.error('Invoice not found', 'INVOICE_NOT_FOUND'));
}

/**
 * Sends a standardized error envelope for state-machine validation failures.
 *
 * @param {import('express').Response} res - Express response object.
 * @param {Error & {code?: string, allowedTransitions?: string[], statusCode?: number}} error - The thrown error.
 * @returns {import('express').Response} The error response.
 */
function sendTransitionError(res, error) {
  const status = error.statusCode || 400;
  const details = error.allowedTransitions ? { allowedTransitions: error.allowedTransitions } : null;

  return res.status(status).json(responseHelper.error(error.message, error.code, details));
}

/**
 * GET /api/invoices/:id/state
 * Returns the current state and allowed transitions for an invoice.
 */
router.get('/:id/state', async (req, res, next) => {
  const { id } = req.params;

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

    if (!invoice) {
      return sendInvoiceNotFound(res);
    }

    const currentState = invoice.status;
    const allowedTransitions = getAllowedTransitions(currentState);

    return res.json({
      ...responseHelper.success({
        invoiceId: id,
        currentState,
        allowedTransitions,
        isTerminal: allowedTransitions.length === 0,
      }),
      message: 'Invoice state retrieved successfully',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/invoices/:id/transition
 * Executes a state transition and persists the resulting state.
 *
 * Request body: { "targetState": "approved", "reason": "..." }
 */
router.post('/:id/transition', async (req, res, next) => {
  const { id } = req.params;
  const { targetState, reason } = req.body || {};

  try {
    if (!targetState) {
      return res.status(400).json(
        responseHelper.error('Target state is required', 'MISSING_TARGET_STATE'),
      );
    }

    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, targetState, req.tenantId, {
      actor,
      reason,
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        reason,
        auditLogId: result.auditLog.id,
      }),
      message: `Invoice transitioned from ${result.previousState} to ${result.newState}`,
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

/**
 * POST /api/invoices/:id/approve
 * Convenience endpoint to approve a pending invoice.
 */
router.post('/:id/approve', async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  try {
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.APPROVED, req.tenantId, {
      actor,
      reason: reason || 'Invoice approved',
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
        action: 'approve',
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      }),
      message: 'Invoice approved successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

/**
 * POST /api/invoices/:id/link-escrow
 * Links an approved invoice to escrow. This is a capital-movement endpoint
 * gated on the caller's SME holding a verified/exempted KYC status.
 */
router.post('/:id/link-escrow', requireKycForFunding, auditKycAccess, async (req, res, next) => {
  const { id } = req.params;
  const { escrowId, reason } = req.body || {};

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

    if (!invoice) {
      return sendInvoiceNotFound(res);
    }

    const linkValidation = canLinkToEscrow(invoice);
    if (!linkValidation.canLink) {
      return res.status(400).json(
        responseHelper.error(linkValidation.reason, 'CANNOT_LINK_TO_ESCROW'),
      );
    }

    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.LINKED_ESCROW, req.tenantId, {
      actor,
      reason: reason || 'Invoice linked to escrow',
      ipAddress,
      userAgent,
      escrowId: escrowId || null,
      metadata: {
        method: req.method,
        path: req.path,
        action: 'link-escrow',
        escrowId: escrowId || 'pending',
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        escrowId: escrowId || null,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      }),
      message: 'Invoice linked to escrow successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

/**
 * POST /api/invoices/:id/reject
 * Convenience endpoint to reject an invoice. Requires a non-empty reason.
 */
router.post('/:id/reject', async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  try {
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json(
        responseHelper.error('Reason is required for rejection', 'MISSING_TRANSITION_REASON'),
      );
    }

    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.REJECTED, req.tenantId, {
      actor,
      reason,
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
        action: 'reject',
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        reason,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      }),
      message: 'Invoice rejected successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

/**
 * GET /api/invoices/:id/history
 * Returns the state-transition history for an invoice.
 */
router.get('/:id/history', async (req, res, next) => {
  const { id } = req.params;

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

    if (!invoice) {
      return sendInvoiceNotFound(res);
    }

    const history = await getTransitionHistory(id, getAuditLogs);

    return res.json({
      ...responseHelper.success({
        invoiceId: id,
        currentState: invoice.status,
        transitions: history,
        totalTransitions: history.length,
      }),
      message: 'Invoice transition history retrieved successfully',
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;