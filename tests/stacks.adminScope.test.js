'use strict';

const express = require('express');
const request = require('supertest');
const { adminStack } = require('../src/middleware/stacks');
const { createAuditLog } = require('../src/services/auditLog');

jest.mock('../src/services/auditLog', () => ({
  createAuditLog: jest.fn().mockResolvedValue({})
}));

describe('adminStack adminScope', () => {
  let app;
  
  beforeAll(() => {
    process.env.API_KEYS = JSON.stringify({ key: 'lf_admin_key_1234', clientId: 'admin-client', scopes: ['admin'] }) + ';' + 
                           JSON.stringify({ key: 'lf_scopeless_key12', clientId: 'scopeless-client', scopes: ['invoices:read'] });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    app = express();
    app.use(express.json());
    app.get('/admin-route', ...adminStack, (req, res) => {
      res.status(200).json({ ok: true });
    });
    
    // Express error handler
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });
  });

  afterAll(() => {
    delete process.env.API_KEYS;
  });

  it('accepts API key with admin scope', async () => {
    const res = await request(app)
      .get('/admin-route')
      .set('x-api-key', 'lf_admin_key_1234');
      
    expect(res.status).toBe(200);
  });

  it('rejects API key without admin scope with RFC 7807 and audit log', async () => {
    const res = await request(app)
      .get('/admin-route')
      .set('x-api-key', 'lf_scopeless_key12');
      
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Insufficient permissions. Required scope: "admin".'
    });
    
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'scopeless-client',
      action: 'READ',
      resourceType: 'admin_api',
      resourceId: '/admin-route',
      statusCode: 403,
      metadata: { reason: 'insufficient_scope', requiredScope: 'admin' }
    }));
  });

  it('falls back to JWT authentication when API key is not present', async () => {
    const res = await request(app)
      .get('/admin-route');
      
    // Should get 401 from JWT auth middleware (authenticateToken)
    expect(res.status).toBe(401);
  });
});
