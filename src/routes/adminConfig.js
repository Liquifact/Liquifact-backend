'use strict';

/**
 * @fileoverview Admin route for runtime configuration writes.
 *
 * POST /api/admin/config
 *   Accepts a `{ section, config }` body, validates it strictly with the
 *   section-specific Zod schema from `src/schemas/config.js`, and returns the
 *   validated configuration back to the caller.
 *
 *   Validation failures are rejected with a structured RFC 7807
 *   `application/problem+json` 400 response containing machine-readable
 *   `fieldErrors` so clients can map errors back to specific form fields.
 *
 * GET /api/admin/config/sections
 *   Returns the list of valid section names accepted by the POST endpoint.
 *
 * Access: Admin-only (JWT bearer or API key). Tenant-scoped.
 *
 * @module routes/adminConfig
 */

const express = require('express');
const { adminStack } = require('../middleware/stacks');
const {
  runtimeConfigSchema,
  validateBody,
  CONFIG_SECTIONS,
} = require('../schemas/config');
const logger = require('../logger');

const router = express.Router();

// ── Apply admin auth + tenant extraction to every route ──────────────────────
router.use(...adminStack);

// ── POST /api/admin/config ────────────────────────────────────────────────────

/**
 * @swagger
 * /api/admin/config:
 *   post:
 *     operationId: updateRuntimeConfig
 *     summary: Write a runtime configuration section
 *     description: |
 *       Validates and accepts a configuration update for one of the supported
 *       runtime config sections.  All fields are strictly validated:
 *       - Unknown keys are rejected (400).
 *       - Strings are length-bounded.
 *       - Numeric values are range-checked.
 *       - Categorical fields are allowlisted.
 *
 *       A machine-readable `fieldErrors` map is returned on any validation
 *       failure so that clients can highlight the offending fields.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Tenant-scoped.
 *
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
 *               section:
 *                 type: string
 *                 enum: [webhook, reconciliation, kyc, retention, fraudThresholds]
 *                 description: The configuration section to update.
 *               config:
 *                 type: object
 *                 description: Section-specific configuration payload.
 *     responses:
 *       200:
 *         description: Configuration validated and accepted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 section:
 *                   type: string
 *                 config:
 *                   type: object
 *                 message:
 *                   type: string
 *       400:
 *         description: Validation error — body contains invalid or missing fields.
 *         content:
 *           application/problem+json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:  { type: string }
 *                 title: { type: string }
 *                 status: { type: integer }
 *                 detail: { type: string }
 *                 code:   { type: string }
 *                 fieldErrors:
 *                   type: object
 *                   additionalProperties: { type: string }
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.post('/', validateBody(runtimeConfigSchema), (req, res) => {
  // validateBody attaches the parsed, coerced payload to req.validated
  const { section, config: validatedConfig } = req.validated;

  logger.info(
    {
      tenantId: req.tenantId,
      section,
      adminClient: req.apiClient?.clientId || req.user?.sub,
    },
    'Admin runtime config update accepted',
  );

  return res.status(200).json({
    section,
    config: validatedConfig,
    message: `Configuration section '${section}' validated and accepted.`,
  });
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
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Section list retrieved.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sections:
 *                   type: array
 *                   items: { type: string }
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.get('/sections', (req, res) => {
  return res.status(200).json({ sections: CONFIG_SECTIONS });
});

module.exports = router;
