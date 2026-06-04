'use strict';

/**
 * @fileoverview API tests for the invoice audit trail endpoints.
 * Covers: trail retrieval, CSV export with escaping, pagination, authz rejection,
 * tenant isolation, and state-transition history.
 */

jest.mock('../src/db/knex');
jest.mock('../src/middleware/apiKey', () => ({
  apiKeyAuth: jest.fn((req, res, next) => {
    req.apiClient = { clientId: 'api-client-1' };
    next();
  }),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const {
  createAuditLog,
  clearAuditLogs,
  getAuditLogs,
} = require('../src/services/auditLog');
const { executeTransition } = require('../src/services/invoiceStateMachine');
const auditTrailRouter = require('../src/routes/auditTrail');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

/** Build a signed JWT for a given tenantId */
function makeToken(tenantId = TENANT_A) {
  return jwt.sign({ sub: 'admin-1', tenantId }, JWT_SECRET, { expiresIn: '1h' });
}

/** Build a minimal Express app mounting the audit trail router */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/audit', auditTrailRouter);
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.detail || err.message || 'error' });
  });
  return app;
}

/** Seed an audit log entry for a given invoiceId and optional tenantId */
function seedLog(invoiceId, tenantId = TENANT_A, overrides = {}) {
  return createAuditLog({
    actor: 'admin-1',
    action: 'UPDATE',
    resourceType: 'invoice',
    resourceId: invoiceId,
    statusCode: 200,
    metadata: { tenantId, ...overrides.metadata },
    ...overrides,
  });
}

describe('GET /api/admin/audit/invoices/:invoiceId', () => {
  let app;

  beforeEach(() => {
    clearAuditLogs();
    app = buildApp();
  });

  it('returns 401 when no auth is provided', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('returns 400 when tenant context is missing', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${makeToken()}`);
    // extractTenant rejects with 400 when no tenant header and no JWT claim
    // Our token includes tenantId so this should pass — test without tenantId in token
    const tokenNoTenant = jwt.sign({ sub: 'admin-1' }, JWT_SECRET, { expiresIn: '1h' });
    const res2 = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${tokenNoTenant}`);
    expect(res2.status).toBe(400);
  });

  it('returns empty data array when no logs exist for invoice', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-none')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('returns audit trail for a specific invoice', async () => {
    seedLog('inv-001');
    seedLog('inv-001');
    seedLog('inv-002'); // different invoice — should not appear

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.invoiceId).toBe('inv-001');
    expect(res.body.meta.total).toBe(2);
    res.body.data.forEach((entry) => expect(entry.resourceId).toBe('inv-001'));
  });

  it('enforces tenant isolation — does not return other tenant logs', async () => {
    seedLog('inv-001', TENANT_A);
    seedLog('inv-001', TENANT_B); // different tenant

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });

  it('supports pagination via limit and offset', async () => {
    for (let i = 0; i < 5; i++) seedLog('inv-page');

    const page1 = await request(app)
      .get('/api/admin/audit/invoices/inv-page?limit=2&offset=0')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    const page2 = await request(app)
      .get('/api/admin/audit/invoices/inv-page?limit=2&offset=2')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.limit).toBe(2);
    expect(page1.body.meta.offset).toBe(0);

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.meta.offset).toBe(2);

    // IDs should be different across pages
    const ids1 = page1.body.data.map((e) => e.id);
    const ids2 = page2.body.data.map((e) => e.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('clamps limit to MAX_LIMIT (500)', async () => {
    seedLog('inv-clamp');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-clamp?limit=9999')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(500);
  });

  it('returns 400 for an empty invoiceId', async () => {
    // Express won't match empty segment — test a very long id instead
    const longId = 'x'.repeat(129);
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${longId}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(400);
  });

  it('accepts x-api-key auth', async () => {
    seedLog('inv-apikey');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-apikey')
      .set('x-api-key', 'any-key')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/audit/invoices/:invoiceId/transitions', () => {
  let app;

  beforeEach(() => {
    clearAuditLogs();
    app = buildApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001/transitions')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('returns empty array when no transitions exist', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-notrans/transitions')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns state-transition history for an invoice', async () => {
    // Seed a STATE_TRANSITION log directly
    createAuditLog({
      actor: 'admin-1',
      action: 'STATE_TRANSITION',
      resourceType: 'invoice',
      resourceId: 'inv-trans',
      before: { state: 'pending' },
      after: { state: 'approved' },
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-trans/transitions')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const t = res.body.data[0];
    expect(t.fromState).toBe('pending');
    expect(t.toState).toBe('approved');
    expect(t.actor).toBe('admin-1');
  });

  it('enforces tenant isolation on transitions', async () => {
    createAuditLog({
      actor: 'admin-1',
      action: 'STATE_TRANSITION',
      resourceType: 'invoice',
      resourceId: 'inv-iso',
      before: { state: 'pending' },
      after: { state: 'approved' },
      metadata: { tenantId: TENANT_B }, // different tenant
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-iso/transitions')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('GET /api/admin/audit/invoices/:invoiceId/export', () => {
  let app;

  beforeEach(() => {
    clearAuditLogs();
    app = buildApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001/export')
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(401);
  });

  it('exports JSON by default', async () => {
    seedLog('inv-export');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-export/export')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(res.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].resourceId).toBe('inv-export');
  });

  it('exports CSV with correct headers', async () => {
    seedLog('inv-csv');
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-csv/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('CSV escapes commas in field values', async () => {
    createAuditLog({
      actor: 'admin,with,commas',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-escape',
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-escape/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text).toContain('"admin,with,commas"');
  });

  it('CSV escapes double-quotes in field values', async () => {
    createAuditLog({
      actor: 'admin"quoted"',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-quote',
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-quote/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    // Double-quote escaping: " → ""
    expect(res.text).toContain('"admin""quoted"""');
  });

  it('CSV returns only header row when no logs exist', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-empty/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text.trim()).toBe('id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent');
  });

  it('does not expose sensitive fields in export', async () => {
    createAuditLog({
      actor: 'admin-1',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-redact',
      before: { apiKey: 'super-secret-before', amount: 100 },
      after: { apiKey: 'super-secret-after', amount: 200 },
      metadata: { tenantId: TENANT_A },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-redact/export')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('super-secret-before');
    expect(res.text).not.toContain('super-secret-after');
    expect(res.text).toContain('***REDACTED***');
  });

  it('enforces tenant isolation on export', async () => {
    seedLog('inv-tenant-export', TENANT_B);

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-tenant-export/export')
      .set('Authorization', `Bearer ${makeToken(TENANT_A)}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed).toHaveLength(0);
  });

  it('respects limit param on export', async () => {
    for (let i = 0; i < 10; i++) seedLog('inv-limit-export');

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-limit-export/export?limit=3')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT_A);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed).toHaveLength(3);
  });
});
