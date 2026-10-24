'use strict';

/**
 * @fileoverview Auth tests for POST /api/internal/indexer/run
 *
 * Tests:
 *   - CRON_SECRET not set → 404 (endpoint invisible)
 *   - Missing Authorization header → 401
 *   - Wrong secret → 401
 *   - Correct secret → 200 with IndexerRunResult body
 */

const request = require('supertest');

// Mock runOnce so we don't hit Soroban RPC
jest.mock('../src/indexer/escrow-indexer', () => ({
  runOnce: jest.fn().mockResolvedValue({
    ingested: 0,
    cursor: null,
    latestLedger: 100,
  }),
  buildRpcServer: jest.fn(),
}));

const { runOnce } = require('../src/indexer/escrow-indexer');

// Build app after mocking
const { createApp } = require('../src/app');

describe('POST /api/internal/indexer/run — authentication', () => {
  let originalSecret;

  beforeEach(() => {
    originalSecret = process.env.CRON_SECRET;
    jest.clearAllMocks();
    runOnce.mockResolvedValue({ ingested: 0, cursor: null, latestLedger: 100 });
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalSecret;
    }
  });

  test('returns 404 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer anything')
      .send({});

    expect(res.status).toBe(404);
  });

  test('returns 404 when CRON_SECRET is an empty string', async () => {
    process.env.CRON_SECRET = '';
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer anything')
      .send({});

    // Empty string is falsy → endpoint should be invisible (404)
    expect(res.status).toBe(404);
  });

  test('returns 401 when Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret-xyz';
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.status).toBe(401);
  });

  test('returns 401 when token is wrong', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer wrong-secret')
      .send({});

    expect(res.status).toBe(401);
  });

  test('returns 401 when Bearer prefix is missing', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'correct-secret') // no "Bearer " prefix
      .send({});

    expect(res.status).toBe(401);
  });

  test('returns 200 with IndexerRunResult when secret is correct', async () => {
    process.env.CRON_SECRET = 'my-secret';
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});

    expect(res.status).toBe(200);
    expect(typeof res.body.ingested).toBe('number');
    expect(res.body).toHaveProperty('cursor');
    expect(typeof res.body.latestLedger).toBe('number');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  test('passes maxPages from request body to runOnce', async () => {
    process.env.CRON_SECRET = 'my-secret';
    const app = createApp();

    await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({ maxPages: 10 });

    expect(runOnce).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 10 }));
  });

  test('clamps maxPages to 20', async () => {
    process.env.CRON_SECRET = 'my-secret';
    const app = createApp();

    await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({ maxPages: 999 });

    expect(runOnce).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 20 }));
  });

  test('uses default maxPages=5 when not supplied', async () => {
    process.env.CRON_SECRET = 'my-secret';
    const app = createApp();

    await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});

    expect(runOnce).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 5 }));
  });

  test('returns 500 when runOnce throws', async () => {
    process.env.CRON_SECRET = 'my-secret';
    runOnce.mockRejectedValueOnce(new Error('rpc down'));
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.status).toBe(500);
    expect(res.body.detail).toMatch(/rpc down/);
  });
});
