'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

// ── Module mocks ─────────────────────────────────────────────────────────────

// Mock DB so we can test the idempotency middleware logic
// `idempotencyMiddleware` expects knex to return a chainable query builder.
const mockDb = jest.fn();

// We need to implement a mock transaction and basic query builder since 
// the idempotency middleware interacts with `idempotency_keys` table.
const mockTrx = jest.fn();
mockDb.transaction = jest.fn(async (cb) => {
  return cb(mockTrx);
});
mockDb.fn = { now: jest.fn(() => '2023-01-01T00:00:00Z') };

jest.mock('../../src/db/knex', () => mockDb);

jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

jest.mock('../../src/metrics', () => ({
  webhookReplayTotal: { inc: jest.fn() },
  idempotencyStorageFailureTotal: { inc: jest.fn() },
  registry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
}));

jest.mock('prom-client', () => ({
  Counter:  class { constructor() {} inc() {} },
  Gauge:    class { constructor() {} set() {} },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics() { return ''; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });

// ── Imports ───────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const adminConfigRouter = require('../../src/routes/adminConfig');

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

/** Mint a valid admin JWT for test requests. */
function makeAdminToken(sub = 'admin-user', tenantId = 'tenant_test') {
  return jwt.sign({ sub, tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());

  // Stub tenant extraction
  app.use((req, _res, next) => {
    if (!req.tenantId) { req.tenantId = 'tenant_test'; }
    next();
  });

  app.use('/api/admin/config', adminConfigRouter);

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  return app;
}

const APP = buildApp();
const AUTH = `Bearer ${makeAdminToken()}`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/admin/config Idempotency', () => {
  let mockWhere, mockFirst, mockInsert, mockUpdate, mockDel;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFirst = jest.fn();
    mockInsert = jest.fn().mockResolvedValue([1]);
    mockUpdate = jest.fn().mockResolvedValue(1);
    mockDel = jest.fn().mockResolvedValue(1);
    
    mockWhere = jest.fn().mockReturnValue({
      first: mockFirst,
      del: mockDel,
      update: mockUpdate,
    });

    // Both mockTrx and mockDb need to act as query builders
    mockTrx.mockReturnValue({
      where: mockWhere,
      insert: mockInsert,
    });

    mockDb.mockReturnValue({
      where: mockWhere,
      update: mockUpdate,
    });
  });

  const payload = {
    section: 'fraudThresholds',
    config: { fraudCeiling: 10000000, manualReviewThreshold: 1000000 },
  };

  it('bypasses idempotency if no header is provided', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.section).toBe('fraudThresholds');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid Idempotency-Key format', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'invalid key!') // space and ! are invalid
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be 8–128 URL-safe characters/);
  });

  it('handles first execution of a new idempotency key', async () => {
    // DB returns nothing for existing key
    mockFirst.mockResolvedValueOnce(null);

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'valid-key-12345678')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.section).toBe('fraudThresholds');
    
    // Should have checked DB inside transaction
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockTrx).toHaveBeenCalledWith('idempotency_keys');
    expect(mockInsert).toHaveBeenCalled();
    
    // Should persist response after returning
    // Since res.json is hooked, we need to wait a tick for the promise to resolve
    await new Promise(setImmediate);
    expect(mockDb).toHaveBeenCalledWith('idempotency_keys');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      response_status: 200,
    }));
  });

  it('replays response for exactly matching completed key', async () => {
    const cachedResponse = {
      section: 'fraudThresholds',
      config: payload.config,
      message: 'Replayed response',
    };
    
    const crypto = require('crypto');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');

    // DB returns existing completed record
    mockFirst.mockResolvedValueOnce({
      idempotency_key: 'valid-key-12345678',
      request_fingerprint: fingerprint,
      response_status: 200,
      response_body: JSON.stringify(cachedResponse),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'valid-key-12345678')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Replayed response');
    
    // Should not have inserted anything or overridden res.json logic
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 409 Conflict when key is reused with a different payload', async () => {
    // DB returns record with different fingerprint
    mockFirst.mockResolvedValueOnce({
      idempotency_key: 'valid-key-12345678',
      request_fingerprint: 'different-fingerprint-from-previous-request',
      response_status: 200,
      response_body: '{}',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'valid-key-12345678')
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
    expect(res.body.detail).toMatch(/different request body/);
  });
});
