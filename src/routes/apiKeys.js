'use strict';

const express = require('express');
const { loadApiKeyRegistry } = require('../config/apiKeys');
const {
  fromCreateApiKeyRequestDto,
  toCreateApiKeyResponseDto,
  toDuplicateApiKeyResponseDto,
  toListApiKeysResponseDto,
  toGetApiKeyResponseDto,
  validateCreateApiKeyRequest,
} = require('./apiKeys.dto');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Module-level runtime store for dynamically created API keys.
 * Reset via {@link resetRuntimeEntries} between tests.
 * @type {Map<string, import('../config/apiKeys').ApiKeyEntry>}
 */
const runtimeRegistry = new Map();

/**
 * Resets the runtime key registry. Used between tests to isolate state.
 * @returns {void}
 */
function resetRuntimeEntries() {
  runtimeRegistry.clear();
}

/**
 * Combines the environment-based registry with the runtime store.
 * Runtime entries take precedence when a key exists in both.
 *
 * @param {NodeJS.ProcessEnv} [env] - Optional env override for loading the config registry.
 * @returns {import('../config/apiKeys').ApiKeyEntry[]} Ordered array of all known entries.
 */
function getAllEntries(env) {
  const configRegistry = loadApiKeyRegistry(env || process.env);
  const configEntries = Array.from(configRegistry.values());
  const seen = new Set();

  for (const entry of configEntries) {
    seen.add(entry.key);
  }

  const runtimeEntries = Array.from(runtimeRegistry.values());
  const merged = [...configEntries];

  for (const entry of runtimeEntries) {
    if (!seen.has(entry.key)) {
      merged.push(entry);
      seen.add(entry.key);
    }
  }

  return merged;
}

// ── Existing cursor-based listing (V1 mount: /v1/api-keys) ──────────────

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
 * GET /
 * Returns a paginated list of registered API keys from the config registry.
 */
router.get('/', (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (Number.isNaN(limit) || limit < 1) {
    limit = DEFAULT_LIMIT;
  }
  if (limit > MAX_LIMIT) {
    limit = MAX_LIMIT;
  }

  const registry = loadApiKeyRegistry();
  const allEntries = Array.from(registry.values());

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
    startIndex = foundIndex + 1;
  }

  const page = allEntries.slice(startIndex, startIndex + limit);

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

// ── New list + get + create routes (mounted at /api and /) ──────────────

/**
 * GET /keys
 * GET /api-keys
 * Returns a flat list of all known API keys (config + runtime).
 */
router.get('/keys', (req, res) => {
  const all = getAllEntries(req.app && req.app.locals && req.app.locals.env);
  return res.json(toListApiKeysResponseDto(all));
});

router.get('/api-keys', (req, res) => {
  const all = getAllEntries(req.app && req.app.locals && req.app.locals.env);
  return res.json(toListApiKeysResponseDto(all));
});

/**
 * POST /keys
 * POST /api-keys
 * Creates a new API key in the runtime store.
 * Idempotency is handled by the idempotencyMiddleware.
 */
router.post('/keys', (req, res) => {
  const errors = validateCreateApiKeyRequest(req.body);
  if (errors.length > 0) {
    return res.status(422).json({
      error: 'Validation failed.',
      code: 'VALIDATION_ERROR',
      details: errors,
    });
  }

  const { key } = req.body;

  const all = getAllEntries(req.app && req.app.locals && req.app.locals.env);
  const existing = all.find((e) => e.key === key);

  if (existing) {
    return res.status(200).json(
      toDuplicateApiKeyResponseDto(existing, 'API key already exists.')
    );
  }

  const entry = fromCreateApiKeyRequestDto(req.body);
  runtimeRegistry.set(entry.key, entry);

  return res.status(201).json(
    toCreateApiKeyResponseDto(entry, 'API key created successfully.')
  );
});

router.post('/api-keys', (req, res) => {
  const errors = validateCreateApiKeyRequest(req.body);
  if (errors.length > 0) {
    return res.status(422).json({
      error: 'Validation failed.',
      code: 'VALIDATION_ERROR',
      details: errors,
    });
  }

  const { key } = req.body;

  const all = getAllEntries(req.app && req.app.locals && req.app.locals.env);
  const existing = all.find((e) => e.key === key);

  if (existing) {
    return res.status(200).json(
      toDuplicateApiKeyResponseDto(existing, 'API key already exists.')
    );
  }

  const entry = fromCreateApiKeyRequestDto(req.body);
  runtimeRegistry.set(entry.key, entry);

  return res.status(201).json(
    toCreateApiKeyResponseDto(entry, 'API key created successfully.')
  );
});

/**
 * GET /keys/:key
 * GET /api-keys/:key
 * Returns a single API key by its key string.
 */
router.get('/keys/:key', (req, res) => {
  const all = getAllEntries(req.app && req.app.locals && req.app.locals.env);
  const entry = all.find((e) => e.key === req.params.key);

  if (!entry) {
    return res.status(404).json({
      error: 'API key not found.',
      code: 'NOT_FOUND',
    });
  }

  return res.json(toGetApiKeyResponseDto(entry));
});

router.get('/api-keys/:key', (req, res) => {
  const all = getAllEntries(req.app && req.app.locals && req.app.locals.env);
  const entry = all.find((e) => e.key === req.params.key);

  if (!entry) {
    return res.status(404).json({
      error: 'API key not found.',
      code: 'NOT_FOUND',
    });
  }

  return res.json(toGetApiKeyResponseDto(entry));
});

module.exports = router;
module.exports.resetRuntimeEntries = resetRuntimeEntries;
