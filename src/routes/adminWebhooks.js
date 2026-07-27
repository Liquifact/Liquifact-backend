'use strict';

/**
 * @fileoverview Admin routes for webhook dead-letter management.
 *
 * All routes require either a valid admin JWT (`Authorization: Bearer <token>`)
 * or a valid API key (`X-API-Key`). Unauthorized callers receive 401/403.
 * Every response is scoped to the authenticated tenant (`req.tenantId`).
 *
 * Routes
 * ──────
 * GET  /api/admin/webhooks/dead-letters
 *   Filterable, cursor-paginated listing of dead-letter rows.
 *   Filters: event, targetUrl, resolved, createdAfter, createdBefore
 *   HMAC secrets and other sensitive fields are NEVER returned.
 *
 * POST /api/admin/webhooks/replay/:id
 *   Enqueue a single dead-letter row for immediate replay.
 *
 * POST /api/admin/webhooks/replay
 *   Enqueue a batch of dead-letter rows for replay (by id list or filter).
 *
 * POST /api/admin/webhooks/resolve/:id
 *   Mark a dead-letter row as resolved without re-sending.
 *
 * @module routes/adminWebhooks
 */

const express = require('express');

const router = express.Router();
const db = require('../db/knex');
const { replayWebhook, resolveDeadLetter } = require('../services/webhooks');
const { webhookReplayTotal } = require('../metrics');
const { authenticateToken } = require('../middleware/auth');
// Legacy src/middleware/apiKey.js has been retired in favour of the env-backed
// registry authenticator. The implementation lives in apiKeyAuth.js and never
// opens a SQLite connection per request — see issue #590.
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const logger = require('../logger');

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Pre-built admin API key middleware (no required scope — any valid, non-revoked
 * key is accepted). Built once so the factory overhead is paid at module load
 * rather than on every request.
 *
 * @type {import('express').RequestHandler}
 */
const _adminApiKeyMiddleware = authenticateApiKey();

/**
 * Accepts either a valid admin JWT or a valid X-API-Key.
 * Honours the existing X-API-KEY contract: when the header is present the
 * request is authenticated against the env-backed key registry; otherwise it
 * falls through to JWT auth.
 *
 * @type {import('express').RequestHandler}
 */
function adminAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return _adminApiKeyMiddleware(req, res, next);
  }
  return out;
}

