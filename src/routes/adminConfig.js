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
const optionalIdempotency = require('../middleware/optionalIdempotency');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
const logger = require('../logger');

const router = express.Router();

// Compress config responses above 500 bytes
router.use(createCompressionMiddleware({ threshold: 500 }));

// Rate limit before auth
router.use(adminConfigLimiter);

// Admin auth + tenant extraction
router.use(...adminStack);

// ── POST /api/admin/config ────────────────────────────────────────────────────
router.post('/', optionalIdempotency, validateBody(runtimeConfigSchema), (req, res) => {
  const validatedDto = toAdminConfigRequestDto(req.validated);
  const { section, config: validatedConfig } = fromAdminConfigRequestDto(validatedDto);

  const result = applyConfig(section, validatedConfig, {
    tenantId: req.tenantId,
    adminClient: req.apiClient?.clientId || req.user?.sub,
  });

  return res.status(200).json(result);
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

module.exports = router;ts = router;

