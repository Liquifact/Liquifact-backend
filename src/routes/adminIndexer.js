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
const { listIndexerEvents, bulkIndexerEvents, validateBulkPayload, INDEXER_SORT_FIELDS, MAX_BULK_BATCH_SIZE } = require('../services/indexerService');
const { mapQueryToDTO, mapDTOToServiceParams } = require('../dto/indexer');
const { CursorError } = require('../utils/cursorPagination');
const { adminStack } = require('../middleware/stacks');
const { indexerLimiter } = require('../middleware/rateLimit');
const { createCompressionMiddleware } = require('../middleware/compression');
const { mapQueryToDTO, mapDTOToServiceParams } = require('../dto/indexer');
const responseHelper = require('../utils/responseHelper');
const logger = require('../logger');
const { validateIndexerQuery } = require('../schemas/indexerQuery');
const { instrumentIndexer } = require('../middleware/indexerMetrics');
const { mapQueryToDTO, mapDTOToServiceParams } = require('../dto/indexer');

// Apply a per-client rate limit before admin auth so bursts are contained
// even when the caller is unauthenticated or misconfigured.
router.use(indexerLimiter);

// Apply admin auth (JWT or API key) + tenant extraction to every route in this
// file.
router.use(...adminStack);

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
 *               $ref: '#/components/schemas/IndexerListResponse'
 *       400:
 *         description: |
 *           Invalid query parameters or malformed/tampered cursor.
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.get('/events', instrumentIndexer(async (req, res, next) => {
  try {
    // ── 1. Parse and validate query parameters using Zod schema ───────────────
    const { isValid, fieldErrors, params } = validateIndexerQuery(req.query);

    if (!isValid) {
      return res.status(400).json({
        ...responseHelper.error('Query parameters contain invalid values.', 'VALIDATION_ERROR', fieldErrors),
        correlation_id: req.correlationId || req.id,
      });
    }

    // ── 2. Call service with correlation context ────────────────────────────
    const correlationId = req.correlationId || req.id;
    let result;
    try {
      result = await listIndexerEvents({
        ...serviceParams,
        dbClient: req._dbClient, // injectable in tests
        correlationId,
      });
    } catch (err) {
      // CursorError is a client error (malformed/tampered cursor) → 400
      if (err instanceof CursorError) {
        return res.status(400).json({
          ...responseHelper.error(
            'Query parameters contain invalid values.',
            'VALIDATION_ERROR',
            { cursor: err.message },
          ),
          correlation_id: req.correlationId || req.id,
        });
      }
      throw err;
    }

    // ── 3. Logging with correlation context ─────────────────────────────────
    logger.info(
      {
        correlationId,
        requestId: req.id,
        count: result.data.length,
        total: result.meta.total,
        hasMore: result.meta.hasMore,
        usedCursor: Boolean(queryDTO.pagination.cursor),
      },
      'Indexer events retrieved',
    );

    // ── 4. Respond with correlation_id ──────────────────────────────────────
    return res.status(200).json({
      ...responseHelper.success(result.data, result.meta),
      correlation_id: correlationId,
      message: 'Indexer events retrieved successfully.',
    });
  } catch (error) {
    return next(error);
  }
}));

/**
 * @swagger
 * /api/admin/indexer/events/bulk:
 *   post:
 *     operationId: bulkIndexerEvents
 *     summary: Bulk-ingest indexer events
 *     description: |
 *       Accepts a bounded JSON array of raw event objects, validates each
 *       independently, and persists valid entries.  Invalid items produce an
 *       error entry in the response without aborting the rest of the batch.
 *
 *       **Access**: Admin-only (JWT bearer or API key).
 *
 *       **Limits**: Maximum **50** items per request (HTTP 413 when exceeded).
 *     tags: [Indexer]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             maxItems: 50
 *             items:
 *               $ref: '#/components/schemas/IndexerEvent'
 *     responses:
 *       200:
 *         description: Per-item results (partial failure is reported, not thrown)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IndexerBulkResponse'
 *       207:
 *         description: Partial success - some items failed validation or persistence
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IndexerBulkResponse'
 *       400:
 *         description: Request body is not an array, is empty, or contains a non-object item
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       413:
 *         description: Batch exceeds maximum allowed size
 */
router.post('/events/bulk', async (req, res, next) => {
  try {
    const validation = validateBulkPayload(req.body);

    if (!validation.ok) {
      return res.status(validation.error.status).json(
        responseHelper.error(validation.error.message, validation.error.code, validation.error.details),
      );
    }

    const result = await bulkIndexerEvents({
      events: validation.events,
      dbClient: req._dbClient,
    });

    const statusCode = result.meta.failed > 0 ? 207 : 200;

    logger.info(
      { requestId: req.id, succeeded: result.meta.succeeded, failed: result.meta.failed, total: result.meta.total },
      'Bulk indexer events processed',
    );

    return res.status(statusCode).json({
      ...responseHelper.success(result.data, result.meta),
      message: 'Bulk indexer events processed.',
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
