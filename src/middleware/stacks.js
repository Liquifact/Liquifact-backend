'use strict';

/**
 * @fileoverview Reusable composed middleware stacks.
 *
 * Centralises the auth→tenant and admin-auth→tenant chains so that every
 * protected router composes the same, consistently-ordered sequence.
 *
 * @module middleware/stacks
 */

const { authenticateToken } = require('./auth');
const { extractTenant } = require('./tenant');
const { authenticateApiKey } = require('./apiKeyAuth');
const { createAuditLog } = require('../services/auditLog');
const { loadApiKeyRegistry, timingSafeStringEqual } = require('../config/apiKeys');

const _adminApiKeyMiddleware = authenticateApiKey({ scope: 'admin' });

/**
 * Accepts either a valid admin JWT or a valid API key.
 * Internal helper — not exported; consumed by {@link adminStack}.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function adminAuth(req, res, next) {
  const apiKeyHeaderPresent = Object.prototype.hasOwnProperty.call(req.headers, 'x-api-key');

  if (apiKeyHeaderPresent) {
    return _adminApiKeyMiddleware(req, res, next);
  }
  return authenticateToken(req, res, next);
}

/**
 * Standard authenticated + tenant-scoped middleware stack.
 *
 * Ordering: `authenticateToken` → `extractTenant`
 *
 * Mount with `router.use(...authenticatedTenantStack)` on any router that
 * requires a valid JWT and a resolved `req.tenantId`.
 *
 * @type {import('express').RequestHandler[]}
 */
const authenticatedTenantStack = [authenticateToken, extractTenant];

/**
 * Admin middleware stack that accepts either a JWT or an API key,
 * followed by tenant extraction.
 *
 * Ordering: `adminAuth` (JWT-or-API-key) → `extractTenant`
 *
 * Mount with `router.use(...adminStack)` on any admin router.
 *
 * @type {import('express').RequestHandler[]}
 */
const adminStack = [adminAuth, extractTenant];

module.exports = { authenticatedTenantStack, adminStack };
