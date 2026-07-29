/**
 * @fileoverview SME Dashboard Metrics endpoints.
 *
 * Provides:
 *  - `GET /metrics`       — aggregated invoice counts for the authenticated user
 *  - `POST /metrics/bulk` — batch endpoint accepting an array of
 *    (tenantId, userId) pairs with per-item success/error results
 *
 * `POST /metrics/bulk` optionally accepts an `Idempotency-Key` header
 * (issue #745). When present, a retried request with the same key and an
 * identical body replays the original response instead of re-executing the
 * batch; the same key reused with a different body returns `409 Conflict`.
 * Omitting the header preserves the prior, non-idempotent behavior. Keys are
 * stored in the shared, TTL-bounded `idempotency_keys` table (see
 * `src/middleware/idempotency.js` and `src/jobs/idempotencyPurge.js`) and are
 * purged automatically once expired.
 *
 * @module routes/sme/metrics
 */

'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { extractTenant } = require('../../middleware/tenant');
const { CursorError } = require('../../utils/cursorPagination');
const invoiceService = require('../../services/invoiceService');
const { validateMetricsRequest } = require('../../utils/metricsValidation');
const optionalIdempotency = require('../../middleware/optionalIdempotency');
const {
  validateBulkMetricsBody,
  validateGetMetricsQuery,
} = require('../../schemas/metrics');
const {
  toSmeMetricsResponse,
  toSmeMetricsMeta,
  toSmeMetricsApiResponse,
} = require('../../dto/metrics');


