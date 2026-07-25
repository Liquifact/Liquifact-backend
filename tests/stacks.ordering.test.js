'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const config = require('../src/config');
const { authenticatedTenantStack, adminStack } = require('../src/middleware/stacks');

function buildApp(stack) {
  const app = express();

  app.use(...stack);

  app.get('/protected', (req, res) => {
    res.status(200).json({
      tenantId: req.tenantId || null,
      user: req.user || null,
      apiClient: req.apiClient || null,
    });
  });

  app.use((err, req, res, next) => {
    if (err && err.status) {
      return res.status(err.status).json({
        type: err.type,
        title: err.title,
        detail: err.detail,
        status: err.status,
      });
    }

    return next(err);
  });

  return app;
}

function signJwt(secret, tenantId = 'tenant-123') {
  return jwt.sign(
    { sub: 'user-1', tenantId },
    secret,
    { algorithm: 'HS256' }
  );
}

describe('middleware stack ordering', () => {
  const secret = '0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = secret;
    process.env.JWT_ALGORITHMS = 'HS256';
    delete process.env.API_KEYS;
    config.validate();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ALGORITHMS;
    delete process.env.API_KEYS;
  });

  it('rejects unauthenticated JWT requests before tenant extraction runs', async () => {
    const app = buildApp(authenticatedTenantStack);

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Authentication token is required');
  });

  it('uses the JWT path when no x-api-key header is present', async () => {
    const app = buildApp(adminStack);
    const token = signJwt(secret);

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-123');

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('tenant-123');
    expect(res.body.user).toEqual(expect.objectContaining({ sub: 'user-1' }));
  });

  it.each([
    ['empty string', ''],
    ['array-valued header', ['api-key-value']],
  ])('routes %s x-api-key headers to the API-key auth branch', async (_label, value) => {
    const app = buildApp(adminStack);
    const req = request(app)
      .get('/protected')
      .set('x-tenant-id', 'tenant-123');

    if (Array.isArray(value)) {
      req.set('x-api-key', value);
    } else {
      req.set('x-api-key', value);
    }

    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key/i);
  });
});
