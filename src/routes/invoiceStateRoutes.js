'use strict';

const express = require('express');
const router = express.Router();
const invoiceStateService = require('../services/invoiceStateService');
const { requireKycForFunding, auditKycAccess } = require('../middleware/kycGating');
const { extractTenant } = require('../middleware/tenant');
const responseHelper = require('../utils/responseHelper');

router.use(extractTenant);

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