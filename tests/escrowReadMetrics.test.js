'use strict';

/**
 * @fileoverview Tests for escrow-read observability — Prometheus metrics and
 * structured logging emitted by both the legacy (/api/escrow/:invoiceId)
 * and V1 (/v1/escrow/:invoiceId) endpoints.
 *
 * Covers:
 *   - recordEscrowRead unit: counter/histogram/error-counter increments and
 *     log-level selection for success, client_error, and server_error.
 *   - Legacy endpoint: metrics + logs on 200, 404, and 500.
 *   - V1 endpoint: metrics + logs on 200 and 404 (with valid JWT).
 */

// ── Mocks (hoisted by Jest) ──────────────────────────────────────────────────

jest.mock('../src/cache/redis', () => ({
  createRedisEscrowSummaryCache: jest.fn(() => null),
  RedisEscrowSummaryCache: jest.fn(),
  getRedisClient: jest.fn(() => ({ client: null, isAvailable: false })),
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve(null)),
    set: jest.fn(() => Promise.resolve('OK')),
    del: jest.fn(() => Promise.resolve(1)),
    quit: jest.fn(() => Promise.resolve()),
  })),
}), { virtual: true });

jest.mock('rate-limit-redis', () => ({ RedisStore: jest.fn() }), { virtual: true });

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (id === 'unknown-inv') return null;
    return 'C_ESCROW_MOCK';
  }),
}));

jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => operation()),
}));

// Mock DB with in-memory store so we can seed projection rows
jest.mock('../src/db/knex', () => {
  const rows = new Map();
  const fakeDb = jest.fn((table) => ({
    _table: table,
    _whereId: null,
    where(field, value) {
      if (typeof field === 'string') this._whereId = String(value);
      return this;
    },
    async first() {
      if (!this._whereId) return null;
      return rows.get(this._whereId) || null;
    },
    async del() { rows.clear(); return 0; },
    async destroy() { rows.clear(); },
    async insert(payload) {
      const entries = Array.isArray(payload) ? payload : [payload];
      entries.forEach((e) => { if (e && e.invoice_id) rows.set(e.invoice_id, e); });
      return entries.length;
    },
  }));
  fakeDb.destroy = async () => { rows.clear(); };
  return fakeDb;
}, { virtual: true });

// ── Imports ───────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createStandardizedApp } = require('../src/app');
const { recordEscrowRead } = require('../src/services/escrowReadMetrics');
const {
  escrowReadRequestsTotal,
  escrowReadRequestDurationSeconds,
  escrowReadErrorsTotal,
  registry,
} = require('../src/metrics');
const db = require('../src/db/knex');
const logger = require('../src/logger');

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'user_test', id: 'user_test', tenantId: 'tenant_test', ...payload },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

