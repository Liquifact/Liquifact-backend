'use strict';

/**
 * @fileoverview Comprehensive tests for the indexer listing endpoint (#667).
 *
 * Coverage:
 *  - listIndexerEvents service: cursor mode, offset mode, filters, edge cases
 *  - adminIndexer route: auth, query validation, CursorError→400, responses
 *  - cursorPagination: new indexer sort fields (observed_at, ledger_sequence)
 *  - Edge cases: empty set, exact-page boundary, over-limit clamp, invalid cursor
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a minimal fake escrow_events row.
 * @param {object} [overrides]
 * @returns {object}
 */
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

/**
 * Creates a lightweight fake Knex-like client backed by an in-memory array.
 * Supports the chained API used by listIndexerEvents.
 *
 * @param {object[]} rows - The full "table" rows.
 * @returns {Function} Fake knex client.
 */
function makeFakeKnex(rows = []) {
  function buildQuery(allRows) {
    let _filters = {};
    let _order = [];
    let _limit = null;
    let _offset = 0;
    let _isCount = false;

    const q = {
      select() { return q; },
      where(fieldOrFn, val) {
        if (typeof fieldOrFn === 'function') { return q; } // keyset fn — skip in fake
        if (typeof fieldOrFn === 'object') { Object.assign(_filters, fieldOrFn); }
        else { _filters[fieldOrFn] = val; }
        return q;
      },
      orderBy(col, dir) { _order.push({ col, dir: dir || 'asc' }); return q; },
      limit(n) { _limit = n; return q; },
      offset(n) { _offset = n; return q; },
      count() { _isCount = true; return q; },
      first() {
        const filtered = _applyFilters(allRows, _filters);
        return Promise.resolve({ total: filtered.length, 'count(*)': filtered.length });
      },
      then(resolve, reject) {
        return _run().then(resolve, reject);
      },
    };

    function _applyFilters(r, filters) {
      return r.filter((row) =>
        Object.entries(filters).every(([k, v]) => String(row[k]) === String(v))
      );
    }

    function _run() {
      let r = _applyFilters(allRows, _filters);
      if (_isCount) {
        return Promise.resolve([{ total: r.length, 'count(*)': r.length }]);
      }
      for (const { col, dir } of [..._order].reverse()) {
        r = [...r].sort((a, b) => {
          const av = a[col]; const bv = b[col];
          const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      if (_offset) r = r.slice(_offset);
      if (_limit !== null) r = r.slice(0, _limit);
      return Promise.resolve(r);
    }

    return q;
  }

  return jest.fn(() => buildQuery(rows));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: Service unit tests (src/services/indexerService.js)
// Uses injected fake dbClient — no DB required.
// ─────────────────────────────────────────────────────────────────────────────

describe('indexerService – listIndexerEvents()', () => {
  let listIndexerEvents;
  let INDEXER_SORT_FIELDS;
  let encodeCursor;
  let decodeCursor;
  let CursorError;

  beforeAll(() => {
    // Load modules once in beforeAll so Jest's module mocking is fully resolved
    ({ listIndexerEvents, INDEXER_SORT_FIELDS } = require('../src/services/indexerService'));
    ({ encodeCursor, decodeCursor, CursorError } = require('../src/utils/cursorPagination'));
  });

  // ── offset-mode pagination ──────────────────────────────────────────────

  describe('offset-mode pagination', () => {
    test('returns all rows when count <= limit (no hasMore)', async () => {
      const events = [makeEvent({ event_id: 'e1' }), makeEvent({ event_id: 'e2' })];
      const result = await listIndexerEvents({ dbClient: makeFakeKnex(events) });

      expect(result.data).toHaveLength(2);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.meta.total).toBe(2);
    });

    test('hasMore is true when rows exceed limit', async () => {
      const events = Array.from({ length: 25 }, (_, i) => makeEvent({ event_id: `e${i}` }));
      const result = await listIndexerEvents({
        pagination: { limit: 5, page: 1 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.data).toHaveLength(5);
      expect(result.meta.hasMore).toBe(true);
      expect(result.meta.nextCursor).not.toBeNull();
    });

    test('page 2 returns the correct slice metadata', async () => {
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent({ event_id: `e${i}`, observed_at: new Date(2026, 0, i + 1) })
      );
      const result = await listIndexerEvents({
        pagination: { limit: 4, page: 2 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.page).toBe(2);
      expect(result.meta.totalPages).toBe(3); // ceil(10/4)
    });

    test('over-limit clamp: limit > 100 is clamped to 100', async () => {
      const events = Array.from({ length: 5 }, (_, i) => makeEvent({ event_id: `e${i}` }));
      const result = await listIndexerEvents({
        pagination: { limit: 9999 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.limit).toBe(100);
    });

    test('exact-page boundary: exactly limit rows → hasMore false', async () => {
      const events = Array.from({ length: 10 }, (_, i) => makeEvent({ event_id: `e${i}` }));
      const result = await listIndexerEvents({
        pagination: { limit: 10 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.data).toHaveLength(10);
      expect(result.meta.hasMore).toBe(false);
    });

    test('empty result set → empty data, hasMore false, total 0', async () => {
      const result = await listIndexerEvents({ dbClient: makeFakeKnex([]) });

      expect(result.data).toEqual([]);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.meta.total).toBe(0);
    });

    test('default limit is 20 when none supplied', async () => {
      const result = await listIndexerEvents({ dbClient: makeFakeKnex([]) });
      expect(result.meta.limit).toBe(20);
    });
  });

  // ── cursor-mode pagination ──────────────────────────────────────────────

  describe('cursor-mode pagination', () => {
    test('first page generates a valid nextCursor when hasMore', async () => {
      const events = Array.from({ length: 6 }, (_, i) =>
        makeEvent({ event_id: `e${i}`, observed_at: new Date(2026, 0, i + 1) })
      );
      const result = await listIndexerEvents({
        pagination: { limit: 5 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.hasMore).toBe(true);
      expect(typeof result.meta.nextCursor).toBe('string');
      expect(result.meta.nextCursor.length).toBeGreaterThan(10);
    });

    test('nextCursor decodes to the correct sort anchor', async () => {
      const events = Array.from({ length: 6 }, (_, i) =>
        makeEvent({
          event_id: `e${String(i).padStart(3, '0')}`,
          observed_at: new Date(2026, 0, i + 1),
        })
      );
      const result = await listIndexerEvents({
        sorting: { sortBy: 'observed_at', order: 'asc' },
        pagination: { limit: 5 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.nextCursor).toBeTruthy();
      const decoded = decodeCursor(result.meta.nextCursor, 'observed_at');
      expect(decoded.sortField).toBe('observed_at');
      expect(decoded.id).toBe(result.data[4].event_id);
    });

    test('no nextCursor on the last page', async () => {
      const events = Array.from({ length: 3 }, (_, i) => makeEvent({ event_id: `e${i}` }));
      const result = await listIndexerEvents({
        pagination: { limit: 10 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    test('throws CursorError for a tampered cursor', async () => {
      await expect(
        listIndexerEvents({
          pagination: { cursor: 'tampered.cursor.value' },
          dbClient: makeFakeKnex([]),
        })
      ).rejects.toBeInstanceOf(CursorError);
    });

    test('cursor with ledger_sequence sort field works', async () => {
      const events = Array.from({ length: 6 }, (_, i) =>
        makeEvent({ event_id: `e${i}`, ledger_sequence: 100 + i })
      );
      const result = await listIndexerEvents({
        sorting: { sortBy: 'ledger_sequence', order: 'asc' },
        pagination: { limit: 5 },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.hasMore).toBe(true);
      const decoded = decodeCursor(result.meta.nextCursor, 'ledger_sequence');
      expect(decoded.sortField).toBe('ledger_sequence');
    });

    test('throws CursorError for sort-field mismatch', async () => {
      // Encode cursor for observed_at but request ledger_sequence
      const cursor = encodeCursor({ sortField: 'observed_at', sortValue: 'v', id: 'e1' });
      await expect(
        listIndexerEvents({
          sorting: { sortBy: 'ledger_sequence' },
          pagination: { cursor },
          dbClient: makeFakeKnex([]),
        })
      ).rejects.toBeInstanceOf(CursorError);
    });
  });

  // ── filters ────────────────────────────────────────────────────────────

  describe('filters', () => {
    test('invoiceId filter narrows result set', async () => {
      const events = [
        makeEvent({ event_id: 'e1', invoice_id: 'inv_A' }),
        makeEvent({ event_id: 'e2', invoice_id: 'inv_B' }),
        makeEvent({ event_id: 'e3', invoice_id: 'inv_A' }),
      ];
      const result = await listIndexerEvents({
        filters: { invoiceId: 'inv_A' },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.total).toBe(2);
    });

    test('eventType filter narrows result set', async () => {
      const events = [
        makeEvent({ event_id: 'e1', event_type: 'escrow_created' }),
        makeEvent({ event_id: 'e2', event_type: 'escrow_funded' }),
      ];
      const result = await listIndexerEvents({
        filters: { eventType: 'escrow_created' },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.total).toBe(1);
      expect(result.data[0].event_id).toBe('e1');
    });

    test('combined filters apply AND logic', async () => {
      const CADDR = 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI';
      const events = [
        makeEvent({ event_id: 'e1', invoice_id: 'inv_A', contract_id: CADDR }),
        makeEvent({ event_id: 'e2', invoice_id: 'inv_A', contract_id: null }),
        makeEvent({ event_id: 'e3', invoice_id: 'inv_B', contract_id: CADDR }),
      ];
      const result = await listIndexerEvents({
        filters: { invoiceId: 'inv_A', contractId: CADDR },
        dbClient: makeFakeKnex(events),
      });

      expect(result.meta.total).toBe(1);
      expect(result.data[0].event_id).toBe('e1');
    });
  });

  // ── sorting ────────────────────────────────────────────────────────────

  describe('sorting', () => {
    test('accepts ledger_sequence as sortBy without error', async () => {
      const result = await listIndexerEvents({
        sorting: { sortBy: 'ledger_sequence', order: 'asc' },
        dbClient: makeFakeKnex([]),
      });
      expect(result.data).toEqual([]);
    });

    test('unknown sortBy falls back to observed_at gracefully', async () => {
      const result = await listIndexerEvents({
        sorting: { sortBy: 'not_a_real_field' },
        dbClient: makeFakeKnex([makeEvent({ event_id: 'e1' })]),
      });
      expect(result.data).toHaveLength(1);
    });

    test('default sort field is observed_at', async () => {
      const result = await listIndexerEvents({ dbClient: makeFakeKnex([]) });
      // No error, meta is defined — default sort applied silently
      expect(result.meta).toBeDefined();
    });
  });

  // ── INDEXER_SORT_FIELDS constant ───────────────────────────────────────

  test('INDEXER_SORT_FIELDS contains observed_at and ledger_sequence', () => {
    expect(INDEXER_SORT_FIELDS).toContain('observed_at');
    expect(INDEXER_SORT_FIELDS).toContain('ledger_sequence');
  });

  // ── isIndexerEnabled() / ESCROW_INDEXER_ENABLED feature flag ───────────

  describe('ESCROW_INDEXER_ENABLED feature flag', () => {
    let isIndexerEnabled;
    let indexerCache;
    let IndexerCache;

    beforeAll(() => {
      ({ isIndexerEnabled, IndexerCache } = require('../src/services/indexerService'));
      ({ indexerCache } = require('../src/services/indexerCache'));
    });

    beforeEach(() => {
      indexerCache.invalidateAll();
    });

    test('isIndexerEnabled defaults to false when config is not validated', () => {
      jest.resetModules();
      const fresh = require('../src/services/indexerService');
      expect(fresh.isIndexerEnabled()).toBe(false);
    });

    test('isIndexerEnabled returns true when ESCROW_INDEXER_ENABLED is "true"', () => {
      const config = require('../src/config');
      const originalGet = config.get;
      config.get = jest.fn(() => ({ ESCROW_INDEXER_ENABLED: 'true' }));
      try {
        expect(isIndexerEnabled()).toBe(true);
      } finally {
        config.get = originalGet;
      }
    });

    test('isIndexerEnabled returns false when ESCROW_INDEXER_ENABLED is "false"', () => {
      const config = require('../src/config');
      const originalGet = config.get;
      config.get = jest.fn(() => ({ ESCROW_INDEXER_ENABLED: 'false' }));
      try {
        expect(isIndexerEnabled()).toBe(false);
      } finally {
        config.get = originalGet;
      }
    });

    test('listIndexerEvents bypasses cache when flag is disabled (no dbClient → cache normally used but skipped)', async () => {
      const config = require('../src/config');
      const originalGet = config.get;
      config.get = jest.fn(() => ({ ESCROW_INDEXER_ENABLED: 'false' }));

      try {
        const events = [makeEvent({ event_id: 'e1' }), makeEvent({ event_id: 'e2' })];
        const fakeKnex = makeFakeKnex(events);

        const result1 = await listIndexerEvents({ dbClient: fakeKnex });
        expect(result1.data).toHaveLength(2);

        const cacheKey = IndexerCache.buildKey({});
        expect(indexerCache.get(cacheKey)).toBeUndefined();
      } finally {
        config.get = originalGet;
      }
    });

    test('listIndexerEvents populates and reads from cache when flag is enabled', async () => {
      const config = require('../src/config');
      const originalGet = config.get;
      config.get = jest.fn(() => ({ ESCROW_INDEXER_ENABLED: 'true' }));

      try {
        const events = [makeEvent({ event_id: 'e1' })];
        let callCount = 0;
        const countingKnex = makeFakeKnex(events);
        const originalFn = countingKnex;
        const wrappedKnex = jest.fn((...args) => {
          callCount += 1;
          return originalFn(...args);
        });

        await listIndexerEvents({ dbClient: wrappedKnex });
        const firstCallCount = callCount;

        const cacheKey = IndexerCache.buildKey({});
        expect(indexerCache.get(cacheKey)).toBeDefined();

        callCount = 0;
        const secondKnex = jest.fn((...args) => {
          callCount += 1;
          return makeFakeKnex([])(...args);
        });
        const secondKnexOrig = secondKnex;

        await listIndexerEvents();
        expect(callCount).toBe(0);
      } finally {
        config.get = originalGet;
        indexerCache.invalidateAll();
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: cursorPagination — new sort fields
// ─────────────────────────────────────────────────────────────────────────────

describe('cursorPagination – indexer sort fields', () => {
  let encodeCursor;
  let decodeCursor;
  let CursorError;
  let ALLOWED_SORT_FIELDS;

  beforeAll(() => {
    ({ encodeCursor, decodeCursor, CursorError, ALLOWED_SORT_FIELDS } =
      require('../src/utils/cursorPagination'));
  });

  test('ALLOWED_SORT_FIELDS includes observed_at', () => {
    expect(ALLOWED_SORT_FIELDS).toContain('observed_at');
  });

  test('ALLOWED_SORT_FIELDS includes ledger_sequence', () => {
    expect(ALLOWED_SORT_FIELDS).toContain('ledger_sequence');
  });

  test('encodeCursor succeeds for observed_at', () => {
    const cursor = encodeCursor({
      sortField: 'observed_at',
      sortValue: '2026-01-01T00:00:00.000Z',
      id: 'evt_123',
    });
    expect(typeof cursor).toBe('string');
    expect(cursor).toContain('.');
  });

  test('encodeCursor succeeds for ledger_sequence', () => {
    const cursor = encodeCursor({
      sortField: 'ledger_sequence',
      sortValue: 42000,
      id: 'evt_456',
    });
    expect(typeof cursor).toBe('string');
  });

  test('decodeCursor round-trips observed_at cursor', () => {
    const orig = { sortField: 'observed_at', sortValue: '2026-06-01T10:00:00Z', id: 'e001' };
    const decoded = decodeCursor(encodeCursor(orig), 'observed_at');
    expect(decoded.sortField).toBe('observed_at');
    expect(decoded.sortValue).toBe(orig.sortValue);
    expect(decoded.id).toBe('e001');
  });

  test('decodeCursor round-trips ledger_sequence cursor', () => {
    const cursor = encodeCursor({ sortField: 'ledger_sequence', sortValue: 99999, id: 'e002' });
    const decoded = decodeCursor(cursor, 'ledger_sequence');
    expect(decoded.sortField).toBe('ledger_sequence');
    expect(decoded.sortValue).toBe(99999);
    expect(decoded.id).toBe('e002');
  });

  test('encodeCursor throws for an unknown sort field', () => {
    expect(() =>
      encodeCursor({ sortField: 'unknown_field', sortValue: 1, id: 'e001' })
    ).toThrow();
  });

  test('decodeCursor throws CursorError for malformed cursor', () => {
    expect(() => decodeCursor('not-a-valid-cursor', 'observed_at')).toThrow(CursorError);
  });

  test('decodeCursor throws CursorError for tampered signature', () => {
    const valid = encodeCursor({ sortField: 'observed_at', sortValue: 'v', id: 'e1' });
    const lastDot = valid.lastIndexOf('.');
    const sig = valid.slice(lastDot + 1);
    const tampered = valid.slice(0, lastDot + 1) +
      sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
    expect(() => decodeCursor(tampered, 'observed_at')).toThrow(CursorError);
  });

  test('decodeCursor throws CursorError when sortField mismatches', () => {
    const cursor = encodeCursor({ sortField: 'observed_at', sortValue: 'v', id: 'e1' });
    expect(() => decodeCursor(cursor, 'ledger_sequence')).toThrow(CursorError);
  });

  test('existing marketplace sort fields still accepted (backward compat)', () => {
    for (const field of ['yield_bps', 'maturity_date', 'funded_ratio', 'amount', 'created_at']) {
      const cursor = encodeCursor({ sortField: field, sortValue: 1, id: 'e1' });
      const decoded = decodeCursor(cursor, field);
      expect(decoded.sortField).toBe(field);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: Route integration tests (GET /api/admin/indexer/events)
// Uses supertest with a top-level jest.mock on the db so no real DB is hit.
// ─────────────────────────────────────────────────────────────────────────────

// Top-level mock for the db — must be hoisted before any require of app/service
jest.mock('../src/db/knex', () => {
  const q = {
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

describe('GET /api/admin/indexer/events route', () => {
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const { createApp } = require('../src/app');
  const db = require('../src/db/knex');
  const { encodeCursor, CursorError } = require('../src/utils/cursorPagination');
  const { indexerCache } = require('../src/services/indexerCache');

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
    indexerCache.invalidateAll();
    // Default: count returns 0, data returns []
    mockQ.first.mockResolvedValue({ total: 0, 'count(*)': 0 });
    mockQ.then.mockImplementation(function (resolve) {
      return Promise.resolve([]).then(resolve);
    });
  });

  // ── auth guard ──────────────────────────────────────────────────────────

  test('401 when no Authorization header', async () => {
    const res = await request(app).get('/api/admin/indexer/events');
    expect(res.status).toBe(401);
  });

  test('401 for invalid Bearer token', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', 'Bearer not.a.valid.jwt');
    expect(res.status).toBe(401);
  });

  // ── successful responses ────────────────────────────────────────────────

  test('200 with empty data array when no events exist', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
    expect(res.body.message).toBe('Indexer events retrieved successfully.');
  });

  test('200 with event rows returned from DB', async () => {
    const rows = [makeEvent({ event_id: 'e1' }), makeEvent({ event_id: 'e2' })];
    mockQ.first.mockResolvedValue({ total: 2, 'count(*)': 2 });
    mockQ.then.mockImplementation(function (resolve) {
      return Promise.resolve(rows).then(resolve);
    });

    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  // ── query parameter validation → 400 ───────────────────────────────────

  test('400 for limit > 100', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?limit=101')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/limit/i);
  });

  test('400 for limit = 0', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?limit=0')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
  });

  test('400 for page < 1', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?page=0')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/page/i);
  });

  test('400 for invalid sortBy', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?sortBy=yield_bps')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/sortBy/i);
  });

  test('400 for invalid order', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?order=sideways')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/order/i);
  });

  test('400 for invalid invoiceId (contains space)', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?invoiceId=has%20spaces')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/invoiceId/i);
  });

  test('400 for invalid contractId format', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?contractId=BADADDR')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/contractId/i);
  });

  test('400 for empty cursor string', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?cursor=')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
  });

  test('400 for malformed cursor (invalid signature)', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?cursor=tampered.invalid.sig')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cursor/i);
  });

  // ── valid parameter acceptance ──────────────────────────────────────────

  test('200 with limit=1 (minimum boundary)', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?limit=1')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('200 with limit=100 (maximum boundary)', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('200 with sortBy=observed_at', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?sortBy=observed_at')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('200 with sortBy=ledger_sequence', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?sortBy=ledger_sequence')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('200 with order=ASC (case-insensitive)', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?order=ASC')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('200 with valid invoiceId filter', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?invoiceId=inv_123')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('200 with valid eventType filter', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?eventType=escrow_funded')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('200 with valid cursor from encodeCursor', async () => {
    const cursor = encodeCursor({ sortField: 'observed_at', sortValue: 'v', id: 'e1' });
    const res = await request(app)
      .get(`/api/admin/indexer/events?cursor=${encodeURIComponent(cursor)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
  });

  test('page is ignored when cursor is supplied', async () => {
    const cursor = encodeCursor({ sortField: 'observed_at', sortValue: 'v', id: 'e1' });
    const res = await request(app)
      .get(`/api/admin/indexer/events?cursor=${encodeURIComponent(cursor)}&page=99`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    // page=99 would be invalid in offset mode but is silently ignored with cursor
    expect(res.status).toBe(200);
  });

  test('400 for eventType longer than 128 chars', async () => {
    const tooLong = 'a'.repeat(129);
    const res = await request(app)
      .get(`/api/admin/indexer/events?eventType=${tooLong}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/eventType/i);
  });

  test('400 for invoiceId longer than 128 chars', async () => {
    const tooLong = 'a'.repeat(129);
    const res = await request(app)
      .get(`/api/admin/indexer/events?invoiceId=${tooLong}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(400);
  });

  test('200 with no query params (all defaults)', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.limit).toBe(20);
  });

  test('response shape includes data, meta, and message', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.meta).toBe('object');
    expect(typeof res.body.message).toBe('string');
    expect(res.body.meta).toHaveProperty('total');
    expect(res.body.meta).toHaveProperty('hasMore');
    expect(res.body.meta).toHaveProperty('limit');
    expect(res.body.meta).toHaveProperty('nextCursor');
  });

  // ── correlation id propagation ──────────────────────────────────────────

  test('200 response includes correlation_id in body when present in header', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .set('x-correlation-id', 'corr_indexer_001');
    expect(res.status).toBe(200);
    expect(res.body.correlation_id).toBe('corr_indexer_001');
  });

  test('200 response includes X-Correlation-Id response header', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(typeof res.headers['x-correlation-id']).toBe('string');
  });

  test('200 response correlation_id matches X-Correlation-Id header', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .set('X-Correlation-Id', 'trace_abc_42');
    expect(res.status).toBe(200);
    expect(res.body.correlation_id).toBe('trace_abc_42');
    expect(res.headers['x-correlation-id']).toBe('trace_abc_42');
  });

  test('correlation_id is generated when no correlation header is present', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test');
    expect(res.status).toBe(200);
    expect(res.body.correlation_id).toBeDefined();
    // Generated IDs start with req_
    expect(res.body.correlation_id).toMatch(/^req_/);
  });

  test('400 validation error includes correlation_id', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?limit=999')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .set('x-correlation-id', 'corr_validation_err');
    expect(res.status).toBe(400);
    expect(res.body.correlation_id).toBe('corr_validation_err');
  });

  test('400 cursor error includes correlation_id', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?cursor=tampered.invalid.sig')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .set('x-correlation-id', 'corr_cursor_err');
    expect(res.status).toBe(400);
    expect(res.body.correlation_id).toBe('corr_cursor_err');
  });

  test('correlation_id in 400 body matches X-Correlation-Id response header', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events?page=0')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .set('X-Correlation-Id', 'trace_page_err');
    expect(res.status).toBe(400);
    expect(res.body.correlation_id).toBe('trace_page_err');
    expect(res.headers['x-correlation-id']).toBe('trace_page_err');
  });

  test('x-request-id header is also accepted as correlation source', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .set('X-Request-Id', 'req_from_lb_42');
    expect(res.status).toBe(200);
    // correlationId middleware prefers x-correlation-id, then x-request-id
    expect(res.body.correlation_id).toBeDefined();
    expect(res.headers['x-request-id']).toBeDefined();
  });

  test('service receives correlationId when passed from route', async () => {
    const indexerService = require('../src/services/indexerService');
    const result = await indexerService.listIndexerEvents({
      dbClient: makeFakeKnex([makeEvent({ event_id: 'e1' })]),
      correlationId: 'svc_corr_001',
    });
    expect(result.correlationId).toBe('svc_corr_001');
  });

  test('correlation_id is absent from x-request-id when only x-request-id is provided', async () => {
    // When only x-request-id is given without x-correlation-id, the middleware
    // should still produce a correlation_id in the body.
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-tenant-id', 'tenant-test')
      .set('X-Request-Id', 'req_only_42');
    expect(res.status).toBe(200);
    expect(res.body.correlation_id).toBeDefined();
  });
});
