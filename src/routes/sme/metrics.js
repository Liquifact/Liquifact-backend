/**
 * @fileoverview SME Dashboard Metrics endpoint.
 * Provides aggregated invoice counts for the authenticated user.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { extractTenant } = require('../../middleware/tenant');
const { CursorError } = require('../../utils/cursorPagination');
const metricsService = require('../../services/metricsService');
const { validateMetricsRequest } = require('../../utils/metricsValidation');


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
 *         description: Bad Request - Missing tenant context or invalid cursor
 *       401:
 *         description: Unauthorized
 */
router.get('/metrics', authenticateToken, extractTenant, async (req, res, next) => {
  try {
    const ctx = validateMetricsRequest(req, res);
    if (!ctx) { return; }

    const { userId, tenantId } = ctx;
    const { cursor, limit } = req.query;

    let result;
    try {
      result = await metricsService.getSmeMetrics(tenantId, userId, { cursor, limit });
    } catch (err) {
      if (err.name === 'CursorError' || err instanceof CursorError) {
        return res.status(400).json({
          error: { message: err.message },
        });
      }
      throw err;
    }

    return res.json({
      data: result.data,
      meta: result.meta,
      error: null,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
