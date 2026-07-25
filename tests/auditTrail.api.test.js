'use strict';

/**
 * API tests for GET /api/audit-trail/:invoiceId (issue #426).
 *
 * Covers:
 * - Authorized access (admin, owner) returns trail
 * - Foreign invoice (wrong tenant) → 404
 * - Nonexistent invoice → 404
 * - Insufficient role → 404
 * - Unauthenticated → 401
 * - Missing tenant → 400
 * - Enumeration regression: foreign and nonexistent are indistinguishable
 */

jest.mock('../src/db/knex');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/db/knex');
const { createApp } = require('../src/app');
const { createAuditLog, clearAuditLogs } = require('../src/services/auditLog');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const token = (claims) => jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';
const INV_A = 'inv_trail_001'; // belongs to TENANT_A
const INV_B = 'inv_trail_002'; // belongs to TENANT_B

const FIXTURES = {
  [`${INV_A}:${TENANT_A}`]: { invoice_id: INV_A, tenant_id: TENANT_A, status: 'pending' },
  [`${INV_B}:${TENANT_B}`]: { invoice_id: INV_B, tenant_id: TENANT_B, status: 'funded' },
};

function setupDb() {
  db.mockImplementation(() => {
    const state = { _conds: {} };
    const chain = {
      where(conds) { Object.assign(state._conds, conds); return chain; },
      first() {
        const { invoice_id, tenant_id } = state._conds;
        return Promise.resolve(FIXTURES[`${invoice_id}:${tenant_id}`] || null);
      },
      select() { return chain; },
      orderBy() { return chain; },
    };
    return chain;
  });
}

const adminA  = token({ sub: 'u1', role: 'admin',    tenantId: TENANT_A });
const ownerA  = token({ sub: 'u2', role: 'owner',    tenantId: TENANT_A });
const investA = token({ sub: 'u3', role: 'investor', tenantId: TENANT_A });
const noRole  = token({ sub: 'u4',                   tenantId: TENANT_A });

describe('GET /api/audit-trail/:invoiceId', () => {
  let app;

  beforeAll(() => { app = createApp(); });

  beforeEach(() => {
    setupDb();
    clearAuditLogs();
    createAuditLog({ actor: 'u1', action: 'CREATE', resourceType: 'invoice', resourceId: INV_A, statusCode: 201 });
    createAuditLog({ actor: 'u2', action: 'UPDATE', resourceType: 'invoice', resourceId: INV_A, statusCode: 200 });
  });

  // ── Authorized ─────────────────────────────────────────────────────────

  it('admin can read trail', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}`)
      .set('Authorization', `Bearer ${adminA}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe(INV_A);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2);
    expect(res.body.count).toBe(2);
    // reverse-chronological: UPDATE first
    expect(res.body.data[0].action).toBe('UPDATE');
  });

  it('owner can read trail', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}`)
      .set('Authorization', `Bearer ${ownerA}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
  });

  it('respects limit param', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}?limit=1`)
      .set('Authorization', `Bearer ${adminA}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  // ── 404 — all unauthorized/nonexistent cases return same status ─────────

  it('returns 404 for invoice belonging to a different tenant', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_B}`)
      .set('Authorization', `Bearer ${adminA}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(404);
  });

  it('returns 404 for nonexistent invoice', async () => {
    const res = await request(app)
      .get('/api/audit-trail/inv_no_such')
      .set('Authorization', `Bearer ${adminA}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(404);
  });

  it('returns 404 for investor role', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}`)
      .set('Authorization', `Bearer ${investA}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(404);
  });

  it('returns 404 when JWT has no role claim', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}`)
      .set('Authorization', `Bearer ${noRole}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(404);
  });

  // ── Enumeration regression ──────────────────────────────────────────────

  it('foreign invoice and nonexistent invoice are indistinguishable (both 404)', async () => {
    const [r1, r2] = await Promise.all([
      request(app).get(`/api/audit-trail/${INV_B}`).set('Authorization', `Bearer ${adminA}`).set('x-tenant-id', TENANT_A),
      request(app).get('/api/audit-trail/inv_ghost').set('Authorization', `Bearer ${adminA}`).set('x-tenant-id', TENANT_A),
    ]);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    // Neither response should leak tenant context
    expect(JSON.stringify(r1.body)).not.toContain(TENANT_B);
    expect(JSON.stringify(r2.body)).not.toContain(TENANT_B);
  });

  // ── Authentication / tenant ─────────────────────────────────────────────

  it('returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('returns 401 for a tampered token', async () => {
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}`)
      .set('Authorization', 'Bearer bad.token.here')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('returns 400 when no tenant context is present', async () => {
    const noTenantToken = token({ sub: 'u1', role: 'admin' }); // no tenantId claim
    const res = await request(app)
      .get(`/api/audit-trail/${INV_A}`)
      .set('Authorization', `Bearer ${noTenantToken}`);
    expect(res.status).toBe(400);
  });
});
