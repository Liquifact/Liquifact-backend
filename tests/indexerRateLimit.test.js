'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/stacks', () => ({
  adminStack: [(req, res, next) => {
    req.user = { id: 'admin-user' };
    next();
  }],
}));

jest.mock('../src/services/indexerService', () => ({
  listIndexerEvents: jest.fn(async () => ({
    data: [],
    meta: { total: 0, hasMore: false, nextCursor: null },
  })),
  INDEXER_SORT_FIELDS: ['observed_at', 'ledger_sequence'],
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

describe('indexer rate limiting', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.RATE_LIMIT_INDEXER_WINDOW_MS;
    delete process.env.RATE_LIMIT_INDEXER_MAX;
    process.env.RATE_LIMIT_INDEXER_WINDOW_MS = '200';
    process.env.RATE_LIMIT_INDEXER_MAX = '2';

    jest.unmock('../src/middleware/rateLimit');

    const adminIndexerRoutes = require('../src/routes/adminIndexer');
    app = express();
    app.use('/api/admin/indexer', adminIndexerRoutes);
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_INDEXER_WINDOW_MS;
    delete process.env.RATE_LIMIT_INDEXER_MAX;
  });

  it('allows requests up to the configured max (at-limit)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).get('/api/admin/indexer/events');
      expect(res.status).not.toBe(429);
    }
  });

  it('returns 429 with a Retry-After header once the max is exceeded', async () => {
    await request(app).get('/api/admin/indexer/events');
    await request(app).get('/api/admin/indexer/events');

    const res = await request(app).get('/api/admin/indexer/events');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(0);
  });

  it('resets the count after the configured window elapses', async () => {
    await request(app).get('/api/admin/indexer/events');
    await request(app).get('/api/admin/indexer/events');

    const blocked = await request(app).get('/api/admin/indexer/events');
    expect(blocked.status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const afterReset = await request(app).get('/api/admin/indexer/events');
    expect(afterReset.status).not.toBe(429);
  });

  it('uses the API key as the client identity when present', async () => {
    await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', 'client-a');
    await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', 'client-a');

    const blockedA = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', 'client-a');
    expect(blockedA.status).toBe(429);

    const clientB = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', 'client-b');
    expect(clientB.status).not.toBe(429);
  });
});
