'use strict';

/**
 * Integration tests for the v1 escrow indexer endpoint.
 * 
 * Covers success, not-found, validation-failure, and idempotent-repeat paths.
 * Uses an in-memory mock database for fast, isolated tests.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock the database with an in-memory store (similar to tests/escrow.read.test.js)
jest.mock('../../src/db/knex', () => {
  const rows = new Map();
  const fakeDb = jest.fn((table) => ({
    _table: table,
    _whereId: null,
    where(field, value) {
      if (typeof field === 'string') {
        this._whereId = String(value);
      }
      return this;
    },
    async first() {
      if (!this._whereId) return null;
      return rows.get(this._whereId) || null;
    },
    async del() {
      rows.clear();
      return 0;
    },
    async destroy() {
      rows.clear();
    },
    async insert(payload) {
      const entries = Array.isArray(payload) ? payload : [payload];
      entries.forEach((entry) => {
        if (entry && entry.invoice_id) {
          rows.set(entry.invoice_id, entry);
        }
      });
      return entries.length;
    },
  }));
  fakeDb.destroy = async () => {
    rows.clear();
  };
  return fakeDb;
}, { virtual: true });

const db = require('../../src/db/knex');
const v1Router = require('../../src/routes/v1/index');
const { errorHandler } = require('../../src/middleware/errorHandler');
const { problemJsonHandler } = require('../../src/middleware/problemJson');

// Mock the escrowMap to return a valid address for our test invoice
jest.mock('../../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (id === 'unknown-inv' || id === 'not-mapped') return null;
    if (id === 'inv_test_123') return 'C_ESCROW_FOR_INV_TEST_123';
    return `C_ESCROW_FOR_${id.toUpperCase()}`;
  }),
}));

// Mock soroban to test fallback
jest.mock('../../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => {
    return operation();
  }),
}));

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

const VALID_INVOICE_ID = 'inv_test_123';
const ESCROW_ADDRESS = 'C_ESCROW_FOR_INV_TEST_123';

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', v1Router);
  app.use(problemJsonHandler);
  app.use(errorHandler);
  return app;
}

function createAuthToken(payload = { sub: 'test-user', role: 'user' }) {
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
}

function getAuthHeader(payload) {
  return { Authorization: `Bearer ${createAuthToken(payload)}` };
}

// Helper to seed a projection row
async function seedProjection(invoiceId, overrides = {}) {
  await db('escrow_event_projection').insert({
    invoice_id: invoiceId,
    latest_event_id: 'evt_1',
    latest_event_type: 'funded',
    latest_ledger_sequence: 12345,
    latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
    latest_observed_at: new Date().toISOString(),
    latest_paging_token: '12345-1',
    ...overrides,
  });
}

describe('GET /v1/escrow/:invoiceId — indexer endpoint', () => {
  let app;

  beforeAll(() => {
    app = buildTestApp();
  });

  beforeEach(async () => {
    await db('escrow_event_projection').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe('Success path', () => {
    it('returns 200 with escrow data when projection exists', async () => {
      await seedProjection(VALID_INVOICE_ID);

      const res = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`)
        .set(getAuthHeader());

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.invoiceId).toBe(VALID_INVOICE_ID);
      expect(res.body.data.escrowAddress).toBe(ESCROW_ADDRESS);
      expect(res.body.data.status).toBe('funded');
      expect(res.body.data.fundedAmount).toBe(5000);
      expect(res.body.data.latest_ledger_sequence).toBe(12345);
      expect(res.body.data.fromProjection).toBe(true);
      expect(res.body.data.daysToMaturity).toBeDefined();
      expect(res.body.message).toContain('event projection');
      expect(res.headers['x-escrow-address']).toBe(ESCROW_ADDRESS);
    });

    it('includes derived fields in response', async () => {
      await seedProjection(VALID_INVOICE_ID, {
        latest_event_body: JSON.stringify({
          status: 'funded',
          fundedAmount: 7500,
          maturityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        latest_ledger_sequence: 20000,
      });

      const res = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`)
        .set(getAuthHeader());

      expect(res.status).toBe(200);
      expect(res.body.data.fundedPercent).toBeDefined();
      expect(res.body.data.daysToMaturity).toBeDefined();
      expect(res.body.data.apyPercent).toBeDefined();
    });
  });

  describe('Not-found path', () => {
    it('returns 404 when no escrow mapping exists for invoiceId', async () => {
      const res = await request(app)
        .get('/v1/escrow/unknown-inv')
        .set(getAuthHeader());

      expect(res.status).toBe(404);
      // The escrowMap returns a plain error object, not RFC 7807
      expect(res.body.error).toBeDefined();
      expect(res.body.error).toContain("No escrow contract mapping found");
    });

    it('returns 404 when invoiceId has no projection and no on-chain data', async () => {
      const res = await request(app)
        .get('/v1/escrow/not-mapped')
        .set(getAuthHeader());

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('Validation-failure path', () => {
    it('returns 400 for invoiceId starting with invalid character', async () => {
      const res = await request(app)
        .get('/v1/escrow/-invalid-start')
        .set(getAuthHeader());

      expect(res.status).toBe(400);
      // Returns RFC 7807 format
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.type).toMatch(/bad-request/);
      expect(res.body.title).toContain('invoiceId contains invalid characters');
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toBeDefined();
    });

    it('returns 401 when no authorization header provided', async () => {
      const res = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`);

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.type).toMatch(/unauthorized/);
      expect(res.body.title).toBe('Unauthorized');
      expect(res.body.status).toBe(401);
      expect(res.body.detail).toContain('Authentication token is required');
    });

    it('returns 401 when authorization header is malformed', async () => {
      const res = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`)
        .set('Authorization', 'InvalidToken');

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.type).toMatch(/unauthorized/);
      expect(res.body.title).toBe('Unauthorized');
    });

    it('returns 401 when token is expired', async () => {
      const expiredToken = jwt.sign(
        { sub: 'test-user' },
        TEST_JWT_SECRET,
        { expiresIn: '-1h', algorithm: 'HS256' }
      );
      const res = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`)
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.type).toMatch(/token-expired/);
      expect(res.body.title).toBe('Invalid Token');
      expect(res.body.status).toBe(401);
      expect(res.body.detail).toContain('Token has expired');
    });
  });

  describe('Idempotent-repeat path (cache)', () => {
    it('returns cached data on second request (idempotent)', async () => {
      await seedProjection(VALID_INVOICE_ID);

      // First request
      const res1 = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`)
        .set(getAuthHeader());

      expect(res1.status).toBe(200);
      expect(res1.body.data.fundedAmount).toBe(5000);

      // Second request should hit cache
      const res2 = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`)
        .set(getAuthHeader());

      expect(res2.status).toBe(200);
      expect(res2.body.data.fundedAmount).toBe(5000);
      expect(res2.body.data).toEqual(res1.body.data);
    });

    it('returns same response shape on repeated calls', async () => {
      await seedProjection(VALID_INVOICE_ID);

      const responses = await Promise.all([
        request(app).get(`/v1/escrow/${VALID_INVOICE_ID}`).set(getAuthHeader()),
        request(app).get(`/v1/escrow/${VALID_INVOICE_ID}`).set(getAuthHeader()),
        request(app).get(`/v1/escrow/${VALID_INVOICE_ID}`).set(getAuthHeader()),
      ]);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.invoiceId).toBe(VALID_INVOICE_ID);
        expect(res.body.data.escrowAddress).toBe(ESCROW_ADDRESS);
        expect(res.body.message).toBeDefined();
      });
    });
  });

  describe('Response shape assertions', () => {
    beforeEach(async () => {
      await seedProjection(VALID_INVOICE_ID);
    });

    it('returns RFC 7807 compliant error shape on validation failure', async () => {
      const res = await request(app)
        .get('/v1/escrow/-invalid-start')
        .set(getAuthHeader());

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.type).toMatch(/bad-request/);
      expect(res.body.title).toBeDefined();
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toBeDefined();
      expect(res.body.instance).toBeDefined();
    });

    it('returns error shape on not-found (from escrowMap)', async () => {
      const res = await request(app)
        .get('/v1/escrow/unknown-inv')
        .set(getAuthHeader());

      expect(res.status).toBe(404);
      // escrowMap returns plain error object
      expect(res.body.error).toBeDefined();
      expect(typeof res.body.error).toBe('string');
    });

    it('returns RFC 7807 compliant error shape on unauthorized', async () => {
      const res = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`);

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.type).toMatch(/unauthorized/);
      expect(res.body.title).toBe('Unauthorized');
      expect(res.body.status).toBe(401);
      expect(res.body.detail).toBeDefined();
      expect(res.body.instance).toBeDefined();
    });

    it('success response includes required fields', async () => {
      const res = await request(app)
        .get(`/v1/escrow/${VALID_INVOICE_ID}`)
        .set(getAuthHeader());

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.message).toBeDefined();
      expect(typeof res.body.data.invoiceId).toBe('string');
      expect(typeof res.body.data.escrowAddress).toBe('string');
      expect(typeof res.body.data.status).toBe('string');
      expect(typeof res.body.data.fundedAmount).toBe('number');
      expect(typeof res.body.data.fromProjection).toBe('boolean');
      expect(res.headers['x-escrow-address']).toBeDefined();
    });
  });
});