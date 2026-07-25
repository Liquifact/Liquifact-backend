'use strict';

/**
 * @fileoverview Health listing route — GET /api/health/checks
 *
 * Returns a bounded, cursor-paginated list of live dependency health-check
 * records. Each record represents one named upstream dependency (Soroban RPC,
 * database, KYC provider, etc.) captured at the same instant.
 *
 * Cursor pagination keeps the response stable and bounded as the dependency
 * roster grows. Cursors are HMAC-signed so any tampering is rejected with 400.
 *
 * @module routes/health
 */

const express = require('express');
const router = express.Router();
const { listHealthChecks } = require('../services/health');
const {
  encodeHealthCursor,
  decodeHealthCursor,
  resolveLimit,
  HealthCursorError,
} = require('../utils/healthCursorPagination');

/**
 * @swagger
 * /api/health/checks:
 *   get:
 *     operationId: listHealthChecks
 *     summary: List dependency health checks with cursor pagination
 *     description: |
 *       Returns a bounded, paginated snapshot of all named upstream dependency
 *       health checks (Soroban RPC, database, KYC provider, escrow indexer,
 *       storage, reconciliation).
 *
 *       **Pagination**
 *
 *       Pass the opaque `nextCursor` from one response as the `cursor` param
 *       in the next request.  Cursors are HMAC-signed — any modification
 *       returns 400.
 *
 *       | Param    | Description                                        |
 *       |----------|----------------------------------------------------|
 *       | `cursor` | Opaque cursor from previous `nextCursor`           |
 *       | `limit`  | Page size (1–100, default 10)                      |
 *
 *     tags: [Health]
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Opaque cursor from a previous response's `nextCursor` field.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Maximum number of checks to return per page.
 *     responses:
 *       200:
 *         description: Health checks retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthChecksListResponse'
 *       400:
 *         description: Malformed or tampered cursor.
 *         $ref: '#/components/responses/Problem400'
 */
router.get('/checks', async (req, res, next) => {
  try {
    const limit = resolveLimit(req.query.limit);
    const rawCursor = req.query.cursor;

    // Decode and validate the incoming cursor when present.
    let afterTimestamp = null;
    let afterId = null;

    if (rawCursor !== undefined) {
      try {
        const decoded = decodeHealthCursor(rawCursor);
        afterTimestamp = decoded.timestamp;
        afterId = decoded.id;
      } catch (err) {
        if (err instanceof HealthCursorError) {
          return res.status(400).json({
            type: 'https://liquifact.io/problems/validation-error',
            title: 'Validation Error',
            status: 400,
            detail: 'Invalid or malformed cursor.',
            fieldErrors: { cursor: err.message },
          });
        }
        throw err;
      }
    }

    // Fetch the full ordered list of health check records.
    const allChecks = await listHealthChecks();

    // Apply keyset filtering when a cursor was supplied.
    // Records are ordered by (timestamp ASC, id ASC); the cursor points to the
    // last item on the previous page so we skip everything up to and including
    // that item.
    let filteredChecks;
    if (afterTimestamp !== null && afterId !== null) {
      const cursorIdx = allChecks.findIndex(
        (c) => c.timestamp === afterTimestamp && c.id === afterId,
      );

      if (cursorIdx === -1) {
        // The cursor pointed to a record that no longer exists in the current
        // snapshot (e.g. a check was removed). Return an empty page so the
        // caller knows it has reached the end rather than silently restarting.
        filteredChecks = [];
      } else {
        filteredChecks = allChecks.slice(cursorIdx + 1);
      }
    } else {
      filteredChecks = allChecks;
    }

    // Slice to the requested page size + 1 to detect whether more pages exist.
    const page = filteredChecks.slice(0, limit);
    const hasMore = filteredChecks.length > limit;

    // Build the next cursor from the last item on this page.
    let nextCursor = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeHealthCursor({ timestamp: last.timestamp, id: last.id });
    }

    return res.json({
      data: page,
      meta: {
        limit,
        hasMore,
        nextCursor,
        total: allChecks.length,
      },
      message: 'Health checks retrieved successfully.',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
