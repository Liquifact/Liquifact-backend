/**
 * Tenant context extraction middleware.
 *
 * Resolves the tenant identifier from the incoming request and attaches it
 * to `req.tenantId` for use by all downstream route handlers and repository
 * helpers.
 *
 * ## Resolution order
 * 1. `x-tenant-id` request header  (service-to-service / API-key flows)
 * 2. `tenantId` claim in a decoded JWT attached at `req.user.tenantId`
 *    (set by the existing `authenticateToken` middleware when it runs first)
 *
 * If neither source yields a non-empty string, the request is rejected with
 * `400 Bad Request` — the server deliberately does not fall back to a default
 * tenant, because doing so could silently grant cross-tenant access.
 *
 * @security
 *   - The header value is sanitised (trimmed, length-capped) before use.
 *   - Tenant IDs are treated as opaque strings; no format is assumed.
 *   - Routes that run BEFORE `authenticateToken` (e.g. /health) should NOT
 *     mount this middleware — otherwise they will be unnecessarily blocked.
 */

'use strict';

const { MAX_TENANT_ID_LENGTH = 128 } = process.env;

/**
 * Sanitise a raw tenant-ID string.
 * Returns null if the value is absent, not a string, or exceeds the
 * maximum permitted length.
 *
 * @param {unknown} raw - The raw value to sanitise.
 * @returns {string|null} The sanitised tenant ID, or null.
 */
function sanitiseTenantId(raw) {
  if (typeof raw !== 'string') { return null; }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_TENANT_ID_LENGTH) { return null; }
  return trimmed;
}

/**
 * Express middleware that resolves and attaches `req.tenantId`.
 *
 * Mount AFTER `authenticateToken` on any route that must be tenant-scoped.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function extractTenant(req, res, next) {
  // 1. Explicit header (highest priority – service-to-service)
  const headerTenant = sanitiseTenantId(req.headers['x-tenant-id']);
  if (headerTenant) {
    req.tenantId = headerTenant;
    return next();
  }

  // 2. JWT claim (set by authenticateToken middleware)
  if (req.user && req.user.tenantId) {
    const jwtTenant = sanitiseTenantId(req.user.tenantId);
    if (jwtTenant) {
      req.tenantId = jwtTenant;
      return next();
    }
  }

  // No tenant could be resolved — reject loudly
  return res.status(400).json({
    error: 'Missing tenant context.',
    message:
      'A valid tenant identifier must be supplied via the x-tenant-id header or an authenticated JWT claim.',
  });
}

module.exports = { extractTenant, sanitiseTenantId };