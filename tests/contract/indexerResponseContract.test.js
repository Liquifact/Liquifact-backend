'use strict';

/**
 * @fileoverview Contract tests for indexer API response shapes.
 *
 * Validates that all indexer endpoint responses match their documented schema:
 * - Exact fields and types (no unexpected extra fields, no missing required fields)
 * - Required vs. optional fields
 * - Success and error response envelopes
 * - Pagination modes (cursor and offset)
 * - Bulk response shapes
 *
 * Cross-reference: docs/indexer.md · src/routes/adminIndexer.js
 * · src/services/indexerService.js · src/utils/responseHelper.js
 */

const express = require('express');
const jwt = require('jsonwebtoken');

// Mock db/knex BEFORE any module that depends on it is loaded.
// This mock supports both the listing query chain and the bulk insert chain.
jest.mock('../../src/db/knex', () => {
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
    clone: jest.fn().mockReturnThis(),
    modify: jest.fn().mockReturnThis(),
  };
  const mockDb = jest.fn(() => q);
  mockDb._q = q;
  return mockDb;
});

// Mock the admin auth stack so HTTP tests don't need real auth headers.
const noopAdminMw = (req, _res, next) => {
  req.user = { sub: 'admin-user', role: 'admin', tenantId: 'tenant-test' };
  req.tenantId = 'tenant-test';
  next();
};
jest.mock('../../src/middleware/stacks', () => ({
  adminStack: [noopAdminMw],
  authenticatedTenantStack: [noopAdminMw],
}));
// Bypass indexer metrics instrumentation which depends on prom-client.
jest.mock('../../src/middleware/indexerMetrics', () => ({
  instrumentIndexer: (handler) => handler,
}));
// Mock indexer cache so it doesn't try to load prometheus metrics or cache config.
jest.mock('../../src/services/indexerCache', () => {
  const mockCache = {
    get: jest.fn(() => undefined),
    set: jest.fn(),
    invalidateAll: jest.fn(),
  };
  const IndexerCacheMock = {
    buildKey: jest.fn(() => 'test-cache-key'),
  };
  return { IndexerCache: IndexerCacheMock, indexerCache: mockCache };
});

const responseHelper = require('../../src/utils/responseHelper');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assertShape(actual, expectedShape) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expectedShape).sort();

  expect(actualKeys).toEqual(expectedKeys);

  for (const [key, validator] of Object.entries(expectedShape)) {
    if (typeof validator === 'function') {
      validator(actual[key], key);
    } else if (validator === 'null') {
      expect(actual[key]).toBeNull();
    } else if (validator === 'any') {
      // key must exist — type unchecked
    } else {
      expect(typeof actual[key]).toBe(validator);
    }
  }
}

function iso8601Matcher() {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
}

function makeEvent(overrides = {}) {
  const id = overrides.event_id || `evt_${Math.random().toString(36).slice(2)}`;
  return {
    event_id: id,
    invoice_id: 'inv_001',
    event_type: 'escrow_created',
    ledger_sequence: 100,
    paging_token: '100-1',
    contract_id: null,
    tx_hash: null,
    observed_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:01Z'),
    ...overrides,
  };
}

