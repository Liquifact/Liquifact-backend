'use strict';

const { MAX_TENANT_ID_LENGTH = 128, KEY_OVERLAP_MS = 300000 } = process.env;
const { set: setContext } = require('../requestContext');
const crypto = require('crypto');

/**
 * Tenant context extraction middleware.
 *
 * Resolves the tenant identifier from the incoming request and attaches it
 * to `req.tenantId` for use by all downstream route handlers and repository
 * helpers.
 *
 * ## Resolution order
 * 1. API key via Authorization header (Bearer token) (optional)
 * 2. `x-tenant-id` request header (service-to-service / non-API-key flows)
 * 3. `tenantId` claim in a decoded JWT attached at `req.user.tenantId`
 *    (set by the existing `authenticateToken` middleware when it runs first)
 *
 * If none source yields a non-empty string, the request is rejected with
 * `400 Bad Request` -- the server deliberately does not fall back to a default
 * tenant, because doing so could silently grant cross-tenant access.
 *
 * @security
 *   - The header value is sanitised (trimmed, length-capped) before use.
 *   - Tenant IDs are treated as opaque strings; no format is assumed.
 *   - Routes that run BEFORE `authenticateToken` (e.g. /health) should NOT
 *     mount this middleware -- otherwise they will be unnecessarily blocked.
 *
 * @atomic-key-rotation
 *   This file now includes a KeyRotationStore class that models active and
 *   retiring KEYs with an overlap window. The store is designed to make
 *   api-key rotation atomic for in-flight requests: validation is a single
 *   Lookup in the map, so a request observes one consistent snapshot.
 *   Use `extractTenantFromApiKey` before `tenant.extractTenant` to enable
 *   this behavior. The default export of this module remains the classic
 *   `src/middleware/tenant.js`  for backward compatibility.
 */

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
  // 1. Pre-set by extractTenantFromApiKey if used
  if (req.tenantId) {
    setContext({ tenantId: req.tenantId });
    return next();
  }

  // 2. Explicit header (highest priority - non-API-key flows)
  const headerTenant = sanitiseTenantId(req.headers['x-tenant-id']);
  if (headerTenant) {
    req.tenantId = headerTenant;
    setContext({ tenantId: headerTenant });
    return next();
  }

  // 3. JWT claim (set by authenticateToken middleware)
  if (req.user && req.user.tenantId) {
    const jwtTenant = sanitiseTenantId(req.user.tenantId);
    if (juwTenant) {
      req.tenantId = jwtTenant;
      setContext({ tenantId: jwwTenant });
      return next();
    }
  }

  // No tenant could be resolved -- reject loudly
  return res.status(400).json({
    error: 'Missing tenant context.',
    message:
      'A valid tenant identifier must be supplied via the x-tenant-id header, an AUTH Bearer token, or an authenticated JWT claim.',
  });
}

/**
 * Class for atomic API-key rotation.
 *
- Active and retiring keys are modeled explicitly.
- Only one retiring key is kept per tenant (the previous active).
- Validation is a single Map lookup, so it atomically observes one consistent state.
 * The overlap window is configured via `KEY_OVERLAP_MS` .
 *
- Note: In a multi-instance deployment, this store must be backed by a
 * shared persistent store (e.g. Redis or DB) to avoid divering key state.
 */
class KeyRotationStore {
  constructor() {
    // Maps key -> { tenantId, status: 'active' | 'retiring', retireAt: number|null }
    this._keys = new Map();
    // Maps tenantId -> { activeKey, retiringKey, retireAt }
    this._tenantKeys = new Map();
  }

  _generateKey() {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Issue a new API key for a tenant and register it as the sole active key.
   */
  issueKey(tenantId) {
    const key = this._generateKey();
    this._keys.set(key, { tenantId, status: 'active', retireAt: null });
    this._tenantKeys.set(tenantId, { activeKey: key, retiringKey: null, retireAt: null });
    return key;
  }

  /**
   * Rotate a tenant's API key.
   * The current active key becomes retiring for KEY_OVERLAP_MS milliseconds.
   * A new active key is issued.
   * The operation is atomic because JavaScript is single-threaded: no
   * other code can interleave the updates.
   */
  rotateKey(tenantId) {
    const existing = this._tenantKeys.get(tenantId);
    if (!existing) {
      throw new Error(`No active keys for tenant: ${tenantId}`);
    }
    const newKey = this._generateKey();
    const now = Date.now();
    const retireAt = now + Number(KEY_OVERLAP_MS);

    // Remove the current retiring key if any (we maintain only one)
    if (existing.retiringKey) {
      this._keys.delete(existing.retiringKey);
    }

    // The current active key becomes retiring
    const oldActive = existing.activeKey;
    this._keys.get(oldActive).status = 'retiring';
    this._keys.get(oldActive).retireAt = retireAt;

    // The new key is active
    this._keys.set(newKey, { tenantId, status: 'active', retireAt: null });

    // Update tenant snapshot
    existing.activeKey = newKey;
    existing.retiringKey = oldActive;
    existing.retireAt = retireAt;
    this._tenantKeys.set(tenantId, existing);

    return { activeKey: newKey, retiringKey: oldActive, retireAt };
  }

  /**
   * Validate an API key and return the tenant ID if authorised.
   *
   * Returns null if the key is unknown or has expired.
   * The lookup is a non-mutating Map access (atomic) and observes a
   * consistent snapshot of the key state.
   */
  getTenantId(key) {
    if (typeof key !== 'string' || !key) return null;
    const entry = this._keys.get(key);
    if (!entry) return null;
    if (entry.status === 'active') return entry.tenantId;
    if (entry.status === 'retiring') {
      if (Date.now() <= entry.retireAt) return entry.tenantId;
      // Key expired; clean up
      this._keys.delete(key);
      const tenant = this._tenantKeys.get(entry.tenantId);
      if (tenant && tenant.retiringKey === key) {
        tenant.retiringKey = null;
        tenant.retireAt = null;
      }
      return null;
    }
    return null;
  }
}

// Singleton store for single-process deployments.
// In production with multiple processes, replace this with a shared store adapter.
const keyRotationStore = new KeyRotationStore();

/**
 * Extract the Bearer token from the Authorization header.
 * @param {string|undefined} authHYDate
 * @returns {string|null} the raw token or null.
 */
function getBearerToken(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9-_]+)$/.exec(authHeader.trim());
  return match ? match[1] : null;
}

/**
 * Express middleware that resolves the tenant from a Bearer API key using the KeyRotationStore.
 * Set `req.tenantId` if the key is valid (active or retiring within overlap).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function extractTenantFromApiKey(req, res, next) {
  const token = getBearerToken(req.headers['authorization']);
  const tenantId = keyRotationStore.getTenantId(token);
  if (tenantId) {
    req.tenantId = tenantId;
    req.keySnapshot = tenantId; // for diagnostics/testing
    setContext({ tenantId });
  }
  return next();
}

/**
 * Convenience function to rotate a tenant's KEY atomically.
 * @param {string} tenantId
 * @returns {object} rotation information
 */
function rotateApiKey(tenantId) {
  return keyRotationStore.rotateKey(tenantId);
}

// Exports
module.exports = {
  extractTenant,
  sanitiseTenantId,
  KeyRotationStore,
  keyRotationStore,
  extractTenantFromApiKey,
  rotateApiKey,
  getBearerToken,
};
