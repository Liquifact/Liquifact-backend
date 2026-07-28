'use strict';

/**
 * @fileoverview Admin routes for LiquifactEscrow wasm version management.
 * All routes require admin authentication (JWT or API key).
 *
 * @module routes/adminEscrow
 */

const express = require('express');
const router = express.Router();
const { adminStack } = require('../middleware/stacks');
const { runContractListRefresh } = require('../jobs/contractListRefresh');
const { getOnChainSchemaVersion, compareVersions } = require('../config/escrowVersions');
const {
  softDeleteEscrowRead,
  restoreEscrowRead,
  getEscrowReadDeletionState,
  purgeExpiredSoftDeletes,
  SOFT_DELETE_ERRORS,
} = require('../services/escrowReadSoftDelete');
const AppError = require('../errors/AppError');
const logger = require('../logger');

router.use(...adminStack);

/**
 * Maximum accepted length of the operator-supplied delete reason. Bounded so a
 * caller cannot write an unbounded blob into the projection table.
 *
 * @constant {number}
 */
const MAX_DELETE_REASON_LENGTH = 500;

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
 * DELETE /api/admin/escrow/reads/:invoiceId
 * Soft-deletes an escrow-read record (issue #31).
 *
 * @swagger
 * /api/admin/escrow/reads/{invoiceId}:
 *   delete:
 *     operationId: softDeleteEscrowRead
 *     summary: Soft-delete an escrow-read record
 *     description: |
 *       Marks the invoice's `escrow_event_projection` record deleted. The row is
 *       retained (not purged) and excluded from every default escrow read, which
 *       then reports the neutral `not_found` state. The record stays restorable
 *       via `POST /api/admin/escrow/reads/{invoiceId}/restore` until its retention
 *       window (`ESCROW_READ_SOFT_DELETE_RETENTION_DAYS`, default 30 days) elapses,
 *       after which the maintenance purge job removes it permanently.
 *       Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
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
 *         description: Record soft-deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoiceId: { type: string }
 *                 deleted: { type: boolean }
 *                 deletedAt: { type: string, format: date-time }
 *                 deletedBy: { type: string, nullable: true }
 *                 deleteReason: { type: string, nullable: true }
 *                 purgeAfter: { type: string, format: date-time }
 *                 restorable: { type: boolean }
 *                 retentionDays: { type: integer }
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       404:
 *         description: No escrow-read record for the invoice
 *       409:
 *         description: Record is already soft-deleted
 */
router.delete('/reads/:invoiceId', async (req, res, next) => {
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
    const result = await softDeleteEscrowRead(req.params.invoiceId, {
      actor,
      reason: parsedReason.value,
    });

    logger.info(
      { invoiceId: result.invoiceId, actor, requestId: req.id },
      'Admin soft-deleted escrow-read record'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * POST /api/admin/escrow/reads/:invoiceId/restore
 * Restores a soft-deleted escrow-read record within its retention window.
 *
 * @swagger
 * /api/admin/escrow/reads/{invoiceId}/restore:
 *   post:
 *     operationId: restoreEscrowRead
 *     summary: Restore a soft-deleted escrow-read record
 *     description: |
 *       Clears the tombstone so the record is served by default reads again.
 *       Only possible while the retention window is open; once it has elapsed the
 *       endpoint returns 410 Gone even if the purge job has not run yet.
 *       Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Record restored
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       404:
 *         description: No escrow-read record for the invoice (possibly purged)
 *       409:
 *         description: Record is not soft-deleted
 *       410:
 *         description: Retention window expired; record can no longer be restored
 */
router.post('/reads/:invoiceId/restore', async (req, res, next) => {
  try {
    const actor = _resolveActor(req);
    const result = await restoreEscrowRead(req.params.invoiceId, { actor });

    logger.info(
      { invoiceId: result.invoiceId, actor, requestId: req.id },
      'Admin restored escrow-read record'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * GET /api/admin/escrow/reads/:invoiceId/deletion-state
 * Reports the soft-delete state of an escrow-read record.
 *
 * @swagger
 * /api/admin/escrow/reads/{invoiceId}/deletion-state:
 *   get:
 *     operationId: getEscrowReadDeletionState
 *     summary: Inspect the soft-delete state of an escrow-read record
 *     description: |
 *       Returns whether the record is soft-deleted, who deleted it and why, when
 *       it will be purged, and whether it is still restorable. This is the only
 *       read that surfaces tombstoned records; ordinary escrow reads hide them.
 *       Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
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
 *         description: No escrow-read record for the invoice
 */
router.get('/reads/:invoiceId/deletion-state', async (req, res, next) => {
  try {
    const result = await getEscrowReadDeletionState(req.params.invoiceId);
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * POST /api/admin/escrow/reads/purge
 * Runs the retention purge synchronously (maintenance task).
 *
 * @swagger
 * /api/admin/escrow/reads/purge:
 *   post:
 *     operationId: purgeExpiredEscrowReads
 *     summary: Purge escrow-read records past their retention window
 *     description: |
 *       Hard-deletes soft-deleted records whose retention window has elapsed. The
 *       same work runs on a schedule via `src/jobs/escrowReadPurge.js`; this
 *       endpoint exists for runbook-driven maintenance. Records still inside their
 *       window are never touched. Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
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
router.post('/reads/purge', async (req, res, next) => {
  try {
    const summary = await purgeExpiredSoftDeletes();
    logger.info(
      { purged: summary.purged, cutoff: summary.cutoff, requestId: req.id },
      'Admin triggered escrow-read retention purge'
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

/**
 * POST /api/admin/escrow/refresh
 * Manually triggers the contract list refresh job.
 *
 * @swagger
 * /api/admin/escrow/refresh:
 *   post:
 *     operationId: refreshEscrowContractList
 *     summary: Trigger a manual contract list refresh
 *     description: |
 *       Manually triggers the Soroban contract list refresh job.
 *       Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       202:
 *         description: Contract list refresh triggered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       502:
 *         description: Soroban RPC read failed
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await runContractListRefresh();
    logger.info({ result, requestId: req.id }, 'Admin triggered contract list refresh');
    return res.status(202).json({
      message: 'Contract list refresh triggered.',
      ...result,
    });
  } catch (err) {
    if (err.code === 'INVALID_CONTRACT_ID') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: err.message,
      }));
    }
    if (err.code === 'RPC_ERROR') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/upstream-error',
        title: 'Upstream Error',
        status: 502,
        detail: 'Soroban RPC read failed. Retry after confirming RPC health.',
      }));
    }
    next(err);
  }
});

/**
 * GET /api/admin/escrow/version
 * Returns the current on-chain SCHEMA_VERSION and registry comparison.
 *
 * @swagger
 * /api/admin/escrow/version:
 *   get:
 *     operationId: getEscrowContractVersion
 *     summary: Get on-chain escrow contract schema version
 *     description: |
 *       Returns the current on-chain `SCHEMA_VERSION` for the LiquifactEscrow
 *       contract and compares it against the known registry version.
 *       Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Version comparison returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 onChainVersion:
 *                   type: string
 *                 knownVersion:
 *                   type: string
 *                 status:
 *                   type: string
 *                   enum: [match, mismatch, unknown]
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       502:
 *         description: Soroban RPC read failed
 */
router.get('/version', async (req, res, next) => {
  try {
    const onChainVersion = await getOnChainSchemaVersion();
    const { status, knownVersion } = compareVersions(onChainVersion);
    return res.json({ onChainVersion, knownVersion, status });
  } catch (err) {
    if (err.code === 'INVALID_CONTRACT_ID') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: err.message,
      }));
    }
    if (err.code === 'RPC_ERROR') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/upstream-error',
        title: 'Upstream Error',
        status: 502,
        detail: 'Soroban RPC read failed.',
      }));
    }
    next(err);
  }
});

module.exports = router;
