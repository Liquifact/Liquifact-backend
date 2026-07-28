'use strict';

/**
 * Integration tests for the indexer write endpoint with idempotency.
 *
 * These tests run against an in-memory SQLite database via the Knex
 * `test` knexfile profile, mirroring the pattern used in
 * `tests/healthWrite.idempotency.test.js`.
 *
 * Coverage targets:
 *  - First write → 201 with persisted event
 *  - Exact replay (same key + same body) → 201 with same persisted event
 *  - Key reuse with different body → 409 (RFC 7807)
 *  - Header validation
 *
 * @jest-environment node
 */

jest.mock('../../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../../knexfile')['test'];
  const sharedConfig = {
    ...config,
    connection: { filename: 'file:adminindexer?mode=memory&cache=shared' },
    pool: { min: 2, max: 2, idleTimeoutMillis: 50 },
  };
  return knex(sharedConfig);
});

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const db = require('../../src/db/knex');
const adminIndexerRouter = require('../../src/routes/adminIndexer');
const { errorHandler } = require('../../src/middleware/errorHandler');
const { problemJsonHandler } = require('../../src/middleware/problemJson');

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

function createAuthToken(payload = { sub: 'test-admin', role: 'admin', tenantId: 'tnt_test' }) {
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
}

function validKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

function validBody(overrides = {}) {
  return {
    eventId: `evt_${crypto.randomBytes(4).toString('hex')}`,
    invoiceId: 'inv_123',
    eventType: 'funded',
    ledgerSequence: 1000,
    ...overrides,
  };
}

function fingerprintOf(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

function buildApp() {
  const app = express();
  app.use(express.json());
  
  // Provide req.id for problemJson tracking
  app.use((req, res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });

  app.use('/api/admin/indexer', adminIndexerRouter);
  
  app.use(problemJsonHandler);
  app.use(errorHandler);
  return app;
}

let app;

beforeAll(async () => {
  await db.schema.createTable('idempotency_keys', (t) => {
    t.increments('id').primary();
    t.string('idempotency_key', 128).notNullable().unique();
    t.string('request_fingerprint', 64).notNullable();
    t.integer('response_status').nullable();
    t.text('response_body').nullable();
    t.timestamp('created_at').defaultTo(db.fn.now());
    t.timestamp('updated_at').defaultTo(db.fn.now());
    t.timestamp('expires_at').notNullable();
  });

  await db.schema.createTable('escrow_events', (t) => {
    t.string('event_id').primary();
    t.string('invoice_id');
    t.string('event_type');
    t.integer('ledger_sequence');
    t.string('paging_token').nullable();
    t.string('contract_id').nullable();
    t.string('tx_hash').nullable();
    t.text('event_body');
    t.timestamp('observed_at');
  });

  await db.schema.createTable('escrow_event_projection', (t) => {
    t.string('invoice_id').primary();
    t.string('latest_event_id');
    t.string('latest_event_type');
    t.integer('latest_ledger_sequence');
    t.string('latest_paging_token').nullable();
    t.text('latest_event_body');
    t.timestamp('latest_observed_at');
    t.timestamp('updated_at');
  });

  app = buildApp();
});

beforeEach(async () => {
  await db('idempotency_keys').del();
  await db('escrow_events').del();
  await db('escrow_event_projection').del();
  delete process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS;
});

afterAll(async () => {
  await db.destroy();
});

const getHeaders = (key) => ({
  Authorization: `Bearer ${createAuthToken()}`,
  'Idempotency-Key': key || validKey(),
});

describe('Indexer Write Idempotency — First request stores fingerprint + response', () => {
  it('executes the handler and returns 201 on the first call', async () => {
    const key = validKey();
    const body = validBody();
    const res = await request(app)
      .post('/api/admin/indexer/events')
      .set(getHeaders(key))
      .send(body);
      
    if (res.status !== 201) {
      console.log('FIRST TEST 400 BODY:', res.body);
    }
    
    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/persisted successfully/i);
    expect(res.body.event.eventId).toBe(body.eventId);
  });

  it('persists exactly one row in idempotency_keys on first call', async () => {
    const key = validKey();
    await request(app)
      .post('/api/admin/indexer/events')
      .set(getHeaders(key))
      .send(validBody())
      .expect(201);
      
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('stores the SHA-256 request fingerprint', async () => {
    const key = validKey();
    const body = validBody();
    await request(app)
      .post('/api/admin/indexer/events')
      .set(getHeaders(key))
      .send(body)
      .expect(201);
      
    const row = await db('idempotency_keys').first();
    expect(row.request_fingerprint).toBe(fingerprintOf(body));
  });

  it('persists the event in escrow_events', async () => {
    const key = validKey();
    const body = validBody();
    await request(app)
      .post('/api/admin/indexer/events')
      .set(getHeaders(key))
      .send(body)
      .expect(201);
      
    const row = await db('escrow_events').first();
    expect(row.event_id).toBe(body.eventId);
  });
});

describe('Indexer Write Idempotency — Replay (same key + same body)', () => {
  it('returns the same response on duplicate (no double-processing)', async () => {
    const key = validKey();
    const body = validBody();
    const headers = getHeaders(key);
    
    const r1 = await request(app)
      .post('/api/admin/indexer/events')
      .set(headers)
      .send(body)
      .expect(201);
      
    const r2 = await request(app)
      .post('/api/admin/indexer/events')
      .set(headers)
      .send(body)
      .expect(201);
      
    expect(r2.body).toEqual(r1.body);
  });
});

describe('Indexer Write Idempotency — Conflict (same key + different body)', () => {
  it('returns 409 with application/problem+json', async () => {
    const key = validKey();
    const headers = getHeaders(key);
    
    await request(app)
      .post('/api/admin/indexer/events')
      .set(headers)
      .send(validBody({ eventId: 'evt_A' }))
      .expect(201);
      
    const res = await request(app)
      .post('/api/admin/indexer/events')
      .set(headers)
      .send(validBody({ eventId: 'evt_B' }))
      .expect(409);
      
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
  });
});

describe('Indexer Write Idempotency — Validation errors', () => {
  it('returns 400 for missing Idempotency-Key header', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events')
      .set({ Authorization: `Bearer ${createAuthToken()}` })
      .send(validBody());
      
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header is required/i);
  });

  it('returns 400 for invalid event payload', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events')
      .set(getHeaders(validKey()))
      .send(validBody({ ledgerSequence: 'not-a-number' }))
      
    expect(res.status).toBe(400);
    // The ValidationError handler we added in adminIndexer.js returns RFC 7807 problemJson format
    // because responseHelper.error('...', 'VALIDATION_ERROR') makes problemJson output that.
  });
});
