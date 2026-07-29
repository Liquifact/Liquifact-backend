'use strict';

const express = require('express');
const router = express.Router();
const invoiceStateService = require('../services/invoiceStateService');
const { requireKycForFunding, auditKycAccess } = require('../middleware/kycGating');
const responseHelper = require('../utils/responseHelper');
const { cacheResponse, makeInvoiceStateKey } = require('../middleware/cache');
const { getSharedStore } = require('../services/cacheStore');
const { cacheConfig } = require('../config/cache');
const { invoiceStateCacheEvictionsTotal } = require('../metrics');

router.use(extractTenant);

// Compress invoice-state responses above the default 1 KB threshold.
// Respects Accept-Encoding (gzip preferred over deflate); small responses
// are always sent as plain JSON regardless of the client's encoding preference.
router.use(createCompressionMiddleware());

// Per-client (API key / IP) rate limit on the invoice-state endpoints (#739).
const { invoiceStateLimiter } = require('../middleware/rateLimit');
router.use(invoiceStateLimiter);

// Response cache for GET /:id/state — bounded, config-driven TTL (#21).
const cacheState = cacheResponse({
  ttl: cacheConfig.invoiceStateTtl,
  store: getSharedStore(),
  keyFn: makeInvoiceStateKey,
});

/**
 * Invalidates the cached state for a given invoice.
 *
 * Deletes the cache entry so subsequent reads fetch fresh data.
 * The eviction is recorded on the invoiceStateCacheEvictionsTotal
 * counter with reason="invalidation".
 *
 * @param {string} tenantId - Tenant identifier.
 * @param {string} invoiceId - Invoice identifier.
 * @returns {void}
 */
