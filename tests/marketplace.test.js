'use strict';

/**
 * Marketplace API – comprehensive test suite
 *
 * Covers:
 *  - Authentication / tenant scoping
 *  - Filter forwarding
 *  - Offset pagination (legacy, backward-compatible)
 *  - Cursor-based pagination (first page, subsequent pages, last page)
 *  - Empty result set
 *  - Malformed / tampered cursor → 400
 *  - Sort-field mismatch mid-pagination → 400
 *  - Non-public status filter → 400
 *  - Invalid query params → 400
 *  - DB error → 500
 *  - nextCursor / hasMore in meta for both modes
 */

const request = require('supertest');
const { createApp, resetStore } = require('../src/index');
const jwt = require('jsonwebtoken');
const db = require('../src/db/knex');
const { encodeCursor, decodeCursor, CursorError } = require('../src/utils/cursorPagination');
const { validateMarketplaceQueryParams } = require('../src/utils/validators');

// ── Knex mock ────────────────────────────────────────────────────────────────

/**
 * We need the mock query to support chained builder calls AND return different
 * data depending on whether `.count()` or `.select()` was called last.
 *
 * The mock is rebuilt fresh in each test via mockQuery helpers below so that
 * individual tests can override the resolved values cleanly.
 */
jest.mock('../src/db/knex', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnThis(),
    clearSelect: jest.fn().mockReturnThis(),
    clearOrder: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ total: 1 }),
    then: jest.fn(function (resolve) {
      if (typeof resolve === 'function') {
        return Promise.resolve([
          { id: 'inv_1', yield_bps: 500, funded_ratio: 50.0, maturity_date: '2024-12-31', created_at: '2024-01-01', amount: 1000, status: 'verified' },
        ]).then(resolve);
      }
      return Promise.resolve([
        { id: 'inv_1', yield_bps: 500, funded_ratio: 50.0, maturity_date: '2024-12-31', created_at: '2024-01-01', amount: 1000, status: 'verified' },
      ]);
    }),
    catch: jest.fn().mockReturnThis(),
  };

  const mockDb = jest.fn(() => mockQuery);
  Object.assign(mockDb, mockQuery);
  return mockDb;
});

// ── Constants ────────────────────────────────────────────────────────────────

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const tokenA = jwt.sign({ id: 'user_investor_a', role: 'investor', tenantId: TENANT_A }, TEST_SECRET, { expiresIn: '1h' });
const tokenB = jwt.sign({ id: 'user_investor_b', role: 'investor', tenantId: TENANT_B }, TEST_SECRET, { expiresIn: '1h' });

// Sample rows used across cursor tests
const SAMPLE_ROW = { id: 'inv_1', yield_bps: 500, funded_ratio: 50.0, maturity_date: '2024-12-31', created_at: '2024-01-01', amount: 1000, status: 'verified' };
const SAMPLE_ROW_2 = { id: 'inv_2', yield_bps: 450, funded_ratio: 40.0, maturity_date: '2025-03-31', created_at: '2024-02-01', amount: 2000, status: 'verified' };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a valid cursor for the given sort field using a sample row.
 */
