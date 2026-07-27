'use strict';

/**
 * @fileoverview Admin routes for the invoice-state soft-delete, restore, and
 * retention-purge surface (issue #866).
 *
 * All routes require admin authentication (JWT or API key) and are mounted
 * under `/api/admin/invoices` by {@link module:app}.
 *
 * @module routes/adminInvoiceState
 */

const express = require('express');
const router = express.Router();
const { adminStack } = require('../middleware/stacks');
const {
  softDeleteInvoiceState,
  restoreInvoiceState,
  getInvoiceStateDeletionState,
  purgeExpiredInvoiceStateSoftDeletes,
  SOFT_DELETE_ERRORS,
  MAX_DELETE_REASON_LENGTH,
} = require('../services/invoiceStateSoftDelete');
const AppError = require('../errors/AppError');
const logger = require('../logger');

router.use(...adminStack);

/**
 * Resolves the acting principal for audit columns: the JWT subject when the
 * request is token-authenticated, otherwise the API-key client id.
 *
 * @param {import('express').Request} req - Authenticated request.
 * @returns {string|null} Actor identifier, or null when neither is present.
 */
function _resolveActor(req) {
  const jwtActor = req.user && (req.user.sub || req.user.userId || req.user.id);
  if (jwtActor) {
    return String(jwtActor);
  }
  if (req.apiClient && req.apiClient.clientId) {
    return `api-key:${req.apiClient.clientId}`;
  }
  return null;
}

/**
 * Validates the optional `reason` field of a soft-delete request.
 *
 * @param {unknown} reason - Raw `req.body.reason`.
 * @returns {{ ok: true, value: string|null } | { ok: false, detail: string }}
 *   Normalised reason, or the validation failure detail.
 */
function _parseDeleteReason(reason) {
  if (reason === undefined || reason === null || reason === '') {
    return { ok: true, value: null };
  }
  if (typeof reason !== 'string') {
    return { ok: false, detail: 'reason must be a string' };
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_DELETE_REASON_LENGTH) {
    return {
      ok: false,
      detail: `reason must be at most ${MAX_DELETE_REASON_LENGTH} characters`,
    };
  }
  return { ok: true, value: trimmed || null };
}

/**
 * Maps a soft-delete service error onto an RFC 7807 `AppError`. Unknown errors
 * are passed through untouched so the global handler reports them as 500s.
 *
 * @param {Error & { code?: string, status?: number }} err - Service error.
 * @param {import('express').Request} req - Request (for `instance`).
 * @returns {Error} An `AppError` for known codes, or the original error.
 */
function _mapSoftDeleteError(err, req) {
  const known = {
    [SOFT_DELETE_ERRORS.INVALID_INVOICE_ID]: {
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
    },
    [SOFT_DELETE_ERRORS.NOT_FOUND]: {
      type: 'https://liquifact.com/probs/not-found',
      title: 'Not Found',
    },
    [SOFT_DELETE_ERRORS.ALREADY_DELETED]: {
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
    },
    [SOFT_DELETE_ERRORS.NOT_DELETED]: {
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
    },
    [SOFT_DELETE_ERRORS.RETENTION_EXPIRED]: {
      type: 'https://liquifact.com/probs/retention-expired',
      title: 'Retention Window Expired',
    },
  };

  const mapping = err && err.code ? known[err.code] : undefined;
  if (!mapping) {
    return err;
  }

  return new AppError({
    ...mapping,
    status: err.status || 400,
    detail: err.message,
    instance: req.originalUrl,
  });
}

/**
 * DELETE /api/admin/invoices/:invoiceId
 * Soft-deletes an invoice (issue #866).
 *
 * @swagger
 * /api/admin/invoices/{invoiceId}:
 *   delete:
 *     operationId: softDeleteInvoiceState
 *     summary: Soft-delete an invoice
 *     description: |
 *       Marks the invoice tombstoned. The row is retained (not purged) and
 *       excluded from every default invoice read, which then reports not found.
 *       The record stays restorable via
 *       `POST /api/admin/invoices/{invoiceId}/restore` until its retention
 *       window (`INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS`, default 30 days)
 *       elapses, after which the maintenance purge job removes it permanently.
 *       Requires admin authentication (JWT or API key).
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *                 description: Operator justification, stored for audit.
 *     responses:
 *       200:
 *         description: Invoice soft-deleted
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       404:
 *         description: No invoice for the given id
 *       409:
 *         description: Invoice is already soft-deleted
 */
