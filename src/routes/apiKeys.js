/**
 * Lightweight API-keys route handlers for testing and integration coverage.
 *
 * These handlers expose a small endpoint family for inspecting and creating
 * API-key entries sourced from the existing environment-backed registry.
 *
 * @module routes/apiKeys
 */

'use strict';

const express = require('express');
const { loadApiKeyRegistry, validateEntry } = require('../config/apiKeys');
const idempotencyMiddleware = require('../middleware/idempotency');

const router = express.Router();
const runtimeEntries = new Map();

function cloneEntry(entry) {
  return {
    key: entry.key,
    clientId: entry.clientId,
    scopes: [...entry.scopes],
    revoked: Boolean(entry.revoked),
  };
}

function buildEntries(env = process.env) {
  const merged = new Map();

  for (const [key, entry] of loadApiKeyRegistry(env)) {
    merged.set(key, cloneEntry(entry));
  }

  for (const [key, entry] of runtimeEntries) {
    merged.set(key, cloneEntry(entry));
  }

  return Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function getEntryByKey(key, env = process.env) {
  return buildEntries(env).find((entry) => entry.key === key);
}

function parseValidationErrors(error) {
  const details = [];

  if (error && Array.isArray(error.issues)) {
    for (const issue of error.issues) {
      details.push({
        field: issue.path && issue.path.length ? issue.path[0] : 'body',
        message: issue.message,
      });
    }
  }

  if (details.length === 0) {
    details.push({ field: 'body', message: error.message || 'Invalid request body.' });
  }

  return details;
}

function createApiKeyHandler(req, res) {
  try {
    const entry = validateEntry(req.body, 0);
    const existing = getEntryByKey(entry.key, req.app.locals?.env || process.env);

    if (existing) {
      return res.status(200).json({
        data: existing,
        message: 'API key already exists.',
        idempotent: true,
      });
    }

    runtimeEntries.set(entry.key, entry);

    return res.status(201).json({
      data: entry,
      message: 'API key created successfully.',
    });
  } catch (error) {
    return res.status(422).json({
      error: 'Validation failed.',
      code: 'VALIDATION_ERROR',
      details: parseValidationErrors(error),
    });
  }
}

function listApiKeysHandler(req, res) {
  const entries = buildEntries(req.app.locals?.env || process.env);

  return res.status(200).json({
    data: entries,
    count: entries.length,
    message: 'API keys retrieved successfully.',
  });
}

function getApiKeyHandler(req, res) {
  const entry = getEntryByKey(req.params.key, req.app.locals?.env || process.env);

  if (!entry) {
    return res.status(404).json({
      error: 'API key not found.',
      code: 'NOT_FOUND',
    });
  }

  return res.status(200).json({
    data: entry,
    message: 'API key retrieved successfully.',
  });
}

router.get('/api-keys', listApiKeysHandler);
router.post('/api-keys', idempotencyMiddleware, createApiKeyHandler);
router.get('/api-keys/:key', getApiKeyHandler);

router.get('/keys', listApiKeysHandler);
router.post('/keys', idempotencyMiddleware, createApiKeyHandler);
router.get('/keys/:key', getApiKeyHandler);

router.resetRuntimeEntries = () => {
  runtimeEntries.clear();
};

module.exports = router;
