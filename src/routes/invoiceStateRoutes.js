'use strict';

const express = require('express');
const router = express.Router();
const invoiceService = require('../services/invoiceService');
const {
  getAllowedTransitions,
  isTerminalState,
  canLinkToEscrow,
  getTransitionHistory,
} = require('../services/invoiceStateMachine');
const { getAuditLogs } = require('../services/auditLog');
const { requireKycForFunding, auditKycAccess } = require('../middleware/kycGating');
const { authenticatedTenantStack } = require('../middleware/stacks');
const responseHelper = require('../utils/responseHelper');

router.use(...authenticatedTenantStack);

// Per-client (API key / IP) rate limit on the invoice-state endpoints (#739).
const { invoiceStateLimiter } = require('../middleware/rateLimit');
router.use(invoiceStateLimiter);

/**
 * Sends a structured error response using a validation error object.
 * @param {import('express').Response} res - Express response.
 * @param {object} errObj - Error object with statusCode and error sub-object.
 * @returns {void}
 */
function sendValidationError(res, errObj) {
  res.status(errObj.statusCode).json({ error: errObj.error });
}

/**
 * Sends a structured error response from a thrown exception.
 * @param {import('express').Response} res - Express response.
 * @param {Error} err - Caught exception with optional code, statusCode, and allowedTransitions.
 * @returns {void}
 */
function sendTransitionError(res, err) {
  const knownCodes = new Set([
    'MISSING_INVOICE_ID',
    'MISSING_CURRENT_STATE',
    'MISSING_TARGET_STATE',
    'MISSING_ACTOR',
    'INVALID_CURRENT_STATE',
    'INVALID_TARGET_STATE',
    'ALREADY_IN_TARGET_STATE',
    'TERMINAL_STATE',
    'MISSING_TRANSITION_REASON',
    'TRANSITION_REASON_TOO_LONG',
    'INVALID_TRANSITION',
    'INVOICE_NOT_FOUND',
    'CANNOT_LINK_TO_ESCROW',
    'LOCKED_STATUS',
  ]);

  const isKnownError = err.code && knownCodes.has(err.code);
  const statusCode = err.statusCode || (isKnownError ? 400 : 500);
  const code = isKnownError ? err.code : 'INTERNAL_ERROR';

  const error = {
    code,
    message: err.message || 'An unexpected error occurred.',
  };
  if (isKnownError && err.allowedTransitions) {
    error.details = { allowedTransitions: err.allowedTransitions };
  }
  res.status(statusCode).json({ error });
}

/**
 * Extracts the actor identifier from the request object.
 * @param {import('express').Request} req - Express request.
 * @returns {string} Actor identifier.
 */
function getActor(req) {
  return (req.user && (req.user.id || req.user.sub)) || 'anonymous';
}

/**
 * GET /api/invoices/:id/state
 * Returns the current state and allowed transitions for an invoice.
 */
router.get('/:id/state', async (req, res) => {
  const ctx = await resolveInvoiceStateContext(req, req.params.id);
  if (ctx.error) {
    return sendValidationError(res, ctx.error);
  }

  const { invoiceId, invoice } = ctx;
  const currentState = invoice.status;
  const allowedTransitions = getAllowedTransitions(currentState);

  res.json({
    data: {
      invoiceId,
      currentState,
      allowedTransitions,
      isTerminal: isTerminalState(currentState),
    },
  });
});

/**
 * POST /api/invoices/:id/transition
 * Executes a state transition to the requested target state.
 */
router.post('/:id/transition', async (req, res) => {
  const ctx = await resolveInvoiceStateContext(req, req.params.id);
  if (ctx.error) {
    return sendValidationError(res, ctx.error);
  }

  const { invoiceId, tenantId } = ctx;
  const { targetState, reason } = req.body;

  try {
    const result = await invoiceService.transitionInvoice(
      invoiceId,
      targetState,
      tenantId,
      {
        actor: getActor(req),
        reason,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      },
    );

    res.json({
      data: {
        invoiceId,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        reason: (result.auditLog && result.auditLog.metadata && result.auditLog.metadata.reason) || reason || null,
        auditLogId: (result.auditLog && result.auditLog.id) || null,
      },
      message: 'Invoice transitioned successfully',
    });
  } catch (err) {
    sendTransitionError(res, err);
  }
});

