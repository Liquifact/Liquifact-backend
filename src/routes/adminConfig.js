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
const { saveDraft, publishConfig, getConfigVersion, getConfigHistory } = require('../services/configVersioning');
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


// ── POST /api/admin/config/draft ────────────────────────────────────────────
/**
 * @swagger
 * /api/admin/config/draft:
 *   post:
 *     operationId: saveConfigDraft
 *     summary: Save a configuration draft
 *     description: |
 *       Saves a configuration draft for operator review before publishing.
 *       If a draft already exists for the section+tenant, it is updated.
 *       Does not affect the currently published configuration.
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [section, config]
 *             properties:
 *               section: { type: string }
 *               config: { type: object }
 *     responses:
 *       201:
 *         description: Draft saved
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.post('/draft', validateBody(runtimeConfigSchema), async (req, res, next) => {
  try {
    const validatedDto = toAdminConfigRequestDto(req.validated);
    const { section, config: validatedConfig } = fromAdminConfigRequestDto(validatedDto);

    const draft = await saveDraft(section, validatedConfig, {
      tenantId: req.tenantId,
      actor: req.apiClient?.clientId || req.user?.sub,
    });

    return res.status(201).json({
      id: draft.id,
      section: draft.section,
      config: JSON.parse(draft.config),
      draftStatus: draft.draft_status,
      version: draft.version,
      diffSummary: draft.diff_summary,
      draftActor: draft.draft_actor,
      message: 'Draft saved for review.',
    });
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/admin/config/publish ──────────────────────────────────────────
/**
 * @swagger
 * /api/admin/config/publish:
 *   post:
 *     operationId: publishConfigVersion
 *     summary: Publish a configuration version
 *     description: |
 *       Publishes a configuration with optimistic concurrency control.
 *       Requires `expectedVersion` to match the current version, preventing
 *       silent overwrites from concurrent edits. Returns 409 if the version
 *       has changed since the operator loaded it.
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [section, config, expectedVersion]
 *             properties:
 *               section: { type: string }
 *               config: { type: object }
 *               expectedVersion: { type: integer, description: Current version for optimistic CAS }
 *     responses:
 *       200:
 *         description: Config published
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       409:
 *         description: Stale version — another operator published first
 *       422:
 *         description: No changes detected
 */
router.post('/publish', validateBody(runtimeConfigSchema), async (req, res, next) => {
  try {
    const validatedDto = toAdminConfigRequestDto(req.validated);
    const { section, config: validatedConfig } = fromAdminConfigRequestDto(validatedDto);

    const expectedVersion = req.body.expectedVersion !== undefined
      ? Number(req.body.expectedVersion)
      : undefined;

    const published = await publishConfig(section, validatedConfig, {
      tenantId: req.tenantId,
      actor: req.apiClient?.clientId || req.user?.sub,
      expectedVersion,
    });

    return res.status(200).json({
      id: published.id,
      section: published.section,
      config: JSON.parse(published.config),
      draftStatus: published.draft_status,
      version: published.version,
      diffSummary: published.diff_summary,
      publishedBy: published.published_by,
      publishedAt: published.published_at,
      message: `Configuration v${published.version} published.`,
    });
  } catch (err) {
    if (err.code === 'STALE_VERSION') {
      return res.status(409).json({
        type: 'https://liquifact.com/probs/stale-version',
        title: 'Stale Version',
        status: 409,
        detail: err.message,
      });
    }
    if (err.code === 'EMPTY_DIFF') {
      return res.status(422).json({
        type: 'https://liquifact.com/probs/empty-diff',
        title: 'No Changes',
        status: 422,
        detail: err.message,
      });
    }
    return next(err);
  }
});

// ── GET /api/admin/config/version/:section ──────────────────────────────────
/**
 * @swagger
 * /api/admin/config/version/{section}:
 *   get:
 *     operationId: getConfigVersion
 *     summary: Get current config version for a section
 *     description: Returns the current published or draft config with version info.
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: section
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Current version returned
 *       404:
 *         description: No config found for section
 */
router.get('/version/:section', async (req, res, next) => {
  try {
    const record = await getConfigVersion(req.params.section, req.tenantId);
    if (!record) {
      return res.status(404).json({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Not Found',
        status: 404,
        detail: `No configuration found for section '${req.params.section}'.`,
      });
    }
    return res.json({
      id: record.id,
      section: record.section,
      config: JSON.parse(record.config),
      draftStatus: record.draft_status,
      version: record.version,
      diffSummary: record.diff_summary,
      publishedBy: record.published_by,
      publishedAt: record.published_at,
      draftActor: record.draft_actor,
      createdAt: record.created_at,
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/admin/config/history/:section ──────────────────────────────────
/**
 * @swagger
 * /api/admin/config/history/{section}:
 *   get:
 *     operationId: getConfigHistory
 *     summary: Get version history for a config section
 *     description: Returns the last 20 versions for audit/review.
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: section
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Version history returned
 */
router.get('/history/:section', async (req, res, next) => {
  try {
    const history = await getConfigHistory(req.params.section, req.tenantId);
    return res.json({ section: req.params.section, versions: history });
  } catch (err) {
    return next(err);
  }
});

router.use(configErrorHandler);

module.exports = router;

