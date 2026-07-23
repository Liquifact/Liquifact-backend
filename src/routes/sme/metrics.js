/**
 * @fileoverview SME Dashboard Metrics endpoint.
 * Provides aggregated invoice counts for the authenticated user.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { extractTenant } = require('../../middleware/tenant');
const invoiceService = require('../../services/invoiceService');
const { validateMetricsRequest } = require('../../utils/metricsValidation');


/**
 * @swagger
 * /api/sme/metrics:
 *   get:
 *     operationId: getSmeMetrics
 *     summary: Get SME dashboard metrics
 *     description: Returns aggregated, tenant- and owner-scoped invoice metrics for the authenticated SME user.
 *     tags: [SME]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: x-tenant-id
 *         schema:
 *           type: string
 *         description: Tenant identifier (optional if supplied via JWT claim)
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
 *                 error:
 *                   type: object
 *                   nullable: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Bad Request - Missing tenant context
 *       401:
 *         description: Unauthorized
 */
router.get('/metrics', authenticateToken, extractTenant, async (req, res, next) => {
  try {
    const ctx = validateMetricsRequest(req, res);
    if (!ctx) { return; }

    const { userId, tenantId } = ctx;

    const metrics = await invoiceService.getSmeInvoiceCounts(tenantId, userId);

    return res.json({
      data: metrics,
      meta: {
        timestamp: new Date().toISOString(),
        version: '0.1.0'
      },
      error: null,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