function makeValidBulkEvent(overrides = {}) {
  return {
    eventId: 'evt_001',
    invoiceId: 'INV-100',
    eventType: 'escrow_created',
    ledgerSequence: 100,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. responseHelper.success() contract
// ─────────────────────────────────────────────────────────────────────────────

describe('responseHelper.success() contract', () => {
  const SUCCESS_ENVELOPE_KEYS = ['data', 'error', 'meta'];

  test('returns exactly data, meta, error fields at the top level', () => {
    const result = responseHelper.success([], { total: 0 });
    expect(Object.keys(result).sort()).toEqual(SUCCESS_ENVELOPE_KEYS);
  });

  test('data is the provided payload', () => {
    const payload = [{ id: 1 }];
    const result = responseHelper.success(payload, {});
    expect(result.data).toBe(payload);
  });

  test('meta contains passthrough fields plus timestamp and version', () => {
    const result = responseHelper.success(null, { total: 42, limit: 20 });

    expect(result.meta.total).toBe(42);
    expect(result.meta.limit).toBe(20);
    expect(result.meta.timestamp).toEqual(expect.stringMatching(iso8601Matcher()));
    expect(result.meta.version).toBe('0.1.0');
  });

  test('meta has exactly the passthrough keys plus timestamp and version — no extras', () => {
    const result = responseHelper.success(null, { total: 1, limit: 20, hasMore: false, nextCursor: null });

    const metaKeys = Object.keys(result.meta).sort();
    expect(metaKeys).toEqual(['hasMore', 'limit', 'nextCursor', 'timestamp', 'total', 'version']);
  });

  test('error is always null', () => {
    const result = responseHelper.success([], {});
    expect(result.error).toBeNull();
  });

  test('meta does not include message (message is route-level, not helper-level)', () => {
    const result = responseHelper.success([], {});
    expect(result).not.toHaveProperty('message');
  });

  test('meta preserves page and totalPages when provided (offset mode)', () => {
    const result = responseHelper.success(null, {
      total: 100, page: 2, limit: 10, totalPages: 10,
      hasMore: true, nextCursor: null,
    });

    expect(result.meta.page).toBe(2);
    expect(result.meta.totalPages).toBe(10);
    const expectedKeys = ['hasMore', 'limit', 'nextCursor', 'page', 'timestamp', 'total', 'totalPages', 'version'];
    expect(Object.keys(result.meta).sort()).toEqual(expectedKeys);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. responseHelper.error() contract
// ─────────────────────────────────────────────────────────────────────────────

describe('responseHelper.error() contract', () => {
  const ERROR_ENVELOPE_KEYS = ['data', 'error', 'meta'];

  test('returns exactly data, meta, error fields at the top level', () => {
    const result = responseHelper.error('Something went wrong.', 'SOME_ERROR');
    expect(Object.keys(result).sort()).toEqual(ERROR_ENVELOPE_KEYS);
  });

  test('data is always null', () => {
    const result = responseHelper.error('fail', 'ERR');
    expect(result.data).toBeNull();
  });

  test('meta contains timestamp and version', () => {
    const result = responseHelper.error('fail', 'ERR');
    expect(result.meta.timestamp).toEqual(expect.stringMatching(iso8601Matcher()));
    expect(result.meta.version).toBe('0.1.0');
  });

  test('meta has exactly timestamp and version — no extras', () => {
    const result = responseHelper.error('fail', 'ERR');
    expect(Object.keys(result.meta).sort()).toEqual(['timestamp', 'version']);
  });

  test('meta does not include pagination fields (error has no pagination)', () => {
    const result = responseHelper.error('fail', 'ERR');
    expect(result.meta).not.toHaveProperty('total');
    expect(result.meta).not.toHaveProperty('limit');
  });

  test('error object contains message, code, and details', () => {
    const result = responseHelper.error('Validation failed.', 'VALIDATION_ERROR', { field: 'bad' });

    expect(result.error.message).toBe('Validation failed.');
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.details).toEqual({ field: 'bad' });
  });

  test('error.details defaults to null when not provided', () => {
    const result = responseHelper.error('fail', 'ERR');
    expect(result.error.details).toBeNull();
  });

  test('error.code defaults to INTERNAL_ERROR when not provided', () => {
    const result = responseHelper.error('fail');
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  test('error object has exactly message, code, details — no extras', () => {
    const result = responseHelper.error('fail', 'ERR', { x: 1 });
    expect(Object.keys(result.error).sort()).toEqual(['code', 'details', 'message']);
  });

  test('does not include message at the top level (message is route-level)', () => {
    const result = responseHelper.error('fail', 'ERR');
    expect(result).not.toHaveProperty('message');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Parser / mapper contract — mapServiceResultToResponseDTO output shape
// ─────────────────────────────────────────────────────────────────────────────

describe('DTO response shape contract', () => {
  const {
    mapRowToEscrowEventDTO,
    mapMetaToDTO,
    mapServiceResultToResponseDTO,
  } = require('../../src/dto/indexer');

  describe('EscrowEventRowDTO shape', () => {
    test('has exactly the documented camelCase fields', () => {
      const row = makeEvent();
      const dto = mapRowToEscrowEventDTO(row);

      expect(Object.keys(dto).sort()).toEqual([
        'contractId', 'createdAt', 'eventId', 'eventType',
        'invoiceId', 'ledgerSequence', 'observedAt', 'pagingToken', 'txHash',
      ]);
    });

    test('each field has the correct type', () => {
      const row = makeEvent();
      const dto = mapRowToEscrowEventDTO(row);

      assertShape(dto, {
        eventId: 'string',
        invoiceId: 'string',
        eventType: 'string',
        ledgerSequence: 'number',
        pagingToken: 'string',
        contractId: 'null',
        txHash: 'null',
        observedAt: val => expect(val).toEqual(expect.stringMatching(iso8601Matcher())),
        createdAt: val => expect(val).toEqual(expect.stringMatching(iso8601Matcher())),
      });
    });

    test('nullable fields are null when source is null', () => {
      const row = makeEvent({ paging_token: null, contract_id: null, tx_hash: null });
      const dto = mapRowToEscrowEventDTO(row);
      expect(dto.pagingToken).toBeNull();
      expect(dto.contractId).toBeNull();
      expect(dto.txHash).toBeNull();
    });

    test('nullable fields are string when source is present', () => {
      const row = makeEvent({
        paging_token: '500-1',
        contract_id: 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI',
        tx_hash: 'abc',
      });
      const dto = mapRowToEscrowEventDTO(row);
      expect(typeof dto.pagingToken).toBe('string');
      expect(typeof dto.contractId).toBe('string');
      expect(typeof dto.txHash).toBe('string');
    });
  });

  describe('IndexerEventsMetaDTO shape', () => {
    test('cursor-mode meta has exact fields', () => {
      const meta = mapMetaToDTO({ total: 42, limit: 20, hasMore: true, nextCursor: 'tok' });
      expect(Object.keys(meta).sort()).toEqual(['hasMore', 'limit', 'nextCursor', 'total']);
    });

    test('offset-mode meta includes page and totalPages', () => {
      const meta = mapMetaToDTO({ total: 100, limit: 10, hasMore: true, nextCursor: null, page: 2, totalPages: 10 });
      expect(Object.keys(meta).sort()).toEqual(['hasMore', 'limit', 'nextCursor', 'page', 'total', 'totalPages']);
    });

    test('nextCursor is null when absent in source', () => {
      const meta = mapMetaToDTO({ total: 0, limit: 20, hasMore: false });
      expect(meta.nextCursor).toBeNull();
    });
  });

  describe('IndexerEventsResponseDTO shape', () => {
    test('full response has exactly data and meta', () => {
      const dto = mapServiceResultToResponseDTO({
        data: [],
        meta: { total: 0, limit: 20, hasMore: false, nextCursor: null },
      });
      expect(Object.keys(dto).sort()).toEqual(['data', 'meta']);
    });

    test('data items are mapped through EscrowEventRowDTO', () => {
      const dto = mapServiceResultToResponseDTO({
        data: [makeEvent({ event_id: 'r1' })],
        meta: { total: 1, limit: 20, hasMore: false, nextCursor: null },
      });
      expect(dto.data[0]).toHaveProperty('eventId', 'r1');
      expect(Object.keys(dto.data[0]).sort()).toEqual([
        'contractId', 'createdAt', 'eventId', 'eventType',
        'invoiceId', 'ledgerSequence', 'observedAt', 'pagingToken', 'txHash',
      ]);
    });

    test('does not include error, message, or meta.timestamp — those are added by responseHelper', () => {
      const dto = mapServiceResultToResponseDTO({
        data: [],
        meta: { total: 0, limit: 20, hasMore: false, nextCursor: null },
      });
      expect(dto).not.toHaveProperty('error');
      expect(dto).not.toHaveProperty('message');
      expect(dto.meta).not.toHaveProperty('timestamp');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Full HTTP response shape contract (via supertest with mock DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('Indexer HTTP response shape contract', () => {
  const request = require('supertest');

  const adminIndexerRoutes = require('../../src/routes/adminIndexer');
  const db = require('../../src/db/knex');

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

  /**
   * Build a minimal Express app that mounts only the admin indexer routes
   * with the standard (already-mocked) dependencies.
   */
  function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.id = 'test-request-id';
      next();
    });

    // Bypass auth middleware by injecting req.user directly for all
    // admin-indexer requests.  This lets us test the response shapes
    // without needing the full auth middleware stack.
    app.use('/api/admin/indexer', (req, res, next) => {
      req.user = { sub: 'admin-user', role: 'admin', tenantId: 'tenant-test' };
      req.tenantId = 'tenant-test';
      next();
    });

    app.use('/api/admin/indexer', adminIndexerRoutes);
    return app;
  }

  beforeAll(() => {
    mockQ = db._q;
    app = buildTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockQ.first.mockResolvedValue({ total: 0, 'count(*)': 0 });
    mockQ.then.mockImplementation(function (resolve) {
      return Promise.resolve([]).then(resolve);
    });
    mockQ.insert.mockReturnThis();
    mockQ.onConflict.mockReturnThis();
    mockQ.merge.mockResolvedValue(undefined);
  });

  // ── 4a. GET /events success response shape ──────────────────────────────

  describe('GET /api/admin/indexer/events — success response', () => {
    test('top-level envelope has exactly data, meta, error, message — no extra fields', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events');

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'message', 'meta']);
    });

    test('data is an array', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('each data row has the exact documented snake_case fields with correct types', async () => {
      const rows = [makeEvent({ event_id: 'e1' })];
      mockQ.first.mockResolvedValue({ total: 1, 'count(*)': 1 });
      mockQ.then.mockImplementation(function (resolve) {
        return Promise.resolve(rows).then(resolve);
      });

      const res = await request(app)
        .get('/api/admin/indexer/events');

      expect(res.body.data).toHaveLength(1);
      const row = res.body.data[0];

      assertShape(row, {
        event_id: 'string',
        invoice_id: 'string',
        event_type: 'string',
        ledger_sequence: 'number',
        paging_token: val => expect(val).toEqual(expect.any(String)),
        contract_id: 'null',
        tx_hash: 'null',
        observed_at: val => expect(val).toEqual(expect.stringMatching(iso8601Matcher())),
        created_at: val => expect(val).toEqual(expect.stringMatching(iso8601Matcher())),
      });
    });

    test('data row paging_token is string when present, null when absent', async () => {
      const withToken = makeEvent({ event_id: 'e1', paging_token: '200-1' });
      const withoutToken = makeEvent({ event_id: 'e2', paging_token: null });

      mockQ.first.mockResolvedValue({ total: 2, 'count(*)': 2 });
      mockQ.then.mockImplementation(function (resolve) {
        return Promise.resolve([withToken, withoutToken]).then(resolve);
      });

      const res = await request(app)
        .get('/api/admin/indexer/events');

      expect(typeof res.body.data[0].paging_token).toBe('string');
      expect(res.body.data[1].paging_token).toBeNull();
    });

    test('data row does not include event_body', async () => {
      const rows = [makeEvent({ event_id: 'e1' })];
      mockQ.first.mockResolvedValue({ total: 1, 'count(*)': 1 });
      mockQ.then.mockImplementation(function (resolve) {
        return Promise.resolve(rows).then(resolve);
      });

      const res = await request(app)
        .get('/api/admin/indexer/events');
      expect(res.body.data[0]).not.toHaveProperty('event_body');
    });

    test('meta has the documented cursor-mode fields with correct types', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events');

      assertShape(res.body.meta, {
        total: 'number',
        limit: 'number',
        hasMore: 'boolean',
        nextCursor: 'null',
        page: 'number',
        totalPages: 'number',
        timestamp: val => expect(val).toEqual(expect.stringMatching(iso8601Matcher())),
        version: 'string',
      });
    });

    test('error is null', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events');
      expect(res.body.error).toBeNull();
    });

    test('message is present and matches documented text', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events');
      expect(res.body.message).toBe('Indexer events retrieved successfully.');
    });

    test('nextCursor is non-null string when hasMore is true', async () => {
      const rows = Array.from({ length: 25 }, (_, i) =>
        makeEvent({ event_id: `e${i}`, observed_at: new Date(2026, 0, i + 1) })
      );
      mockQ.first.mockResolvedValue({ total: 25, 'count(*)': 25 });
      mockQ.then.mockImplementation(function (resolve) {
        return Promise.resolve(rows.slice(0, 21)).then(resolve);
      });

      const res = await request(app)
        .get('/api/admin/indexer/events?limit=20');

      expect(res.body.meta.hasMore).toBe(true);
      expect(typeof res.body.meta.nextCursor).toBe('string');
      expect(res.body.meta.nextCursor.length).toBeGreaterThan(0);
    });
  });

  // ── 4b. GET /events offset-mode meta shape ──────────────────────────────

  describe('GET /api/admin/indexer/events — offset-mode meta', () => {
    test('meta includes page and totalPages in offset mode', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => makeEvent({ event_id: `e${i}` }));
      mockQ.first.mockResolvedValue({ total: 10, 'count(*)': 10 });
      mockQ.then.mockImplementation(function (resolve) {
        return Promise.resolve(rows).then(resolve);
      });

      const res = await request(app)
        .get('/api/admin/indexer/events?page=1&limit=5');

      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.totalPages).toBe(2);
    });

    test('offset-mode meta has exactly the documented keys', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => makeEvent({ event_id: `e${i}` }));
      mockQ.first.mockResolvedValue({ total: 3, 'count(*)': 3 });
      mockQ.then.mockImplementation(function (resolve) {
        return Promise.resolve(rows).then(resolve);
      });

      const res = await request(app)
        .get('/api/admin/indexer/events?page=1&limit=2');

      expect(Object.keys(res.body.meta).sort()).toEqual(
        ['hasMore', 'limit', 'nextCursor', 'page', 'timestamp', 'total', 'totalPages', 'version'],
      );
    });

    test('page and totalPages have defaults (1) when no page param is sent', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events');
      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.totalPages).toBe(0); // 0 total / 20 limit = 0
    });
  });

  // ── 4c. GET /events validation error response shape ─────────────────────

  describe('GET /api/admin/indexer/events — validation error response', () => {
    test('top-level envelope has exactly data, meta, error — no message field', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events?limit=9999');

      expect(res.status).toBe(400);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta']);
    });

    test('data is null in error response', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events?limit=-1');
      expect(res.body.data).toBeNull();
    });

    test('meta contains exactly timestamp and version — no pagination fields', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events?sortBy=invalid');
      expect(Object.keys(res.body.meta).sort()).toEqual(['timestamp', 'version']);
    });

    test('error has message, code, and details with correct types', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events?invoiceId=bad%20space');

      assertShape(res.body.error, {
        message: 'string',
        code: 'string',
        details: 'object',
      });
    });

    test('error.code is VALIDATION_ERROR for query param issues', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events?limit=9999');
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('error.details contains the specific invalid field key', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events?sortBy=badfield');
      expect(res.body.error.details).toHaveProperty('sortBy');
    });

    test('error object has exactly message, code, details — no extra fields', async () => {
      const res = await request(app)
        .get('/api/admin/indexer/events?limit=9999');
      expect(Object.keys(res.body.error).sort()).toEqual(['code', 'details', 'message']);
    });
  });

  // ── 4d. POST /events/bulk success response shape ────────────────────────

  describe('POST /api/admin/indexer/events/bulk — success response', () => {
    test('top-level envelope has exactly data, meta, error, message', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent()]);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'message', 'meta']);
    });

    test('data is an array of per-item results', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent()]);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    test('success item has exactly fields: index, success, eventId — no extras', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent({ eventId: 'evt_001' })]);

      expect(Object.keys(res.body.data[0]).sort()).toEqual(['eventId', 'index', 'success']);
    });

    test('success item has correct types', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent({ eventId: 'evt_001' })]);

      assertShape(res.body.data[0], {
        index: 'number',
        success: 'boolean',
        eventId: 'string',
      });
    });

    test('meta has succeeded, failed, total, timestamp, version — no extras', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent()]);

      expect(Object.keys(res.body.meta).sort()).toEqual(
        ['failed', 'succeeded', 'timestamp', 'total', 'version'],
      );
    });

    test('meta has correct types', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent()]);

      assertShape(res.body.meta, {
        succeeded: 'number',
        failed: 'number',
        total: 'number',
        timestamp: val => expect(val).toEqual(expect.stringMatching(iso8601Matcher())),
        version: 'string',
      });
    });

    test('message is present', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent()]);
      expect(res.body.message).toBe('Bulk indexer events processed.');
    });

    test('error is null', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([makeValidBulkEvent()]);
      expect(res.body.error).toBeNull();
    });
  });

  // ── 4e. POST /events/bulk partial failure response shape ────────────────

  describe('POST /api/admin/indexer/events/bulk — partial failure (207)', () => {
    test('response includes both success and failure items', async () => {
      const events = [
        makeValidBulkEvent({ eventId: 'evt_ok' }),
        { invoiceId: 'INV-BAD', eventType: 'x', ledgerSequence: 1 },
      ];

      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send(events);

      expect(res.status).toBe(207);
      expect(res.body.data).toHaveLength(2);
    });

    test('failed item has exactly index, success, error — no extras', async () => {
      const events = [
        makeValidBulkEvent({ eventId: 'evt_ok' }),
        { invoiceId: 'INV-BAD', eventType: 'x', ledgerSequence: 1 },
      ];

      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send(events);

      const failedItem = res.body.data[1];
      expect(Object.keys(failedItem).sort()).toEqual(['error', 'index', 'success']);
    });

    test('failed item error has code, optional message and details', async () => {
      const events = [
        makeValidBulkEvent({ eventId: 'evt_ok' }),
        { invoiceId: 'INV-BAD', eventType: 'x', ledgerSequence: 1 },
      ];

      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send(events);

      const err = res.body.data[1].error;
      expect(err).toHaveProperty('code');
      expect(typeof err.code).toBe('string');
      expect(Object.keys(err).length).toBeGreaterThanOrEqual(1);
    });

    test('meta still reports correct succeeded/failed/total counts', async () => {
      const events = [
        makeValidBulkEvent({ eventId: 'evt_ok' }),
        { bad: true },
      ];

      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send(events);

      expect(res.body.meta.succeeded).toBe(1);
      expect(res.body.meta.failed).toBe(1);
      expect(res.body.meta.total).toBe(2);
    });

    test('message and error null still present in 207', async () => {
      const events = [
        makeValidBulkEvent({ eventId: 'evt_ok' }),
        { bad: true },
      ];

      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send(events);

      expect(res.body.error).toBeNull();
      expect(res.body.message).toBe('Bulk indexer events processed.');
    });
  });

  // ── 4f. POST /events/bulk validation error response shape ───────────────

  describe('POST /api/admin/indexer/events/bulk — validation error (400)', () => {
    test('top-level envelope has exactly data, meta, error — no message', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send({ not: 'array' });

      expect(res.status).toBe(400);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta']);
    });

    test('data is null', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([]);
      expect(res.body.data).toBeNull();
    });

    test('meta has timestamp and version only', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send('not-an-object');

      expect(Object.keys(res.body.meta).sort()).toEqual(['timestamp', 'version']);
    });

    test('error has message, code, and details', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send([]);

      assertShape(res.body.error, {
        message: 'string',
        code: 'string',
        details: 'object',
      });
    });

    test('413 response has same envelope shape but different code', async () => {
      const oversized = Array.from({ length: 51 }, (_, i) => makeValidBulkEvent({ eventId: `evt_${i}` }));
      const res = await request(app)
        .post('/api/admin/indexer/events/bulk')
        .send(oversized);

      expect(res.status).toBe(413);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta']);
      expect(res.body.error.code).toBe('BATCH_TOO_LARGE');
      expect(res.body.data).toBeNull();
    });
  });
});
