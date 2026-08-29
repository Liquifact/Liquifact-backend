'use strict';

const { z } = require('zod');
const express = require('express');
const { loadApiKeyRegistry } = require('../config/apiKeys');
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const { extractTenant } = require('../middleware/tenant');
const { apiKeysLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.use(apiKeysLimiter);

const MAX_BULK_ITEMS = 25;

const ROTATION_OVERLAP_MS = 5 * 60 * 1000;

const bulkItemSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().trim().min(1).max(255),
    apiKey: z.string().trim().min(8).max(4096),
  }),
  z.object({
    action: z.literal('rename'),
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(255),
  }),
  z.object({
    action: z.literal('activate'),
    id: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('deactivate'),
    id: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('rotate'),
    id: z.number().int().positive(),
    apiKey: z.string().trim().min(8).max(4096),
    name: z.string().trim().min(1).max(255).optional(),
  }),
]);

/**
 * Get the API key registry, using the bounded in-memory cache when available.
 * Falls through to a fresh parse on cache miss or expired entry.
 * @returns {Map<string, Object>} The API key registry.
 */
function getRegistry() {
  const cache = getApiKeysCache();
  return cache.getOrLoad();
}


/**
 * Encode a simple opaque cursor from the last key string.
 * @param {string} key
 * @returns {string}
 */
function encodeCursor(key) {
  return Buffer.from(key).toString('base64');
}

/**
 * Decode the opaque cursor back to the key string.
 * @param {string} cursor
 * @returns {string | null}
 */
