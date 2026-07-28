'use strict';

/**
 * @fileoverview Tests for adminEscrowRead.js and its audit logging of mutations.
 */

const request = require('supertest');
const app = require('../src/app');
const { createAuditLog } = require('../src/services/auditLog');
// Assumed helper removed, we are mocking the auth middleware instead
const db = require('../src/db/knex');

// We mock auditLog.js to observe the createAuditLog calls
jest.mock('../src/services/auditLog', () => {
  const original = jest.requireActual('../src/services/auditLog');
  return {
    ...original,
    createAuditLog: jest.fn(original.createAuditLog),
    getAuditLogs: jest.fn().mockResolvedValue([{ id: 'audit-1' }]),
  };
});

// We also mock auth so we can inject an admin token
jest.mock('../src/middleware/stacks', () => {
  return {
    adminStack: [
      (req, res, next) => {
        // Mocked admin middleware
        req.user = { sub: 'admin-user' };
        req.tenantId = 'test-tenant';
        next();
      }
    ],
    authenticatedTenantStack: [
      (req, res, next) => {
        req.user = { sub: 'user' };
        req.tenantId = 'test-tenant';
        next();
      }
    ]
  };
});

describe('adminEscrowRead mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const testId = 'config-test-123';

  it('should list configurations via GET /', async () => {
    // Insert a record first
    const uniqueId = 'config-test-get-123';
    const payload = { id: uniqueId, config: { cacheTtl: 60 }, secretKey: 'my-secret' };
    await request(app).post('/api/admin/escrow-read').send(payload).expect(201);
    
    const res = await request(app).get('/api/admin/escrow-read').expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: uniqueId, config: { cacheTtl: 60 } })
    ]));
  });

  it('should cover CREATE audit entries', async () => {
    const payload = { id: testId, config: { cacheTtl: 60 }, secretKey: 'my-secret' };
    
    const res = await request(app)
      .post('/api/admin/escrow-read')
      .send(payload)
      .expect(201);
      
    expect(res.body.data.id).toBe(testId);
    
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CREATE',
      resourceType: 'admin',
      resourceId: 'escrow-read',
      after: expect.objectContaining({ secretKey: 'my-secret' })
    }));
  });

  it('should reject POST with missing id', async () => {
    const payload = { config: { cacheTtl: 60 } };
    const res = await request(app).post('/api/admin/escrow-read').send(payload).expect(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('should reject POST with invalid config', async () => {
    const payload = { id: 'invalid-config', config: { cacheTtl: 'not-a-number' } };
    const res = await request(app).post('/api/admin/escrow-read').send(payload).expect(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('should reject POST with duplicate id', async () => {
    const payload = { id: testId, config: { cacheTtl: 60 } };
    await request(app).post('/api/admin/escrow-read').send(payload).expect(409);
  });

  it('should cover UPDATE audit entries', async () => {
    const payload = { config: { cacheTtl: 120 } };
    
    const res = await request(app)
      .put(`/api/admin/escrow-read/${testId}`)
      .send(payload)
      .expect(200);
      
    expect(res.body.data.id).toBe(testId);
    expect(res.body.data.config.cacheTtl).toBe(120);
    
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UPDATE',
      resourceType: 'admin',
      resourceId: 'escrow-read',
    }));
  });

  it('should reject PUT with no fields', async () => {
    const res = await request(app).put(`/api/admin/escrow-read/${testId}`).send({}).expect(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('should return 404 for PUT on non-existent config', async () => {
    const payload = { config: { cacheTtl: 120 } };
    const res = await request(app).put('/api/admin/escrow-read/does-not-exist').send(payload).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should cover DELETE audit entries', async () => {
    await request(app)
      .delete(`/api/admin/escrow-read/${testId}`)
      .expect(204);
      
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'DELETE',
      resourceType: 'admin',
      resourceId: 'escrow-read',
    }));
  });

  it('should return 404 for DELETE on non-existent config', async () => {
    const res = await request(app).delete('/api/admin/escrow-read/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should expose a read view for audit logs bounded correctly', async () => {
    const res = await request(app)
      .get('/api/admin/escrow-read/audit?limit=10')
      .expect(200);
      
    expect(res.body.data).toEqual([{ id: 'audit-1' }]);
  });
});