function invalidateInvoiceStateCache(tenantId, invoiceId) {
  const store = getSharedStore();
  const key = 'invoiceState:state:' + tenantId + ':' + invoiceId;
  store.del(key);
  invoiceStateCacheEvictionsTotal.labels('invalidation').inc();
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
router.get('/:id/state', cacheState, async (req, res, next) => {
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
  if (statusCode >= 400) {
    return '4xx';
  }
  return '2xx';
}

/**
 * Maps an error object to a coarse telemetry cause label.
 *
 * @param {Error|null|undefined} error - Error raised by a handler.
 * @returns {string} Error cause label.
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

    invalidateInvoiceStateCache(req.tenantId, id);

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
 * POST /api/invoices/:id/approve
 * Convenience endpoint to approve a pending invoice.
 */
/**
 * @swagger
 * /api/invoices/{id}/approve:
 *   post:
 *     operationId: approveInvoiceState
 *     summary: Approve a pending invoice
 *     description: Transition a pending invoice to approved state.
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Invoice approved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateApproveResponse'
 *       400:
 *         description: Transition error or validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 *       404:
 *         description: Invoice not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 */
router.post('/:id/approve', async (req, res, next) => {
  const { reason } = req.body || {};

  try {
    const context = buildContext(req, { action: 'approve' });
    const result = await invoiceStateService.approve(req.params.id, req.tenantId, reason, context);

    invalidateInvoiceStateCache(req.tenantId, id);

    return res.status(200).json({
      ...responseHelper.success(result),
      message: 'Invoice approved successfully',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/invoices/{id}/link-escrow:
 *   post:
 *     operationId: linkInvoiceEscrow
 *     summary: Link an approved invoice to escrow
 *     description: Links an approved invoice to escrow state. Gated on verified/exempted KYC status.
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               escrowId:
 *                 type: string
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Invoice linked to escrow successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateLinkEscrowResponse'
 *       400:
 *         description: Transition error or validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 *       404:
 *         description: Invoice not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 */
router.post('/:id/link-escrow', requireKycForFunding, auditKycAccess, async (req, res, next) => {
  const { escrowId, reason } = req.body || {};

  try {
    const context = buildContext(req, {
      action: 'link-escrow',
      escrowId: escrowId || 'pending',
    });
    const result = await invoiceStateService.linkEscrow(req.params.id, req.tenantId, escrowId, reason, context);

    invalidateInvoiceStateCache(req.tenantId, id);

    return res.status(200).json({
      ...responseHelper.success(result),
      message: 'Invoice linked to escrow successfully',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/invoices/{id}/reject:
 *   post:
 *     operationId: rejectInvoiceState
 *     summary: Reject an invoice
 *     description: Rejects an invoice with a mandatory reason.
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Invoice rejected successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateRejectResponse'
 *       400:
 *         description: Transition error or validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 *       404:
 *         description: Invoice not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 */
router.post('/:id/reject', async (req, res, next) => {
  const { reason } = req.body || {};

  try {
    const context = buildContext(req, { action: 'reject' });
    const result = await invoiceStateService.reject(req.params.id, req.tenantId, reason, context);

    invalidateInvoiceStateCache(req.tenantId, id);

    return res.status(200).json({
      ...responseHelper.success(result),
      message: 'Invoice rejected successfully',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/invoices/{id}/history:
 *   get:
 *     operationId: getInvoiceStateHistory
 *     summary: Get invoice transition history
 *     description: Returns the state transition history log for an invoice.
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *     responses:
 *       200:
 *         description: Invoice transition history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateHistoryResponse'
 *       400:
 *         description: Transition error or validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 *       404:
 *         description: Invoice not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 */
router.get('/:id/history', async (req, res, next) => {
  try {
    const result = await invoiceStateService.getHistory(req.params.id, req.tenantId);

    return res.json({
      ...responseHelper.success(result),
      message: 'Invoice transition history retrieved successfully',
    });
  } catch (error) {
    return next(error);
  }
});

const MAX_BULK_ITEMS = 25;

/**
 * POST /api/invoices/bulk
 * Processes a batch of invoice-state operations and returns per-item results.
 */
/**
 * @swagger
 * /api/invoices/bulk:
 *   post:
 *     operationId: bulkInvoiceStateOperations
 *     summary: Bulk invoice-state operations
 *     description: Processes a bounded array of invoice-state operations and returns per-item success/error without failing the whole batch.
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             maxItems: 25
 *             items:
 *               type: object
 *               required: [invoiceId, action]
 *               properties:
 *                 invoiceId:
 *                   type: string
 *                   description: Invoice identifier
 *                 action:
 *                   type: string
 *                   enum: [approve, reject, link-escrow, transition]
 *                   description: The state-transition action to perform
 *                 reason:
 *                   type: string
 *                   description: Optional rationale for the action (required for reject)
 *                 escrowId:
 *                   type: string
 *                   description: Escrow contract identifier (required for link-escrow)
 *                 targetState:
 *                   type: string
 *                   description: Target lifecycle state (required for transition)
 *     responses:
 *       200:
 *         description: Bulk operation results with per-item status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateBulkResponse'
 *       400:
 *         description: Validation error (empty batch, over-cap, or invalid body)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvoiceStateErrorResponse'
 */
router.post('/bulk', async (req, res, _next) => {
  const items = req.body;

  if (!Array.isArray(items)) {
    return res.status(400).json(responseHelper.error('Request body must be a JSON array of invoice-state operations', 'INVALID_BATCH_TYPE'));
  }

  if (items.length === 0) {
    return res.status(400).json(responseHelper.error('Batch must contain at least one invoice-state operation', 'EMPTY_BATCH'));
  }

  if (items.length > MAX_BULK_ITEMS) {
    return res.status(400).json(responseHelper.error(`Batch size exceeds maximum of ${MAX_BULK_ITEMS}`, 'BATCH_OVER_CAP'));
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

      const context = buildContext(req, { action, bulkIndex: index });
      let result;

      switch (action) {
        case 'approve': {
          result = await invoiceStateService.approve(invoiceId.trim(), req.tenantId, reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'reject': {
          result = await invoiceStateService.reject(invoiceId.trim(), req.tenantId, reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'link-escrow': {
          result = await invoiceStateService.linkEscrow(invoiceId.trim(), req.tenantId, escrowId || null, reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        case 'transition': {
          if (!targetState || typeof targetState !== 'string' || targetState.trim().length === 0) {
            throw Object.assign(new Error('targetState is required for transition action'), { code: 'MISSING_TARGET_STATE' });
          }
          result = await invoiceStateService.transition(invoiceId.trim(), req.tenantId, targetState.trim(), reason, context);
          results.push({ index, success: true, action, result });
          break;
        }
        default: {
          throw Object.assign(new Error(`Unknown action: ${action}`), { code: 'INVALID_ACTION' });
        }
      }
    } catch (error) {
      console.error('BULK ITEM ERROR', { index, action, invoiceId, code: error.code, message: error.message, stack: error.stack });
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
    succeeded: results.filter((item) => item.success).length,
    failed: results.filter((item) => !item.success).length,
  };

  return res.status(200).json({
    ...responseHelper.success({ results, summary }),
    message: 'Bulk invoice-state operation completed',
  });
});

// Mount the shared invoice-state error middleware after all route
// handlers so StateTransitionErrors from any handler receive a
// consistent response envelope (issue #968).
router.use(invoiceStateErrorHandler);

module.exports = router;