/**
 * POST /api/invoices/:id/approve
 * Convenience endpoint to approve an invoice.
 */
router.post('/:id/approve', async (req, res) => {
  const ctx = await resolveInvoiceStateContext(req, req.params.id);
  if (ctx.error) {
    return sendValidationError(res, ctx.error);
  }

  const { invoiceId, tenantId } = ctx;
  const { reason } = req.body;

  try {
    const result = await invoiceService.transitionInvoice(
      invoiceId,
      'approved',
      tenantId,
      {
        actor: getActor(req),
        reason,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      },
    );

    res.json({
      data: {
        invoiceId,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        reason: (result.auditLog && result.auditLog.metadata && result.auditLog.metadata.reason) || reason || null,
        auditLogId: (result.auditLog && result.auditLog.id) || null,
      },
      message: 'Invoice approved successfully',
    });
  } catch (err) {
    sendTransitionError(res, err);
  }
});

/**
 * POST /api/invoices/:id/link-escrow
 * Convenience endpoint to link an approved invoice to an escrow contract.
 */
router.post('/:id/link-escrow', async (req, res) => {
  const ctx = await resolveInvoiceStateContext(req, req.params.id);
  if (ctx.error) {
    return sendValidationError(res, ctx.error);
  }

  const { invoiceId, tenantId, invoice } = ctx;
  const { escrowId, reason } = req.body;

  const linkCheck = canLinkToEscrow(invoice);
  if (!linkCheck.canLink) {
    const errObj = buildInvoiceStateError('CANNOT_LINK_TO_ESCROW', linkCheck.reason || 'Invoice cannot be linked to escrow.', 400);
    return sendValidationError(res, errObj);
  }

  try {
    const result = await invoiceService.transitionInvoice(
      invoiceId,
      'linked_escrow',
      tenantId,
      {
        actor: getActor(req),
        reason,
        escrowId: escrowId || null,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      },
    );

    res.json({
      data: {
        invoiceId,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        escrowId: escrowId || null,
        reason: (result.auditLog && result.auditLog.metadata && result.auditLog.metadata.reason) || reason || null,
        auditLogId: (result.auditLog && result.auditLog.id) || null,
      },
      message: 'Invoice linked to escrow successfully',
    });
  } catch (err) {
    sendTransitionError(res, err);
  }
});

/**
 * POST /api/invoices/:id/reject
 * Convenience endpoint to reject an invoice.
 */
router.post('/:id/reject', async (req, res) => {
  const ctx = await resolveInvoiceStateContext(req, req.params.id);
  if (ctx.error) {
    return sendValidationError(res, ctx.error);
  }

  const { invoiceId, tenantId } = ctx;
  const { reason } = req.body;

  try {
    const result = await invoiceService.transitionInvoice(
      invoiceId,
      'rejected',
      tenantId,
      {
        actor: getActor(req),
        reason,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      },
    );

    res.json({
      data: {
        invoiceId,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        reason: (result.auditLog && result.auditLog.metadata && result.auditLog.metadata.reason) || reason || null,
        auditLogId: (result.auditLog && result.auditLog.id) || null,
      },
      message: 'Invoice rejected successfully',
    });
  } catch (err) {
    sendTransitionError(res, err);
  }
});

/**
 * GET /api/invoices/:id/history
 * Returns the transition history for an invoice.
 */
router.get('/:id/history', async (req, res) => {
  const ctx = await resolveInvoiceStateContext(req, req.params.id);
  if (ctx.error) {
    return sendValidationError(res, ctx.error);
  }

  const { invoiceId, invoice } = ctx;
  const transitions = await getTransitionHistory(invoiceId, getAuditLogs);

  res.json({
    data: {
      invoiceId,
      currentState: invoice.status,
      transitions,
      totalTransitions: transitions.length,
    },
  });
});

module.exports = router;
