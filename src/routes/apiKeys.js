'use strict';

const express = require('express');
const { z } = require('zod');
const { hashApiKey, initDb } = require('../middleware/apiKey');
const AppError = require('../errors/AppError');

const router = express.Router();

const MAX_BULK_ITEMS = 25;

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
]);

/**
 * Closes the SQLite database handle.
 *
 * @param {object} db - SQLite database handle.
 * @returns {Promise<void>}
 */
function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

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
  await run(db, 'INSERT INTO api_keys (key_hash, name, is_active) VALUES (?, ?, 1)', [
    keyHash,
    item.name,
  ]);
  const row = await get(db, 'SELECT id, name, is_active FROM api_keys WHERE key_hash = ?', [keyHash]);
  return {
    id: row.id,
    name: row.name,
    isActive: Boolean(row.is_active),
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
  const existing = await get(db, 'SELECT id, name, is_active FROM api_keys WHERE id = ?', [item.id]);
  if (!existing) {
    throw new AppError({
      type: 'https://liquifact.com/probs/not-found',
      title: 'API Key Not Found',
      status: 404,
      detail: `API key ${item.id} was not found`,
    });
  }

  if (item.action === 'rename') {
    await run(db, 'UPDATE api_keys SET name = ? WHERE id = ?', [item.name, item.id]);
  } else {
    await run(db, 'UPDATE api_keys SET is_active = ? WHERE id = ?', [item.action === 'activate' ? 1 : 0, item.id]);
  }

  const updated = await get(db, 'SELECT id, name, is_active FROM api_keys WHERE id = ?', [item.id]);
  return {
    id: updated.id,
    name: updated.name,
    isActive: Boolean(updated.is_active),
  };
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
router.post('/bulk', async (req, res, next) => {
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
        let result;

        if (item.action === 'create') {
          result = await createKey(db, item);
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

module.exports = {
  router,
  MAX_BULK_ITEMS,
};
