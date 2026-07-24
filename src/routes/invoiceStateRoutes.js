'use strict';

/**
 * Invoice State Routes
 *
 * Mounted under `/api/invoices` via `mountFeatureRouter` in `src/app.js`.
 * Inbound request bodies are validated through the strict wrapper in
 * `src/schemas/invoiceState.js` so that malformed inputs (missing required
 * fields, wrong types, unknown keys, oversized strings, out-of-range
 * values, prototype-pollution vectors, excessive metadata depth) are
 * rejected with a structured RFC 7807 400 before any business-logic step
 * runs.  The `fieldErrors` map carries machine-readable uppercase codes so
 * clients can branch on validation outcomes programmatically.
 *
 * The `/transition` endpoint inspects the requested target state against
 * `CAPITAL_MOVING_STATES` to surface whether the caller will need KYC
 * gating.  This route is intentionally read-only w.r.t. the database; the
 * real persistence path lives in `src/services/invoiceService.js`.
 */

const express = require('express');

const {
  INVOICE_STATES,
  CAPITAL_MOVING_STATES,
  isTerminalState,
  getAllowedTransitions,
} = require('../services/invoiceStateMachine');
const { safeParseTransitionBody } = require('../schemas/invoiceState');
const invoiceService = require('../services/invoiceService');
const { getAuditLogs } = require('../services/auditLog');

const router = express.Router();

/**
 * Builds an RFC 7807 `application/problem+json` payload describing a
 * validation failure on the transition body.
 * @param {Record<string, string>} fieldErrors - Map of field path to code.
 * @returns {object} RFC 7807 problem-details body.
 */
function buildTransitionValidationProblem(fieldErrors) {
  return {
    type: 'https://liquifact.io/problems/validation-error',
    title: 'Invalid invoice-state request body',
    status: 400,
    detail:
      'Request body for invoice-state endpoint is malformed: ' +
      'review fieldErrors for the specific machine-readable code.',
    code: 'INVOICE_STATE_VALIDATION_FAILED',
    fieldErrors,
  };
}

/**
 * Builds an application-level error response body.
 * @param {string} code - Machine-readable error code.
 * @param {string} message - Human-readable description.
 * @param {object} [details] - Optional additional error context.
 * @returns {object} Error response body.
 */
function buildAppError(code, message, details) {
  const body = { error: { code, message } };
  if (details) { body.error.details = details; }
  return body;
}

/**
 * Middleware that validates the body of a state-transition request.
 * On failure responds with 400; on success attaches parsed payload.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function validateTransitionBody(req, res, next) {
  const result = safeParseTransitionBody(req.body);
  if (!result.success) {
    return res.status(400).json(buildTransitionValidationProblem(result.fieldErrors));
  }
  req.validatedTransitionBody = result.data;
  return next();
}

/**
 * Resolves the tenant ID from header or JWT claim.
 * Attaches req.tenantId or responds 400.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function resolveTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'] || (req.user && req.user.tenantId);
  if (!tenantId) {
    return res.status(400).json({
      error: 'Missing tenant context.',
      message: 'A valid tenant identifier must be supplied via the x-tenant-id header or an authenticated JWT claim.',
    });
  }
  req.tenantId = tenantId;
  return next();
}

/**
 * Extracts actor, IP address, and user agent from the request.
 * @param {import('express').Request} req
 * @returns {{ actor: string, ipAddress: string, userAgent: string }}
 */
