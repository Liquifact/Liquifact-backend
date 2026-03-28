/**
 * @file __tests__/tenant.test.js
 * @description Unit tests for the tenant extraction middleware.
 *
 * Coverage targets:
 *   - Header resolution (happy path)
 *   - JWT claim resolution (happy path)
 *   - Header takes priority over JWT claim
 *   - Missing tenant → 400
 *   - Oversized / whitespace-only tenant ID → 400
 *   - sanitiseTenantId helper edge cases
 */

'use strict';

const { extractTenant, sanitiseTenantId } = require('../middleware/tenant');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock req/res/next triple.
 *
 * @param {{ headers?: object, user?: object }} opts
 * @returns
 */
function buildMocks({ headers = {}, user = undefined } = {}) {
  const req = { headers, user };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

// ─── sanitiseTenantId ─────────────────────────────────────────────────────────

describe('sanitiseTenantId', () => {
  it('returns null for undefined', () => {
    expect(sanitiseTenantId(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(sanitiseTenantId(null)).toBeNull();
  });

  it('returns null for a number', () => {
    expect(sanitiseTenantId(42)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(sanitiseTenantId('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(sanitiseTenantId('   ')).toBeNull();
  });

  it('returns null for a string exceeding 128 chars', () => {
    expect(sanitiseTenantId('a'.repeat(129))).toBeNull();
  });

  it('returns the trimmed string for a valid value', () => {
    expect(sanitiseTenantId('  tenant-abc  ')).toBe('tenant-abc');
  });

  it('accepts a string of exactly 128 characters', () => {
    const id = 'x'.repeat(128);
    expect(sanitiseTenantId(id)).toBe(id);
  });
});

// ─── extractTenant ────────────────────────────────────────────────────────────

describe('extractTenant middleware', () => {
  describe('happy path – header resolution', () => {
    it('sets req.tenantId from x-tenant-id header and calls next()', () => {
      const { req, res, next } = buildMocks({
        headers: { 'x-tenant-id': 'tenant-alpha' },
      });
      extractTenant(req, res, next);
      expect(req.tenantId).toBe('tenant-alpha');
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('trims whitespace from the header value', () => {
      const { req, res, next } = buildMocks({
        headers: { 'x-tenant-id': '  tenant-beta  ' },
      });
      extractTenant(req, res, next);
      expect(req.tenantId).toBe('tenant-beta');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('happy path – JWT claim resolution', () => {
    it('sets req.tenantId from req.user.tenantId when no header present', () => {
      const { req, res, next } = buildMocks({
        headers: {},
        user: { id: 'u1', tenantId: 'tenant-jwt' },
      });
      extractTenant(req, res, next);
      expect(req.tenantId).toBe('tenant-jwt');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('priority: header over JWT', () => {
    it('uses header tenantId when both header and JWT claim are present', () => {
      const { req, res, next } = buildMocks({
        headers: { 'x-tenant-id': 'header-tenant' },
        user: { tenantId: 'jwt-tenant' },
      });
      extractTenant(req, res, next);
      expect(req.tenantId).toBe('header-tenant');
    });
  });

  describe('missing tenant → 400', () => {
    it('returns 400 when no header and no req.user', () => {
      const { req, res, next } = buildMocks({ headers: {} });
      extractTenant(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when req.user exists but has no tenantId', () => {
      const { req, res, next } = buildMocks({ user: { id: 'u1' } });
      extractTenant(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when header is whitespace only', () => {
      const { req, res, next } = buildMocks({
        headers: { 'x-tenant-id': '   ' },
      });
      extractTenant(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when header tenant ID exceeds 128 characters', () => {
      const { req, res, next } = buildMocks({
        headers: { 'x-tenant-id': 'x'.repeat(200) },
      });
      extractTenant(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when JWT tenantId is whitespace only', () => {
      const { req, res, next } = buildMocks({
        user: { tenantId: '   ' },
      });
      extractTenant(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });
  });
});