'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/stacks', () => ({
  adminStack: [(req, res, next) => {
    req.user = { id: 'admin-user' };
    next();
  }],
}));

jest.mock('../src/middleware/indexerMetrics', () => ({
  instrumentIndexer: (handler) => handler,
}));

jest.mock('../src/schemas/indexerQuery', () => ({
  validateIndexerQuery: jest.fn(),
}));

jest.mock('../src/dto/indexer', () => ({
  mapQueryToDTO: jest.fn(),
  mapDTOToServiceParams: jest.fn(),
}));

jest.mock('../src/services/indexerService', () => ({
  listIndexerEvents: jest.fn(),
  INDEXER_SORT_FIELDS: ['observed_at', 'ledger_sequence'],
}));

jest.mock('../src/middleware/rateLimit', () => ({
  indexerLimiter: (_req, _res, next) => next(),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

describe('GET /api/admin/indexer/events — compression integration', () => {
  let app;
  let validateIndexerQuery;
  let mapQueryToDTO;
  let mapDTOToServiceParams;
  let listIndexerEvents;

  function buildLargeResult(count) {
    const data = Array.from({ length: count }, (_, i) => ({
      eventId: `evt_${i}`,
      invoiceId: 'inv_001',
      eventType: 'escrow_created',
      ledgerSequence: 100 + i,
      pagingToken: `${100 + i}-1`,
      contractId: 'x'.repeat(64),
      txHash: 'y'.repeat(64),
      observedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    return {
      data,
      meta: {
        total: data.length,
        limit: data.length,
        hasMore: false,
        nextCursor: null,
      },
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    validateIndexerQuery = require('../src/schemas/indexerQuery').validateIndexerQuery;
    mapQueryToDTO = require('../src/dto/indexer').mapQueryToDTO;
    mapDTOToServiceParams = require('../src/dto/indexer').mapDTOToServiceParams;
    listIndexerEvents = require('../src/services/indexerService').listIndexerEvents;

    validateIndexerQuery.mockReturnValue({
      isValid: true,
      fieldErrors: null,
      params: { sortBy: 'observed_at', order: 'desc', limit: 20, page: 1 },
    });
    mapQueryToDTO.mockReturnValue({
      sorting: { sortBy: 'observed_at', order: 'desc' },
      pagination: { cursor: null, page: 1, limit: 20 },
    });
    mapDTOToServiceParams.mockReturnValue({
      sorting: { sortBy: 'observed_at', order: 'desc' },
      pagination: { page: 1, limit: 20 },
    });

    const adminIndexerRoutes = require('../src/routes/adminIndexer');
    app = express();
    app.use('/api/admin/indexer', adminIndexerRoutes);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  test('large response with Accept-Encoding: gzip is compressed', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(50));

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'gzip')
      .buffer(true);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.data).toHaveLength(50);
  });

  test('large response with Accept-Encoding: deflate is compressed', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(50));

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'deflate')
      .buffer(true);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('deflate');
    expect(res.body.data).toHaveLength(50);
  });

  test('small response is NOT compressed even with Accept-Encoding: gzip', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(1));

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('no Accept-Encoding: response body is correct (may be auto-decompressed by client)', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(50));

    const res = await request(app)
      .get('/api/admin/indexer/events');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(50);
  });

  test('Accept-Encoding: identity: response is plain JSON', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(50));

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'identity');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.data).toHaveLength(50);
  });

  test('Vary: Accept-Encoding is always present on indexer responses', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(1));

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['vary']).toMatch(/accept-encoding/i);
  });

  test('validation error response (400) stays uncompressed', async () => {
    validateIndexerQuery.mockReturnValue({
      isValid: false,
      fieldErrors: { limit: 'must be between 1 and 100' },
      params: null,
    });

    const res = await request(app)
      .get('/api/admin/indexer/events?limit=999')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(400);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('gzip round-trip: compressed body decompresses to expected envelope', async () => {
    const result = buildLargeResult(10);
    listIndexerEvents.mockResolvedValue(result);

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'gzip')
      .buffer(true);

    expect(res.status).toBe(200);
    // supertest auto-decompresses, so assert on the body directly
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data).toHaveLength(10);
    expect(res.body.meta.total).toBe(10);
  });

  test('Content-Type is application/json on compressed response', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(50));

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'gzip')
      .buffer(true);

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('HTTP status 200 is preserved on compressed response', async () => {
    listIndexerEvents.mockResolvedValue(buildLargeResult(50));

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Accept-Encoding', 'gzip')
      .buffer(true);

    expect(res.status).toBe(200);
  });

  test('POST /events/bulk response stays uncompressed (small body)', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .send([]);

    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
