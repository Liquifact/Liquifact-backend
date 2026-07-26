'use strict';

/**
 * @fileoverview Tests for POST /v1/escrow/batch — the bulk escrow-read endpoint.
 *
 * Covers:
 *  - Success path (multiple valid invoice IDs read in one request)
 *  - Partial-failure isolation (unmapped invoice ID does not fail the batch)
 *  - Empty-batch rejection (422)
 *  - Over-cap rejection (422, > MAX_BATCH_SIZE items)
 *  - Non-array / wrong-shaped body rejection (422)
 *  - Auth error path (missing / invalid token → 401)
 *  - Response shape assertions
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createStandardizedApp } = require('../src/app');
const { MAX_BATCH_SIZE } = require('../src/schemas/escrowBatchRead');

// ── Shared mocks (mirror tests/v1.escrow.read.test.js) ─────────────────────

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (!id || id === 'unknown-batch-inv' || id === 'nonexistent_batch_999') return null;
    return `C_BATCH_ESCROW_FOR_${id.toUpperCase()}`;
  }),
  EscrowNotFoundError: class EscrowNotFoundError extends Error {},
}));

jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => {
    return operation();
  }),
}));

// In-memory store keyed by invoice_id for the projection table.
jest.mock('../src/db/knex', () => {
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

const db = require('../src/db/knex');
const { createRedisEscrowSummaryCache } = require('../src/cache/redis');

// ── JWT helpers ───────────────────────────────────────────────────────────

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'test-user', id: 'user_batch', tenantId: 'tenant_batch_test', ...payload },
    TEST_SECRET,
    { expiresIn: '1h' }
  );
}

function authHeader(payload = {}) {
  return `Bearer ${makeToken(payload)}`;
}

// ── Test suite ───────────────────────────────────────────────────────────

describe('POST /v1/escrow/batch (authenticated)', () => {
  let app;
  let cache;

  beforeAll(() => {
    app = createStandardizedApp();
    cache = createRedisEscrowSummaryCache();
  });

  afterAll(async () => {
    await db.destroy();
    if (cache && cache.client) {
      await cache.client.quit();
    }
  });

  beforeEach(async () => {
    await db('escrow_event_projection').del();
    if (cache && cache.client) {
      await cache.client.flushall();
    }
  });

  // ── Success paths ─────────────────────────────────────────────────────

  it('returns 200 with per-item results for a batch of valid invoice IDs', async () => {
    await db('escrow_event_projection').insert([
      {
        invoice_id: 'inv_batch_1',
        latest_event_id: 'evt_batch_1',
        latest_event_type: 'funded',
        latest_ledger_sequence: 100,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
        latest_observed_at: new Date(),
      },
      {
        invoice_id: 'inv_batch_2',
        latest_event_id: 'evt_batch_2',
        latest_event_type: 'funded',
        latest_ledger_sequence: 200,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 8000 }),
        latest_observed_at: new Date(),
      },
    ]);

    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: ['inv_batch_1', 'inv_batch_2'] });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.errors).toHaveLength(0);

    const byId = Object.fromEntries(res.body.data.results.map((r) => [r.invoiceId, r]));
    expect(byId.inv_batch_1.fundedAmount).toBe(5000);
    expect(byId.inv_batch_1.escrowAddress).toBe('C_BATCH_ESCROW_FOR_INV_BATCH_1');
    expect(byId.inv_batch_1).toHaveProperty('daysToMaturity');
    expect(byId.inv_batch_2.fundedAmount).toBe(8000);
  });

  it('returns 200 with a neutral stub result for a mapped invoice with no projection', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: ['inv_batch_live'] });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.results[0].status).toBe('not_found');
    expect(res.body.data.results[0].fundedAmount).toBe(0);
  });

  // ── Partial-failure isolation ────────────────────────────────────────

  it('isolates an unmapped invoice ID into errors without failing the batch', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv_batch_ok',
      latest_event_id: 'evt_ok',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 100 }),
      latest_observed_at: new Date(),
    });

    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: ['inv_batch_ok', 'unknown-batch-inv'] });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.results[0].invoiceId).toBe('inv_batch_ok');
    expect(res.body.data.errors).toHaveLength(1);
    expect(res.body.data.errors[0]).toMatchObject({
      invoiceId: 'unknown-batch-inv',
      code: 'NOT_FOUND',
    });
    expect(res.body.data.errors[0].error).toMatch(/No escrow contract mapping found/);
  });

  it('returns all-errors when every invoice ID in the batch is unmapped', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: ['unknown-batch-inv', 'nonexistent_batch_999'] });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(0);
    expect(res.body.data.errors).toHaveLength(2);
  });

  // ── Validation-failure paths ─────────────────────────────────────────

  it('returns 422 for an empty invoiceIds array', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: [] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it(`returns 422 when invoiceIds exceeds the ${MAX_BATCH_SIZE}-item cap`, async () => {
    const invoiceIds = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => `inv_over_${i}`);

    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when invoiceIds is missing', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when invoiceIds is not an array', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: 'inv_batch_1' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 for an unknown top-level field (strict schema)', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: ['inv_batch_1'], extraField: 'nope' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Auth error paths ──────────────────────────────────────────────────

  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .send({ invoiceIds: ['inv_batch_1'] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 before validating the body when unauthenticated', async () => {
    const res = await request(app)
      .post('/v1/escrow/batch')
      .send({ invoiceIds: [] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // ── Response shape assertions ─────────────────────────────────────────

  it('returns a well-formed envelope with results/errors arrays and a summary message', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv_batch_shape',
      latest_event_id: 'evt_shape',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 100 }),
      latest_observed_at: new Date(),
    });

    const res = await request(app)
      .post('/v1/escrow/batch')
      .set('Authorization', authHeader())
      .send({ invoiceIds: ['inv_batch_shape', 'unknown-batch-inv'] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toBeNull();
    expect(Array.isArray(res.body.data.results)).toBe(true);
    expect(Array.isArray(res.body.data.errors)).toBe(true);
  });
});