function makeCursor(sortField = 'created_at', row = SAMPLE_ROW) {
  return encodeCursor({ sortField, sortValue: row[sortField], id: row.id });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Marketplace API', () => {
  let app;
  let mockQuery;

  beforeAll(() => {
    app = createApp({ enableTestRoutes: true });
    mockQuery = db();
  });

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    // Default: count returns 1, data returns one sample row
    mockQuery.first.mockResolvedValue({ total: 1 });
    mockQuery.then.mockImplementation(function (resolve) {
      return Promise.resolve([SAMPLE_ROW]).then(resolve);
    });
  });

  // ── Authentication ──────────────────────────────────────────────────────────
  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/marketplace');
      expect(res.status).toBe(401);
    });

    it('returns 200 when authenticated', async () => {
      const res = await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Response shape ──────────────────────────────────────────────────────────
  describe('Response shape', () => {
    it('returns data array, meta block, and message', async () => {
      const res = await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(res.body.message).toBe('Marketplace invoices retrieved successfully.');
    });

    it('meta always contains hasMore and nextCursor', async () => {
      const res = await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.meta).toHaveProperty('hasMore');
      expect(res.body.meta).toHaveProperty('nextCursor');
    });
  });

  // ── Tenant scoping ──────────────────────────────────────────────────────────
  describe('Tenant scoping', () => {
    it('scopes by JWT tenantId by default', async () => {
      await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(mockQuery.where).toHaveBeenCalledWith('tenant_id', TENANT_A);
    });

    it('scopes by x-tenant-id header when provided', async () => {
      await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-tenant-id', TENANT_B)
        .expect(200);

      expect(mockQuery.where).toHaveBeenCalledWith('tenant_id', TENANT_B);
    });
  });

  // ── Filter forwarding ───────────────────────────────────────────────────────
  describe('Filter forwarding', () => {
    it('forwards all filter params to the query builder', async () => {
      const res = await request(app)
        .get('/api/marketplace?yieldBpsMin=400&yieldBpsMax=600&fundedRatioMin=20&fundedRatioMax=80&maturityDateFrom=2024-01-01&maturityDateTo=2024-12-31&status=verified')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', '>=', 400);
      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', '<=', 600);
      expect(mockQuery.where).toHaveBeenCalledWith('funded_ratio', '>=', 20);
      expect(mockQuery.where).toHaveBeenCalledWith('funded_ratio', '<=', 80);
      expect(mockQuery.where).toHaveBeenCalledWith('maturity_date', '>=', '2024-01-01');
      expect(mockQuery.where).toHaveBeenCalledWith('maturity_date', '<=', '2024-12-31');
      expect(mockQuery.where).toHaveBeenCalledWith('status', 'verified');
    });

    it('returns 400 for non-public status (pending_verification)', async () => {
      const res = await request(app)
        .get('/api/marketplace?status=pending_verification')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
      expect(res.body.fieldErrors.status).toBeDefined();
    });
  });

  // ── Sorting ─────────────────────────────────────────────────────────────────
  describe('Sorting', () => {
    it('applies sortBy and order to the query', async () => {
      const res = await request(app)
        .get('/api/marketplace?sortBy=yield_bps&order=asc')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(mockQuery.orderBy).toHaveBeenCalledWith('yield_bps', 'asc');
    });

    it('defaults to created_at desc when no sortBy supplied', async () => {
      const res = await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(mockQuery.orderBy).toHaveBeenCalledWith('created_at', 'desc');
    });
  });

  // ── Offset pagination (legacy) ──────────────────────────────────────────────
  describe('Offset pagination (legacy)', () => {
    it('applies limit and offset for page=2, limit=5', async () => {
      const res = await request(app)
        .get('/api/marketplace?page=2&limit=5')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(mockQuery.limit).toHaveBeenCalledWith(6); // limit+1 for hasMore probe
      expect(mockQuery.offset).toHaveBeenCalledWith(5);
      expect(res.body.meta.page).toBe(2);
      expect(res.body.meta.limit).toBe(5);
    });

    it('includes totalPages in offset mode meta', async () => {
      mockQuery.first.mockResolvedValue({ total: 25 });

      const res = await request(app)
        .get('/api/marketplace?page=1&limit=10')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.meta).toHaveProperty('totalPages');
    });

    it('hasMore=false and nextCursor=null on last offset page', async () => {
      // Return only 1 row (≤ limit) — no extra row means no next page
      mockQuery.then.mockImplementation(function (resolve) {
        return Promise.resolve([SAMPLE_ROW]).then(resolve);
      });

      const res = await request(app)
        .get('/api/marketplace?page=1&limit=10')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });
  });

  // ── Cursor pagination ───────────────────────────────────────────────────────
  describe('Cursor-based pagination', () => {
    it('accepts a valid cursor and returns 200', async () => {
      const cursor = makeCursor('created_at');

      const res = await request(app)
        .get(`/api/marketplace?cursor=${encodeURIComponent(cursor)}&sortBy=created_at&order=desc`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
    });

    it('returns nextCursor when hasMore=true', async () => {
      // Return limit+1 rows to simulate "there are more"
      const rows = [SAMPLE_ROW, SAMPLE_ROW_2, { ...SAMPLE_ROW, id: 'inv_3' }];
      mockQuery.then.mockImplementation(function (resolve) {
        return Promise.resolve(rows).then(resolve);
      });

      const res = await request(app)
        .get('/api/marketplace?limit=2')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.hasMore).toBe(true);
      expect(typeof res.body.meta.nextCursor).toBe('string');
      expect(res.body.meta.nextCursor.length).toBeGreaterThan(0);
    });

    it('nextCursor is null when on the last page', async () => {
      // Exactly 1 row → no hasMore
      mockQuery.then.mockImplementation(function (resolve) {
        return Promise.resolve([SAMPLE_ROW]).then(resolve);
      });

      const res = await request(app)
        .get('/api/marketplace?limit=10')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    it('nextCursor is null on empty result set', async () => {
      mockQuery.first.mockResolvedValue({ total: 0 });
      mockQuery.then.mockImplementation(function (resolve) {
        return Promise.resolve([]).then(resolve);
      });

      const res = await request(app)
        .get('/api/marketplace?limit=10')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    it('returns 400 for a completely malformed cursor string', async () => {
      const res = await request(app)
        .get('/api/marketplace?cursor=notavalidcursor&sortBy=created_at')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
      expect(res.body.fieldErrors.cursor).toBeDefined();
    });

    it('returns 400 for a base64-valid but tampered cursor', async () => {
      // Build a valid cursor then corrupt the signature
      const valid = makeCursor('created_at');
      const tampered = valid.slice(0, -4) + 'xxxx';

      const res = await request(app)
        .get(`/api/marketplace?cursor=${encodeURIComponent(tampered)}&sortBy=created_at`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.cursor).toMatch(/signature/i);
    });

    it('returns 400 when cursor sort field does not match requested sortBy', async () => {
      // Cursor was encoded for yield_bps but client sends sortBy=amount
      const cursor = makeCursor('yield_bps');

      const res = await request(app)
        .get(`/api/marketplace?cursor=${encodeURIComponent(cursor)}&sortBy=amount`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.cursor).toMatch(/sort field/i);
    });

    it('data length equals limit when hasMore=true', async () => {
      // 3 rows returned for limit=2 → hasMore=true, data sliced to 2
      const rows = [SAMPLE_ROW, SAMPLE_ROW_2, { ...SAMPLE_ROW, id: 'inv_3' }];
      mockQuery.then.mockImplementation(function (resolve) {
        return Promise.resolve(rows).then(resolve);
      });

      const res = await request(app)
        .get('/api/marketplace?limit=2')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  // ── Validation errors ───────────────────────────────────────────────────────
  describe('Input validation', () => {
    it('returns 400 for negative yieldBpsMin', async () => {
      const res = await request(app)
        .get('/api/marketplace?yieldBpsMin=-100')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
      expect(res.body.fieldErrors.yieldBpsMin).toBeDefined();
    });

    it('returns 400 for fundedRatioMin > 100', async () => {
      const res = await request(app)
        .get('/api/marketplace?fundedRatioMin=150')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid maturityDateFrom format', async () => {
      const res = await request(app)
        .get('/api/marketplace?maturityDateFrom=invalid')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
    });

    it('returns 400 for limit > 100', async () => {
      const res = await request(app)
        .get('/api/marketplace?limit=999')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
    });

    it('returns 400 for page < 1', async () => {
      const res = await request(app)
        .get('/api/marketplace?page=0')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid sortBy value', async () => {
      const res = await request(app)
        .get('/api/marketplace?sortBy=unknown_field')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid order value', async () => {
      const res = await request(app)
        .get('/api/marketplace?order=sideways')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────
  describe('Error handling', () => {
    it('returns 500 on database errors', async () => {
      mockQuery.then.mockImplementationOnce((resolve, reject) => {
        if (typeof reject === 'function') {
          return reject(new Error('DB connection failed'));
        }
        throw new Error('DB connection failed');
      });

      const res = await request(app)
        .get('/api/marketplace')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });
  });
});

// ── Unit tests: cursorPagination.js ─────────────────────────────────────────

describe('cursorPagination – unit tests', () => {
  describe('encodeCursor', () => {
    it('returns a string with exactly one dot separator', () => {
      const cursor = encodeCursor({ sortField: 'yield_bps', sortValue: 500, id: 'inv_1' });
      expect(typeof cursor).toBe('string');
      // dot separates payload from signature
      const parts = cursor.split('.');
      expect(parts.length).toBe(2);
    });

    it('throws for unsupported sortField', () => {
      expect(() =>
        encodeCursor({ sortField: 'hacked_field', sortValue: 1, id: 'x' })
      ).toThrow('unsupported sortField');
    });

    it('throws for missing id', () => {
      expect(() =>
        encodeCursor({ sortField: 'amount', sortValue: 100, id: '' })
      ).toThrow('id must be a non-empty string');
    });
  });

  describe('decodeCursor', () => {
    it('round-trips a valid cursor', () => {
      const cursor = encodeCursor({ sortField: 'amount', sortValue: 999, id: 'inv_abc' });
      const decoded = decodeCursor(cursor, 'amount');
      expect(decoded.sortField).toBe('amount');
      expect(decoded.sortValue).toBe(999);
      expect(decoded.id).toBe('inv_abc');
      expect(typeof decoded.iat).toBe('number');
    });

    it('throws CursorError for missing dot', () => {
      expect(() => decodeCursor('nodothere', 'amount')).toThrow(CursorError);
    });

    it('throws CursorError for wrong signature', () => {
      const cursor = encodeCursor({ sortField: 'amount', sortValue: 1, id: 'x' });
      const tampered = cursor.slice(0, -4) + 'abcd';
      expect(() => decodeCursor(tampered, 'amount')).toThrow(CursorError);
    });

    it('throws CursorError when sortField does not match expected', () => {
      const cursor = encodeCursor({ sortField: 'amount', sortValue: 1, id: 'x' });
      expect(() => decodeCursor(cursor, 'yield_bps')).toThrow(CursorError);
    });

    it('throws CursorError for non-base64url payload', () => {
      const fakeSig = require('crypto').createHmac('sha256', process.env.JWT_SECRET || 'test-secret').update('!!!').digest('hex');
      expect(() => decodeCursor(`!!!.${fakeSig}`, 'amount')).toThrow(CursorError);
    });

    it('throws CursorError for unknown sortField in payload', () => {
      // Construct a payload with an unknown field but valid structure
      const payload = Buffer.from(
        JSON.stringify({ sortField: 'bad_field', sortValue: 1, id: 'x', iat: 0 })
      ).toString('base64url');
      const sig = require('crypto')
        .createHmac('sha256', process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'dev-cursor-secret-change-in-prod')
        .update(payload)
        .digest('hex');
      expect(() => decodeCursor(`${payload}.${sig}`, 'bad_field')).toThrow(CursorError);
    });
  });
});

// ── Unit tests: validateMarketplaceQueryParams (cursor additions) ────────────

describe('validateMarketplaceQueryParams – cursor support', () => {
  it('accepts a cursor string and puts it in pagination', () => {
    const { isValid, validatedParams } = validateMarketplaceQueryParams({
      cursor: 'someopaquevalue',
      sortBy: 'yield_bps',
      limit: '10',
    });
    expect(isValid).toBe(true);
    expect(validatedParams.pagination.cursor).toBe('someopaquevalue');
  });

  it('ignores page when cursor is present', () => {
    const { isValid, validatedParams } = validateMarketplaceQueryParams({
      cursor: 'someopaquevalue',
      page: '3',
      limit: '10',
    });
    expect(isValid).toBe(true);
    expect(validatedParams.pagination.cursor).toBe('someopaquevalue');
    expect(validatedParams.pagination.page).toBeUndefined();
  });

  it('rejects an empty cursor string', () => {
    const { isValid, fieldErrors } = validateMarketplaceQueryParams({ cursor: '' });
    expect(isValid).toBe(false);
    expect(fieldErrors.cursor).toMatch(/cursor/i);
  });

  it('rejects a cursor over 2048 characters', () => {
    const { isValid, fieldErrors } = validateMarketplaceQueryParams({
      cursor: 'a'.repeat(2049),
    });
    expect(isValid).toBe(false);
    expect(fieldErrors.cursor).toMatch(/cursor/i);
  });

  it('still validates page when no cursor', () => {
    const { isValid, fieldErrors } = validateMarketplaceQueryParams({ page: '0' });
    expect(isValid).toBe(false);
    expect(fieldErrors.page).toMatch(/page/i);
  });

  it('accepts all valid sort fields', () => {
    const fields = ['yield_bps', 'maturity_date', 'funded_ratio', 'amount', 'created_at'];
    for (const f of fields) {
      const { isValid } = validateMarketplaceQueryParams({ sortBy: f });
      expect(isValid).toBe(true);
    }
  });
});

// ── Unit tests: status vocabulary alignment ──────────────────────────────────

describe('Status vocabulary alignment – state machine vs marketplace', () => {
  /**
   * These tests enforce the contract that the marketplace visibility set is
   * always a proper subset of the authoritative ALL_INVOICE_STATUSES from
   * invoiceStateMachine.  If either constant drifts the suite fails
   * immediately, making the misalignment impossible to ship silently.
   */
  const {
    ALL_INVOICE_STATUSES,
    INVESTABLE_STATUSES,
  } = require('../src/services/invoiceStateMachine');
  const { PUBLIC_INVESTABLE_INVOICE_STATUSES } = require('../src/services/marketplaceService');

  it('ALL_INVOICE_STATUSES contains at least the legacy funding-progress vocabulary', () => {
    // These are the statuses that existed in the validator before this change.
    // Removing any of them from the state machine would be a breaking regression.
    const requiredStatuses = [
      'pending_verification',
      'verified',
      'partially_funded',
      'funded',
      'completed',
      'defaulted',
    ];
    for (const s of requiredStatuses) {
      expect(ALL_INVOICE_STATUSES).toContain(s);
    }
  });

  it('ALL_INVOICE_STATUSES contains all lifecycle states from INVOICE_STATES', () => {
    const { INVOICE_STATES } = require('../src/services/invoiceStateMachine');
    for (const s of Object.values(INVOICE_STATES)) {
      expect(ALL_INVOICE_STATUSES).toContain(s);
    }
  });

  it('INVESTABLE_STATUSES is a non-empty frozen array', () => {
    expect(Array.isArray(INVESTABLE_STATUSES)).toBe(true);
    expect(INVESTABLE_STATUSES.length).toBeGreaterThan(0);
    // Object.isFrozen checks the freeze applied in invoiceStateMachine
    expect(Object.isFrozen(INVESTABLE_STATUSES)).toBe(true);
  });

  it('every status in INVESTABLE_STATUSES is a recognized state (subset of ALL_INVOICE_STATUSES)', () => {
    for (const s of INVESTABLE_STATUSES) {
      expect(ALL_INVOICE_STATUSES).toContain(s);
    }
  });

  it('PUBLIC_INVESTABLE_INVOICE_STATUSES is the same reference as INVESTABLE_STATUSES (single source)', () => {
    // The marketplace constant must be derived from — not a copy of — the
    // state machine constant.  A value equality check is the minimum bar;
    // identity equality (===) confirms no accidental re-freeze with new array.
    expect(PUBLIC_INVESTABLE_INVOICE_STATUSES).toBe(INVESTABLE_STATUSES);
  });

  it('no terminal lifecycle state is investable', () => {
    const { TERMINAL_STATES } = require('../src/services/invoiceStateMachine');
    for (const s of TERMINAL_STATES) {
      expect(INVESTABLE_STATUSES).not.toContain(s);
    }
  });

  it('no non-public state (pending, approved, rejected, cancelled) is in INVESTABLE_STATUSES', () => {
    const nonPublicStates = ['pending', 'approved', 'linked_escrow', 'rejected', 'cancelled', 'pending_verification', 'defaulted'];
    for (const s of nonPublicStates) {
      expect(INVESTABLE_STATUSES).not.toContain(s);
    }
  });

  it('verified is in INVESTABLE_STATUSES', () => {
    expect(INVESTABLE_STATUSES).toContain('verified');
  });

  it('partially_funded is in INVESTABLE_STATUSES', () => {
    expect(INVESTABLE_STATUSES).toContain('partially_funded');
  });

  it('funded is NOT in INVESTABLE_STATUSES (fully funded invoices are no longer accepting commitments)', () => {
    // Once fully funded, no additional investor commitments can be accepted.
    expect(INVESTABLE_STATUSES).not.toContain('funded');
  });
});
