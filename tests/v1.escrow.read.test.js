'use strict';

/**
 * @fileoverview Tests for GET /v1/escrow/:invoiceId — the authenticated escrow-read endpoint.
 *
 * Covers:
 *  - Success path (valid token + projection data)
 *  - Success path (valid token + neutral RPC stub fallback)
 *  - Not-found path (unknown invoice ID)
 *  - Validation-failure path (invalid invoiceId format → 400)
 *  - Auth error path (missing / invalid token → 401)
 *  - Idempotent-repeat path (identical requests return consistent results)
 *  - Response shape assertions (envelope, fields, headers)
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createStandardizedApp } = require('../src/app');

// ── Shared mocks (mirror tests/escrow.read.test.js) ───────────────────────────

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    // Realistic: return null for empty strings and known-unknown IDs
    if (!id || id === 'unknown-v1-inv' || id === 'nonexistent_v1_999') return null;
    return `C_V1_ESCROW_FOR_${id.toUpperCase()}`;
  }),
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

// ── JWT helpers ───────────────────────────────────────────────────────────────

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'test-user', id: 'user_v1', tenantId: 'tenant_v1_test', ...payload },
    TEST_SECRET,
    { expiresIn: '1h' }
  );
}

function authHeader(payload = {}) {
  return `Bearer ${makeToken(payload)}`;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('GET /v1/escrow/:invoiceId (authenticated)', () => {
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

  // ── Success paths ────────────────────────────────────────────────────────

  it('returns 200 with projection data when invoice has a seeded projection row', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv_v1_proj',
      latest_event_id: 'evt_v1_1',
      latest_event_type: 'funded',
      latest_ledger_sequence: 500,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 7500 }),
      latest_observed_at: new Date(),
    });

    const res = await request(app)
      .get('/v1/escrow/inv_v1_proj')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.headers['x-escrow-address']).toBe('C_V1_ESCROW_FOR_INV_V1_PROJ');
    expect(res.body.error).toBeNull();
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.version).toBeDefined();
    expect(res.body.data).toBeDefined();
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.fundedAmount).toBe(7500);
    expect(res.body.data.latest_ledger_sequence).toBe(500);
    expect(res.body.data.latest_event_type).toBe('funded');
    expect(res.body.data.fromProjection).toBe(true);
    expect(res.body.data.escrowAddress).toBe('C_V1_ESCROW_FOR_INV_V1_PROJ');
    // v1 endpoint enriches with derived fields
    expect(res.body.data).toHaveProperty('daysToMaturity');
  });

  it('returns 200 with neutral stub when no projection exists (non-fabricated)', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv_v1_live')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.status).toBe('not_found');
    expect(res.body.data.fundedAmount).toBe(0);
    expect(res.body.data.escrowAddress).toBe('C_V1_ESCROW_FOR_INV_V1_LIVE');
  });

  it('includes derived fields in the success response', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv_v1_derived',
      latest_event_id: 'evt_derived',
      latest_event_type: 'funded',
      latest_ledger_sequence: 42,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 3000 }),
      latest_observed_at: new Date(),
    });

    const res = await request(app)
      .get('/v1/escrow/inv_v1_derived')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    // computeEscrowDerivedFields returns apyPercent, fundedPercent, and daysToMaturity
    expect(res.body.data).toHaveProperty('apyPercent');
    expect(res.body.data).toHaveProperty('fundedPercent');
    expect(res.body.data).toHaveProperty('daysToMaturity');
    expect(res.body.data).toHaveProperty('escrowAddress');
    expect(res.body.data.escrowAddress).toBe('C_V1_ESCROW_FOR_INV_V1_DERIVED');
  });

  // ── Not-found paths ──────────────────────────────────────────────────────

  it('returns 404 for unknown invoice ID (no escrow mapping)', async () => {
    const res = await request(app)
      .get('/v1/escrow/unknown-v1-inv')
      .set('Authorization', authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toMatch(/No escrow contract mapping found/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for non-existent invoice with valid format', async () => {
    const res = await request(app)
      .get('/v1/escrow/nonexistent_v1_999')
      .set('Authorization', authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/No escrow contract mapping found/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── Validation-failure paths ─────────────────────────────────────────────

  it('returns 404 for empty invoiceId via HTTP', async () => {
    // Express decodes %20 to a single space; the route trims to empty string.
    // The mock now returns null for empty IDs, producing 404 NOT_FOUND.
    const res = await request(app)
      .get('/v1/escrow/%20')
      .set('Authorization', authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for invoiceId with invalid characters', async () => {
    // The v1 route uses readEscrowState which validates invoiceId
    // and throws with code INVALID_INVOICE_ID / status 400.
    // The standardised envelope maps 400 → BAD_REQUEST.
    const res = await request(app)
      .get('/v1/escrow/bad@invalid!')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 401 before mapping check when unauthenticated', async () => {
    // When unauthenticated, the v1 endpoint should reject with 401 before
    // checking whether the invoice ID is in the escrow map.
    const res = await request(app).get('/v1/escrow/unknown-v1-inv');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // ── Auth error paths ─────────────────────────────────────────────────────

  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app).get('/v1/escrow/inv_v1_proj');

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/Authentication token is required/);
  });

  it('returns 401 when an invalid token is provided', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv_v1_proj')
      .set('Authorization', 'Bearer some.invalid.token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when Authorization header has wrong scheme (not Bearer)', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv_v1_proj')
      .set('Authorization', `Basic ${makeToken()}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/Invalid Authorization header format/);
  });

  it('returns 401 for expired token', async () => {
    const expiredToken = jwt.sign(
      { sub: 'test-user', id: 'user_v1' },
      TEST_SECRET,
      { expiresIn: '-1h' }
    );

    const res = await request(app)
      .get('/v1/escrow/inv_v1_proj')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/Token has expired/);
  });

  // ── Idempotent-repeat paths ──────────────────────────────────────────────

  it('returns identical data on repeated success requests (idempotency)', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv_v1_idem',
      latest_event_id: 'evt_v1_idem',
      latest_event_type: 'funded',
      latest_ledger_sequence: 300,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 4200 }),
      latest_observed_at: new Date(),
    });

    const first = await request(app)
      .get('/v1/escrow/inv_v1_idem')
      .set('Authorization', authHeader());
    expect(first.status).toBe(200);

    const second = await request(app)
      .get('/v1/escrow/inv_v1_idem')
      .set('Authorization', authHeader());
    expect(second.status).toBe(200);

    // Core fields must be identical
    expect(second.body.data.status).toBe(first.body.data.status);
    expect(second.body.data.fundedAmount).toBe(first.body.data.fundedAmount);
    expect(second.body.data.latest_ledger_sequence).toBe(first.body.data.latest_ledger_sequence);
    expect(second.body.data.latest_event_type).toBe(first.body.data.latest_event_type);
    expect(second.body.data.source).toBe(first.body.data.source);
    expect(second.body.data.escrowAddress).toBe(first.body.data.escrowAddress);
    expect(second.body.data.fromProjection).toBe(first.body.data.fromProjection);
  });

  it('returns identical 404 error on repeated not-found requests (idempotency)', async () => {
    const first = await request(app)
      .get('/v1/escrow/unknown-v1-inv')
      .set('Authorization', authHeader());
    expect(first.status).toBe(404);

    const second = await request(app)
      .get('/v1/escrow/unknown-v1-inv')
      .set('Authorization', authHeader());
    expect(second.status).toBe(404);

    expect(second.body.error.code).toBe(first.body.error.code);
    expect(second.body.error.message).toBe(first.body.error.message);
  });

  it('returns identical 400 on repeated validation-failure requests (idempotency)', async () => {
    const first = await request(app)
      .get('/v1/escrow/bad@invalid!')
      .set('Authorization', authHeader());
    expect(first.status).toBe(400);

    const second = await request(app)
      .get('/v1/escrow/bad@invalid!')
      .set('Authorization', authHeader());
    expect(second.status).toBe(400);

    expect(second.body.error.code).toBe(first.body.error.code);
    expect(second.body.error.message).toBe(first.body.error.message);
  });

  // ── Response shape assertions ────────────────────────────────────────────

  it('returns a well-formed success envelope with all required fields', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv_v1_shape',
      latest_event_id: 'evt_shape',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 100 }),
      latest_observed_at: new Date(),
    });

    const res = await request(app)
      .get('/v1/escrow/inv_v1_shape')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);

    // Standard envelope: data, meta, error
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toBeNull();
    expect(res.body.meta).toHaveProperty('version');
    expect(res.body.meta).toHaveProperty('timestamp');

    // Escrow-specific data fields
    expect(res.body.data).toHaveProperty('invoiceId');
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('fundedAmount');
    expect(res.body.data).toHaveProperty('legal_hold');
    expect(res.body.data).toHaveProperty('legalHoldStatus');
    expect(res.body.data).toHaveProperty('escrowAddress');
    expect(res.body.data).toHaveProperty('fromProjection');
    expect(typeof res.body.data.fundedAmount).toBe('number');
    expect(typeof res.body.data.legal_hold).toBe('boolean');
  });

  it('sets X-Escrow-Address header on successful reads', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv_v1_hdr',
      latest_event_id: 'evt_hdr',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 100 }),
      latest_observed_at: new Date(),
    });

    const res = await request(app)
      .get('/v1/escrow/inv_v1_hdr')
      .set('Authorization', authHeader());

    expect(res.headers['x-escrow-address']).toBe('C_V1_ESCROW_FOR_INV_V1_HDR');
    // Must be a valid Stellar contract address
    expect(res.headers['x-escrow-address']).toMatch(/^C_/);
  });
});
