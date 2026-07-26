/**
 * API Keys listing endpoint with cursor-based pagination.
 *
 * GET /v1/api-keys
 * Query params:
 *   limit   {number}  items per page (default 20, max 100)
 *   cursor  {string}  opaque cursor from previous page
 *
 * Response:
 *   {
 *     data: ApiKeyEntry[],
 *     nextCursor: string | null
 *   }
 */

'use strict';

const express = require('express');
const { loadApiKeyRegistry } = require('../config/apiKeys');
const { getApiKeysCache } = require('../cache/apiKeysCache');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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

module.exports = router;