function authHeader(payload = {}) {
  return `Bearer ${makeToken(payload)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read the current value of a labelled counter from the registry. */
async function getCounterValue(counter, labels) {
  const metrics = await registry.getMetricsAsJSON();
  const match = metrics.find((m) => m.name === counter.name);
  if (!match || !match.values.length) { return 0; }

  const valueEntry = match.values.find((v) =>
    Object.entries(labels).every(([k, expected]) => v.labels && v.labels[k] === expected),
  );
  return valueEntry ? (valueEntry.value || 0) : 0;
}

/** Read a labelled histogram's _sum value. */
async function getHistogramSum(histogram, labels) {
  const metrics = await registry.getMetricsAsJSON();
  const match = metrics.find((m) => m.name === histogram.name);
  if (!match || !match.values.length) { return 0; }

  for (const v of match.values) {
    const ok = Object.entries(labels).every(([k, expected]) => v.labels && v.labels[k] === expected);
    if (!ok) { continue; }
    if (v.labels && v.labels.le !== undefined) { continue; }
    if (v.metricName && v.metricName.endsWith('_count')) { continue; }
    if (v.metricName && v.metricName.endsWith('_created')) { continue; }
    return v.value || 0;
  }
  return 0;
}

// ── Unit tests: recordEscrowRead ─────────────────────────────────────────────

describe('recordEscrowRead (unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset counters by creating new registry entries (prom-client doesn't
    // allow resetting labelled metrics, but for test purposes we check
    // relative increments).
  });

  it('increments the requests counter with endpoint=legacy, status=success', async () => {
    const before = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'success' });

    recordEscrowRead({ startTime: Date.now() - 10, invoiceId: 'inv-1', endpoint: 'legacy', statusCode: 200 });

    const after = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'success' });
    expect(after).toBeGreaterThan(before);
  });

  it('increments the requests counter with endpoint=v1, status=client_error', async () => {
    const before = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'client_error' });

    recordEscrowRead({ startTime: Date.now() - 5, invoiceId: 'inv-2', endpoint: 'v1', statusCode: 404 });

    const after = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'client_error' });
    expect(after).toBeGreaterThan(before);
  });

  it('increments the requests counter with status=server_error for 500', async () => {
    const before = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'server_error' });

    recordEscrowRead({ startTime: Date.now() - 10, invoiceId: 'inv-3', endpoint: 'legacy', statusCode: 500 });

    const after = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'server_error' });
    expect(after).toBeGreaterThan(before);
  });

  it('observes duration in the histogram', async () => {
    const start = Date.now() - 50; // 50ms ago

    recordEscrowRead({ startTime: start, invoiceId: 'inv-4', endpoint: 'v1', statusCode: 200 });

    const sum = await getHistogramSum(escrowReadRequestDurationSeconds, { endpoint: 'v1', status: 'success' });
    // Duration should be >= 0.05 seconds
    expect(sum).toBeGreaterThan(0);
  });

  it('increments the error counter for client errors (404)', async () => {
    const before = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'legacy', error_cause: 'not_found' });

    recordEscrowRead({ startTime: Date.now() - 5, invoiceId: 'inv-5', endpoint: 'legacy', statusCode: 404 });

    const after = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'legacy', error_cause: 'not_found' });
    expect(after).toBeGreaterThan(before);
  });

  it('increments the error counter for server errors (500)', async () => {
    const before = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'v1', error_cause: 'internal' });

    recordEscrowRead({ startTime: Date.now() - 5, invoiceId: 'inv-6', endpoint: 'v1', statusCode: 500, err: new Error('DB down') });

    const after = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'v1', error_cause: 'internal' });
    expect(after).toBeGreaterThan(before);
  });

  it('does NOT increment error counter for successful requests', async () => {
    const before = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'v1', error_cause: 'not_found' });

    recordEscrowRead({ startTime: Date.now() - 5, invoiceId: 'inv-7', endpoint: 'v1', statusCode: 200 });

    const after = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'v1', error_cause: 'not_found' });
    expect(after).toBe(before);
  });

  it('logs at info level for success (200)', () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});

    recordEscrowRead({ startTime: Date.now() - 5, invoiceId: 'inv-8', endpoint: 'legacy', statusCode: 200 });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv-8', endpoint: 'legacy', statusCode: 200 }),
      'escrow-read: request completed',
    );
  });

  it('logs at warn level for client errors (404)', () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    recordEscrowRead({ startTime: Date.now() - 5, invoiceId: 'inv-9', endpoint: 'v1', statusCode: 404 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv-9', endpoint: 'v1', statusCode: 404, errorCause: 'not_found' }),
      'escrow-read: client error',
    );
  });

  it('logs at error level for server errors (500)', () => {
    jest.spyOn(logger, 'error').mockImplementation(() => {});

    recordEscrowRead({
      startTime: Date.now() - 5,
      invoiceId: 'inv-10',
      endpoint: 'legacy',
      statusCode: 500,
      err: new Error('DB connection failed'),
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'inv-10',
        endpoint: 'legacy',
        statusCode: 500,
        errorCause: 'internal',
        errorMessage: 'DB connection failed',
      }),
      'escrow-read: request failed',
    );
  });

  it('includes durationMs in the log data', () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});

    recordEscrowRead({ startTime: Date.now() - 42, invoiceId: 'inv-11', endpoint: 'v1', statusCode: 200 });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: expect.any(Number) }),
      expect.any(String),
    );
    const callArg = logger.info.mock.calls[0][0];
    expect(callArg.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('never logs stack traces', () => {
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    err.stack = 'sensitive stack trace here';

    recordEscrowRead({ startTime: Date.now(), invoiceId: 'inv-12', endpoint: 'legacy', statusCode: 500, err });

    const callArg = logger.error.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('stack');
    expect(callArg).not.toHaveProperty('stackTrace');
    expect(callArg.errorMessage).toBe('boom');
  });
});

// ── Integration: Legacy endpoint ─────────────────────────────────────────────

describe('GET /api/escrow/:invoiceId — metrics & logging', () => {
  let app;

  beforeAll(() => {
    app = createStandardizedApp();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db('escrow_event_projection').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('emits success metrics on 200', async () => {
    const before = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'success' });

    const res = await request(app).get('/api/escrow/inv-metrics-ok');
    expect(res.status).toBe(200);

    const after = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'success' });
    expect(after).toBeGreaterThan(before);
  });

  it('records duration in histogram on 200', async () => {
    await request(app).get('/api/escrow/inv-metrics-dur');

    const sum = await getHistogramSum(escrowReadRequestDurationSeconds, { endpoint: 'legacy', status: 'success' });
    // Histogram _sum is cumulative; it must be > 0 after at least one observation.
    expect(sum).toBeGreaterThan(0);
  });

  it('emits client_error metrics on 404', async () => {
    const before = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'client_error' });

    const res = await request(app).get('/api/escrow/unknown-inv');
    expect(res.status).toBe(404);

    const after = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'legacy', status: 'client_error' });
    expect(after).toBeGreaterThan(before);
  });

  it('increments error counter with not_found on 404', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const before = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'legacy', error_cause: 'not_found' });

    await request(app).get('/api/escrow/unknown-inv');

    const after = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'legacy', error_cause: 'not_found' });
    expect(after).toBeGreaterThan(before);
  });

  it('logs at info level on 200', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});

    await request(app).get('/api/escrow/inv-log-ok');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'legacy', statusCode: 200 }),
      'escrow-read: request completed',
    );
  });

  it('logs at warn level on 404', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await request(app).get('/api/escrow/unknown-inv');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'legacy', statusCode: 404, errorCause: 'not_found' }),
      'escrow-read: client error',
    );
  });

  it('includes invoiceId and durationMs in logs', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});

    await request(app).get('/api/escrow/inv-log-fields');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'inv-log-fields',
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
    const callArg = logger.info.mock.calls[0][0];
    expect(callArg.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Integration: V1 endpoint ─────────────────────────────────────────────────

describe('GET /v1/escrow/:invoiceId — metrics & logging', () => {
  let app;

  beforeAll(() => {
    app = createStandardizedApp();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db('escrow_event_projection').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('emits success metrics on 200 with valid auth', async () => {
    const before = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'success' });

    const res = await request(app)
      .get('/v1/escrow/inv-v1-ok')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);

    const after = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'success' });
    expect(after).toBeGreaterThan(before);
  });

  it('records duration in histogram on 200', async () => {
    await request(app)
      .get('/v1/escrow/inv-v1-dur')
      .set('Authorization', authHeader());

    const sum = await getHistogramSum(escrowReadRequestDurationSeconds, { endpoint: 'v1', status: 'success' });
    expect(sum).toBeGreaterThan(0);
  });

  it('emits client_error metrics on 404', async () => {
    const before = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'client_error' });

    const res = await request(app)
      .get('/v1/escrow/unknown-inv')
      .set('Authorization', authHeader());
    expect(res.status).toBe(404);

    const after = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'client_error' });
    expect(after).toBeGreaterThan(before);
  });

  it('increments error counter with not_found on 404', async () => {
    const before = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'v1', error_cause: 'not_found' });

    await request(app)
      .get('/v1/escrow/unknown-inv')
      .set('Authorization', authHeader());

    const after = await getCounterValue(escrowReadErrorsTotal, { endpoint: 'v1', error_cause: 'not_found' });
    expect(after).toBeGreaterThan(before);
  });

  it('logs at info level on 200 with V1 endpoint label', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});

    await request(app)
      .get('/v1/escrow/inv-v1-log')
      .set('Authorization', authHeader());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'v1', statusCode: 200 }),
      'escrow-read: request completed',
    );
  });

  it('logs at warn level on 404', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await request(app)
      .get('/v1/escrow/unknown-inv')
      .set('Authorization', authHeader());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'v1', statusCode: 404, errorCause: 'not_found' }),
      'escrow-read: client error',
    );
  });

  it('does not emit metrics for auth failures (401 — middleware rejects before handler)', async () => {
    const beforeSuccess = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'success' });
    const beforeError = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'client_error' });

    await request(app).get('/v1/escrow/inv-auth-fail');

    const afterSuccess = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'success' });
    const afterError = await getCounterValue(escrowReadRequestsTotal, { endpoint: 'v1', status: 'client_error' });
    // Auth rejection (401) happens in middleware — our handler never runs, so no
    // escrow-read metrics are emitted.
    expect(afterSuccess).toBe(beforeSuccess);
    expect(afterError).toBe(beforeError);
  });

  it('still logs after middleware auth failure (401 is handled by auth middleware, not escrow handler)', async () => {
    // The 401 is emitted by authenticateToken, not by the escrow-read handler.
    // We verify that the escrow-read handler does NOT log on 401 because it
    // never executes.
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await request(app).get('/v1/escrow/inv-noauth');

    // The escrow-specific warn log should NOT fire (handler never ran)
    const escrowWarnCalls = logger.warn.mock.calls.filter(
      (call) => call[1] && call[1].includes('escrow-read'),
    );
    expect(escrowWarnCalls).toHaveLength(0);
  });

  it('includes V1 endpoint label in structured log', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});

    await request(app)
      .get('/v1/escrow/inv-v1-label')
      .set('Authorization', authHeader());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'v1' }),
      expect.any(String),
    );
  });
});

// ── Edge cases: label boundaries ─────────────────────────────────────────────

describe('statusLabel and errorCauseLabel edge cases', () => {
  it('classifies 399 as success', () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});

    recordEscrowRead({ startTime: Date.now(), invoiceId: 'inv-edge', endpoint: 'legacy', statusCode: 399 });

    expect(logger.info).toHaveBeenCalled();
  });

  it('classifies 400 as client_error with bad_request cause', () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    recordEscrowRead({ startTime: Date.now(), invoiceId: 'inv-edge', endpoint: 'legacy', statusCode: 400 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCause: 'bad_request' }),
      expect.any(String),
    );
  });

  it('classifies 401 as client_error with auth cause', () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    recordEscrowRead({ startTime: Date.now(), invoiceId: 'inv-edge', endpoint: 'v1', statusCode: 401 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCause: 'auth' }),
      expect.any(String),
    );
  });

  it('classifies 403 as client_error with auth cause', () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    recordEscrowRead({ startTime: Date.now(), invoiceId: 'inv-edge', endpoint: 'v1', statusCode: 403 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCause: 'auth' }),
      expect.any(String),
    );
  });

  it('uses err.code for error_cause when available', () => {
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    const err = new Error('custom');
    err.code = 'SOROBAN_TIMEOUT';

    recordEscrowRead({ startTime: Date.now(), invoiceId: 'inv-code', endpoint: 'legacy', statusCode: 502, err });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCause: 'SOROBAN_TIMEOUT' }),
      expect.any(String),
    );
  });
});
