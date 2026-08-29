'use strict';

/**
 * @fileoverview Admin endpoint for listing persisted background jobs with cursor pagination.
 *
 * Exposes a cursor-paginated view of the `background_jobs` table to authorized
 * admin callers. The endpoint requires a valid JWT bearer token or API key and
 * applies the standard admin middleware stack (auth → tenant extraction).
 *
 * Payload JSONB and lease fencing tokens are intentionally excluded from list
 * rows — they may contain sensitive job arguments or grant write access that
 * should not be exposed in bulk listings.
 *
 * ## Pagination
 *
 * This endpoint uses **keyset (cursor) pagination** for stable, efficient
 * traversal even as rows are inserted or deleted between pages:
 *
 * 1. Make a request without `cursor` to get the first page.
 * 2. If `meta.hasMore` is `true`, pass `meta.nextCursor` as the `cursor`
 *    query parameter in the next request.
 * 3. Repeat until `meta.hasMore` is `false`.
 *
 * Cursors are opaque and HMAC-signed; any modification returns `400 Bad Request`.
 * The `sortBy` and `order` parameters must be consistent across pages in the
 * same pagination session.
 *
 * @module routes/adminJobs
 */

const express = require('express');
const router  = express.Router();

const db             = require('../db/knex');
const { adminStack } = require('../middleware/stacks');
const responseHelper = require('../utils/responseHelper');
const logger         = require('../logger');
const {
  createJobPersistence,
  JobCursorError,
  LIST_JOBS_DEFAULT_LIMIT,
  LIST_JOBS_MAX_LIMIT,
  LIST_JOBS_SORT_FIELDS,
} = require('../workers/jobPersistence');

// Apply admin auth (JWT or API key) + tenant extraction to every route in this file.
router.use(...adminStack);

/**
 * @swagger
 * /api/admin/jobs:
 *   get:
 *     operationId: listPersistedJobs
 *     summary: List persisted background jobs (cursor-paginated)
 *     description: |
 *       Returns a cursor-paginated listing of rows from the `background_jobs`
 *       table. Rows are never returned in an unbounded array — the page size
 *       is capped at 100.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Tenant-scoped.
 *
 *       **Pagination (cursor mode — recommended)**
 *       1. Request the first page without a `cursor`.
 *       2. If `meta.hasMore` is `true`, pass `meta.nextCursor` as `cursor` in
 *          the next request.
 *       3. Keep `sortBy` and `order` identical across all pages.
 *
 *       Cursors are opaque HMAC-signed tokens. Any modification returns 400.
 *
 *       **Note**: `payload` and lease fencing tokens are intentionally excluded
 *       from every row to prevent sensitive job arguments or write credentials
 *       from leaking in bulk API responses.
 *
 *     tags: [Admin, Jobs]
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
 *         description: Number of rows per page (clamped to [1, 100])
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Opaque cursor from previous page `meta.nextCursor`
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [created_at, status, type, attempts]
 *           default: created_at
 *         description: Column to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort direction
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, completed, failed, retrying]
 *         description: Filter by job status
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by job type (exact match)
 *     responses:
 *       200:
 *         description: Jobs page retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/BackgroundJobSummary'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *                     nextCursor:
 *                       type: string
 *                       nullable: true
 *       400:
 *         description: Invalid pagination parameters or tampered cursor
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
 * GET /api/admin/jobs
 *
 * Returns a cursor-paginated listing of persisted background jobs.
 *
 * Query parameters:
 *   - `limit`  {integer} Rows per page. Clamped to [1, 100]. Default: 20.
 *   - `cursor` {string}  Opaque cursor from a previous page.
 *   - `sortBy` {string}  Sort column. One of: created_at, status, type, attempts.
 *   - `order`  {string}  'asc' or 'desc'. Default: 'desc'.
 *   - `status` {string}  Optional status filter.
 *   - `type`   {string}  Optional type filter (exact match).
 *
 * Response 200:
 *   Standard success envelope whose `data` array contains job summary objects
 *   (payload and fencing tokens excluded) and whose `meta` carries cursor pagination fields.
 *
 * Response 400:
 *   When query parameters are invalid or the cursor is tampered/malformed.
 *
 * @param {import('express').Request}  req  - Express request.
 * @param {import('express').Response} res  - Express response.
 * @param {import('express').NextFunction} next - Express next.
 * @returns {Promise<void>}
 */
router.get('/', async (req, res, next) => {
  // ── Input validation ────────────────────────────────────────────────────
  const rawLimit  = req.query.limit;
  const rawSortBy = req.query.sortBy;
  const rawOrder  = req.query.order;
  const rawStatus = req.query.status;

  if (rawLimit !== undefined) {
    const v = parseInt(rawLimit, 10);
    if (isNaN(v) || v < 1 || v > LIST_JOBS_MAX_LIMIT) {
      return res.status(400).json(
        responseHelper.error(
          `limit must be an integer between 1 and ${LIST_JOBS_MAX_LIMIT}`,
          'INVALID_PAGINATION',
        ),
      );
    }
  }

  if (rawSortBy !== undefined && !LIST_JOBS_SORT_FIELDS.includes(rawSortBy)) {
    return res.status(400).json(
      responseHelper.error(
        `sortBy must be one of: ${LIST_JOBS_SORT_FIELDS.join(', ')}`,
        'INVALID_PAGINATION',
      ),
    );
  }

  if (rawOrder !== undefined && rawOrder !== 'asc' && rawOrder !== 'desc') {
    return res.status(400).json(
      responseHelper.error('order must be "asc" or "desc"', 'INVALID_PAGINATION'),
    );
  }

  const VALID_STATUSES = ['pending', 'processing', 'completed', 'failed', 'retrying'];
  if (rawStatus !== undefined && !VALID_STATUSES.includes(rawStatus)) {
    return res.status(400).json(
      responseHelper.error(
        `status must be one of: ${VALID_STATUSES.join(', ')}`,
        'INVALID_PAGINATION',
      ),
    );
  }

  // ── Execute listing ──────────────────────────────────────────────────────
  try {
    const dbClient   = req._dbClient || db;
    const persistence = createJobPersistence(dbClient);

    const result = await persistence.listJobs({
      limit:  rawLimit  !== undefined ? parseInt(rawLimit, 10)   : LIST_JOBS_DEFAULT_LIMIT,
      cursor: req.query.cursor,
      sortBy: rawSortBy,
      order:  rawOrder,
      status: rawStatus,
      type:   req.query.type,
    });

    logger.info(
      {
        requestId: req.id,
        tenantId:  req.tenantId,
        limit:     result.meta.limit,
        hasMore:   result.meta.hasMore,
        count:     result.data.length,
      },
      'Admin jobs listing retrieved',
    );

    const data = result.data.map((job) => {
      const safeJob = { ...job };
      // Never expose lease fencing tokens; doing so would let a stale worker
      // bypass the fencing token check after its lease has been reassigned.
      delete safeJob.lease_token;
      delete safeJob.payload;
      return safeJob;
    });

    return res.status(200).json({
      ...responseHelper.success(data, result.meta),
      message: 'Background jobs retrieved successfully.',
    });
  } catch (err) {
    if (err instanceof JobCursorError) {
      return res.status(400).json(
        responseHelper.error(err.message, 'INVALID_CURSOR'),
      );
    }

    logger.error(
      { err: err?.message, tenantId: req.tenantId },
      'Failed to fetch persisted jobs listing',
    );
    return next(err);
  }
});

module.exports = router;
