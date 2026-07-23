'use strict';

/**
 * @fileoverview Marketplace routes for searching and sorting invoices.
 * @module routes/marketplace
 */

const express = require('express');
const router = express.Router();
const marketplaceService = require('../services/marketplaceService');
const { validateMarketplaceQueryParams } = require('../utils/validators');
const { CursorError } = require('../utils/cursorPagination');
const { authenticatedTenantStack } = require('../middleware/stacks');
const { cacheResponse, makeMarketplaceKey } = require('../middleware/cache');
const { getSharedStore } = require('../services/cacheStore');
const logger = require('../logger');

router.use(...authenticatedTenantStack);

const CACHE_TTL_MS = 15000;
const cacheMiddleware = cacheResponse({
  ttl: CACHE_TTL_MS,
  store: getSharedStore(),
  keyFn: makeMarketplaceKey,
});

/**
 * @swagger
 * /api/marketplace:
 *   get:
 *     operationId: listMarketplaceInvoices
 *     summary: Search and sort marketplace invoices
 *     description: |
 *       Retrieve a paginated list of invoices available in the marketplace with
 *       advanced filtering and sorting.
 *
 *       **Pagination modes**
 *
 *       | Mode | Parameters | Notes |
 *       |------|-----------|-------|
 *       | Cursor (recommended) | `cursor` + `limit` | Stable under inserts/deletes; use `nextCursor` from the previous response |
 *       | Offset (legacy) | `page` + `limit` | Backward-compatible; may drift on busy datasets |
 *
 *       When `cursor` is supplied, `page` is ignored.
 *       The cursor is opaque and HMAC-signed — any modification returns 400.
 *       Cursors are tied to a specific `sortBy` field; switching sort order
 *       mid-pagination requires starting from the first page (no `cursor`).
 *     tags: [Marketplace]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [verified, partially_funded]
 *         description: Filter by invoice status (only publicly investable statuses allowed)
 *       - in: query
 *         name: yieldBpsMin
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Minimum yield in basis points
 *       - in: query
 *         name: yieldBpsMax
 *         schema:
 *           type: integer
 *           minimum: 0
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
 *           minimum: 0
 *           maximum: 100
 *         description: Minimum funded ratio (0–100)
 *       - in: query
 *         name: fundedRatioMax
 *         schema:
 *           type: number
 *           minimum: 0
 *           maximum: 100
 *         description: Maximum funded ratio (0–100)
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [yield_bps, maturity_date, funded_ratio, amount, created_at]
 *           default: created_at
 *         description: Field to sort by. Must stay constant across pages when using cursor pagination.
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order. Must stay constant across pages when using cursor pagination.
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: |
 *           Opaque, HMAC-signed cursor returned as `nextCursor` in a previous
 *           response.  When present, offset-based `page` is ignored.
 *           A malformed or tampered cursor returns 400.
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number (offset mode only; ignored when `cursor` is supplied)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Items per page (applies to both pagination modes)
 *     responses:
 *       200:
 *         description: Marketplace invoices retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MarketplaceListResponse'
 *             examples:
 *               cursorFirstPage:
 *                 summary: First page (cursor mode)
 *                 value:
 *                   data: []
 *                   meta:
 *                     total: 42
 *                     limit: 10
 *                     hasMore: true
 *                     nextCursor: "eyJzb3J0RmllbGQiOiJ5aWVsZF9icHMi....<sig>"
 *                   message: "Marketplace invoices retrieved successfully."
 *               cursorLastPage:
 *                 summary: Last page (cursor mode)
 *                 value:
 *                   data: []
 *                   meta:
 *                     total: 42
 *                     limit: 10
 *                     hasMore: false
 *                     nextCursor: null
 *                   message: "Marketplace invoices retrieved successfully."
 *               offsetMode:
 *                 summary: Offset mode (legacy)
 *                 value:
 *                   data: []
 *                   meta:
 *                     total: 42
 *                     page: 2
 *                     limit: 10
 *                     totalPages: 5
 *                     hasMore: true
 *                     nextCursor: "eyJzb3J0RmllbGQiOiJ5aWVsZF9icHMi....<sig>"
 *                   message: "Marketplace invoices retrieved successfully."
 *       400:
 *         description: |
 *           Invalid query parameters or malformed/tampered cursor.
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 */
router.get('/', cacheMiddleware, async (req, res, next) => {
  try {
    const { isValid, fieldErrors, validatedParams } = validateMarketplaceQueryParams(req.query);

    if (!isValid) {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Query parameters contain invalid values.',
        fieldErrors,
      });
    }

    // Enforce explicit visibility rules; never allow clients to enumerate
    // tenant-private statuses via filter manipulation.
    if (
      validatedParams.filters &&
      validatedParams.filters.status &&
      !marketplaceService.PUBLIC_INVESTABLE_INVOICE_STATUSES.includes(validatedParams.filters.status)
    ) {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Query parameters contain invalid values.',
        fieldErrors: {
          status: `Invalid status for marketplace. Must be one of: ${marketplaceService.PUBLIC_INVESTABLE_INVOICE_STATUSES.join(', ')}`,
        },
      });
    }

    let result;
    try {
      result = await marketplaceService.getMarketplaceInvoices({
        tenantId: req.tenantId,
        queryParams: validatedParams,
      });
    } catch (err) {
      // CursorError is a client error (malformed/tampered cursor) → 400
      if (err instanceof CursorError) {
        return res.status(400).json({
          type: 'https://liquifact.io/problems/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'Query parameters contain invalid values.',
          fieldErrors: {
            cursor: err.message,
          },
        });
      }
      throw err;
    }

    logger.info({
      requestId: req.id,
      count: result.data.length,
      total: result.meta.total,
      hasMore: result.meta.hasMore,
      usedCursor: Boolean(validatedParams.pagination && validatedParams.pagination.cursor),
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