function extractContext(req) {
  return {
    actor: (req.user && (req.user.id || req.user.sub)) || 'anonymous',
    ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

router.post('/transition', validateTransitionBody, (req, res) => {
  const { targetState } = req.validatedTransitionBody || {};
  if (CAPITAL_MOVING_STATES.has(targetState)) {
    return res.status(200).json({ requiresKYC: true, state: targetState });
  }
  return res.status(200).json({ requiresKYC: false, state: targetState });
});

router.get('/:id/state', resolveTenant, async (req, res, next) => {
  try {
    const invoice = await invoiceService.getInvoiceById(req.params.id, req.tenantId);
    if (!invoice) {
      return res.status(404).json(buildAppError('INVOICE_NOT_FOUND', 'Invoice not found'));
    }
    const currentState = invoice.status || INVOICE_STATES.PENDING;
    const allowed = getAllowedTransitions(currentState);
    return res.status(200).json({
      data: {
        invoiceId: req.params.id,
        currentState,
        allowedTransitions: allowed,
        isTerminal: isTerminalState(currentState),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/transition', resolveTenant, async (req, res, next) => {
  try {
    const { targetState, reason } = req.body;
    const { actor, ipAddress, userAgent } = extractContext(req);
    const result = await invoiceService.transitionInvoice(req.params.id, targetState, req.tenantId, {
      actor,
      reason,
      ipAddress,
      userAgent,
    });
    return res.status(200).json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        reason: reason || '',
        auditLogId: result.auditLog ? result.auditLog.id : undefined,
      },
      message: `Invoice transitioned to ${result.newState} successfully`,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json(buildAppError(err.code, err.message));
    }
    if (err.code && err.code !== 'INVOICE_NOT_FOUND') {
      const details = err.allowedTransitions ? { allowedTransitions: err.allowedTransitions } : undefined;
      return res.status(400).json(buildAppError(err.code, err.message, details));
    }
    return next(err);
  }
});

router.post('/:id/approve', resolveTenant, async (req, res, next) => {
  try {
    const { actor, ipAddress, userAgent } = extractContext(req);
    const result = await invoiceService.transitionInvoice(req.params.id, INVOICE_STATES.APPROVED, req.tenantId, {
      actor,
      reason: req.body?.reason,
      ipAddress,
      userAgent,
    });
    return res.status(200).json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        reason: req.body?.reason || '',
        auditLogId: result.auditLog ? result.auditLog.id : undefined,
      },
      message: 'Invoice approved successfully',
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json(buildAppError(err.code, err.message));
    }
    if (err.code && err.code !== 'INVOICE_NOT_FOUND') {
      return res.status(400).json(buildAppError(err.code, err.message));
    }
    return next(err);
  }
});

router.post('/:id/link-escrow', resolveTenant, async (req, res, next) => {
  try {
    const { actor, ipAddress, userAgent } = extractContext(req);
    const escrowId = req.body?.escrowId || null;

    const result = await invoiceService.transitionInvoice(req.params.id, INVOICE_STATES.LINKED_ESCROW, req.tenantId, {
      actor,
      reason: req.body?.reason,
      ipAddress,
      userAgent,
      escrowId,
    });
    return res.status(200).json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        escrowId,
        reason: req.body?.reason || '',
        auditLogId: result.auditLog ? result.auditLog.id : undefined,
      },
      message: 'Invoice linked to escrow successfully',
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json(buildAppError(err.code, err.message));
    }
    if (err.code && err.code !== 'INVOICE_NOT_FOUND') {
      const details = err.allowedTransitions ? { allowedTransitions: err.allowedTransitions } : undefined;
      return res.status(400).json(buildAppError('CANNOT_LINK_TO_ESCROW', err.message, details));
    }
    return next(err);
  }
});

router.post('/:id/reject', resolveTenant, async (req, res, next) => {
  try {
    const { actor, ipAddress, userAgent } = extractContext(req);
    const result = await invoiceService.transitionInvoice(req.params.id, INVOICE_STATES.REJECTED, req.tenantId, {
      actor,
      reason: req.body?.reason,
      ipAddress,
      userAgent,
    });
    return res.status(200).json({
      data: {
        previousState: result.previousState,
        currentState: result.newState,
        transitionedBy: result.transitionedBy,
        reason: req.body?.reason || '',
        auditLogId: result.auditLog ? result.auditLog.id : undefined,
      },
      message: 'Invoice rejected successfully',
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json(buildAppError(err.code, err.message));
    }
    if (err.code && err.code !== 'INVOICE_NOT_FOUND') {
      const details = err.allowedTransitions ? { allowedTransitions: err.allowedTransitions } : undefined;
      return res.status(400).json(buildAppError(err.code, err.message, details));
    }
    return next(err);
  }
});

router.get('/:id/history', resolveTenant, async (req, res, next) => {
  try {
    const invoice = await invoiceService.getInvoiceById(req.params.id, req.tenantId);
    if (!invoice) {
      return res.status(404).json(buildAppError('INVOICE_NOT_FOUND', 'Invoice not found'));
    }

    const logs = await getAuditLogs({ resourceId: req.params.id, action: 'STATE_TRANSITION' });

    const transitions = logs.map((log) => ({
      fromState: log.changes?.before?.state || '',
      toState: log.changes?.after?.state || '',
      transitionedBy: log.actor,
      reason: log.metadata?.reason || '',
      timestamp: log.timestamp,
    }));

    return res.status(200).json({
      data: {
        invoiceId: req.params.id,
        currentState: invoice.status || INVOICE_STATES.PENDING,
        transitions,
        totalTransitions: transitions.length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
