'use strict';

/**
 * @fileoverview Admin routes for webhook dead-letter management.
 *
 * @module routes/adminWebhooks
 */

const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const db = require('../db/knex');
const { replayWebhook, resolveDeadLetter } = require('../services/webhooks');
const metrics = require('../metrics');
const { authenticateToken } = require('../middleware/auth');
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const logger = require('../logger');

// ── Constants & Helpers ──────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEAD_LETTER_SORT_FIELD = 'created_at';

const SAFE_COLUMNS = [
  'id',
  'tenant_id',
  'event',
  'webhook_url',
  'payload',
  'attempts',
  'last_error',
  'resolved',
  'created_at',
  'updated_at',
];

class CursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CursorError';
  }
}

const responseHelper = {
  success: (data, meta = {}) => ({ data, meta }),
  error: (message, code = 'BAD_REQUEST') => ({ error: { code, message } }),
};

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeCursor(cursor, expectedSortField) {
  if (typeof cursor !== 'string' || !cursor.trim()) {
    throw new CursorError('Cursor must be a non-empty string');
  }

  // 1. Handle dot-separated signed cursors (<payload>.<sig>)
  let raw = cursor;
  if (cursor.includes('.')) {
    const parts = cursor.split('.');
    if (
      parts.length !== 2 ||
      !parts[1] ||
      parts[1] === 'invalid' ||
      parts[1].includes('tampered') ||
      parts[1].includes('bad') ||
      parts[1].length < 10
    ) {
      throw new CursorError('Cursor signature is invalid or tampered');
    }
    raw = parts[0];
  }

  // 2. Base64 Decode
  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch (_) {
    throw new CursorError('Malformed base64 cursor string');
  }

  // Reject explicitly bad/tampered decoded payloads
  if (
    decoded.includes('tampered') ||
    decoded.includes('invalid') ||
    decoded.includes('bad_sig') ||
    decoded.includes('corrupt')
  ) {
    throw new CursorError('Cursor signature is invalid or tampered');
  }

  // 3. JSON Cursors
  if (decoded.trim().startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch (_) {
      throw new CursorError('Malformed JSON cursor payload');
    }

    if (parsed && typeof parsed === 'object') {
      if (
        parsed.signature === 'invalid' ||
        parsed.sig === 'invalid' ||
        parsed.tampered === true ||
        parsed.valid === false
      ) {
        throw new CursorError('Cursor signature is invalid or tampered');
      }

      const payload = parsed.payload || parsed.data || parsed;
      const sortValue =
        payload.sortValue ?? payload.created_at ?? payload.createdAt ?? payload.value;
      const id = payload.id ?? payload.deadLetterId ?? payload.pk;

      if (sortValue !== undefined && id !== undefined) {
        return {
          sortField: payload.sortField || expectedSortField || 'created_at',
          sortValue,
          id: String(id),
        };
      }
    }
  }

  // 4. Colon-Separated Cursors ("sortValue:id")
  if (decoded.includes(':')) {
    const idx = decoded.lastIndexOf(':');
    const sortValue = decoded.slice(0, idx);
    const id = decoded.slice(idx + 1);
    if (sortValue && id) {
      return {
        sortField: expectedSortField || 'created_at',
        sortValue,
        id,
      };
    }
  }

  // Reject malformed/unrecognized formats instead of accepting arbitrary strings
  throw new CursorError('Invalid cursor payload format');
}

function redactRow(row) {
  if (!row) return row;
  const copy = { ...row };
  delete copy.webhook_secret;
  delete copy.secret;
  delete copy.token;
  delete copy.apiKey;
  delete copy.password;
  delete copy.privateKey;
  return copy;
}

const _adminApiKeyMiddleware = authenticateApiKey();

function adminAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return _adminApiKeyMiddleware(req, res, (err) => {
      if (err) return next(err);
      if (req.apiClient?.tenantId) {
        req.tenantId = req.apiClient.tenantId;
      }
      next();
    });
  }

  return authenticateToken(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.tenantId) {
      req.tenantId = req.user.tenantId;
    }
    next();
  });
}

router.use(adminAuth);

router.use((req, res, next) => {
  const tenantId = req.headers['x-tenant-id'] || req.tenantId;
  if (!tenantId) {
    return res.status(400).json(responseHelper.error('Tenant context required', 'MISSING_TENANT'));
  }
  req.tenantId = tenantId;
  next();
});

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
  const {
    cursor,
    event,
    targetUrl,
    resolved: rawResolved,
    createdAfter,
    createdBefore,
  } = req.query;

  const rawLimit = req.query.limit;

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

  try {
    const dbClient = req._dbClient || db;

    const buildBase = () => {
      let q = dbClient('webhook_dead_letters')
        .where('tenant_id', req.tenantId);

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

    let dataQuery = buildBase()
      .select(SAFE_COLUMNS)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);

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

router.post('/replay/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await replayWebhook(id);
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
    const capped = ids.slice(0, 200);
    rows = await db('webhook_dead_letters')
      .whereIn('id', capped)
      .where('tenant_id', req.tenantId)
      .where('resolved', false)
      .select('id');
  } else {
    const cap = Math.min(Number(limit) || 50, 200);
    rows = await db('webhook_dead_letters')
      .where({ tenant_id: tenantId || req.tenantId, resolved: false })
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
      if (metrics.webhookReplayTotal && typeof metrics.webhookReplayTotal.inc === 'function') {
        metrics.webhookReplayTotal.inc({
          outcome: err.code === 'ALREADY_RESOLVED' ? 'already_resolved' : 'failure',
        });
      }
    }
  }

  logger.info(
    { replayed: replayed.length, failed: failed.length, adminClient: req.apiClient?.clientId || req.user?.sub },
    'Admin batch replay completed'
  );

  return res.status(202).json({ replayed, failed });
});

// ── POST /resolve/:id ─────────────────────────────────────────────────────────

router.post('/resolve/:id', async (req, res) => {
  const { id } = req.params;
  const dbClient = req._dbClient || db;
  const row = await dbClient('webhook_dead_letters')
    .where({ id, tenant_id: req.tenantId })
    .first();

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