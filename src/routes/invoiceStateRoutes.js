'use strict';

const express = require('express');
const router = express.Router();
const invoiceStateService = require('../services/invoiceStateService');
const { requireKycForFunding, auditKycAccess } = require('../middleware/kycGating');
const { authenticatedTenantStack } = require('../middleware/stacks');
const responseHelper = require('../utils/responseHelper');
const {
  INVOICE_STATES,
  executeTransition,
  getAllowedTransitions,
  getTransitionHistory,
  canLinkToEscrow,
} = require('../services/invoiceStateMachine');
const { getAuditLogs } = require('../services/auditLog');
const logger = require('../logger');
const {
  invoiceStateRequestDurationMs,
  invoiceStateRequestCount,
} = require('../metrics');

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
 * Classifies an HTTP status code into a coarse status bucket.
 *
 * @param {number} statusCode - HTTP status code.
 * @returns {string} Status class label.
 */
function classifyStatus(statusCode) {
  if (statusCode >= 500) {
    return '5xx';
  }
  if (statusCode >= 400) {
    return '4xx';
  }
  return '2xx';
}

/**
 * Wraps a route handler so invoice-state requests emit metrics and logs.
 *
 * @param {string} routeName - Stable route label for telemetry.
 * @param {Function} handler - Route handler to execute.
 * @returns {Function} Wrapped Express handler.
 */
function instrumentRequest(routeName, handler) {
  return async (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    let errorCause = 'none';

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const statusClass = classifyStatus(res.statusCode);
      if (statusClass === '4xx') {
        errorCause = 'client_error';
      } else if (statusClass === '5xx') {
        errorCause = 'server_error';
      } else if (errorCause === 'unknown_error') {
        errorCause = 'none';
      }

      invoiceStateRequestDurationMs.observe({
        route: routeName,
        method: req.method,
        status_class: statusClass,
        error_cause: errorCause,
      }, durationMs);

      invoiceStateRequestCount.inc({
        route: routeName,
        method: req.method,
        status_class: statusClass,
        error_cause: errorCause,
      });

      logger.info({
        route: routeName,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        errorCause,
      }, 'Invoice-state request completed');
    });

    res.on('close', () => {
      if (res.writableEnded) {
        return;
      }
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.warn({
        route: routeName,
        method: req.method,
        path: req.path,
        durationMs,
        errorCause: 'client_disconnect',
      }, 'Invoice-state request closed before completion');
    });

    try {
      await Promise.resolve(handler(req, res, (err) => {
        if (err) {
          errorCause = classifyErrorCause(err);
        }
        next(err);
      }));
    } catch (error) {
      errorCause = classifyErrorCause(error);
      throw error;
    }
  };
}

/**
 * Maps an error object to a coarse telemetry cause label.
 *
 * @param {Error|null|undefined} error - Error raised by a handler.
 * @returns {string} Error cause label.
 */
function classifyErrorCause(error) {
  if (!error) {
    return 'none';
  }
  if (error.code && typeof error.code === 'string') {
    return error.code;
  }
  if (error.statusCode >= 500) {
    return 'server_error';
  }
  if (error.statusCode >= 400) {
    return 'client_error';
  }
  return 'unknown_error';
}

/**
 * GET /api/invoices/:id/state
 * Returns the current state and allowed transitions for an invoice.
 */
router.get('/:id/state', instrumentRequest('invoice-state:get', (req, res) => {
  const { id } = req.params;

  // Get invoice from database
  const invoice = mockInvoices.get(id);

  if (!invoice) {
    res.status(404).json({
      error: 'Invoice not found',
      code: 'INVOICE_NOT_FOUND',
    });
    return;
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
}));

/**
 * POST /api/invoices/:id/transition
 * Executes a state transition to the requested target state.
 */
router.post('/:id/transition', instrumentRequest('invoice-state:transition', (req, res, next) => {
  const { id } = req.params;
  const { targetState, reason } = mapTransitionRequest(req.body);

  try {
    // Validate request body
    if (!targetState) {
      res.status(400).json({
        error: 'Target state is required',
        code: 'MISSING_TARGET_STATE',
      });
      return;
    }

    // Get invoice from database
    const invoice = mockInvoices.get(id);

    if (!invoice) {
      res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
      return;
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    // Execute transition
    const result = executeTransition({
      invoiceId: id,
      currentState,
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
}));

/**
 * POST /api/invoices/:id/approve
 * Convenience endpoint to approve an invoice.
 */
router.post('/:id/approve', instrumentRequest('invoice-state:approve', (req, res, next) => {
  const { id } = req.params;
  const { reason } = mapApproveRequest(req.body);

  try {
    const invoice = mockInvoices.get(id);

    if (!invoice) {
      res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
      return;
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = executeTransition({
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
    );

    const responseDto = toTransitionResponse({ invoiceId: id, result });
    return res.status(200).json({
      ...responseHelper.success(responseDto),
      message: 'Invoice approved successfully',
    });
  } catch (err) {
    sendTransitionError(res, err);
  }
}));

/**
 * POST /api/invoices/:id/link-escrow
 * Convenience endpoint to link an approved invoice to an escrow contract.
 */
router.post('/:id/link-escrow', instrumentRequest('invoice-state:link-escrow', (req, res, next) => {
  const { id } = req.params;
  const { escrowId, reason } = mapLinkEscrowRequest(req.body);

  try {
    const invoice = mockInvoices.get(id);

    if (!invoice) {
      res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
      return;
    }

    // Validate business rules
    const linkValidation = canLinkToEscrow(invoice);
    if (!linkValidation.canLink) {
      res.status(400).json({
        error: linkValidation.reason,
        code: 'CANNOT_LINK_TO_ESCROW',
      });
      return;
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = executeTransition({
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
}));

/**
 * GET /api/invoices/:id/history
 * Returns the transition history for an invoice.
 */
router.get('/:id/history', instrumentRequest('invoice-state:history', (req, res) => {
  const { id } = req.params;

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

  if (!invoice) {
    res.status(404).json({
      error: 'Invoice not found',
      code: 'INVOICE_NOT_FOUND',
    });
    return;
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
}));

/**
 * POST /api/invoices/:id/transition
 * Executes a state transition and persists the resulting state.
 *
 * Request body: { "targetState": "approved", "reason": "..." }
 */
router.post('/:id/reject', instrumentRequest('invoice-state:reject', (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    if (!reason) {
      res.status(400).json({
        error: 'Reason is required for rejection',
        code: 'MISSING_REASON',
      });
      return;
    }

    const invoice = mockInvoices.get(id);

    if (!invoice) {
      res.status(404).json({
        error: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
      });
      return;
    }

    const currentState = invoice.status;
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = executeTransition({
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
}));

module.exports = router;
