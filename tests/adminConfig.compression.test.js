'use strict';

const express = require('express');
const request = require('supertest');

// Mock admin stack to bypass authentication for these tests
jest.mock('../src/middleware/stacks', () => ({
  adminStack: [(req, res, next) => {
    req.tenantId = 'tenant_123';
    next();
  }],
}));

// Mock idempotency middleware since we don't want to set up the DB
jest.mock('../src/middleware/idempotency', () => (req, res, next) => next());

// Mock rate limiter
jest.mock('../src/middleware/rateLimit', () => ({
  adminConfigLimiter: (req, res, next) => next(),
}));

// We only need to test the route behavior
const adminConfigRouter = require('../src/routes/adminConfig');

describe('Admin Config Compression', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Mount it at the expected path
    app.use('/api/admin/config', adminConfigRouter);
  });

  // A small payload < 500 bytes
  const smallPayload = {
    section: 'webhook',
    config: {
      url: 'https://example.com/webhook',
      secret: 'supersecret_1234567890',
      events: ['invoice.created'],
    }
  };

  // A large payload > 500 bytes
  const largeEvents = Array(45).fill(0).map((_, i) => `event.name.number.${i}.which.is.long`);
  const largePayload = {
    section: 'webhook',
    config: {
      url: 'https://example.com/webhook',
      secret: 'supersecret_1234567890',
      events: largeEvents,
    }
  };

  it('does not compress small responses', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Accept-Encoding', 'gzip')
      .send(smallPayload);
      
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('compresses large responses above the threshold', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Accept-Encoding', 'gzip')
      .send(largePayload);
      
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does not compress large responses if Accept-Encoding is not set', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .send(largePayload);
      
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
