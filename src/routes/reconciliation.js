'use strict';

/**
 * @fileoverview Paginated reconciliation run history endpoint.
 *
 * Exposes recent rows from the `reconciliation_runs` table to authorized
 * admin callers. The endpoint is scoped to the authenticated tenant and
 * protected by the standard admin middleware stack.
 *
 * No raw on-chain values (contract addresses, XDR, ledger keys) are leaked
 * in any response or error path.
 *
 * @module routes/reconciliation
 */

const express = require('express');
const router = express.Router();
const db = require('../db/knex');
const { adminStack } = require('../middleware/stacks');
const responseHelper = require('../utils/responseHelper');
const logger = require('../logger');

/**
 * Maximum allowed page size for the runs history listing.
 * @constant {number}
 */
const MAX_LIMIT = 100;

/**
 * Default page size when `limit` is not supplied by the caller.
 * @constant {number}
 */
const DEFAULT_LIMIT = 20;

// Apply admin auth (JWT or API key) + tenant extraction to every route in this file.
router.use(...adminStack);

/**
 * @swagger
 * /api/admin/reconciliation/runs:
 *   get:
 *     operationId: listReconciliationRuns
 *     summary: List recent escrow reconciliation runs (paginated)
 *     description: |
 *       Returns a paginated list of nightly escrow reconciliation runs from
 *       the `reconciliation_runs` table, ordered newest-first.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Tenant-scoped.
 *
 *       **Pagination**
 *       | Param | Default | Range | Notes |
 *       |-------|---------|-------|-------|
 *       | `limit` | 20 | 1–100 | Rows per page |
 *       | `page`  | 1  | ≥ 1   | 1-based page number |
 *
 *       **Per-invoice result details** are omitted from list rows to keep
 *       payloads small. The `results` JSON column is never surfaced here —
 *       raw on-chain values are not exposed through this endpoint.
 *     tags: [Reconciliation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of rows per page
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: 1-based page number
 *     responses:
 *       200:
 *         description: Reconciliation runs retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReconciliationRun'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       400:
 *         description: Invalid pagination parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StandardEnvelope'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */

/**
 * GET /api/admin/reconciliation/runs
 *
 * Returns a paginated list of recent escrow reconciliation run summaries.
 * Rows are ordered by `reconciled_at DESC` (most recent first).
 * Per-invoice `results` JSON is intentionally excluded to avoid leaking
 * on-chain funding figures in bulk list responses.
 *
 * Query parameters:
 *   - `limit` {integer}  Rows per page. Clamped to [1, 100]. Default: 20.
 *   - `page`  {integer}  1-based page number. Default: 1.
 *
 * Response 200:
 *   Standard success envelope whose `data` array contains reconciliation run
 *   summary objects and whose `meta` carries pagination counters.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next.
 * @returns {Promise<void>}
 */
router.get('/runs', async (req, res, next) => {
  // ── Input validation ──────────────────────────────────────────────────────
  const rawLimit = req.query.limit;
  const rawPage = req.query.page;

  if (rawLimit !== undefined) {
    const v = parseInt(rawLimit, 10);
    if (isNaN(v) || v < 1 || v > MAX_LIMIT) {
      return res.status(400).json(
        responseHelper.error(
          `limit must be an integer between 1 and ${MAX_LIMIT}`,
          'INVALID_PAGINATION',
        ),
      );
    }
  }
  if (rawPage !== undefined) {
    const v = parseInt(rawPage, 10);
    if (isNaN(v) || v < 1) {
      return res.status(400).json(
        responseHelper.error('page must be an integer >= 1', 'INVALID_PAGINATION'),
      );
    }
  }

  const limit = rawLimit !== undefined ? Math.min(parseInt(rawLimit, 10), MAX_LIMIT) : DEFAULT_LIMIT;
  const page = rawPage !== undefined ? Math.max(1, parseInt(rawPage, 10)) : 1;
  const offset = (page - 1) * limit;

  // ── DB query ──────────────────────────────────────────────────────────────
  try {
    const dbClient = req._dbClient || db;

    // Fetch the total count and the current page in parallel.
    const [countResult, rows] = await Promise.all([
      dbClient('reconciliation_runs').count('id as count'),
      dbClient('reconciliation_runs')
        .select(
          'id',
          'total',
          'matches',
          'mismatches',
          'errors',
          'reconciled_at',
          'created_at',
        )
        .orderBy('reconciled_at', 'desc')
        .limit(limit)
        .offset(offset),
    ]);

    const total = parseInt(countResult[0].count, 10) || 0;
    const totalPages = Math.ceil(total / limit);

    logger.info(
      { requestId: req.id, page, limit, total, tenantId: req.tenantId },
      'Reconciliation runs history retrieved',
    );

    return res.status(200).json({
      ...responseHelper.success(rows, {
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
      }),
      message: 'Reconciliation runs retrieved successfully.',
    });
  } catch (error) {
    logger.error(
      { err: error?.message, tenantId: req.tenantId },
      'Failed to fetch reconciliation runs history',
    );
    return next(error);
  }
});

module.exports = router;
