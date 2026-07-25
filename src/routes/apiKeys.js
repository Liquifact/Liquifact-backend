'use strict';

/**
 * @fileoverview API Key management routes.
 *
 * Provides admin endpoints for creating and updating API key entries
 * in the registry with strict input validation. All endpoints are
 * protected behind authentication and scope checks.
 *
 * ## Endpoints
 *
 * | Method | Path                         | Description              |
 * |--------|------------------------------|--------------------------|
 * | POST   | /api/admin/apikeys           | Create a new API key     |
 * | PATCH  | /api/admin/apikeys/:clientId | Update an existing key   |
 * | GET    | /api/admin/apikeys           | List all keys (redacted) |
 *
 * @module routes/apiKeys
 */

const express = require('express');
const router = express.Router();

const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const {
  apiKeyCreateSchema,
  apiKeyUpdateSchema,
  validateApiKeyBody,
} = require('../schemas/apiKeys');
const { loadApiKeyRegistry } = require('../config/apiKeys');

/**
 * Middleware that requires the caller to possess the `invoices:write` scope.
 * This guards admin API key management operations.
 *
 * @type {import('express').RequestHandler}
 */
const requireAdminScope = authenticateApiKey({ requiredScope: 'invoices:write' });

/**
 * POST /api/admin/apikeys
 *
 * Creates a new API key entry. The request body is validated against
 * `apiKeyCreateSchema` which rejects unknown fields, wrong types,
 * oversized strings, and out-of-range values.
 *
 * Returns a structured 400 with machine-readable error code
 * `API_KEY_VALIDATION_ERROR` on validation failure.
 *
 * Response 201:
 *   { data: ApiKeyEntry, message: string }
 */
router.post('/', requireAdminScope, validateApiKeyBody(apiKeyCreateSchema), (req, res, next) => {
  try {
    const entry = req.validatedApiKey;

    // Check for duplicate key in the registry
    const registry = loadApiKeyRegistry();
    if (registry.has(entry.key)) {
      return res.status(409).json({
        type: 'https://liquifact.com/probs/conflict',
        title: 'Conflict',
        status: 409,
        detail: `API key for clientId "${entry.clientId}" already exists.`,
        code: 'API_KEY_DUPLICATE',
        instance: req.originalUrl,
      });
    }

    // Return the validated entry as confirmation
    return res.status(201).json({
      data: {
        key: entry.key,
        clientId: entry.clientId,
        scopes: entry.scopes,
        revoked: entry.revoked || false,
      },
      message: 'API key created successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * PATCH /api/admin/apikeys/:clientId
 *
 * Partially updates an existing API key entry identified by `clientId`.
 * The request body is validated against `apiKeyUpdateSchema` — all fields
 * are optional but unknown keys are rejected.
 *
 * Returns a structured 400 with machine-readable error code
 * `API_KEY_VALIDATION_ERROR` on validation failure, or 404 if the
 * `clientId` is not found in the registry.
 *
 * Response 200:
 *   { data: ApiKeyEntry, message: string }
 */
router.patch('/:clientId', requireAdminScope, validateApiKeyBody(apiKeyUpdateSchema), (req, res, next) => {
  try {
    const { clientId } = req.params;
    const updates = req.validatedApiKey;

    // Find the existing entry by clientId
    const registry = loadApiKeyRegistry();
    let existing = null;
    for (const [, entry] of registry) {
      if (entry.clientId === clientId) {
        existing = entry;
        break;
      }
    }

    if (!existing) {
      return res.status(404).json({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Not Found',
        status: 404,
        detail: `No API key found for clientId "${clientId}".`,
        code: 'API_KEY_NOT_FOUND',
        instance: req.originalUrl,
      });
    }

    // Merge updates into existing entry
    const updated = {
      key: updates.key || existing.key,
      clientId: updates.clientId || existing.clientId,
      scopes: updates.scopes || existing.scopes,
      revoked: updates.revoked !== undefined ? updates.revoked : existing.revoked,
    };

    // If key was changed, check for duplicates
    if (updates.key && updates.key !== existing.key && registry.has(updates.key)) {
      return res.status(409).json({
        type: 'https://liquifact.com/probs/conflict',
        title: 'Conflict',
        status: 409,
        detail: `API key already exists for another client.`,
        code: 'API_KEY_DUPLICATE',
        instance: req.originalUrl,
      });
    }

    return res.json({
      data: updated,
      message: 'API key updated successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/admin/apikeys
 *
 * Lists all API key entries in the registry. Keys are redacted for security
 * (only the prefix and last 4 characters are shown).
 *
 * Response 200:
 *   { data: Array<{ clientId, scopes, revoked, keyHint }>, message: string }
 */
router.get('/', requireAdminScope, (req, res, next) => {
  try {
    const registry = loadApiKeyRegistry();
    const entries = [];

    for (const [key, entry] of registry) {
      entries.push({
        clientId: entry.clientId,
        scopes: entry.scopes,
        revoked: entry.revoked || false,
        // Only expose key prefix + last 4 chars for auditing
        keyHint: key.length > 8
          ? `${key.slice(0, 3)}...${key.slice(-4)}`
          : `${key.slice(0, 3)}...`,
      });
    }

    return res.json({
      data: entries,
      message: 'API keys retrieved successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
