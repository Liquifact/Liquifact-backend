/**
 * Invoice State Transition Routes
 * Handles invoice lifecycle state transitions with audit logging.
 *
 * Capital-movement routes are protected by the KYC gate:
 *   - POST /:id/link-escrow   — initiates escrow funding lifecycle
 *   - POST /:id/transition     — when targetState is 'funded' or 'settled'
 *
 * @module routes/invoiceStateRoutes
 */

const express = require('express');
const router = express.Router();
const {
  INVOICE_STATES,
  executeTransition,
  getAllowedTransitions,
  getTransitionHistory,
  canLinkToEscrow,
} = require('../services/invoiceStateMachine');
const { getAuditLogs } = require('../services/auditLog');
const { requireKycForFunding } = require('../middleware/kycGating');

/**
 * States that initiate or settle capital movement and therefore require
 * the caller to be KYC-verified before transitioning to them.
 */
const CAPITAL_MOVING_STATES = new Set([
  'funded',
  'settled',
  INVOICE_STATES.FUNDED,
  INVOICE_STATES.SETTLED,
].filter(Boolean));

/**
 * Helper to extract actor from request
 * In production, this would come from JWT middleware
 * 
 * @param {import('express').Request} req Express request object
 * @returns {string} Actor identifier
 */
function getActorFromRequest(req) {
  if (req.user && req.user.id) {
    return req.user.id;
  }
  if (req.user && req.user.sub) {
    return req.user.sub;
  }
  // Fallback to IP for unauthenticated requests (should not happen in production)
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Mock invoice database
 * In production, this would be replaced with actual database queries
 */
const mockInvoices = new Map([
  ['inv-001', { id: 'inv-001', status: 'pending', amount: 1000, customer: 'Acme Corp' }],
  ['inv-002', { id: 'inv-002', status: 'approved', amount: 2000, customer: 'TechCo' }],
  ['inv-003', { id: 'inv-003', status: 'linked_escrow', amount: 5000, customer: 'GlobalInc' }],
]);

/**
 * GET /api/invoices/:id/state
 * Get current state and allowed transitions for an invoice
 */
router.get('/:id/state', (req, res) => {
  const { id } = req.params;

  // Get invoice from database
  const invoice = mockInvoices.get(id);

  if (!invoice) {
    return res.status(404).json({
      error: 'Invoice not found',
      code: 'INVOICE_NOT_FOUND',
    });
  }

  const currentState = invoice.status;
  const allowedTransitions = getAllowedTransitions(currentState);

  res.json({
    data: {
      invoiceId: id,
      currentState,
      allowedTransitions,
      isTerminal: allowedTransitions.length === 0,
    },
    message: 'Invoice state retrieved successfully',
  });
});

/**
 * POST /api/invoices/:id/transition
 * Execute a state transition
 * 
 * Request body:
 * {
 *   "targetState": "approved",
 *   "reason": "Invoice verified and approved by finance team"
 * }
 */
/**
 * KYC gate selector for transition endpoint.
 * Runs `requireKycForFunding` only when the requested targetState is a
 * capital-moving state; passes through for non-capital transitions.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function conditionalKycGate(req, res, next) {
  const { targetState } = req.body || {};
  if (targetState && CAPITAL_MOVING_STATES.has(targetState)) {
    return requireKycForFunding(req, res, next);
  }
  return next();
}

router.post('/:id/transition', conditionalKycGate, async (req, res, next) => {
  const { id } = req.params;
  const { targetState, reason } = req.body;

  try {
    // Validate request body
    if (!targetState) {
      return res.status(400).json({
        error: 'Target state is required',
        code: 'MISSING_TARGET_STATE',
      });
    }

    // Get invoice from database
    const invoice = mockInvoices.get(id);

    if (!invoice) {
      return res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    // Execute transition
    const result = await executeTransition({
      invoiceId: id,
      currentState,
      targetState,
      actor,
      reason,
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
      },
    });

    // Update invoice in database
    invoice.status = targetState;
    invoice.updatedAt = new Date().toISOString();
    invoice.updatedBy = actor;

    res.status(200).json({
      data: {
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        reason,
        auditLogId: result.auditLog.id,
      },
      message: `Invoice transitioned from ${result.previousState} to ${result.newState}`,
    });
  } catch (error) {
    // Handle validation errors
    if (error.code) {
      return res.status(400).json({
        error: error.message,
        code: error.code,
        allowedTransitions: error.allowedTransitions,
      });
    }

    // Pass unexpected errors to error handler
    next(error);
  }
});

/**
 * POST /api/invoices/:id/approve
 * Convenience endpoint to approve an invoice
 */
router.post('/:id/approve', async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const invoice = mockInvoices.get(id);

    if (!invoice) {
      return res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await executeTransition({
      invoiceId: id,
      currentState,
      targetState: INVOICE_STATES.APPROVED,
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

    invoice.status = INVOICE_STATES.APPROVED;
    invoice.updatedAt = new Date().toISOString();
    invoice.updatedBy = actor;

    res.status(200).json({
      data: {
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      },
      message: 'Invoice approved successfully',
    });
  } catch (error) {
    if (error.code) {
      return res.status(400).json({
        error: error.message,
        code: error.code,
        allowedTransitions: error.allowedTransitions,
      });
    }
    next(error);
  }
});

/**
 * POST /api/invoices/:id/link-escrow
 * Link an approved invoice to escrow.
 *
 * This is a capital-movement endpoint: it initiates the escrow funding
 * lifecycle. KYC must be verified before the link can be made.
 */
router.post('/:id/link-escrow', requireKycForFunding, async (req, res, next) => {
  const { id } = req.params;
  const { escrowId, reason } = req.body;

  try {
    const invoice = mockInvoices.get(id);

    if (!invoice) {
      return res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
    }

    // Validate business rules
    const linkValidation = canLinkToEscrow(invoice);
    if (!linkValidation.canLink) {
      return res.status(400).json({
        error: linkValidation.reason,
        code: 'CANNOT_LINK_TO_ESCROW',
      });
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await executeTransition({
      invoiceId: id,
      currentState,
      targetState: INVOICE_STATES.LINKED_ESCROW,
      actor,
      reason: reason || 'Invoice linked to escrow',
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
        action: 'link-escrow',
        escrowId: escrowId || 'pending',
      },
    });

    invoice.status = INVOICE_STATES.LINKED_ESCROW;
    invoice.escrowId = escrowId;
    invoice.updatedAt = new Date().toISOString();
    invoice.updatedBy = actor;

    res.status(200).json({
      data: {
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        escrowId: escrowId || null,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      },
      message: 'Invoice linked to escrow successfully',
    });
  } catch (error) {
    if (error.code) {
      return res.status(400).json({
        error: error.message,
        code: error.code,
        allowedTransitions: error.allowedTransitions,
      });
    }
    next(error);
  }
});

/**
 * GET /api/invoices/:id/history
 * Get state transition history for an invoice
 */
router.get('/:id/history', async (req, res) => {
  const { id } = req.params;

  // Check if invoice exists
  const invoice = mockInvoices.get(id);

  if (!invoice) {
    return res.status(404).json({
      error: 'Invoice not found',
      code: 'INVOICE_NOT_FOUND',
    });
  }

  const history = await getTransitionHistory(id, getAuditLogs);

  res.json({
    data: {
      invoiceId: id,
      currentState: invoice.status,
      transitions: history,
      totalTransitions: history.length,
    },
    message: 'Invoice transition history retrieved successfully',
  });
});

/**
 * POST /api/invoices/:id/reject
 * Convenience endpoint to reject an invoice
 */
router.post('/:id/reject', async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({
        error: 'Reason is required for rejection',
        code: 'MISSING_TRANSITION_REASON',
      });
    }

    const invoice = mockInvoices.get(id);

    if (!invoice) {
      return res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await executeTransition({
      invoiceId: id,
      currentState,
      targetState: INVOICE_STATES.REJECTED,
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

    invoice.status = INVOICE_STATES.REJECTED;
    invoice.updatedAt = new Date().toISOString();
    invoice.updatedBy = actor;

    res.status(200).json({
      data: {
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        reason,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      },
      message: 'Invoice rejected successfully',
    });
  } catch (error) {
    if (error.code) {
      return res.status(400).json({
        error: error.message,
        code: error.code,
        allowedTransitions: error.allowedTransitions,
      });
    }
    next(error);
  }
});

module.exports = router;
module.exports.mockInvoices = mockInvoices; // Export for testing
