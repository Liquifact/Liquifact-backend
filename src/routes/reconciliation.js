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
const { SettlementDryRunError, runSettlementDryRun } = require('../jobs/settlementDryRun');
const { InvoiceFundingReconciliationError } = require('../jobs/invoiceFundingReconciliation');
const { createTenantInvoiceFundingDbSource } = require('../jobs/settlementDryRunDbSource');

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
      dbClient('reconciliation_runs').where({ tenant_id: req.tenantId }).count('id as count'),
      dbClient('reconciliation_runs')
        .where({ tenant_id: req.tenantId })
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

/**
 * @swagger
 * /api/admin/reconciliation/settlement/dry-run:
 *   post:
 *     operationId: runSettlementDryRun
 *     summary: Preview proposed funding-settlement corrections (read-only)
 *     description: |
 *       Runs the bounded, read-only invoice-funding-reconciliation scan for
 *       the authenticated tenant and returns proposed corrections and manual-
 *       review reasons, without applying anything.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Tenant-scoped — only
 *       the authenticated tenant's invoices and funding records are read.
 *
 *       **This is a preview only.** The request body must set
 *       `"mode": "dry-run"` — any other value (including `"apply"`) is
 *       rejected with `400 INVALID_MODE` before any data is read. There is no
 *       endpoint, mode, or code path in this service that applies a proposed
 *       settlement correction; automatic application is explicitly out of
 *       scope for this feature.
 *
 *       **No writes, no external calls.** This endpoint only issues `SELECT`
 *       queries against `invoices`, `escrow_summaries`, and `escrow_operations`
 *       for the authenticated tenant. It never writes to the database and
 *       never calls the Soroban RPC or any other external service.
 *     tags: [Reconciliation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mode]
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [dry-run]
 *                 description: Must be the literal string "dry-run". No other value is supported.
 *               pageSize:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 1000
 *                 description: Rows read per DB page during the underlying scan. Default 100.
 *               maxRecords:
 *                 type: integer
 *                 minimum: 1
 *                 description: Safety ceiling on total invoices scanned in this call. Default 10000.
 *               maxProposals:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 2000
 *                 description: Cap on combined proposed-change + manual-review items returned. Default 500.
 *               runId:
 *                 type: string
 *                 description: Optional caller-supplied correlation id, echoed back in the response.
 *     responses:
 *       200:
 *         description: Settlement dry-run completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     runId: { type: string }
 *                     mode: { type: string, enum: [dry-run] }
 *                     status: { type: string, enum: [clean, drift, incomplete] }
 *                     scanned: { type: integer }
 *                     complete: { type: boolean }
 *                     proposedChangeCount: { type: integer }
 *                     manualReviewCount: { type: integer }
 *                     truncated: { type: boolean }
 *                     proposedChanges: { type: array, items: { type: object } }
 *                     manualReview: { type: array, items: { type: object } }
 *       400:
 *         description: Missing/invalid mode, or invalid pagination options
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StandardEnvelope'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       502:
 *         description: The tenant's funding data could not be read (DB read failure)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StandardEnvelope'
 */

/**
 * POST /api/admin/reconciliation/settlement/dry-run
 *
 * Bounded, read-only settlement-correction preview for the authenticated
 * tenant's invoice funding data. See the swagger block above for the full
 * request/response contract.
 *
 * Security notes:
 *   - `mode` must be exactly `"dry-run"`; every other value — including
 *     `"apply"` — is rejected with 400 before any query runs. There is no
 *     apply code path anywhere in this router or the jobs it calls.
 *   - The DB source (`createTenantInvoiceFundingDbSource`) is built with
 *     `req.tenantId` (set by `extractTenant` in `adminStack`) and every query
 *     it issues is scoped to that tenant; a caller can never read another
 *     tenant's invoices or funding records through this endpoint.
 *   - Only typed, pre-validated error messages (`INVALID_MODE`,
 *     `INVALID_OPTIONS`) are ever sent to the client. Any other failure
 *     (DB error, etc.) is forwarded to the central error handler via
 *     `next(error)`, which returns a generic `Internal server error` message
 *     with no stack trace or DB detail in non-development environments.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next.
 * @returns {Promise<void>}
 */
router.post('/settlement/dry-run', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    const dbClient = req._dbClient || db;
    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: req.tenantId });

    const report = await runSettlementDryRun({
      source,
      mode: body.mode,
      pageSize: body.pageSize,
      maxRecords: body.maxRecords,
      maxProposals: body.maxProposals,
      runId: body.runId,
    });

    logger.info(
      {
        requestId: req.id,
        tenantId: req.tenantId,
        runId: report.runId,
        status: report.status,
        scanned: report.scanned,
        proposedChangeCount: report.proposedChangeCount,
        manualReviewCount: report.manualReviewCount,
        truncated: report.truncated,
      },
      'Settlement dry-run completed',
    );

    return res.status(200).json({
      ...responseHelper.success(report),
      message: 'Settlement dry-run completed successfully.',
    });
  } catch (error) {
    if (error instanceof SettlementDryRunError && (error.code === 'INVALID_MODE' || error.code === 'INVALID_OPTIONS')) {
      // Client-supplied input problem — the message is a fixed, pre-written
      // validation string with no DB detail, safe to return directly.
      return res.status(400).json(responseHelper.error(error.message, error.code));
    }
    if (error instanceof InvoiceFundingReconciliationError && error.code === 'INVALID_OPTIONS') {
      return res.status(400).json(responseHelper.error(error.message, error.code));
    }
    if (error instanceof InvoiceFundingReconciliationError) {
      // SOURCE_UNAVAILABLE / INVALID_SOURCE_BATCH: the scan itself failed
      // (DB read error or a malformed adapter page) — not a client input
      // problem. The message is a fixed, pre-written string with no DB
      // detail (see invoiceFundingReconciliation.js), so it is still safe
      // to surface, but the status code reflects that this is a server-side
      // failure rather than bad input.
      logger.error(
        { requestId: req.id, tenantId: req.tenantId, code: error.code },
        'Settlement dry-run source read failed',
      );
      return res.status(502).json(responseHelper.error('Funding data could not be read for this tenant. Please retry.', error.code));
    }
    logger.error(
      { requestId: req.id, tenantId: req.tenantId, err: error?.message },
      'Settlement dry-run failed',
    );
    return next(error);
  }
});

module.exports = router;
