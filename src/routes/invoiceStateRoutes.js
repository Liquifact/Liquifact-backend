'use strict';

/**
 * Invoice State Routes
 *
 * Exposes the following endpoints, all tenant-scoped via the `extractTenant`
 * middleware:
 *
 *   GET  /:id/state       — Return current state + allowed transitions
 *   POST /:id/transition  — Execute an arbitrary valid state transition
 *   POST /:id/approve     — Convenience shortcut: transition to APPROVED
 *   POST /:id/link-escrow — Convenience shortcut: transition to LINKED_ESCROW
 *   POST /:id/reject      — Convenience shortcut: transition to REJECTED
 *   GET  /:id/history     — Return audit-trail of all transitions for an invoice
 *
 * All mutating routes delegate persistence to `invoiceService.transitionInvoice`
 * which in turn calls `invoiceStateMachine.executeTransition` and emits an
 * immutable audit log entry.
 *
 * @module routes/invoiceStateRoutes
 */

const express = require('express');
const { extractTenant } = require('../middleware/tenant');
const invoiceService = require('../services/invoiceService');
const {
  INVOICE_STATES,
  CAPITAL_MOVING_STATES,
  getAllowedTransitions,
  isTerminalState,
  validateTransition,
  canLinkToEscrow,
  getTransitionHistory,
} = require('../services/invoiceStateMachine');
const { getAuditLogs } = require('../services/auditLog');

const router = express.Router();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves an invoice for the request's tenant and returns a 404 JSON error
 * if not found.  Returns null and ends the response when the invoice is
 * missing; returns the invoice row otherwise.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {string} invoiceId
 * @returns {Promise<object|null>}
 */