router.delete('/:invoiceId', async (req, res, next) => {
  const parsedReason = _parseDeleteReason(req.body && req.body.reason);
  if (!parsedReason.ok) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: parsedReason.detail,
      instance: req.originalUrl,
    }));
  }

  try {
    const actor = _resolveActor(req);
    const result = await softDeleteInvoiceState(req.params.invoiceId, {
      actor,
      reason: parsedReason.value,
    });

    logger.info(
      { invoiceId: result.invoiceId, actor, requestId: req.id },
      'Admin soft-deleted invoice'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * POST /api/admin/invoices/:invoiceId/restore
 * Restores a soft-deleted invoice within its retention window.
 *
 * @swagger
 * /api/admin/invoices/{invoiceId}/restore:
 *   post:
 *     operationId: restoreInvoiceState
 *     summary: Restore a soft-deleted invoice
 *     description: |
 *       Clears the tombstone so the record is served by default reads again.
 *       Only possible while the retention window is open; once it has elapsed
 *       the endpoint returns 410 Gone even if the purge job has not run yet.
 *       Requires admin authentication (JWT or API key).
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Invoice restored
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       404:
 *         description: No invoice for the given id (possibly purged)
 *       409:
 *         description: Invoice is not soft-deleted
 *       410:
 *         description: Retention window expired; invoice can no longer be restored
 */
router.post('/:invoiceId/restore', async (req, res, next) => {
  try {
    const actor = _resolveActor(req);
    const result = await restoreInvoiceState(req.params.invoiceId, { actor });

    logger.info(
      { invoiceId: result.invoiceId, actor, requestId: req.id },
      'Admin restored invoice'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * GET /api/admin/invoices/:invoiceId/deletion-state
 * Reports the soft-delete state of an invoice.
 *
 * @swagger
 * /api/admin/invoices/{invoiceId}/deletion-state:
 *   get:
 *     operationId: getInvoiceStateDeletionState
 *     summary: Inspect the soft-delete state of an invoice
 *     description: |
 *       Returns whether the invoice is soft-deleted, who deleted it and why,
 *       when it will be purged, and whether it is still restorable. This is
 *       the only read that surfaces tombstoned records; ordinary invoice
 *       reads hide them. Requires admin authentication (JWT or API key).
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Soft-delete state returned
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       404:
 *         description: No invoice for the given id
 */
router.get('/:invoiceId/deletion-state', async (req, res, next) => {
  try {
    const result = await getInvoiceStateDeletionState(req.params.invoiceId);
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * POST /api/admin/invoices/purge
 * Runs the retention purge synchronously (maintenance task).
 *
 * @swagger
 * /api/admin/invoices/purge:
 *   post:
 *     operationId: purgeExpiredInvoiceStates
 *     summary: Purge invoice records past their retention window
 *     description: |
 *       Hard-deletes soft-deleted invoices whose retention window has elapsed.
 *       The same work runs on a schedule via `src/jobs/invoiceStatePurge.js`;
 *       this endpoint exists for runbook-driven maintenance. Records still
 *       inside their window are never touched. Requires admin authentication
 *       (JWT or API key).
 *     tags: [InvoiceState]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Purge completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 purged: { type: integer }
 *                 batches: { type: integer }
 *                 cutoff: { type: string, format: date-time }
 *                 retentionDays: { type: integer }
 *                 maxBatchesReached: { type: boolean }
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.post('/purge', async (req, res, next) => {
  try {
    const summary = await purgeExpiredInvoiceStateSoftDeletes();
    logger.info(
      { purged: summary.purged, cutoff: summary.cutoff, requestId: req.id },
      'Admin triggered invoice-state retention purge'
    );
    // `invoiceIds` is omitted from the response: operators get the counts, and
    // the full list stays in the logs rather than in an unbounded payload.
    return res.json({
      purged: summary.purged,
      batches: summary.batches,
      cutoff: summary.cutoff,
      retentionDays: summary.retentionDays,
      maxBatchesReached: summary.maxBatchesReached,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
