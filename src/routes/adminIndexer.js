'use strict';

/**
 * @fileoverview Admin indexer events listing endpoint.
 *
 * Exposes a cursor-paginated read over the `escrow_events` table so operators
 * can inspect indexed Soroban / Horizon contract events without querying the
 * database directly.
 *
 * Route:  GET /api/admin/indexer/events
 * Access: Admin-only (JWT bearer or API key).
 *
 * @module routes/adminIndexer
 */

const express = require('express');

const router = express.Router();
const { listIndexerEvents, INDEXER_SORT_FIELDS } = require('../services/indexerService');
const { CursorError } = require('../utils/cursorPagination');
const { adminStack } = require('../middleware/stacks');
const responseHelper = require('../utils/responseHelper');
const logger = require('../logger');

/**
 * Maximum page size clamped by the service layer.
 * @constant {number}
 */
const MAX_LIMIT = 100;

// Apply admin auth (JWT or API key) + tenant extraction to every route in this
// file.
router.use(...adminStack);

/**
 * Validates and normalises query parameters for the events listing endpoint.
 *
 * @param {object} query - Express `req.query` object.
 * @returns {{ isValid: boolean, fieldErrors: Record<string,string>, params: object }}
 */
function _parseQuery(query) {
  const fieldErrors = {};
  const params = { filters: {}, sorting: {}, pagination: {} };

  const ALLOWED_PARAMS = new Set(['invoiceId', 'eventType', 'contractId', 'sortBy', 'order', 'cursor', 'page', 'limit']);
  const unknown = Object.keys(query).filter((k) => !ALLOWED_PARAMS.has(k));
  if (unknown.length > 0) {
    fieldErrors._unknown = `Unknown query parameters: ${unknown.join(', ')}`;
  }

  const { invoiceId, eventType, contractId, sortBy, order, cursor, page, limit } = query;

  // ── Filters ───────────────────────────────────────────────────────────────
  if (invoiceId !== undefined) {
    if (typeof invoiceId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(invoiceId.trim())) {
      params.filters.invoiceId = invoiceId.trim();
    } else {
      fieldErrors.invoiceId = 'invoiceId must be 1–128 alphanumeric/underscore/hyphen characters';
    }
  }

  if (eventType !== undefined) {
    if (typeof eventType === 'string' && eventType.trim().length > 0 && eventType.trim().length <= 128) {
      params.filters.eventType = eventType.trim();
    } else {
      fieldErrors.eventType = 'eventType must be a non-empty string (max 128 chars)';
    }
  }

  if (contractId !== undefined) {
    if (typeof contractId === 'string' && /^C[A-Z2-7]{55}$/.test(contractId.trim())) {
      params.filters.contractId = contractId.trim();
    } else {
      fieldErrors.contractId = 'contractId must be a valid Stellar contract address (C… 56 chars)';
    }
  }

  // ── Sorting ───────────────────────────────────────────────────────────────
  if (sortBy !== undefined) {
    if (INDEXER_SORT_FIELDS.includes(sortBy)) {
      params.sorting.sortBy = sortBy;
    } else {
      fieldErrors.sortBy = `sortBy must be one of: ${INDEXER_SORT_FIELDS.join(', ')}`;
    }
  }

  if (order !== undefined) {
    const lowerOrder = String(order).toLowerCase();
    if (lowerOrder === 'asc' || lowerOrder === 'desc') {
      params.sorting.order = lowerOrder;
    } else {
      fieldErrors.order = 'order must be "asc" or "desc"';
    }
  }

  // ── Pagination ────────────────────────────────────────────────────────────
  if (cursor !== undefined) {
    if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048) {
      params.pagination.cursor = cursor;
    } else {
      fieldErrors.cursor = 'cursor must be a non-empty string (max 2048 chars)';
    }
  }

  // page is only relevant when no cursor is provided
  if (cursor === undefined && page !== undefined) {
    const val = parseInt(page, 10);
    if (!isNaN(val) && val >= 1) {
      params.pagination.page = val;
    } else {
      fieldErrors.page = 'page must be an integer >= 1';
    }
  }

  if (limit !== undefined) {
    const val = parseInt(limit, 10);
    if (!isNaN(val) && val >= 1 && val <= MAX_LIMIT) {
      params.pagination.limit = val;
    } else {
      fieldErrors.limit = `limit must be an integer between 1 and ${MAX_LIMIT}`;
    }
  }

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    params,
  };
}