async function resolveOrNotFound(req, res, invoiceId) {
  const invoice = await invoiceService.getInvoiceById(invoiceId, req.tenantId);
  if (!invoice) {
    res.status(404).json({
      error: { code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' },
    });
    return null;
  }
  return invoice;
}

/**
 * Maps a state-machine / service-layer error code to an HTTP status code.
 *
 * @param {string} code - Machine-readable error code.
 * @returns {number} HTTP status.
 */
function errorCodeToStatus(code) {
  switch (code) {
    case 'INVOICE_NOT_FOUND':
      return 404;
    case 'INVALID_TRANSITION':
    case 'TERMINAL_STATE':
    case 'ALREADY_IN_TARGET_STATE':
    case 'MISSING_TARGET_STATE':
    case 'MISSING_TRANSITION_REASON':
    case 'TRANSITION_REASON_TOO_LONG':
    case 'INVALID_CURRENT_STATE':
    case 'INVALID_TARGET_STATE':
    case 'MISSING_INVOICE_ID':
    case 'MISSING_CURRENT_STATE':
    case 'MISSING_ACTOR':
    case 'CANNOT_LINK_TO_ESCROW':
      return 400;
    default:
      return 500;
  }
}

/**
 * Builds the actor identifier from the request.
 * Prefers `req.user.id` then `req.user.sub`, falls back to 'anonymous'.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveActor(req) {
  if (req.user) {
    return req.user.id || req.user.sub || 'anonymous';
  }
  return 'anonymous';
}

// ---------------------------------------------------------------------------
// GET /:id/state
// ---------------------------------------------------------------------------

/**
 * GET /api/invoices/:id/state
 *
 * Returns the current lifecycle state of the invoice along with the list of
 * allowed next transitions and a flag indicating whether the state is terminal.
 *
 * Response 200:
 *   {
 *     data: {
 *       invoiceId:           string,
 *       currentState:        string,
 *       allowedTransitions:  string[],
 *       isTerminal:          boolean,
 *       requiresKYC:         boolean   // true when the state involves capital movement
 *     }
 *   }
 *
 * Response 400: missing tenant context
 * Response 404: invoice not found or belongs to a different tenant
 */
router.get('/:id/state', extractTenant, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();
    const invoice = await resolveOrNotFound(req, res, invoiceId);
    if (!invoice) {return;}

    const currentState = invoice.status;
    const allowed = getAllowedTransitions(currentState);
    const terminal = isTerminalState(currentState);

    return res.json({
      data: {
        invoiceId,
        currentState,
        allowedTransitions: allowed,
        isTerminal: terminal,
        requiresKYC: CAPITAL_MOVING_STATES.has(currentState),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/transition
// ---------------------------------------------------------------------------

/**
 * POST /api/invoices/:id/transition
 *
 * Executes an arbitrary valid state transition for the invoice.
 * The caller supplies `targetState` in the request body; `reason` is
 * required when the target state is REJECTED or CANCELLED.
 *
 * Body:
 *   targetState  {string}  Required — desired lifecycle state
 *   reason       {string}  Required for REJECTED / CANCELLED targets
 *
 * Response 200:
 *   {
 *     data: {
 *       previousState:  string,
 *       currentState:   string,
 *       transitionedBy: string,
 *       reason?:        string,
 *       auditLogId:     string
 *     },
 *     message: string
 *   }
 *
 * Response 400: validation error (invalid transition, missing reason, …)
 * Response 404: invoice not found / wrong tenant
 */
router.post('/:id/transition', extractTenant, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();
    const { targetState, reason } = req.body || {};

    // targetState is required — check before hitting the DB
    if (!targetState) {
      return res.status(400).json({
        error: {
          code: 'MISSING_TARGET_STATE',
          message: 'targetState is required',
        },
      });
    }

    const invoice = await resolveOrNotFound(req, res, invoiceId);
    if (!invoice) {return;}

    const actor = resolveActor(req);

    // Pre-validate so we can return detailed errors without touching the DB
    const preCheck = validateTransition({
      invoiceId,
      currentState: invoice.status,
      targetState,
      actor,
      reason,
    });

    if (!preCheck.isValid) {
      return res.status(errorCodeToStatus(preCheck.code)).json({
        error: {
          code: preCheck.code,
          message: preCheck.error,
          details: {
            ...(preCheck.allowedTransitions
              ? { allowedTransitions: preCheck.allowedTransitions }
              : {}),
          },
        },
      });
    }

    let result;
    try {
      result = await invoiceService.transitionInvoice(invoiceId, targetState, req.tenantId, {
        actor,
        reason,
        ipAddress: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
      });
    } catch (err) {
      if (err.code === 'INVOICE_NOT_FOUND') {
        return res.status(404).json({
          error: { code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (err.code) {
        return res.status(errorCodeToStatus(err.code)).json({
          error: {
            code: err.code,
            message: err.message,
            details: {
              ...(err.allowedTransitions
                ? { allowedTransitions: err.allowedTransitions }
                : {}),
            },
          },
        });
      }
      return next(err);
    }

    return res.json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        ...(reason !== undefined && reason !== null ? { reason } : {}),
        auditLogId: result.auditLog && result.auditLog.id,
      },
      message: `Invoice transitioned to '${result.newState}' successfully`,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/approve
// ---------------------------------------------------------------------------

/**
 * POST /api/invoices/:id/approve
 *
 * Convenience endpoint — transitions the invoice to APPROVED.
 *
 * Body:
 *   reason  {string}  Optional reason for approval
 *
 * Response 200:
 *   {
 *     data: { previousState, currentState, transitionedBy, reason?, auditLogId },
 *     message: "Invoice approved successfully"
 *   }
 */
router.post('/:id/approve', extractTenant, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();
    const { reason } = req.body || {};

    const invoice = await resolveOrNotFound(req, res, invoiceId);
    if (!invoice) {return;}

    const actor = resolveActor(req);

    let result;
    try {
      result = await invoiceService.transitionInvoice(
        invoiceId,
        INVOICE_STATES.APPROVED,
        req.tenantId,
        {
          actor,
          reason,
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
        },
      );
    } catch (err) {
      if (err.code === 'INVOICE_NOT_FOUND') {
        return res.status(404).json({
          error: { code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (err.code) {
        return res.status(errorCodeToStatus(err.code)).json({
          error: {
            code: err.code,
            message: err.message,
            details: {
              ...(err.allowedTransitions
                ? { allowedTransitions: err.allowedTransitions }
                : {}),
            },
          },
        });
      }
      return next(err);
    }

    return res.json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        ...(reason !== undefined && reason !== null ? { reason } : {}),
        auditLogId: result.auditLog && result.auditLog.id,
      },
      message: 'Invoice approved successfully',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/link-escrow
// ---------------------------------------------------------------------------

/**
 * POST /api/invoices/:id/link-escrow
 *
 * Convenience endpoint — transitions an APPROVED invoice to LINKED_ESCROW.
 * Persists the optional `escrowId` in the invoice metadata.
 *
 * Body:
 *   escrowId  {string}  Escrow contract ID to persist in invoice metadata
 *   reason    {string}  Optional reason
 *
 * Response 200:
 *   {
 *     data: { previousState, currentState, transitionedBy, escrowId, auditLogId },
 *     message: "Invoice linked to escrow successfully"
 *   }
 *
 * Response 400: CANNOT_LINK_TO_ESCROW when invoice is not in APPROVED state
 */
router.post('/:id/link-escrow', extractTenant, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();
    const { escrowId = null, reason } = req.body || {};

    const invoice = await resolveOrNotFound(req, res, invoiceId);
    if (!invoice) {return;}

    // Business rule: only approved invoices can be linked to escrow
    const linkCheck = canLinkToEscrow(invoice);
    if (!linkCheck.canLink) {
      return res.status(400).json({
        error: {
          code: 'CANNOT_LINK_TO_ESCROW',
          message: linkCheck.reason,
        },
      });
    }

    const actor = resolveActor(req);

    let result;
    try {
      result = await invoiceService.transitionInvoice(
        invoiceId,
        INVOICE_STATES.LINKED_ESCROW,
        req.tenantId,
        {
          actor,
          reason,
          escrowId,
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
          metadata: { ...(escrowId ? { escrowId } : {}) },
        },
      );
    } catch (err) {
      if (err.code === 'INVOICE_NOT_FOUND') {
        return res.status(404).json({
          error: { code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (err.code) {
        return res.status(errorCodeToStatus(err.code)).json({
          error: {
            code: err.code,
            message: err.message,
            details: {
              ...(err.allowedTransitions
                ? { allowedTransitions: err.allowedTransitions }
                : {}),
            },
          },
        });
      }
      return next(err);
    }

    return res.json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        escrowId: escrowId || null,
        auditLogId: result.auditLog && result.auditLog.id,
      },
      message: 'Invoice linked to escrow successfully',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/reject
// ---------------------------------------------------------------------------

/**
 * POST /api/invoices/:id/reject
 *
 * Convenience endpoint — transitions the invoice to REJECTED.
 * A non-empty `reason` is always required for rejections.
 *
 * Body:
 *   reason  {string}  Required — explanation for rejection
 *
 * Response 200:
 *   {
 *     data: { previousState, currentState, transitionedBy, reason, auditLogId },
 *     message: "Invoice rejected successfully"
 *   }
 *
 * Response 400: MISSING_TRANSITION_REASON when reason is absent
 */
router.post('/:id/reject', extractTenant, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();
    const { reason } = req.body || {};

    const invoice = await resolveOrNotFound(req, res, invoiceId);
    if (!invoice) {return;}

    const actor = resolveActor(req);

    let result;
    try {
      result = await invoiceService.transitionInvoice(
        invoiceId,
        INVOICE_STATES.REJECTED,
        req.tenantId,
        {
          actor,
          reason,
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
        },
      );
    } catch (err) {
      if (err.code === 'INVOICE_NOT_FOUND') {
        return res.status(404).json({
          error: { code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (err.code) {
        return res.status(errorCodeToStatus(err.code)).json({
          error: {
            code: err.code,
            message: err.message,
            details: {
              ...(err.allowedTransitions
                ? { allowedTransitions: err.allowedTransitions }
                : {}),
            },
          },
        });
      }
      return next(err);
    }

    return res.json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        reason: reason || null,
        auditLogId: result.auditLog && result.auditLog.id,
      },
      message: 'Invoice rejected successfully',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id/history
// ---------------------------------------------------------------------------

/**
 * GET /api/invoices/:id/history
 *
 * Returns the ordered transition history for the invoice, newest-first,
 * sourced directly from the append-only audit log.
 *
 * Query params:
 *   limit  {number}  Maximum number of history entries to return (default: 100, max: 500)
 *
 * Response 200:
 *   {
 *     data: {
 *       invoiceId:        string,
 *       currentState:     string,
 *       transitions:      TransitionEntry[],
 *       totalTransitions: number
 *     }
 *   }
 *
 * Response 404: invoice not found / wrong tenant
 */
router.get('/:id/history', extractTenant, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();

    const invoice = await resolveOrNotFound(req, res, invoiceId);
    if (!invoice) {return;}

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const transitions = await getTransitionHistory(invoiceId, (opts) =>
      getAuditLogs({ ...opts, limit }),
    );

    return res.json({
      data: {
        invoiceId,
        currentState: invoice.status,
        transitions,
        totalTransitions: transitions.length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