function decodeCursor(cursor) {
  try {
    return Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * GET /api-keys
 * Returns a paginated list of registered API keys.
 */
router.get('/', (req, res) => {
  // Parse and clamp limit
  let limit = parseInt(req.query.limit, 10);
  if (Number.isNaN(limit) || limit < 1) {
    limit = DEFAULT_LIMIT;
  }
  if (limit > MAX_LIMIT) {
    limit = MAX_LIMIT;
  }

  // Load all keys from the cached registry
  const registry = getRegistry();
  const allEntries = Array.from(registry.values());

  // Apply cursor if provided
  let startIndex = 0;
  if (req.query.cursor) {
    const decoded = decodeCursor(req.query.cursor);
    if (!decoded) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }

    const foundIndex = allEntries.findIndex((entry) => entry.key === decoded);
    if (foundIndex === -1) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    startIndex = foundIndex + 1; // start after the cursor item
  }

  // Slice the page
  const page = allEntries.slice(startIndex, startIndex + limit);

  // Determine next cursor
  let nextCursor = null;
  if (startIndex + limit < allEntries.length) {
    const lastItem = page[page.length - 1];
    nextCursor = encodeCursor(lastItem.key);
  }

  return res.json({
    data: page,
    nextCursor,
  });
});

/**
 * Runs an SQL statement on the provided database handle.
 *
 * @param {object} db - SQLite database handle.
 * @param {string} sql - SQL statement to execute.
 * @param {unknown[]} [params=[]] - Statement parameters.
 * @returns {Promise<object>} Statement metadata.
 */
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

/**
 * Fetches a single row from the provided database handle.
 *
 * @param {object} db - SQLite database handle.
 * @param {string} sql - SQL statement to execute.
 * @param {unknown[]} [params=[]] - Statement parameters.
 * @returns {Promise<object|undefined>} Query result row.
 */
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

/**
 * Fetches all rows from the provided database handle.
 *
 * @param {object} db - SQLite database handle.
 * @param {string} sql - SQL statement to execute.
 * @param {unknown[]} [params=[]] - Statement parameters.
 * @returns {Promise<object[]>} Query result rows.
 */
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

/**
 * Ensures the api_keys table exists before processing a bulk request.
 *
 * @param {object} db - SQLite database handle.
 * @returns {Promise<void>}
 */
async function ensureApiKeyTable(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      is_active BOOLEAN DEFAULT 1,
      audit_log TEXT
    )
  `);

  const columns = await all(db, 'PRAGMA table_info(api_keys)');
  const hasTenantId = columns.some((column) => column.name === 'tenant_id');
  if (!hasTenantId) {
    await run(db, 'ALTER TABLE api_keys ADD COLUMN tenant_id TEXT');
  }

  const hasStatus = columns.some((column) => column.name === 'status');
  if (!hasStatus) {
    await run(db, "ALTER TABLE api_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }

  const hasActivatedAt = columns.some((column) => column.name === 'activated_at');
  if (!hasActivatedAt) {
    await run(db, 'ALTER TABLE api_keys ADD COLUMN activated_at DATETIME');
  }

  const hasRetiresAt = columns.some((column) => column.name === 'retires_at');
  if (!hasRetiresAt) {
    await run(db, 'ALTER TABLE api_keys ADD COLUMN retires_at DATETIME');
  }
}

/**
 * Creates a new API key entry.
 *
 * @param {object} db - SQLite database handle.
 * @param {object} item - Parsed bulk operation.
 * @returns {Promise<object>} Created key summary.
 */
async function createKey(db, item) {
  const keyHash = hashApiKey(item.apiKey);
  const activatedAt = new Date().toISOString();
  await run(db, "INSERT INTO api_keys (tenant_id, key_hash, name, is_active, status, activated_at) VALUES (?, ?, ?, 1, 'active', ?)", [
    item.tenantId,
    keyHash,
    item.name,
    activatedAt,
  ]);
  const row = await get(db, "SELECT id, name, is_active, status, activated_at, retires_at FROM api_keys WHERE key_hash = ? AND tenant_id = ?", [keyHash, item.tenantId]);
  return {
    id: row.id,
    name: row.name,
    isActive: Boolean(row.is_active),
    status: row.status,
    activatedAt: row.activated_at,
    retiresAt: row.retires_at,
  };
}

/**
 * Updates an existing API key entry.
 *
 * @param {object} db - SQLite database handle.
 * @param {object} item - Parsed bulk operation.
 * @returns {Promise<object>} Updated key summary.
 */
async function updateKey(db, item) {
  const existing = await get(db, 'SELECT id, name, is_active FROM api_keys WHERE id = ? AND tenant_id = ?', [item.id, item.tenantId]);
  if (!existing) {
    throw new AppError({
      type: 'https://liquifact.com/probs/not-found',
      title: 'API Key Not Found',
      status: 404,
      detail: `API key ${item.id} was not found`,
    });
  }

  if (item.action === 'rename') {
    await run(db, 'UPDATE api_keys SET name = ? WHERE id = ? AND tenant_id = ?', [item.name, item.id, item.tenantId]);
  } else if (item.action === 'activate') {
    await run(db, "UPDATE api_keys SET is_active = 1, status = 'active', retires_at = NULL WHERE id = ? AND tenant_id = ?", [item.id, item.tenantId]);
  } else {
    await run(db, "UPDATE api_keys SET is_active = 0, status = 'retired' WHERE id = ? AND tenant_id = ?", [item.id, item.tenantId]);
  }

  const updated = await get(db, "SELECT id, name, is_active, status, activated_at, retires_at FROM api_keys WHERE id = ? AND tenant_id = ?", [item.id, item.tenantId]);
  return {
    id: updated.id,
    name: updated.name,
    isActive: Boolean(updated.is_active),
    status: updated.status,
    activatedAt: updated.activated_at,
    retiresAt: updated.retires_at,
  };
}

/**
 * Atomically rotates an active API key by retiring the old key and creating
 * the replacement in the same transaction. The old key remains usable until
 * its retires_at timestamp, and the new key becomes visible only on commit.
 *
 * @param {object} db - SQLite database handle.
 * @param {object} item - Parsed rotate operation.
 * @returns {Promise<object>} Created key summary with rotation metadata.
 */
async function rotateKey(db, item) {
  const now = new Date();
  const retiresAt = new Date(now.getTime() + ROTATION_OVERLAP_MS);
  const keyHash = hashApiKey(item.apiKey);

  try {
    await run(db, 'BEGIN IMMEDIATE');

    const existing = await get(
      db,
      "SELECT id, name, status, is_active, retires_at FROM api_keys WHERE id = ? AND tenant_id = ?",
      [item.id, item.tenantId]
    );
    if (!existing) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'API Key Not Found',
        status: 404,
        detail: `API key ${item.id} was not found`,
      });
    }
    if (existing.status !== 'active' || existing.is_active !== 1) {
      throw new AppError({
        type: 'https://liquifact.com/probs/conflict',
        title: 'API Key Not Active',
        status: 409,
        detail: `API key ${item.id} is not active and cannot be rotated`,
      });
    }

    const updateResult = await run(
      db,
      "UPDATE api_keys SET status = 'retiring', retires_at = ? WHERE id = ? AND tenant_id = ? AND status = 'active'",
      [retiresAt.toISOString(), item.id, item.tenantId]
    );
    if (updateResult.changes !== 1) {
      throw new AppError({
        type: 'https://liquifact.com/probs/conflict',
        title: 'Rotation Conflict',
        status: 409,
        detail: `API key ${item.id} was concurrently rotated`,
      });
    }

    await run(
      db,
      "INSERT INTO api_keys (tenant_id, key_hash, name, is_active, status, activated_at, retires_at) VALUES (?, ?, ?, 1, 'active', ?, NULL)",
      [item.tenantId, keyHash, item.name || existing.name, now.toISOString()]
    );

    const row = await get(
      db,
      "SELECT id, name, is_active, status, activated_at, retires_at FROM api_keys WHERE key_hash = ? AND tenant_id = ?",
      [keyHash, item.tenantId]
    );

    await run(db, 'COMMIT');

    return {
      id: row.id,
      name: row.name,
      isActive: true,
      status: row.status,
      activatedAt: row.activated_at,
      retiresAt: row.retires_at,
      previousId: existing.id,
      previousRetiresAt: retiresAt.toISOString(),
    };
  } catch (err) {
    try {
      await run(db, 'ROLLBACK');
    } catch {
      // Preserve the original error if rollback also fails.
    }
    throw err;
  }
}

/**
 * Normalizes thrown errors into a human-readable message string.
 *
 * @param {unknown} err - Thrown value.
 * @returns {string} Readable error message.
 */
function normalizeError(err) {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => issue.message).join(', ');
  }
  if (err && typeof err.message === 'string') {
    return err.message;
  }
  return 'Unknown item error';
}

/**
 * Processes a bounded bulk batch of api-key operations.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {Promise<import('express').Response|void>}
 */
router.post('/bulk', authenticateApiKey({ requiredScope: 'invoices:write' }), extractTenant, async (req, res, next) => {
  const items = req.body;

  if (!Array.isArray(items)) {
    return next(
      new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Request body must be a JSON array of api-key operations',
      })
    );
  }

  if (items.length === 0) {
    return next(
      new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Batch must contain at least one api-key operation',
      })
    );
  }

  if (items.length > MAX_BULK_ITEMS) {
    return next(
      new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: `Batch size exceeds maximum of ${MAX_BULK_ITEMS}`,
      })
    );
  }

  const db = initDb();
  try {
    await ensureApiKeyTable(db);
    const results = [];

    for (const [index, rawItem] of items.entries()) {
      try {
        const item = bulkItemSchema.parse(rawItem);
        item.tenantId = req.tenantId;
        let result;

        if (item.action === 'create') {
          result = await createKey(db, item);
        } else if (item.action === 'rotate') {
          result = await rotateKey(db, item);
        } else {
          result = await updateKey(db, item);
        }

        results.push({ index, success: true, action: item.action, result });
      } catch (err) {
        results.push({
          index,
          success: false,
          error: normalizeError(err),
        });
      }
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success).length,
    };

    return res.status(200).json({
      data: results,
      summary,
    });
  } catch (err) {
    return next(err);
  } finally {
    await closeDb(db);
  }
});

module.exports = router;
module.exports.router = router;
module.exports.MAX_BULK_ITEMS = MAX_BULK_ITEMS;
