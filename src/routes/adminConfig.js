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
const idempotencyMiddleware = require('../middleware/idempotency');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
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
router.post('/', optionalIdempotency, validateBody(runtimeConfigSchema), instrumentConfig('config_update', (req, res) => {
  // validateBody attaches the parsed, coerced payload to req.validated
  const validatedDto = toAdminConfigRequestDto(req.validated);
  const { section, config: validatedConfig } = fromAdminConfigRequestDto(validatedDto);

  try {
    const result = await applyConfig(section, validatedConfig, {
      tenantId: req.tenantId,
      adminClient: req.apiClient?.clientId || req.user?.sub,
    });

  return res.status(200).json(result);
}));

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
router.get('/sections', instrumentConfig('config_sections', (req, res) => {
  return res.status(200).json({ sections: getConfigSections() });
}));

module.exports = router;

