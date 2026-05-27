'use strict';

/**
 * @fileoverview Marketplace routes for searching and sorting invoices.
 * @module routes/marketplace
 */

const express = require('express');
const router = express.Router();
const marketplaceService = require('../services/marketplaceService');
const { validateMarketplaceQueryParams } = require('../utils/validators');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../logger');

/**
 * @swagger
 * /api/marketplace:
 *   get:
 *     summary: Search and sort marketplace invoices
 *     description: Retrieve a paginated list of invoices available in the marketplace with advanced filtering and sorting.
 *     tags: [Marketplace]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by invoice status
 *       - in: query
 *         name: yieldBpsMin
 *         schema:
 *           type: integer
 *         description: Minimum yield in basis points
 *       - in: query
 *         name: yieldBpsMax
 *         schema:
 *           type: integer
 *         description: Maximum yield in basis points
 *       - in: query
 *         name: maturityDateFrom
 *         schema:
 *           type: string
 *           format: date
 *         description: Minimum maturity date (YYYY-MM-DD)
 *       - in: query
 *         name: maturityDateTo
 *         schema:
 *           type: string
 *           format: date
 *         description: Maximum maturity date (YYYY-MM-DD)
 *       - in: query
 *         name: fundedRatioMin
 *         schema:
 *           type: number
 *         description: Minimum funded ratio (0-100)
 *       - in: query
 *         name: fundedRatioMax
 *         schema:
 *           type: number
 *         description: Maximum funded ratio (0-100)
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [yield_bps, maturity_date, funded_ratio, amount, created_at]
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Marketplace invoices retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MarketplaceListResponse'
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 */
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { isValid, errors, validatedParams } = validateMarketplaceQueryParams(req.query);

    if (!isValid) {
      return res.status(400).json({ errors });
    }

    const result = await marketplaceService.getMarketplaceInvoices(validatedParams);

    logger.info({ 
      requestId: req.id, 
      count: result.data.length,
      total: result.meta.total 
    }, 'Retrieved marketplace invoices');

    return res.json({
      ...result,
      message: 'Marketplace invoices retrieved successfully.',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
