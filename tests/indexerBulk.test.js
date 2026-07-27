'use strict';

/**
 * @fileoverview Tests for the bulk indexer events endpoint (#22).
 *
 * Covers:
 *  - Service layer: validateBulkPayload, bulkIndexerEvents
 *  - Route: POST /api/admin/indexer/events/bulk
 *  - Edge cases: empty batch, over-cap rejected, partial failure, auth guard
 */

const VALID_EVENT = {
  eventId: 'evt_001',
  invoiceId: 'INV-100',
  eventType: 'escrow_created',
  ledgerSequence: 100,
};

function makeValidEvent(overrides = {}) {
  return { ...VALID_EVENT, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: validateBulkPayload unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('validateBulkPayload()', () => {
  let validateBulkPayload;

  beforeAll(() => {
    ({ validateBulkPayload } = require('../src/services/indexerService'));
  });

  test('rejects non-array body', () => {
    const result = validateBulkPayload({ not: 'array' });
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects null body', () => {
    const result = validateBulkPayload(null);
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(400);
  });

  test('rejects string body', () => {
    const result = validateBulkPayload('hello');
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(400);
  });

  test('rejects empty array', () => {
    const result = validateBulkPayload([]);
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects batch exceeding MAX_BULK_BATCH_SIZE (50)', () => {
    const oversized = Array.from({ length: 51 }, (_, i) => makeValidEvent({ eventId: `evt_${i}` }));
    const result = validateBulkPayload(oversized);
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(413);
    expect(result.error.code).toBe('BATCH_TOO_LARGE');
    expect(result.error.details.maxBatchSize).toBe(50);
    expect(result.error.details.received).toBe(51);
  });

  test('accepts batch at exact cap (50)', () => {
    const atCap = Array.from({ length: 50 }, (_, i) => makeValidEvent({ eventId: `evt_${i}` }));
    const result = validateBulkPayload(atCap);
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(50);
  });

  test('rejects array with a non-object item', () => {
    const result = validateBulkPayload([makeValidEvent(), 'not-an-object']);
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.details).toHaveProperty(['items[1]']);
  });

  test('rejects array with null item', () => {
    const result = validateBulkPayload([makeValidEvent(), null]);
    expect(result.ok).toBe(false);
    expect(result.error.status).toBe(400);
  });

  test('accepts single valid event', () => {
    const result = validateBulkPayload([makeValidEvent()]);
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: bulkIndexerEvents service unit tests
// Uses an in-memory Knex fake — no real DB required.
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkIndexerEvents()', () => {
  let bulkIndexerEvents;

  beforeAll(() => {
    ({ bulkIndexerEvents } = require('../src/services/indexerService'));
  });

  function makeFakeKnex() {
    const inserted = [];
    const q = {
      insert: jest.fn(function (row) { inserted.push(row); return q; }),
      onConflict: jest.fn(() => q),
      merge: jest.fn(function () { return Promise.resolve(); }),
    };
    q.onConflict.mockReturnValue(q);

    const knex = jest.fn(() => q);
    knex.inserted = inserted;
    knex._q = q;
    return knex;
  }

  test('persists a single valid event and returns success', async () => {
    const knex = makeFakeKnex();
    const result = await bulkIndexerEvents({ events: [makeValidEvent()], dbClient: knex });

    expect(result.meta.total).toBe(1);
    expect(result.meta.succeeded).toBe(1);
    expect(result.meta.failed).toBe(0);
    expect(result.data[0].success).toBe(true);
    expect(result.data[0].eventId).toBe('evt_001');
  });

  test('returns per-item error for invalid event without aborting batch', async () => {
    const knex = makeFakeKnex();
    const events = [
      makeValidEvent(),
      { eventId: '', invoiceId: 'INV-100', eventType: 'escrow_created', ledgerSequence: 100 },
    ];
    const result = await bulkIndexerEvents({ events, dbClient: knex });

    expect(result.meta.total).toBe(2);
    expect(result.meta.succeeded).toBe(1);
    expect(result.meta.failed).toBe(1);
    expect(result.data[0].success).toBe(true);
    expect(result.data[1].success).toBe(false);
    expect(result.data[1].error.code).toBe('VALIDATION_ERROR');
  });

  test('all items fail when all are invalid', async () => {
    const knex = makeFakeKnex();
    const events = [
      { notAnEvent: true },
      { eventId: 'x' },
    ];
    const result = await bulkIndexerEvents({ events, dbClient: knex });

    expect(result.meta.succeeded).toBe(0);
    expect(result.meta.failed).toBe(2);
    expect(result.data.every((r) => r.success === false)).toBe(true);
  });

  test('catches DB errors and returns PERSIST_ERROR without aborting', async () => {
    const knex = makeFakeKnex();
    knex._q.merge.mockRejectedValueOnce(new Error('disk full'));
    const events = [makeValidEvent(), makeValidEvent({ eventId: 'evt_002' })];
    const result = await bulkIndexerEvents({ events, dbClient: knex });

    expect(result.meta.succeeded).toBe(1);
    expect(result.meta.failed).toBe(1);
    expect(result.data[0].success).toBe(false);
    expect(result.data[0].error.code).toBe('PERSIST_ERROR');
    expect(result.data[1].success).toBe(true);
  });

  test('normalizes field names from camelCase to snake_case on insert', async () => {
    const knex = makeFakeKnex();
    await bulkIndexerEvents({ events: [makeValidEvent()], dbClient: knex });

    const inserted = knex.inserted[0];
    expect(inserted.event_id).toBe('evt_001');
    expect(inserted.invoice_id).toBe('INV-100');
    expect(inserted.event_type).toBe('escrow_created');
    expect(inserted.ledger_sequence).toBe(100);
  });

  test('applies defaults for optional fields', async () => {
    const knex = makeFakeKnex();
    await bulkIndexerEvents({ events: [makeValidEvent()], dbClient: knex });

    const inserted = knex.inserted[0];
    expect(inserted.paging_token).toBeNull();
    expect(inserted.contract_id).toBeNull();
    expect(inserted.tx_hash).toBeNull();
    expect(inserted.observed_at).toBeTruthy();
  });

  test('preserves contractId and txHash when provided', async () => {
    const knex = makeFakeKnex();
    const event = makeValidEvent({
      contractId: 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI',
      txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    await bulkIndexerEvents({ events: [event], dbClient: knex });

    const inserted = knex.inserted[0];
    expect(inserted.contract_id).toBe('CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI');
    expect(inserted.tx_hash).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  test('serializes eventBody as JSON string', async () => {
    const knex = makeFakeKnex();
    const event = makeValidEvent({ eventBody: { foo: 'bar' } });
    await bulkIndexerEvents({ events: [event], dbClient: knex });

    const inserted = knex.inserted[0];
    expect(inserted.event_body).toBe('{"foo":"bar"}');
  });

  test('empty events array returns zero totals', async () => {
    const knex = makeFakeKnex();
    const result = await bulkIndexerEvents({ events: [], dbClient: knex });

    expect(result.meta.total).toBe(0);
    expect(result.meta.succeeded).toBe(0);
    expect(result.meta.failed).toBe(0);
    expect(result.data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: Route integration tests (POST /api/admin/indexer/events/bulk)
// Uses supertest with a top-level jest.mock on the db so no real DB is hit.
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => {
  const q = {
    insert: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    merge: jest.fn().mockResolvedValue(undefined),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ total: 0, 'count(*)': 0 }),
    then: jest.fn(function (resolve) {
      return Promise.resolve([]).then(resolve);
    }),
  };
  const mockDb = jest.fn(() => q);
  mockDb._q = q;
  return mockDb;
});

describe('POST /api/admin/indexer/events/bulk route', () => {
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const { createApp } = require('../src/app');
  const db = require('../src/db/knex');

  const SECRET = process.env.JWT_SECRET;
  const ISS = process.env.JWT_ISSUER || 'liquifact';
  const AUD = process.env.JWT_AUDIENCE || 'liquifact-api';

  function makeAdminToken(tenantId = 'tenant-test') {
    return jwt.sign(
      { sub: 'admin-user', tenantId, role: 'admin' },
      SECRET,
      { algorithm: 'HS256', issuer: ISS, audience: AUD },
    );
  }

  let app;
  let mockQ;
  const adminToken = makeAdminToken();

  beforeAll(() => {
    app = createApp();
    mockQ = db._q;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockQ.insert.mockReturnThis();
    mockQ.onConflict.mockReturnThis();
    mockQ.merge.mockResolvedValue(undefined);
  });

  test('401 when no Authorization header', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  test('401 for invalid Bearer token', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', 'Bearer not.a.valid.jwt')
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  test('400 when body is not an array', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send({ not: 'array' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/array/i);
  });

  test('400 when body is an empty array', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send([]);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at least one/i);
  });

  test('413 when batch exceeds max size (50)', async () => {
    const oversized = Array.from({ length: 51 }, (_, i) => makeValidEvent({ eventId: `evt_${i}` }));
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BATCH_TOO_LARGE');
  });

  test('400 when array contains a non-object item', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send([makeValidEvent(), 'bad-item']);
    expect(res.status).toBe(400);
  });

  test('200 with all items valid', async () => {
    const events = [
      makeValidEvent({ eventId: 'evt_1' }),
      makeValidEvent({ eventId: 'evt_2' }),
    ];
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send(events);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((r) => r.success === true)).toBe(true);
    expect(res.body.meta.succeeded).toBe(2);
    expect(res.body.meta.failed).toBe(0);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.message).toBe('Bulk indexer events processed.');
  });

  test('200 with single valid event', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send([makeValidEvent()]);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].success).toBe(true);
  });

  test('207 when some items fail validation', async () => {
    const events = [
      makeValidEvent({ eventId: 'evt_ok' }),
      { invoiceId: 'INV-BAD', eventType: 'x', ledgerSequence: 1 },
    ];
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send(events);

    expect(res.status).toBe(207);
    expect(res.body.meta.succeeded).toBe(1);
    expect(res.body.meta.failed).toBe(1);
    expect(res.body.data[0].success).toBe(true);
    expect(res.body.data[1].success).toBe(false);
  });

  test('207 when DB write fails for some items', async () => {
    mockQ.merge.mockRejectedValueOnce(new Error('constraint violation'));

    const events = [
      makeValidEvent({ eventId: 'evt_ok' }),
      makeValidEvent({ eventId: 'evt_db_fail' }),
    ];
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send(events);

    expect(res.status).toBe(207);
    expect(res.body.meta.succeeded).toBe(1);
    expect(res.body.meta.failed).toBe(1);
    expect(res.body.data[0].success).toBe(false);
    expect(res.body.data[0].error.code).toBe('PERSIST_ERROR');
    expect(res.body.data[1].success).toBe(true);
  });

  test('207 when all items fail validation', async () => {
    const events = [
      { not: 'valid' },
      { also: 'invalid' },
    ];
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send(events);

    expect(res.status).toBe(207);
    expect(res.body.meta.succeeded).toBe(0);
    expect(res.body.meta.failed).toBe(2);
  });

  test('response includes data, meta, error, and message fields', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send([makeValidEvent()]);

    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('message');
    expect(res.body.error).toBeNull();
  });

  test('per-item result includes index, success, and eventId', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send([makeValidEvent({ eventId: 'evt_shape' })]);

    const item = res.body.data[0];
    expect(item).toHaveProperty('index', 0);
    expect(item).toHaveProperty('success', true);
    expect(item).toHaveProperty('eventId', 'evt_shape');
  });

  test('per-item error result includes index, success, and error', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send([{ bad: true }]);

    const item = res.body.data[0];
    expect(item).toHaveProperty('index', 0);
    expect(item).toHaveProperty('success', false);
    expect(item).toHaveProperty('error');
    expect(item.error).toHaveProperty('code');
  });

  test('200 with exactly 50 events (at cap)', async () => {
    const atCap = Array.from({ length: 50 }, (_, i) => makeValidEvent({ eventId: `evt_${i}` }));
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .send(atCap);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(50);
    expect(res.body.meta.succeeded).toBe(50);
  });
});
