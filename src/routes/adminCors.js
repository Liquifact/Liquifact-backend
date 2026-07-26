'use strict';

/**
 * @fileoverview Admin routes for bulk CORS origin management.
 *
 * POST /api/admin/cors/bulk
 *   Accepts a bounded array of CORS origin operations and processes each one
 *   independently, returning per-item success/error results.  A partial
 *   failure in one item does not prevent remaining items from being processed
 *   and the overall HTTP response is always 200 (the per-item `success` field
 *   tells the caller which items failed).
 *
 *   Supported per-item operations:
 *   - `add`     — Append an origin to the live allowlist.
 *   - `remove`  — Remove an origin from the live allowlist.
 *   - `replace` — Swap one origin for another in the live allowlist.
 *
 *   Validation errors for individual items are reported in-place in `results`
 *   rather than aborting the batch.  Structural errors (non-array body,
 *   over-cap batch, empty array) still return an RFC 7807 4xx response.
 *
 * Access: Admin-only (JWT bearer or API key). Tenant-scoped.
 *
 * Rate limiting: shares the config-endpoint limiter so that bulk calls
 * consume the same per-client budget as individual config writes.
 *
 * @module routes/adminCors
 */

const express = require('express');
const { adminStack } = require('../middleware/stacks');
const { adminConfigLimiter } = require('../middleware/rateLimit');
const {
  processBulkCorsOperations,
  BULK_CORS_MAX_OPERATIONS,
} = require('../config/cors');
const logger = require('../logger');

const router = express.Router();

// ── Per-client rate limit (shared with adminConfig, issue #754) ────────────
router.use(adminConfigLimiter);

// ── Admin auth + tenant extraction ────────────────────────────────────────
router.use(...adminStack);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/cors/bulk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/admin/cors/bulk:
 *   post:
 *     operationId: bulkCorsOperations
 *     summary: Bulk CORS origin operations
 *     description: |
 *       Processes a bounded array of CORS origin operations in one request.
 *
 *       Each item in the array is validated and applied independently — a
 *       failure in one item does not prevent the rest from running.  The
 *       response is always HTTP 200 with a `results` array containing the
 *       per-item outcome (`success`, `error`).
 *
 *       **Supported operations**
 *       - `add`     — Adds the origin to the live allowlist.
 *       - `remove`  — Removes the origin from the live allowlist.
 *       - `replace` — Replaces `origin` with `newOrigin` in the live allowlist.
 *
 *       **Batch cap**: The `operations` array must contain 1–25 items.
 *       Requests with more than 25 items are rejected with HTTP 400 before
 *       any operation is applied.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Tenant-scoped.
 *       **Rate limit**: same per-client budget as `POST /api/admin/config`.
 *
 *     tags: [AdminCors]
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
 *                 maxItems: 25
 *                 items:
 *                   type: object
 *                   required: [op, origin]
 *                   properties:
 *                     op:
 *                       type: string
 *                       enum: [add, remove, replace]
 *                     origin:
 *                       type: string
 *                       example: "https://app.example.com"
 *                     newOrigin:
 *                       type: string
 *                       example: "https://newapp.example.com"
 *                       description: Required and only valid when op is 'replace'.
 *     responses:
 *       200:
 *         description: |
 *           Batch processed. Inspect each result's `success` field to
 *           determine per-item outcome.
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
 *                       index:   { type: integer }
 *                       success: { type: boolean }
 *                       op:      { type: string }
 *                       origin:  { type: string }
 *                       newOrigin:
 *                         type: string
 *                         nullable: true
 *                       error:
 *                         type: string
 *                         nullable: true
 *                 updatedOrigins:
 *                   type: array
 *                   items: { type: string }
 *                 message: { type: string }
 *       400:
 *         description: |
 *           Structural validation error — `operations` is not an array, is
 *           empty, or exceeds the 25-item cap.
 *         content:
 *           application/problem+json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:   { type: string }
 *                 title:  { type: string }
 *                 status: { type: integer }
 *                 detail: { type: string }
 *                 code:   { type: string }
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       429:
 *         description: Rate limit exceeded — see Retry-After header.
 */
router.post('/bulk', (req, res) => {
  const { operations } = req.body || {};

  // ── Structural validation ────────────────────────────────────────────────

  if (!Array.isArray(operations)) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: '`operations` must be an array.',
      code: 'VALIDATION_ERROR',
    });
  }

  if (operations.length === 0) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: '`operations` must contain at least one item.',
      code: 'VALIDATION_ERROR',
    });
  }

  if (operations.length > BULK_CORS_MAX_OPERATIONS) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: `Batch too large: received ${operations.length} operations, maximum is ${BULK_CORS_MAX_OPERATIONS}.`,
      code: 'BATCH_TOO_LARGE',
    });
  }

  // ── Process batch ────────────────────────────────────────────────────────

  const { results, updatedOrigins } = processBulkCorsOperations(operations);

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  logger.info(
    {
      tenantId: req.tenantId,
      adminClient: req.apiClient?.clientId || req.user?.sub,
      total: results.length,
      succeeded,
      failed,
    },
    'Admin bulk CORS operation completed',
  );

  return res.status(200).json({
    results,
    updatedOrigins,
    message: `Bulk CORS operation completed: ${succeeded} succeeded, ${failed} failed.`,
  });
});

module.exports = router;
