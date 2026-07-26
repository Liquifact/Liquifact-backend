'use strict';

const express = require('express');
const router = express.Router();
const invoiceStateService = require('../services/invoiceStateService');
const { requireKycForFunding, auditKycAccess } = require('../middleware/kycGating');
const { authenticatedTenantStack } = require('../middleware/stacks');
const responseHelper = require('../utils/responseHelper');
const {
  mapTransitionRequest,
  mapApproveRequest,
  mapLinkEscrowRequest,
  mapRejectRequest,
  toInvoiceStateResponse,
  toTransitionResponse,
  toLinkEscrowResponse,
  toInvoiceHistoryResponse,
} = require('../dtos/invoiceStateDtos');

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
 * Builds the context object from the request.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {Object} additionalMetadata - Extra metadata to include.
 * @returns {Object} Context object.
 */
function buildContext(req, additionalMetadata = {}) {
  return {
    actor: getActorFromRequest(req),
    ipAddress: req.ip || (req.socket && req.socket.remoteAddress) || 'unknown',
    userAgent: req.get('user-agent') || 'unknown',
    metadata: {
      method: req.method,
      path: req.path,
      ...additionalMetadata,
    },
  };
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
  try {
    const result = await invoiceStateService.getState(req.params.id, req.tenantId);

    return res.json({
      ...responseHelper.success(result),
      message: 'Invoice state retrieved successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
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
router.post('/:id/transition', async (req, res, next) => {
  const { id } = req.params;
  const { targetState, reason } = mapTransitionRequest(req.body);

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

    const responseDto = toTransitionResponse({ invoiceId: id, result, reason });
    return res.status(200).json({
      ...responseHelper.success(responseDto),
      message: `Invoice transitioned from ${result.previousState} to ${result.newState}`,
    });
  } catch (err) {
    sendTransitionError(res, err);
  }
});

/**
 * POST /api/invoices/:id/approve
 * Convenience endpoint to approve an invoice.
 */
router.post('/:id/approve', async (req, res, next) => {
  const { id } = req.params;
  const { reason } = mapApproveRequest(req.body);

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

    const responseDto = toTransitionResponse({ invoiceId: id, result });
    return res.status(200).json({
      ...responseHelper.success(responseDto),
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
router.post('/:id/link-escrow', requireKycForFunding, auditKycAccess, async (req, res, next) => {
  const { id } = req.params;
  const { escrowId, reason } = mapLinkEscrowRequest(req.body);

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

    const responseDto = toLinkEscrowResponse({ invoiceId: id, result, escrowId });
    return res.status(200).json({
      ...responseHelper.success(responseDto),
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
router.post('/:id/reject', async (req, res, next) => {
  const { id } = req.params;
  const { reason } = mapRejectRequest(req.body);

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

    const responseDto = toTransitionResponse({ invoiceId: id, result, reason });
    return res.status(200).json({
      ...responseHelper.success(responseDto),
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
router.get('/:id/history', async (req, res, next) => {
  const { id } = req.params;

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

    if (!invoice) {
      return sendInvoiceNotFound(res);
    }

    const transitions = await getTransitionHistory(id, getAuditLogs);
    const historyDto = toInvoiceHistoryResponse({
      invoiceId: id,
      currentState: invoice.status,
      transitions,
    });

    return res.json({
      ...responseHelper.success(historyDto),
      message: 'Invoice transition history retrieved successfully',
    });
  } catch (error) {
    return next(error);
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

/**
 * POST /api/invoices/:id/transition
 * Executes a state transition and persists the resulting state.
 *
 * Request body: { "targetState": "approved", "reason": "..." }
 */
router.post('/:id/transition', async (req, res, next) => {
  const { targetState, reason } = req.body || {};

  try {
    const context = buildContext(req);
    const result = await invoiceStateService.transition(req.params.id, req.tenantId, targetState, reason, context);

    return res.status(200).json({
      ...responseHelper.success(result),
      message: `Invoice transitioned from ${result.previousState} to ${result.currentState}`,
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
  const { reason } = req.body || {};

  try {
    const context = buildContext(req, { action: 'approve' });
    const result = await invoiceStateService.approve(req.params.id, req.tenantId, reason, context);

    return res.status(200).json({
      ...responseHelper.success(result),
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
  const { escrowId, reason } = req.body || {};

  try {
    const context = buildContext(req, {
      action: 'link-escrow',
      escrowId: escrowId || 'pending',
    });
    const result = await invoiceStateService.linkEscrow(req.params.id, req.tenantId, escrowId, reason, context);

    return res.status(200).json({
      ...responseHelper.success(result),
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
  const { reason } = req.body || {};

  try {
    const context = buildContext(req, { action: 'reject' });
    const result = await invoiceStateService.reject(req.params.id, req.tenantId, reason, context);

    return res.status(200).json({
      ...responseHelper.success(result),
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
  try {
    const result = await invoiceStateService.getHistory(req.params.id, req.tenantId);

    return res.json({
      ...responseHelper.success(result),
      message: 'Invoice transition history retrieved successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

module.exports = router;
