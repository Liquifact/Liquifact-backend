'use strict';

/**
 * Tests for the idempotency middleware covering:
 *  - Missing Idempotency-Key header ? 400
 *  - Invalid key format ? 400
 *  - First call executes normally ? 201
 *  - Duplicate key replays original response ? 201
 *  - Same key + different body ? 409
 *  - Keys persist in the database
 */

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

// -- Helpers ---------------------------------------------------------------

/** Generate a valid idempotency key */
function validKey() {
  return 'ik_' + crypto.randomBytes(8).toString('hex');
}

/** Minimal valid funding request body */
function validBody(overrides = {}) {
  return {
    invoiceId: 'INV-2024-001',
    investmentAmount: 5000.00,
    smeId: 'SME-789',
    ...overrides,
  };
}

// -- Setup -----------------------------------------------------------------

// We need to mock the knex db module BEFORE requiring the middleware.
// The middleware requires db/knex at module load time.
jest.mock('../src/db/knex', () => {
  const store = new Map();
  return {
    transaction: jest.fn((fn) => {
      const trx = {
        __store: store,
        where: jest.fn().mockReturnThis(),
        first: jest.fn(async () => {
          // Find by idempotency_key
          return trx._lastKey ? store.get(trx._lastKey) || null : null;
        }),
        insert: jest.fn(async (row) => {
          trx._lastKey = row.idempotency_key;
          store.set(row.idempotency_key, {
            ...row,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }),
        update: jest.fn(async (updates) => {
          if (trx._lastKey) {
            const existing = store.get(trx._lastKey) || {};
            store.set(trx._lastKey, { ...existing, ...updates });
          }
        }),
        _lastKey: null,
        raw: jest.fn(() => new Date(Date.now() + 86400000)),
        fn: { now: () => new Date() },
      };
      return fn(trx);
    }),
    fn: { now: () => new Date() },
    raw: jest.fn(() => new Date(Date.now() + 86400000)),
  };
});

// Now we can require the middleware
const idempotencyMiddleware = require('../middleware/idempotency');

function createApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/invest/fund-invoice', idempotencyMiddleware, (req, res) => {
    return res.status(201).json({
      data: {
        investmentId: 'inv_test_' + Date.now(),
        invoiceId: req.body.invoiceId,
        smeId: req.body.smeId,
        investmentAmount: req.body.investmentAmount,
        status: 'pending',
      },
      meta: { timestamp: new Date().toISOString() },
      message: 'Investment submitted successfully.',
    });
  });
  return app;
}

// -- Tests -----------------------------------------------------------------

describe('Idempotency Middleware', () => {
  let app;

  beforeEach(() => {
    app = createApp();
  });

  // -- Validation --------------------------------------------------------

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .send(validBody())
      .expect(400);

    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key contains invalid characters', async () => {
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', 'invalid key with spaces!')
      .send(validBody())
      .expect(400);

    expect(res.body.error).toMatch(/8.*128.*URL-safe/);
  });

  it('returns 400 when Idempotency-Key is too short', async () => {
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', 'short')
      .send(validBody())
      .expect(400);

    expect(res.body.error).toMatch(/8.*128.*URL-safe/);
  });

  // -- First call ---------------------------------------------------------

  it('executes the handler on first call (new key)', async () => {
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);

    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.investmentId).toBeDefined();
  });

  // -- Duplicate key replay -----------------------------------------------

  it('returns the cached response on duplicate key with same body', async () => {
    const key = validKey();
    const body = validBody();

    // First call
    const first = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // Second call with same key and body
    const second = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // Should return the same investmentId
    expect(second.body.data.investmentId).toBe(first.body.data.investmentId);
    expect(second.body.data.status).toBe('pending');
  });

  // -- Conflicting body ---------------------------------------------------

  it('returns 409 when same key is used with a different body', async () => {
    const key = validKey();

    // First call with body A
    await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(validBody({ investmentAmount: 1000 }))
      .expect(201);

    // Second call with same key but body B
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send(validBody({ investmentAmount: 2000 }))
      .expect(409);

    expect(res.body.error).toMatch(/different request body/);
  });

  // -- Multiple different keys --------------------------------------------

  it('allows multiple requests with different keys', async () => {
    const key1 = validKey();
    const key2 = validKey();

    const res1 = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key1)
      .send(validBody({ invoiceId: 'INV-001' }))
      .expect(201);

    const res2 = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key2)
      .send(validBody({ invoiceId: 'INV-002' }))
      .expect(201);

    // Different keys should produce different investmentIds
    expect(res1.body.data.investmentId).not.toBe(res2.body.data.investmentId);
    expect(res1.body.data.invoiceId).toBe('INV-001');
    expect(res2.body.data.invoiceId).toBe('INV-002');
  });

  // -- Empty body handling ------------------------------------------------

  it('handles requests with empty body', async () => {
    const key = validKey();

    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('Idempotency-Key', key)
      .send({})
      .expect(201);

    // The handler should still return a response even with empty body
    expect(res.body.data.investmentId).toBeDefined();
  });
});
