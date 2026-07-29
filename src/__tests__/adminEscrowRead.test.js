'use strict';

const request = require('supertest');
const app = require('../app');
const { getAuditLogs } = require('../services/auditLog');
const { parseValidationErrors } = require('../schemas/invoice');

jest.mock('../services/auditLog', () => ({
  getAuditLogs: jest.fn().mockResolvedValue([]),
  logAuditEntry: jest.fn().mockResolvedValue(),
}));

jest.mock('../middleware/stacks', () => ({
  adminStack: [(req, res, next) => next()],
}));

describe('Admin Escrow Read Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/admin/escrow-read', () => {
    it('should create a valid escrow-read config', async () => {
      const res = await request(app)
        .post('/api/admin/escrow-read')
        .send({
          id: 'test-id',
          config: { cacheTtl: 3600 },
          secretKey: 'my-secret',
        });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('test-id');
    });

    it('should reject missing id with 400', async () => {
      const res = await request(app)
        .post('/api/admin/escrow-read')
        .send({
          config: { cacheTtl: 3600 },
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors).toHaveProperty('id');
    });

    it('should reject unknown fields with 400', async () => {
      const res = await request(app)
        .post('/api/admin/escrow-read')
        .send({
          id: 'test-id2',
          unknownField: 'bad',
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors).toHaveProperty('_root');
    });

    it('should reject cacheTtl out of range (too high)', async () => {
      const res = await request(app)
        .post('/api/admin/escrow-read')
        .send({
          id: 'test-id3',
          config: { cacheTtl: 999999999999 },
        });
      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('config.cacheTtl');
    });

    it('should reject oversized secretKey', async () => {
      const res = await request(app)
        .post('/api/admin/escrow-read')
        .send({
          id: 'test-id4',
          secretKey: 'a'.repeat(257),
        });
      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('secretKey');
    });

    it('should reject negative cacheTtl', async () => {
      const res = await request(app)
        .post('/api/admin/escrow-read')
        .send({
          id: 'test-id5',
          config: { cacheTtl: -100 },
        });
      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('config.cacheTtl');
    });

    it('should reject wrong types', async () => {
      const res = await request(app)
        .post('/api/admin/escrow-read')
        .send({
          id: 123, // should be string
          config: { cacheTtl: '3600' }, // should be number
        });
      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('id');
      expect(res.body.fieldErrors).toHaveProperty('config.cacheTtl');
    });
  });

  describe('PUT /api/admin/escrow-read/:id', () => {
    it('should update an existing escrow-read config', async () => {
      // First create one
      await request(app)
        .post('/api/admin/escrow-read')
        .send({
          id: 'update-id',
          config: { cacheTtl: 3600 },
        });

      const res = await request(app)
        .put('/api/admin/escrow-read/update-id')
        .send({
          config: { cacheTtl: 7200 },
        });
      expect(res.status).toBe(200);
      expect(res.body.config.cacheTtl).toBe(7200);
    });

    it('should reject empty payload with 400', async () => {
      const res = await request(app)
        .put('/api/admin/escrow-read/update-id')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('_root');
    });
    
    it('should reject unknown fields with 400', async () => {
      const res = await request(app)
        .put('/api/admin/escrow-read/update-id')
        .send({
          unknownField: 'bad',
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
