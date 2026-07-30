'use strict';

/**
 * @fileoverview Admin route for runtime configuration writes.
 *
 * POST /api/admin/config
 *   Accepts a `{ section, config }` body, validates it strictly with the
 *   section-specific Zod schema from `src/schemas/config.js`, and returns the
 *   validated configuration back to the caller.
 *
 * GET /api/admin/config/sections
 *   Returns the list of valid section names accepted by the POST endpoint.
 *   Supports ETag / If-None-Match conditional GET (304).
 *
 * DELETE /api/admin/config/:id
 *   Soft-deletes a persisted config record (issue #31). The row is retained and
 *   hidden from default reads, and stays restorable for the retention window.
 *
 * POST /api/admin/config/:id/restore
 *   Restores a soft-deleted record while its retention window is open.
 *
 * GET /api/admin/config/:id/deletion-state
 *   Reports the tombstone: who deleted it, why, when it will be purged.
 *
 * POST /api/admin/config/purge
 *   Runs the retention purge on demand (the same work the scheduled
 *   maintenance task performs).
 *
 * @module routes/adminConfig
 */

const express = require('express');
const crypto = require('crypto');
const { createCompressionMiddleware } = require('../middleware/compression');
const { adminStack } = require('../middleware/stacks');
const {
  runtimeConfigSchema,
  validateBody,
} = require('../schemas/config');
const { adminConfigLimiter } = require('../middleware/rateLimit');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
const { configErrorHandler } = require('../middleware/configErrorHandler');
const optionalIdempotency = require('../middleware/optionalIdempotency');
const { instrumentConfig } = require('../middleware/configMetrics');
const { toAdminConfigRequestDto, fromAdminConfigRequestDto } = require('../dto/config');
const { applyConfig, getConfigSections } = require('../services/configService');
const { SOFT_DELETE_ERRORS } = require('../services/configSoftDelete');
const AppError = require('../errors/AppError');
const logger = require('../logger');

const router = express.Router();

// Compress config responses above 500 bytes
router.use(createCompressionMiddleware({ threshold: 500 }));

// Rate limit before auth
router.use(adminConfigLimiter);

// Admin auth + tenant extraction
router.use(...adminStack);

/**
 * Maps a config soft-delete service error onto an RFC 7807 `AppError`.
 *
 * @param {Error & { code?: string, status?: number }} err - Service error.
 * @param {import('express').Request} req - Request (for `instance`).
 * @returns {Error} An `AppError` for known codes, or the original error.
 */
function _mapSoftDeleteError(err, req) {
  const known = {
    [SOFT_DELETE_ERRORS.INVALID_ID]: {
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

// ── POST /api/admin/config ────────────────────────────────────────────────────
router.post('/', optionalIdempotency, validateBody(runtimeConfigSchema), async (req, res, next) => {
  const validatedDto = toAdminConfigRequestDto(req.validated);
  const { section, config: validatedConfig } = fromAdminConfigRequestDto(validatedDto);

  try {
    const result = await applyConfig(section, validatedConfig, {
      tenantId: req.tenantId,
      adminClient: req.apiClient?.clientId || req.user?.sub,
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/admin/config/sections ───────────────────────────────────────────
/**
 * @swagger
 * /api/admin/config/sections:
 *   get:
 *     operationId: listConfigSections
 *     summary: List valid configuration section names
 *     description: |
 *       Returns the list of section names accepted by
 *       `POST /api/admin/config`.
 *       Supports conditional requests via ETag / If-None-Match (304).
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: If-None-Match
 *         schema:
 *           type: string
 *         required: false
 *         description: ETag from a previous response. Returns 304 if unchanged.
 *     responses:
 *       200:
 *         description: Section list retrieved.
 *         headers:
 *           ETag:
 *             schema:
 *               type: string
 *             description: Opaque validator for the current sections list.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sections:
 *                   type: array
 *                   items: { type: string }
 *       304:
 *         description: Not Modified — client already has the current version.
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.get('/sections', (req, res) => {
  const sections = getConfigSections();
  const body = { sections };

  // Stable ETag based on the current sections list
  const etag = `"${crypto
    .createHash('sha1')
    .update(JSON.stringify(sections))
    .digest('hex')}"`;

  // Conditional GET support
  const ifNoneMatch = req.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.set('ETag', etag);
    return res.status(304).end();
  }

  res.set('ETag', etag);
  return res.status(200).json(body);
});

// ── DELETE /api/admin/config/:id ───────────────────────────────────────────────
/**
 * @swagger
 * /api/admin/config/{id}:
 *   delete:
 *     operationId: softDeleteConfig
 *     summary: Soft-delete a config record
 *     description: |
 *       Marks the config record deleted. The row is retained (not purged) and
 *       excluded from default config reads. The record stays restorable via
 *       `POST /api/admin/config/{id}/restore` until its retention window
 *       (`CONFIG_SOFT_DELETE_RETENTION_DAYS`, default 30 days) elapses,
 *       after which the maintenance purge job removes it permanently.
 *       Requires admin authentication (JWT or API key).
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *                 id: { type: string }
 *                 section: { type: string }
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
 *         description: No config record for the id
 *       409:
 *         description: Record is already soft-deleted
 */
router.post('/', optionalIdempotency, validateBody(runtimeConfigSchema), async (req, res, next) => {
  try {
    const validatedDto = toAdminConfigRequestDto(req.validated);
    const { section, config: validatedConfig } = fromAdminConfigRequestDto(validatedDto);

    const result = await applyConfig(section, validatedConfig, {
      tenantId: req.tenantId,
      adminClient: req.apiClient?.clientId || req.user?.sub,
    });

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
});

// ── GET /api/admin/config/:id/deletion-state ────────────────────────────────────
/**
 * @swagger
 * /api/admin/config/{id}/deletion-state:
 *   get:
 *     operationId: getConfigDeletionState
 *     summary: Inspect the soft-delete state of a config record
 *     description: |
 *       Returns whether the record is soft-deleted, who deleted it and why, when
 *       it will be purged, and whether it is still restorable.
 *       Requires admin authentication (JWT or API key).
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *         description: No config record for the id
 */
router.get('/:id/deletion-state', async (req, res, next) => {
  try {
    const result = await getConfigDeletionState(req.params.id);
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

// ── POST /api/admin/config/purge ────────────────────────────────────────────────
/**
 * @swagger
 * /api/admin/config/purge:
 *   post:
 *     operationId: purgeExpiredConfigs
 *     summary: Purge config records past their retention window
 *     description: |
 *       Hard-deletes soft-deleted config records whose retention window has
 *       elapsed. Records still inside their window are never touched.
 *       Requires admin authentication (JWT or API key).
 *     tags: [AdminConfig]
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
    const summary = await purgeExpiredConfigSoftDeletes();
    logger.info(
      { purged: summary.purged, cutoff: summary.cutoff, requestId: req.id },
      'Admin triggered config retention purge'
    );
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

router.use(configErrorHandler);

module.exports = router;