// ── GET /dead-letters ────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/admin/webhooks/dead-letters:
 *   get:
 *     operationId: listWebhookDeadLetters
 *     summary: List dead-letter webhook deliveries (filterable, cursor-paginated)
 *     description: |
 *       Returns a cursor-paginated list of rows from `webhook_dead_letters`
 *       that belong to the authenticated tenant.
 *
 *       **Access**: Admin-only (JWT bearer or API key). Results are always
 *       scoped to `req.tenantId` — no cross-tenant data is ever returned.
 *
 *       **Security**: HMAC secrets and other sensitive material are never
 *       included in any response field.
 *
 *       **Pagination** (cursor-based, mirrors `GET /api/marketplace`):
 *       | Param | Default | Range | Notes |
 *       |-------|---------|-------|-------|
 *       | `limit`  | 20 | 1–100 | Rows per page |
 *       | `cursor` | – | opaque | Returned as `nextCursor` in prior response |
 *
 *       **Filters**:
 *       | Param | Type | Description |
 *       |-------|------|-------------|
 *       | `event`        | string  | Exact match on `event` column (e.g. `invoice.approved`) |
 *       | `targetUrl`    | string  | Exact match on `webhook_url` column |
 *       | `resolved`     | boolean | `true` / `false` |
 *       | `createdAfter` | ISO 8601 date-time | Lower bound on `created_at` (inclusive) |
 *       | `createdBefore`| ISO 8601 date-time | Upper bound on `created_at` (exclusive) |
 *     tags: [AdminWebhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Opaque cursor from the previous page's `nextCursor` field.
 *       - in: query
 *         name: event
 *         schema: { type: string }
 *       - in: query
 *         name: targetUrl
 *         schema: { type: string }
 *       - in: query
 *         name: resolved
 *         schema: { type: boolean }
 *       - in: query
 *         name: createdAfter
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: createdBefore
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Dead-letter rows retrieved.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/DeadLetterRow'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     limit: { type: integer }
 *                     hasMore: { type: boolean }
 *                     nextCursor: { type: string, nullable: true }
 *       400:
 *         description: Invalid query parameters.
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 */
router.get('/dead-letters', async (req, res, next) => {
  // ── 1. Parse & validate query params ────────────────────────────────────
  const {
    cursor,
    event,
    targetUrl,
    resolved: rawResolved,
    createdAfter,
    createdBefore,
  } = req.query;

  const rawLimit = req.query.limit;

  // limit validation
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

  const limit = rawLimit !== undefined
    ? Math.min(parseInt(rawLimit, 10), MAX_LIMIT)
    : DEFAULT_LIMIT;

  // resolved flag validation
  let resolvedFilter;
  if (rawResolved !== undefined) {
    if (rawResolved === 'true') {
      resolvedFilter = true;
    } else if (rawResolved === 'false') {
      resolvedFilter = false;
    } else {
      return res.status(400).json(
        responseHelper.error(
          'resolved must be "true" or "false"',
          'INVALID_FILTER',
        ),
      );
    }
  }

  // date range validation
  if (createdAfter !== undefined && isNaN(Date.parse(createdAfter))) {
    return res.status(400).json(
      responseHelper.error(
        'createdAfter must be a valid ISO 8601 date-time string',
        'INVALID_FILTER',
      ),
    );
  }
  if (createdBefore !== undefined && isNaN(Date.parse(createdBefore))) {
    return res.status(400).json(
      responseHelper.error(
        'createdBefore must be a valid ISO 8601 date-time string',
        'INVALID_FILTER',
      ),
    );
  }

  // ── 2. Decode cursor (if present) ────────────────────────────────────────
  let cursorData = null;
  if (cursor) {
    try {
      cursorData = decodeCursor(cursor, DEAD_LETTER_SORT_FIELD);
    } catch (err) {
      if (err instanceof CursorError) {
        return res.status(400).json(
          responseHelper.error(err.message, 'INVALID_CURSOR'),
        );
      }
      return next(err);
    }
  }

  // ── 3. Build and execute DB query ────────────────────────────────────────
  try {
    const dbClient = req._dbClient || db;

    const buildBase = () => {
      let q = dbClient('webhook_dead_letters')
        .where('tenant_id', req.tenantId);

      // optional filters
      if (event !== undefined) {
        q = q.where('event', event);
      }
      if (targetUrl !== undefined) {
        q = q.where('webhook_url', targetUrl);
      }
      if (resolvedFilter !== undefined) {
        q = q.where('resolved', resolvedFilter);
      }
      if (createdAfter !== undefined) {
        q = q.where('created_at', '>=', new Date(createdAfter).toISOString());
      }
      if (createdBefore !== undefined) {
        q = q.where('created_at', '<', new Date(createdBefore).toISOString());
      }

      return q;
    };

    // Keyset pagination: if a cursor is present, add the WHERE clause that
    // continues from where the previous page left off.
    //
    // We sort by created_at DESC, id DESC (tiebreaker).
    // Rows are "after" the cursor when:
    //   created_at < cursor.sortValue
    //   OR (created_at = cursor.sortValue AND id < cursor.id)
    //
    let dataQuery = buildBase()
      .select(SAFE_COLUMNS)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1); // fetch one extra to determine hasMore

    if (cursorData) {
      dataQuery = dataQuery.where(function () {
        this.where('created_at', '<', cursorData.sortValue)
          .orWhere(function () {
            this.where('created_at', cursorData.sortValue)
              .andWhere('id', '<', cursorData.id);
          });
      });
    }

    const rows = await dataQuery;

    // ── 4. Determine hasMore and build nextCursor ────────────────────────
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore) {
      const lastRow = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor({
        sortField: DEAD_LETTER_SORT_FIELD,
        sortValue: lastRow.created_at instanceof Date
          ? lastRow.created_at.toISOString()
          : lastRow.created_at,
        id: String(lastRow.id),
      });
    }

    // ── 5. Redact and respond ────────────────────────────────────────────
    const safeRows = pageRows.map(redactRow);

    logger.info(
      {
        requestId: req.id,
        tenantId: req.tenantId,
        count: safeRows.length,
        hasMore,
        filters: { event, targetUrl, resolved: resolvedFilter, createdAfter, createdBefore },
      },
      'Dead-letter list retrieved',
    );

    return res.status(200).json({
      ...responseHelper.success(safeRows, {
        limit,
        hasMore,
        nextCursor,
      }),
      message: 'Dead-letter rows retrieved successfully.',
    });
  } catch (error) {
    logger.error(
      { err: error?.message, tenantId: req.tenantId },
      'Failed to fetch dead-letter rows',
    );
    return next(error);
  }
});

