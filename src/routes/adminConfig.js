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
 * Rate limiting (issue #754): a per-client limiter is mounted *before* the
 * `adminStack` so that failed auth attempts still consume quota. This blocks
 * auth-flooding with bogus API keys / JWTs and bounds the blast radius of a
 * buggy redeploy loop hammering this surface. Limits are env-driven and
 * default to 20 requests per 60 s window per client.
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
const { adminConfigLimiter } = require('../middleware/rateLimit');
const idempotencyMiddleware = require('../middleware/idempotency');
const logger = require('../logger');
const { applyConfigSection } = require('../services/configService');

const router = express.Router();

// ── Apply per-client rate limit *before* admin auth + tenant extraction ─────
// Mounting the limiter ahead of adminStack ensures failed authentication
// attempts still count toward each client's quota — defending against
// auth-flooding as well as legitimate bursts of config writes.
router.use(adminConfigLimiter);

// ── Apply admin auth + tenant extraction to every route ──────────────────────
router.use(...adminStack);

/**
 * Conditionally applies idempotency logic if the client provides the header.
 * Allows gradual rollout without breaking existing API clients.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Express next callback
 * @returns {void}
 */
const optionalIdempotency = (req, res, next) => {
  if (req.header('Idempotency-Key')) {
    return idempotencyMiddleware(req, res, next);
  }
  next();
};

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
 *       **Idempotency**: Requires an `Idempotency-Key` header. Retried
 *       requests with the same key and body return the original cached
 *       response; reusing a key with a different body returns 409.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Tenant-scoped.
 *       **Rate limit (issue #754)**: per client (API key / IP); default 20
 *       requests per 60 s window. Returns `429` with a `Retry-After` header
 *       when the budget is exhausted.
 *
 *       **Idempotency (issue #755)**: send an `Idempotency-Key` header (8-128
 *       URL-safe characters) to safely retry requests. Retries with the same
 *       key and payload will return the cached response.
 *
 *     tags: [AdminConfig]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[A-Za-z0-9._:-]{8,128}$'
 *         description: Unique idempotency key for this config update. Safe to retry with the same key.
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
 *                 enum: [webhook, reconciliation, kyc, retention, fraudThresholds, cors]
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
 *         description: Validation error — body contains invalid or missing fields, or missing/malformed Idempotency-Key.
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
 *       409:
 *         description: Idempotency key reused with a different request body.
 *         content:
 *           application/problem+json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:    { type: string }
 *                 title:   { type: string }
 *                 status:  { type: integer }
 *                 detail:  { type: string }
 *                 requestId: { type: string }
 *       429:
 *         description: Rate limit exceeded (issue #754) — see Retry-After header.
 *         headers:
 *           Retry-After:
 *             schema:
 *               type: integer
 *             description: Seconds until the rate-limit window resets.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:    { type: string }
 *                 title:   { type: string }
 *                 status:  { type: integer }
 *                 code:    { type: string }
 *                 retryable: { type: boolean }
 *                 retry_hint: { type: string }
 *                 scope:   { type: string }
 *                 error:   { type: string }
 *                 message: { type: string }
 */
router.post('/', idempotencyMiddleware, validateBody(runtimeConfigSchema), (req, res) => {
  // validateBody attaches the parsed, coerced payload to req.validated
  const { section, config: validatedConfig } = req.validated;

  // Apply runtime configuration changes for supported sections.
  applyConfigSection(section, validatedConfig);

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