/**
 * @swagger
 * /api/admin/indexer/events:
 *   get:
 *     operationId: listIndexerEvents
 *     summary: List indexed escrow events (admin, cursor-paginated)
 *     description: |
 *       Returns a bounded, cursor-paginated list of rows from the
 *       `escrow_events` table ordered by `observed_at DESC` by default.
 *
 *       **Access**: Admin-only (JWT bearer or API key).
 *
 *       **Pagination modes**
 *
 *       | Mode | Parameters | Notes |
 *       |------|-----------|-------|
 *       | Cursor (recommended) | `cursor` + `limit` | Stable under inserts; use `nextCursor` from the previous response |
 *       | Offset (legacy) | `page` + `limit` | Backward-compatible; may drift on busy datasets |
 *
 *       When `cursor` is supplied, `page` is ignored.
 *       Cursors are opaque and HMAC-signed — any modification returns 400.
 *       Cursors are tied to a specific `sortBy` field; switching sort mid-
 *       pagination requires starting from the first page (no `cursor`).
 *
 *       **`event_body` is not included in list rows** to keep payloads small.
 *     tags: [Indexer]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: invoiceId
 *         schema:
 *           type: string
 *           maxLength: 128
 *         description: Filter by invoice ID
 *       - in: query
 *         name: eventType
 *         schema:
 *           type: string
 *           maxLength: 128
 *         description: Filter by event type
 *       - in: query
 *         name: contractId
 *         schema:
 *           type: string
 *         description: Filter by Stellar contract address
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [observed_at, ledger_sequence]
 *           default: observed_at
 *         description: Field to sort by. Must stay constant across cursor pages.
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order. Must stay constant across cursor pages.
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *           maxLength: 2048
 *         description: |
 *           Opaque HMAC-signed cursor returned as `nextCursor` in a previous
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
 *           default: 20
 *         description: Items per page (applies to both pagination modes)
 *     responses:
 *       200:
 *         description: Indexer events retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       event_id:       { type: string }
 *                       invoice_id:     { type: string }
 *                       event_type:     { type: string }
 *                       ledger_sequence: { type: integer }
 *                       paging_token:   { type: string, nullable: true }
 *                       contract_id:    { type: string, nullable: true }
 *                       tx_hash:        { type: string, nullable: true }
 *                       observed_at:    { type: string, format: date-time }
 *                       created_at:     { type: string, format: date-time }
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:      { type: integer }
 *                     limit:      { type: integer }
 *                     hasMore:    { type: boolean }
 *                     nextCursor: { type: string, nullable: true }
 *       400:
 *         description: |
 *           Invalid query parameters or malformed/tampered cursor.
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.get('/events', async (req, res, next) => {
  try {
    // ── 1. Parse and validate query parameters ──────────────────────────────
    const { isValid, fieldErrors, params } = _parseQuery(req.query);

    if (!isValid) {
      return res.status(400).json(
        responseHelper.error('Query parameters contain invalid values.', 'VALIDATION_ERROR', fieldErrors),
      );
    }

    // ── 2. Call service ─────────────────────────────────────────────────────
    let result;
    try {
      result = await listIndexerEvents({
        filters: params.filters,
        sorting: params.sorting,
        pagination: params.pagination,
        dbClient: req._dbClient, // injectable in tests
      });
    } catch (err) {
      // CursorError is a client error (malformed/tampered cursor) → 400
      if (err instanceof CursorError) {
        return res.status(400).json(
          responseHelper.error(
            'Query parameters contain invalid values.',
            'VALIDATION_ERROR',
            { cursor: err.message },
          ),
        );
      }
      throw err;
    }

    // ── 3. Logging ──────────────────────────────────────────────────────────
    logger.info(
      {
        requestId: req.id,
        count: result.data.length,
        total: result.meta.total,
        hasMore: result.meta.hasMore,
        usedCursor: Boolean(params.pagination.cursor),
      },
      'Indexer events retrieved',
    );

    // ── 4. Respond ──────────────────────────────────────────────────────────
    return res.status(200).json({
      ...responseHelper.success(result.data, result.meta),
      message: 'Indexer events retrieved successfully.',
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
