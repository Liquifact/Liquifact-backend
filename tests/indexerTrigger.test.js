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
    runOnce.mockReset();
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

  test.each([
    ['0 (below minimum)', 0],
    ['21 (above maximum)', 21],
    ['"abc" (non-numeric string)', 'abc'],
    ['1.5 (non-integer float)', 1.5],
  ])('returns 400 VALIDATION_FAILED when maxPages is %s', async (_label, invalidMaxPages) => {
    process.env.CRON_SECRET = 'my-secret';
    const app = createApp();

    const res = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({ maxPages: invalidMaxPages });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Validation Failed',
    });
    expect(runOnce).not.toHaveBeenCalled();
  });

  test('accepts boundary maxPages values 1 and 20', async () => {
    process.env.CRON_SECRET = 'my-secret';
    const app = createApp();

    for (const maxPages of [1, 20]) {
      const res = await request(app)
        .post('/api/internal/indexer/run')
        .set('Authorization', 'Bearer my-secret')
        .send({ maxPages });

      expect(res.status).toBe(200);
      expect(runOnce).toHaveBeenCalledWith(expect.objectContaining({ maxPages }));
    }
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

  test('returns 500 when runOnce throws and logs structured JSON error', async () => {
    process.env.CRON_SECRET = 'my-secret';
    runOnce.mockRejectedValueOnce(new Error('rpc down'));
    const stderrLines = [];
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    const app = createApp();

    try {
      const res = await request(app)
        .post('/api/internal/indexer/run')
        .set('Authorization', 'Bearer my-secret')
        .send({});

      expect(res.status).toBe(500);
      expect(res.body.status).toBe(500);
      expect(res.body.detail).toMatch(/rpc down/);

      expect(stderrSpy).toHaveBeenCalled();
      const parsed = JSON.parse(stderrLines[stderrLines.length - 1]);
      expect(parsed.level).toBe('error');
      expect(parsed.message).toBe('Indexer trigger run failed');
      expect(parsed.err).toBe('rpc down');
      expect(parsed['0']).toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test('returns 409 INDEXER_BUSY with Retry-After for an overlapping run', async () => {
    process.env.CRON_SECRET = 'my-secret';
    let resolveRun;
    const deferred = new Promise((resolve) => { resolveRun = resolve; });
    runOnce
      .mockImplementationOnce(() => deferred)
      .mockRejectedValueOnce(Object.assign(new Error('already running'), { code: 'INDEXER_BUSY' }));
    const app = createApp();

    const first = request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({})
      .then((res) => res);

    // Wait until the deferred mock is actually invoked
    for (let i = 0; i < 20 && runOnce.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const second = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});

    expect(second.status).toBe(409);
    expect(second.headers['retry-after']).toBe('1');
    expect(second.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(second.body).toMatchObject({
      status: 409,
      code: 'INDEXER_BUSY',
      title: 'Indexer Busy',
    });

    resolveRun({ ingested: 0, cursor: null, latestLedger: 100 });
    await first;
  });

  test('allows sequential runs after success', async () => {
    process.env.CRON_SECRET = 'my-secret';
    const app = createApp();

    const first = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});
    const second = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  test('allows a subsequent run after an earlier run fails', async () => {
    process.env.CRON_SECRET = 'my-secret';
    runOnce
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce({ ingested: 0, cursor: null, latestLedger: 100 });
    const app = createApp();

    const failed = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});
    const retry = await request(app)
      .post('/api/internal/indexer/run')
      .set('Authorization', 'Bearer my-secret')
      .send({});

    expect(failed.status).toBe(500);
    expect(retry.status).toBe(200);
  });
});