// ── POST /replay/:id ─────────────────────────────────────────────────────────

/**
 * POST /api/admin/webhooks/replay/:id
 * Replay a single dead-letter row by its UUID.
 */
router.post('/replay/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await replayWebhook(id);
    // `req.apiClient` is set by src/middleware/apiKeyAuth.js on success; the
    // JWT path sets `req.user`. The legacy `req.apiKey` no longer exists.
    logger.info({ deadLetterId: id, adminClient: req.apiClient?.clientId || req.user?.sub }, 'Admin triggered replay');
    return res.status(202).json({ replayed: [id] });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: `Dead-letter row not found: ${id}` });
    }
    if (err.code === 'ALREADY_RESOLVED') {
      return res.status(409).json({ error: `Dead-letter row already resolved: ${id}` });
    }
    logger.error({ deadLetterId: id, err: err.message }, 'Admin replay failed');
    return res.status(502).json({ error: `Replay failed: ${err.message}` });
  }
});

// ── POST /replay (batch) ──────────────────────────────────────────────────────

/**
 * POST /api/admin/webhooks/replay
 * Replay a batch of dead-letter rows.
 *
 * Body (one of):
 *   { "ids": ["uuid1", "uuid2"] }           — explicit list
 *   { "tenantId": "t_123" }                 — all unresolved for tenant
 *   { "tenantId": "t_123", "limit": 50 }    — with page limit (max 200)
 */
router.post('/replay', async (req, res) => {
  const { ids, tenantId, limit = 50 } = req.body || {};

  if (!ids && !tenantId) {
    return res.status(400).json({ error: 'Provide either "ids" array or "tenantId" filter.' });
  }

  let rows;
  if (ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '"ids" must be a non-empty array.' });
    }
    // cap batch to 200 to prevent DoS
    const capped = ids.slice(0, 200);
    rows = await db('webhook_dead_letters')
      .whereIn('id', capped)
      .where('resolved', false)
      .select('id');
  } else {
    const cap = Math.min(Number(limit) || 50, 200);
    rows = await db('webhook_dead_letters')
      .where({ tenant_id: tenantId, resolved: false })
      .orderBy('created_at', 'asc')
      .limit(cap)
      .select('id');
  }

  const replayed = [];
  const failed = [];

  for (const row of rows) {
    try {
      await replayWebhook(row.id);
      replayed.push(row.id);
    } catch (err) {
      failed.push({ id: row.id, error: err.message });
      webhookReplayTotal.inc({
        outcome: err.code === 'ALREADY_RESOLVED' ? 'already_resolved' : 'failure',
      });
    }
  }

  logger.info(
    { replayed: replayed.length, failed: failed.length, adminClient: req.apiClient?.clientId || req.user?.sub },
    'Admin batch replay completed'
  );

  return res.status(202).json({ replayed, failed });
});

// ── POST /resolve/:id ─────────────────────────────────────────────────────────

/**
 * POST /api/admin/webhooks/resolve/:id
 * Mark a dead-letter row as resolved without re-sending.
 */
router.post('/resolve/:id', async (req, res) => {
  const { id } = req.params;
  const row = await db('webhook_dead_letters').where('id', id).first();
  if (!row) {
    return res.status(404).json({ error: `Dead-letter row not found: ${id}` });
  }
  if (row.resolved) {
    return res.status(409).json({ error: `Dead-letter row already resolved: ${id}` });
  }
  await resolveDeadLetter(id);
  logger.info({ deadLetterId: id, adminClient: req.apiClient?.clientId || req.user?.sub }, 'Admin resolved dead-letter without replay');
  return res.status(200).json({ resolved: id });
});

module.exports = router;
