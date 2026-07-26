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
const { listIndexerEvents } = require('../services/indexerService');
const { CursorError } = require('../utils/cursorPagination');
const { adminStack } = require('../middleware/stacks');
const { indexerLimiter } = require('../middleware/rateLimit');
const responseHelper = require('../utils/responseHelper');
const logger = require('../logger');
const { validateIndexerQuery } = require('../schemas/indexerQuery');

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
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       eventId:        { type: string }
 *                       invoiceId:      { type: string }
 *                       eventType:      { type: string }
 *                       ledgerSequence: { type: integer }
 *                       pagingToken:    { type: string, nullable: true }
 *                       contractId:     { type: string, nullable: true }
 *                       txHash:         { type: string, nullable: true }
 *                       observedAt:     { type: string, format: date-time }
 *                       createdAt:      { type: string, format: date-time }
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
router.get('/events', instrumentIndexer(async (req, res, next) => {
  try {
    // ── 1. Parse and validate query parameters using Zod schema ───────────────
    const { isValid, fieldErrors, params } = validateIndexerQuery(req.query);

    if (!isValid) {
      return res.status(400).json(
        responseHelper.error('Query parameters contain invalid values.', 'VALIDATION_ERROR', fieldErrors),
      );
    }

    // ── 2. Map validated params → request DTO → service options ────────────
    const queryDTO = mapQueryToDTO(params);
    const serviceParams = mapDTOToServiceParams(queryDTO);

    // ── 3. Call service ─────────────────────────────────────────────────────
    let result;
    try {
      result = await listIndexerEvents({
        ...serviceParams,
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

    // ── 4. Logging ──────────────────────────────────────────────────────────
    logger.info(
      {
        requestId: req.id,
        count: result.data.length,
        total: result.meta.total,
        hasMore: result.meta.hasMore,
        usedCursor: Boolean(queryDTO.pagination.cursor),
      },
      'Indexer events retrieved',
    );

    // ── 5. Respond ──────────────────────────────────────────────────────────
    // result.data is already an EscrowEventRowDTO[] and result.meta is an
    // IndexerEventsMetaDTO — both mapped by indexerService at the boundary.
    return res.status(200).json({
      ...responseHelper.success(result.data, result.meta),
      message: 'Indexer events retrieved successfully.',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/admin/indexer/events:
 *   post:
 *     operationId: writeIndexerEvent
 *     summary: Write an indexed escrow event (idempotent)
 *     description: |
 *       Persists a single escrow event and updates the per-invoice projection.
 *       This endpoint is idempotent; it requires an `Idempotency-Key` header
 *       to prevent duplicate application of state changes on retry.
 *     tags: [Indexer]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *         description: Unique key for safe retries
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: The raw event payload to persist
 *     responses:
 *       201:
 *         description: Event persisted successfully
 *       400:
 *         description: Validation error
 *       409:
 *         description: Idempotency conflict
 */
router.post('/events', express.json(), idempotencyMiddleware, async (req, res, next) => {
  try {
    const rawEvent = req.body;
    const dbClient = req._dbClient || db;
    const store = createKnexEscrowEventStore(dbClient);
    
    // We use a transaction runner to ensure event and projection are updated atomically
    const transactionRunner = async (handler) => {
      return dbClient.transaction(handler);
    };

    const event = await persistEscrowEvent({ store, transactionRunner }, rawEvent);

    logger.info({ eventId: event.eventId, invoiceId: event.invoiceId }, 'Admin indexer event persisted');
    return res.status(201).json({
      message: 'Event persisted successfully.',
      event,
    });
  } catch (error) {
    if (error instanceof ValidationError || error.name === 'ValidationError') {
      return res.status(400).json(
        responseHelper.error(error.message, error.code, error.details)
      );
    }
    return next(error);
  }
});

module.exports = router;
