/**
 * API Keys endpoints with cursor-based pagination and key lifecycle management.
 *
 * GET /v1/api-keys
 *   Query params:
 *     limit   {number}  items per page (default 20, max 100)
 *     cursor  {string}  opaque cursor from previous page
 *   Response:
 *     { data: ApiKeyEntry[], nextCursor: string | null }
 *
 * POST /v1/api-keys
 *   Body: { key: string, clientId: string, scopes: string[], revoked?: boolean }
 *   Response 201: { data: ApiKeyEntry, message: string }
 *
 * GET /v1/api-keys/:key
 *   Response 200: { data: ApiKeyEntry }
 *   Response 404: { error: string }
 *
 * @module routes/apiKeys
 */

'use strict';

const express = require('express');
const { loadApiKeyRegistry, validateEntry } = require('../config/apiKeys');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── Runtime entries store (in-memory) ─────────────────────────────────────────
// Keys created via POST are stored here so they appear in subsequent GET
// listings and GET /:key lookups. This mirrors the env-based registry for
// dynamically created keys.

/** @type {Map<string, import('../config/apiKeys').ApiKeyEntry>} */
let runtimeEntries = new Map();

/**
 * Resets the runtime entries store. Exported so test suites can clean up
 * between cases without restarting the process.
 *
 * @returns {void}
 */
function resetRuntimeEntries() {
  runtimeEntries = new Map();
}

/**
 * Builds the combined registry (env-based entries + runtime entries).
 * Runtime entries take precedence so a dynamically created key with the
 * same key string as a static entry overrides it.
 *
 * @returns {Map<string, import('../config/apiKeys').ApiKeyEntry>}
 */
function buildCombinedRegistry() {
  const staticRegistry = loadApiKeyRegistry();
  const combined = new Map(staticRegistry);
  for (const [key, entry] of runtimeEntries) {
    combined.set(key, entry);
  }
  return combined;
}

/**
 * Validates an API key creation/update request body.
 *
 * Shared validation consumed by POST and any future write endpoints so
 * that every handler enforces the same contract.
 *
 * @param {unknown} body - The request body to validate.
 * @returns {{ valid: true, entry: import('../config/apiKeys').ApiKeyEntry } | { valid: false, error: string }}
 */
function validateApiKeyBody(body) {
  try {
    const entry = validateEntry(body, 0);
    return { valid: true, entry };
  } catch (err) {
    return { valid: false, error: `Validation failed: ${err.message}` };
  }
}

// ── Encode/decode cursors ────────────────────────────────────────────────────

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

// ── Route handler definitions (reusable) ─────────────────────────────────────

/**
 * GET list handler — returns a paginated list of registered API keys.
 */
function listHandler(req, res) {
  // Parse and clamp limit
  let limit = parseInt(req.query.limit, 10);
  if (Number.isNaN(limit) || limit < 1) {
    limit = DEFAULT_LIMIT;
  }
  if (limit > MAX_LIMIT) {
    limit = MAX_LIMIT;
  }

  // Load all keys from the combined registry
  const registry = buildCombinedRegistry();
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
    count: allEntries.length,
    nextCursor,
  });
}

/**
 * POST create handler — creates a new API key in the runtime store.
 */
function createHandler(req, res) {
  const validation = validateApiKeyBody(req.body);

  if (!validation.valid) {
    return res.status(422).json({ error: validation.error });
  }

  const entry = validation.entry;

  // Check for duplicate key in the combined registry
  const existing = buildCombinedRegistry().get(entry.key);
  if (existing) {
    return res.status(200).json({
      data: existing,
      message: 'API key already exists (idempotent).',
      idempotent: true,
    });
  }

  // Store in runtime entries
  runtimeEntries.set(entry.key, entry);

  return res.status(201).json({
    data: entry,
    message: 'API key created successfully.',
  });
}

/**
 * GET single-key handler — returns a single API key by its key string.
 */
function singleKeyHandler(req, res) {
  const key = req.params.key;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid key parameter' });
  }

  const registry = buildCombinedRegistry();
  const entry = registry.get(key);

  if (!entry) {
    return res.status(404).json({ error: 'API key not found' });
  }

  return res.json({ data: entry });
}

// ── Route registration ───────────────────────────────────────────────────────
// Static path aliases are registered BEFORE parameterised routes so they
// take priority in Express 5 routing.

// GET list — accessible at /, /keys, and /api-keys
router.get('/', listHandler);
router.get('/keys', listHandler);
router.get('/api-keys', listHandler);

// POST create — accessible at / and /keys
router.post('/', createHandler);
router.post('/keys', createHandler);

// GET single key
router.get('/:key', singleKeyHandler);

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
