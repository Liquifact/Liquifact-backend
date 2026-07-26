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
 * POST /api/admin/config/bulk
 *   Accepts `{ operations: [{ section, config }, ...] }`, validates each item
 *   independently, and returns per-item success/error results. The batch is
 *   capped at BULK_CONFIG_MAX_ITEMS (default 10). Individual item failures do
 *   not reject the entire batch.
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
const compression = require('compression');
const { adminStack } = require('../middleware/stacks');
const {
  runtimeConfigSchema,
  validateBody,
  CONFIG_SECTIONS,
  bulkConfigSchema,
  parseValidationErrors,
} = require('../schemas/config');
const { adminConfigLimiter } = require('../middleware/rateLimit');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
const logger = require('../logger');

const router = express.Router();

// Compress config responses above 500 bytes (issue #52)
router.use(compression({ threshold: 500 }));

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
 *         schema:
 *           type: string
 *         required: false
 *         description: Optional 8-128 character URL-safe string to safely retry requests without double-applying.
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
 *         description: Validation error — body contains invalid or missing fields, or idempotency key is malformed.
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
 *         description: Idempotency conflict — the key was reused with a different payload.
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
router.post('/', optionalIdempotency, validateBody(runtimeConfigSchema), (req, res) => {
  // validateBody attaches the parsed, coerced payload to req.validated
  const validatedDto = toAdminConfigRequestDto(req.validated);
  const { section, config: validatedConfig } = fromAdminConfigRequestDto(validatedDto);

  // Apply runtime configuration changes for supported sections.
  applyConfigSection(section, validatedConfig);

  const adminClient = req.apiClient?.clientId || req.user?.sub || 'system';

  logger.info(
    {
      tenantId: req.tenantId,
      section,
      adminClient,
    },
    'Admin runtime config update accepted',
  );

  // Fire-and-forget outbound webhook emission for config update
  emitConfigWebhook({
    tenantId: req.tenantId,
    section,
    config: validatedConfig,
    actor: adminClient,
  }).catch((err) => {
    logger.error(
      { err: err.message, tenantId: req.tenantId, section },
      'Failed to emit config event webhook',
    );
  });

  return res.status(200).json({
    section,
    config: validatedConfig,
    message: `Configuration section '${section}' validated and accepted.`,
  });

  return res.status(200).json(responseDto);
});

// ── POST /api/admin/config/bulk ─────────────────────────────────────────────

/**
 * Applies runtime CORS side-effects for a validated CORS config item.
 * Extracted as a helper so both the single and bulk handlers share the same
 * logic without duplication.
 *
 * @param {object} validatedConfig - Validated CORS configuration object.
 * @returns {void}
 */
function applyCorsEffects(validatedConfig) {
  if (validatedConfig.origins) {
    process.env.CORS_ALLOWED_ORIGINS = validatedConfig.origins.join(',');
    reloadCorsOrigins();
  }
  if (validatedConfig.maxAge !== undefined) {
    process.env.CORS_MAX_AGE = String(validatedConfig.maxAge);
    reloadCorsMaxAge();
  }
}

/**
 * @swagger
 * /api/admin/config/bulk:
 *   post:
 *     operationId: bulkUpdateRuntimeConfig
 *     summary: Bulk-write runtime configuration sections
 *     description: |
 *       Accepts an array of configuration operations and processes each
 *       independently. Individual item failures do not reject the entire
 *       batch — the response always contains per-item results.
 *
 *       **Batch cap**: at most `BULK_CONFIG_MAX_ITEMS` operations (default 10).
 *       Exceeding the cap rejects the entire request with 400.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Tenant-scoped.
 *       **Rate limit**: shares the per-client budget with the single config
 *       endpoint (issue #754).
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
 *             required: [operations]
 *             properties:
 *               operations:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 10
 *                 items:
 *                   type: object
 *                   required: [section, config]
 *                   properties:
 *                     section:
 *                       type: string
 *                       enum: [webhook, reconciliation, kyc, retention, fraudThresholds, cors]
 *                     config:
 *                       type: object
 *     responses:
 *       200:
 *         description: Batch processed. Per-item results are in the `results` array.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       index:
 *                         type: integer
 *                       section:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [success, error]
 *                       config:
 *                         type: object
 *                       errors:
 *                         type: object
 *                         additionalProperties: { type: string }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     succeeded: { type: integer }
 *                     failed: { type: integer }
 *       400:
 *         description: Envelope validation error (e.g. over-cap, empty batch, missing operations).
 *         content:
 *           application/problem+json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:  { type: string }
 *                 title: { type: string }
 *                 status: { type: integer }
 *                 detail: { type: string }
 *                 fieldErrors:
 *                   type: object
 *                   additionalProperties: { type: string }
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       429:
 *         description: Rate limit exceeded — see Retry-After header.
 */
router.post('/bulk', validateBody(bulkConfigSchema), (req, res) => {
  const { operations } = req.validated;
  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const itemResult = runtimeConfigSchema.safeParse(op);

    if (itemResult.success) {
      const { section, config: validatedConfig } = itemResult.data;

      // Apply CORS side-effects inline (same behaviour as single endpoint)
      if (section === 'cors') {
        applyCorsEffects(validatedConfig);
      }

      results.push({
        index: i,
        section,
        status: 'success',
        config: validatedConfig,
      });
      succeeded++;
    } else {
      const errors = parseValidationErrors(itemResult.error);
      results.push({
        index: i,
        section: op.section || null,
        status: 'error',
        errors,
      });
      failed++;
    }
  }

  logger.info(
    {
      tenantId: req.tenantId,
      total: operations.length,
      succeeded,
      failed,
      adminClient: req.apiClient?.clientId || req.user?.sub,
    },
    'Admin bulk config update processed',
  );

  return res.status(200).json({
    results,
    summary: {
      total: operations.length,
      succeeded,
      failed,
    },
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
  const sectionsDto = fromConfigSectionsResponseDto({ sections: CONFIG_SECTIONS });
  return res.status(200).json(sectionsDto);
});

module.exports = router;