/**
 * @swagger
 * /api/sme/metrics:
 *   get:
 *     operationId: getSmeMetrics
 *     summary: Get SME dashboard metrics
 *     description: |
 *       Returns aggregated, tenant- and owner-scoped invoice metrics for the
 *       authenticated SME user.
 *
 *       **Pagination**
 *       Supply `limit` (1–100, default 20) and optionally `cursor` (the
 *       `nextCursor` from a prior response) to page through individual
 *       invoice rows while still receiving the aggregated counts.
 *
 *       When neither `cursor` nor `limit` is provided the response shape
 *       is identical to the original (aggregated counts only).
 *     tags: [SME]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: x-tenant-id
 *         schema:
 *           type: string
 *         description: Tenant identifier (optional if supplied via JWT claim)
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Opaque cursor from the previous page's `nextCursor` field.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page (1–100, default 20).
 *     responses:
 *       200:
 *         description: Metrics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     open:
 *                       type: integer
 *                       description: Number of open invoices
 *                     funded:
 *                       type: integer
 *                       description: Number of funded invoices
 *                     settled:
 *                       type: integer
 *                       description: Number of settled invoices
 *                     defaulted:
 *                       type: integer
 *                       description: Number of defaulted invoices
 *                 meta:
 *                   type: object
 *                   properties:
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *                     version:
 *                       type: string
 *                     invoices:
 *                       type: array
 *                       items:
 *                         type: object
 *                       description: Paginated invoice rows (present when cursor or limit is supplied)
 *                     total:
 *                       type: integer
 *                       description: Total matching invoices
 *                     limit:
 *                       type: integer
 *                       description: Applied page size
 *                     hasMore:
 *                       type: boolean
 *                       description: Whether there are more pages
 *                     nextCursor:
 *                       type: string
 *                       nullable: true
 *                       description: Opaque cursor for the next page
 *                 error:
 *                   type: object
 *                   nullable: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Bad Request — missing tenant context, invalid cursor, or invalid query params
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/metrics',
  authenticateToken,
  extractTenant,
  validateGetMetricsQuery,
  async (req, res, next) => {
    try {
      const ctx = validateMetricsRequest(req, res);
      if (!ctx) { return; }

      const { userId, tenantId } = ctx;

      const rawMetrics = await invoiceService.getSmeInvoiceCounts(tenantId, userId);
      const data = toSmeMetricsResponse(rawMetrics);

      // Prefer schema-validated (and coerced) query values; fall back to raw
      // query strings to preserve backward compatibility.
      const validatedQuery = req.validatedQuery || {};
      const cursor =
        validatedQuery.cursor !== undefined
          ? validatedQuery.cursor
          : req.query.cursor;
      const limit =
        validatedQuery.limit !== undefined
          ? String(validatedQuery.limit)
          : req.query.limit;

      const usePagination = cursor !== undefined || limit !== undefined;

      if (!usePagination) {
        const meta = toSmeMetricsMeta({
          timestamp: new Date().toISOString(),
          version: '0.1.0',
        });
        return res.json(toSmeMetricsApiResponse(data, meta));
      }

      let result;
      try {
        result = await invoiceService.getSmeInvoiceList(tenantId, userId, { cursor, limit });
      } catch (err) {
        if (err.name === 'CursorError' || err instanceof CursorError) {
          return res.status(400).json({
            error: { message: err.message },
          });
        }
        throw err;
      }

      const meta = toSmeMetricsMeta({
        invoices: result.invoices,
        total: result.meta.total,
        limit: result.meta.limit,
        hasMore: result.meta.hasMore,
        nextCursor: result.meta.nextCursor,
        timestamp: new Date().toISOString(),
        version: '0.1.0',
      });
      return res.json(toSmeMetricsApiResponse(data, meta));
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * @swagger
 * /api/sme/metrics/bulk:
 *   post:
 *     operationId: bulkSmeMetrics
 *     summary: Bulk SME dashboard metrics
 *     description: |
 *       Accepts an array of `{ tenantId, userId }` pairs and returns
 *       per-item invoice counts without failing the whole batch.
 *
 *       **Batch limit:** 25 operations per request.
 *
 *       **Authorization:** Each item's `tenantId` must match the
 *       authenticated user's tenant scope. Cross-tenant pairs are
 *       rejected per-item with a 403-equivalent error entry.
 *     tags: [SME]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema:
 *           type: string
 *           minLength: 8
 *           maxLength: 128
 *           pattern: '^[A-Za-z0-9._:-]{8,128}$'
 *         description: |
 *           Optional client-generated key (8–128 URL-safe characters).
 *           When supplied, a retried request with the same key **and** the
 *           same request body replays the original response instead of
 *           re-running the batch. Reusing the same key with a different
 *           body returns `409 Conflict`. Omit the header to opt out of
 *           idempotency handling entirely (unchanged legacy behavior).
 *           Keys expire automatically after the configured TTL.
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
 *                 maxItems: 25
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [tenantId, userId]
 *                   properties:
 *                     tenantId:
 *                       type: string
 *                       maxLength: 128
 *                     userId:
 *                       type: string
 *                       maxLength: 128
 *     responses:
 *       200:
 *         description: Bulk metrics results
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
 *                       tenantId:
 *                         type: string
 *                       userId:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [success, error]
 *                       data:
 *                         type: object
 *                         nullable: true
 *                       error:
 *                         type: string
 *                         nullable: true
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     succeeded:
 *                       type: integer
 *                     failed:
 *                       type: integer
 *                     timestamp:
 *                       type: string
 *       400:
 *         description: Validation error (empty array, over-cap, missing fields)
 *       401:
 *         description: Unauthorized
 *       409:
 *         description: |
 *           Idempotency-Key was reused with a different request body.
 *           Returned as an RFC 7807 problem+json document.
 */
router.post(
  '/metrics/bulk',
  authenticateToken,
  extractTenant,
  express.json({ limit: '100kb' }),
  optionalIdempotency,
  validateBulkMetricsBody,
  async (req, res, next) => {
    try {
      const callerCtx = validateMetricsRequest(req, res);
      if (!callerCtx) {
        return;
      }

      const { tenantId: callerTenantId } = callerCtx;
      const { operations } = req.validated;

      const results = [];
      let succeeded = 0;
      let failed = 0;

      for (const op of operations) {
        const { tenantId, userId } = op;

        if (tenantId !== callerTenantId) {
          results.push({
            tenantId,
            userId,
            status: 'error',
            data: null,
            error: 'Cross-tenant access denied',
          });
          failed++;
          continue;
        }

        try {
          const data = await invoiceService.getSmeInvoiceCounts(tenantId, userId);
          results.push({
            tenantId,
            userId,
            status: 'success',
            data,
            error: null,
          });
          succeeded++;
        } catch (err) {
          results.push({
            tenantId,
            userId,
            status: 'error',
            data: null,
            error: err.message || 'Internal error',
          });
          failed++;
        }
      }

      return res.json({
        results,
        meta: {
          total: operations.length,
          succeeded,
          failed,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;