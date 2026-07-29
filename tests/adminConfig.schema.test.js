'use strict';

const express = require('express');
const request = require('supertest');
const { adminConfigLimiter } = require('../src/middleware/rateLimit');
const { adminStack } = require('../src/middleware/stacks');

jest.mock('../src/middleware/rateLimit', () => ({
  adminConfigLimiter: (req, res, next) => next(),
}));

jest.mock('../src/middleware/stacks', () => ({
  adminStack: [(req, res, next) => {
    req.tenantId = 'tenant_123';
    req.user = { sub: 'admin_test' };
    next();
  }],
}));

jest.mock('../src/middleware/idempotency', () => (req, res, next) => next());

const adminConfigRouter = require('../src/routes/adminConfig');

describe('Admin Config Schema Validation', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/admin/config', adminConfigRouter);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: { message: err.message }});
    });
  });

  it('rejects invalid request payloads with structured errors (400)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .send({ section: 'unknown', config: {} });

    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/validation-error/);
    expect(res.body.fieldErrors).toBeDefined();
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('accepts valid request payloads (200)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .send({
        section: 'cors',
        config: { origins: ['https://example.com'], maxAge: 86400 }
      });

    expect(res.status).toBe(200);
    expect(res.body.section).toBe('cors');
    expect(res.body.config.origins).toContain('https://example.com');
    expect(res.body.message).toBeDefined();
  });

  it('validates GET /sections response payload', async () => {
    const res = await request(app)
      .get('/api/admin/config/sections');

    expect(res.status).toBe(200);
    expect(res.body.sections).toBeDefined();
    expect(res.body.sections).toContain('cors');
  });

  it('validates ETag and returns 304 if unchanged', async () => {
    const res1 = await request(app).get('/api/admin/config/sections');
    const etag = res1.headers['etag'];
    expect(etag).toBeDefined();

    const res2 = await request(app)
      .get('/api/admin/config/sections')
      .set('If-None-Match', etag);

    expect(res2.status).toBe(304);
  });
});
