'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// 1. Mock DB and API Keys BEFORE requiring anything else
jest.mock('../src/db/knex');
jest.mock('../src/config/apiKeys', () => ({
  loadApiKeyRegistry: () => {
    return new Map([
      ['valid-export-key', { clientId: 'client-1', scopes: ['invoices:export'], revoked: false }],
      ['no-scope-key', { clientId: 'client-2', scopes: ['other:scope'], revoked: false }],
      ['revoked-key', { clientId: 'client-3', scopes: ['invoices:export'], revoked: true }]
    ]);
  }
}));
jest.mock('../src/services/invoiceService', () => ({
  getInvoiceById: jest.fn(async (id, tenantId) => {
    if (id === 'inv-export-test' && tenantId === 'tenant-test') {
      return { id, tenant_id: tenantId };
    }
    return null;
  })
}));

const { clearAuditLogs } = require('../src/services/auditLog');
const auditTrailRouter = require('../src/routes/auditTrail');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const TENANT = 'tenant-test';

function makeToken(tenantId = TENANT) {
  return jwt.sign({ sub: 'admin-1', tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/audit', auditTrailRouter);
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.detail || err.message || 'error' });
  });
  return app;
}

describe('Invoice Export API Key Scope Enforcement', () => {
  let app;
  const invoiceId = 'inv-export-test';

  beforeEach(async () => {
    await clearAuditLogs();
    app = buildApp();
  });

  it('allows export with valid API key and scope', async () => {
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT)
      .set('x-api-key', 'valid-export-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  it('returns 404 (safe denial) when API key is missing', async () => {
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns 404 (safe denial) when API key lacks invoices:export scope', async () => {
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT)
      .set('x-api-key', 'no-scope-key');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns 404 (safe denial) when API key is invalid', async () => {
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT)
      .set('x-api-key', 'does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns 404 (safe denial) when API key is revoked', async () => {
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT)
      .set('x-api-key', 'revoked-key');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns 404 when tenant mismatch (before API key check)', async () => {
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv`)
      .set('Authorization', `Bearer ${makeToken('wrong-tenant')}`)
      .set('x-tenant-id', 'wrong-tenant')
      .set('x-api-key', 'valid-export-key');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('supports large export requests', async () => {
    const res = await request(app)
      .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv&limit=10000`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT)
      .set('x-api-key', 'valid-export-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });
});
