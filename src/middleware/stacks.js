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

/**
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
  if (req.headers['x-api-key']) {
    const originalStatus = res.status;
    const originalJson = res.json;
    let statusCode;

    res.status = function(code) {
      statusCode = code;
      return originalStatus.apply(this, arguments);
    };

    res.json = function(body) {
      if (statusCode === 403 && body && body.error && body.error.startsWith('Insufficient permissions')) {
        let clientId = 'unknown';
        try {
          const rawKey = req.headers['x-api-key'].trim();
          const registry = loadApiKeyRegistry();
          for (const [key, entry] of registry) {
            if (timingSafeStringEqual(rawKey, key)) {
              clientId = entry.clientId;
              break;
            }
          }
        } catch (err) {}

        createAuditLog({
          actor: clientId,
          action: 'READ',
          resourceType: 'admin_api',
          resourceId: req.path,
          statusCode: 403,
          ipAddress: req.ip,
          userAgent: req.get('user-agent') || 'unknown',
          metadata: { reason: 'insufficient_scope', requiredScope: 'admin' }
        }).catch(() => {});

        res.setHeader('Content-Type', 'application/problem+json');
        return originalJson.call(this, {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'Insufficient permissions. Required scope: "admin".'
        });
      }
      return originalJson.call(this, body);
    };

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
