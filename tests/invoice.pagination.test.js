'use strict';

/**
 * Invoice Pagination — Comprehensive Test Suite
 *
 * Covers:
 *  - Empty result set
 *  - Cursor-based pagination (first page, next page, last page)
 *  - Offset-based pagination (legacy, backward-compatible)
 *  - Exact page-size boundary
 *  - Over-limit clamp
 *  - Invalid / tampered cursor → CursorError
 *  - Sort-field mismatch → CursorError
 *  - Filters forwarded with cursor
 *  - Default limit when none specified
 *
 * @jest-environment node
 */

// ── Knex mock ────────────────────────────────────────────────────────────────

// Replace the broad repository test fixture with the purpose-built query
// builder below; this suite needs to control count rows and page rows
// independently to exercise limit+1 keyset behavior.
let mockTotal = { total: 0 };
let mockRows = [];
jest.unmock('../src/db/knex');
jest.mock('../src/db/knex', () => {
  const buildMockQuery = () => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ total: 0 }),
    count: jest.fn(() => Promise.resolve([mockTotal])),
    orWhere: jest.fn().mockReturnThis(),
    then: jest.fn(function (resolve) {
      if (typeof resolve === 'function') {
        return Promise.resolve(mockRows).then(resolve);
      }
      return Promise.resolve([]);
    }),
    catch: jest.fn().mockReturnThis(),
  });

  const mockQuery = buildMockQuery();
  const mockDb = jest.fn(() => mockQuery);
  Object.assign(mockDb, mockQuery);
  return mockDb;
});

// ── Module under test ─────────────────────────────────────────────────────────

const db = require('../src/db/knex');
const { encodeCursor, decodeCursor, CursorError } = require('../src/utils/cursorPagination');
const {
  encodeInvoiceCursor,
  decodeInvoiceCursor,
  isAfterInvoiceCursor,
  normalizeInvoicePageSize,
} = require('../src/utils/invoicePagination');
const invoiceService = require('../src/services/invoiceService');
const { getInvoicesWithPagination } = invoiceService;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(id, overrides = {}) {
  return {
    id,
    invoice_id: `inv_${id}`,
    amount: 1000,
    date: '2024-01-15',
    created_at: '2024-01-01T00:00:00Z',
    status: 'pending',
    customer: 'TestCo',
    ...overrides,
  };
}

function makeCursor(sortField, row) {
  return encodeCursor({ sortField, sortValue: row[sortField], id: row.id });
}

/**
 * Returns the mock query builder object that knex() returns.
 */
function getMockQuery() {
  return db();
}

/**
 * Configures the mock to return the given count and rows.
 */
function mockDbResult(rows, total) {
  const q = getMockQuery();
  mockRows = rows;
  mockTotal = { total: total ?? rows.length };
  if (typeof db.__setInvoicePaginationFixture === 'function') {
    db.__setInvoicePaginationFixture(rows, mockTotal.total);
  }
  q.first.mockResolvedValue(mockTotal);
  q.then.mockImplementation(function (resolve) {
    return Promise.resolve(rows).then(resolve);
  });
}

describe('getInvoicesWithPagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Empty result set ──────────────────────────────────────────────────────

  describe('empty result set', () => {
    it('returns empty data array with hasMore=false and nextCursor=null', async () => {
      mockDbResult([], 0);

      const result = await getInvoicesWithPagination({});

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    it('still returns meta fields when filters yield no matches', async () => {
      mockDbResult([], 0);

      const result = await getInvoicesWithPagination({
        filters: { status: 'nonexistent' },
      });

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.limit).toBe(10);
    });
  });

  // ── Cursor-based pagination ───────────────────────────────────────────────

  describe('cursor-based pagination', () => {
    it('returns first page with nextCursor when more rows exist', async () => {
      // Provide limit+1 = 3 rows so hasMore is computed as true
      const rows = [
        makeRow('a', { amount: 100 }),
        makeRow('b', { amount: 200 }),
        makeRow('c', { amount: 300 }),
      ];
      mockDbResult(rows, 5);

      const result = await getInvoicesWithPagination({
        sorting: { sortBy: 'amount', order: 'asc' },
        pagination: { limit: 2 },
      });

      expect(result.data).toHaveLength(2);
      expect(result.meta.limit).toBe(2);
      expect(result.meta.hasMore).toBe(true);
      expect(result.meta.nextCursor).toBeTruthy();
      // nextCursor should be decodable and point to the last row
      const decoded = decodeCursor(result.meta.nextCursor, 'amount');
      expect(decoded.id).toBe('b');
      expect(decoded.sortValue).toBe(200);
    });

    it('returns hasMore=false and nextCursor=null on the last page', async () => {
      const rows = [makeRow('a', { amount: 100 })];
      mockDbResult(rows, 1);

      const result = await getInvoicesWithPagination({
        sorting: { sortBy: 'amount', order: 'asc' },
        pagination: { limit: 2 },
      });

      expect(result.data).toHaveLength(1);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    it('fetches subsequent pages via cursor', async () => {
      // Simulate cursor pointing to row 'b'
      const cursor = makeCursor('amount', makeRow('b', { amount: 200 }));
      const rows = [
        makeRow('c', { amount: 300 }),
        makeRow('d', { amount: 400 }),
        makeRow('e', { amount: 500 }),
      ];
      mockDbResult(rows, 8);

      const result = await getInvoicesWithPagination({
        sorting: { sortBy: 'amount', order: 'asc' },
        pagination: { cursor, limit: 2 },
      });

      expect(result.data).toHaveLength(2);
      expect(result.meta.hasMore).toBe(true);
      // nextCursor should point to 'd'
      const decoded = decodeCursor(result.meta.nextCursor, 'amount');
      expect(decoded.id).toBe('d');
    });

    it('throws CursorError for a malformed cursor', async () => {
      await expect(
        getInvoicesWithPagination({
          pagination: { cursor: 'not-a-valid-cursor' },
        })
      ).rejects.toThrow(CursorError);
    });

    it('throws CursorError for a tampered cursor', async () => {
      const cursor = makeCursor('amount', makeRow('a'));
      const tampered = cursor.slice(0, -5) + 'abcde';

      await expect(
        getInvoicesWithPagination({
          sorting: { sortBy: 'amount', order: 'asc' },
          pagination: { cursor: tampered },
        })
      ).rejects.toThrow(CursorError);
    });

    it('throws CursorError when cursor sort field does not match request sort field', async () => {
      const cursor = makeCursor('amount', makeRow('a'));

      await expect(
        getInvoicesWithPagination({
          sorting: { sortBy: 'date', order: 'asc' },
          pagination: { cursor },
        })
      ).rejects.toThrow(CursorError);
    });

    it('applies filters together with cursor pagination', async () => {
      const cursor = makeCursor('amount', makeRow('b', { amount: 200 }));
      mockDbResult([makeRow('c', { amount: 300 })], 2);

      await getInvoicesWithPagination({
        filters: { status: 'approved' },
        sorting: { sortBy: 'amount', order: 'asc' },
        pagination: { cursor, limit: 2 },
      });

      const q = getMockQuery();
      // The filter should have been applied (status = 'approved')
      // The keyset predicate should use the cursor value
      expect(q.where).toHaveBeenCalledWith('status', 'approved');
    });
  });

  // ── Offset-based pagination (legacy) ──────────────────────────────────────

  describe('offset-based pagination (legacy)', () => {
    it('returns first page with totalPages', async () => {
      const rows = [makeRow('a'), makeRow('b'), makeRow('c')];
      mockDbResult(rows, 20);

      const result = await getInvoicesWithPagination({
        pagination: { page: 1, limit: 2 },
      });

      expect(result.data).toHaveLength(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.totalPages).toBe(10);
      expect(result.meta.hasMore).toBe(true);
    });

    it('returns a nextCursor even in offset mode when more rows exist', async () => {
      const rows = [makeRow('a'), makeRow('b'), makeRow('c')];
      mockDbResult(rows, 20);

      const result = await getInvoicesWithPagination({
        sorting: { sortBy: 'created_at', order: 'desc' },
        pagination: { page: 1, limit: 2 },
      });

      expect(result.meta.nextCursor).toBeTruthy();
      const decoded = decodeCursor(result.meta.nextCursor, 'created_at');
      expect(decoded.id).toBe('b');
    });

    it('returns hasMore=false on last page', async () => {
      const rows = [makeRow('a')];
      mockDbResult(rows, 1);

      const result = await getInvoicesWithPagination({
        pagination: { page: 1, limit: 2 },
      });

      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    it('ignores page when cursor is supplied', async () => {
      // When cursor is present, the code should take the cursor path
      const cursor = makeCursor('created_at', makeRow('b'));
      const rows = [makeRow('c')];
      mockDbResult(rows, 5);

      const result = await getInvoicesWithPagination({
        pagination: { cursor, page: 999, limit: 2 },
      });

      // Should have used cursor (keyset) path — not offset
      expect(result.data).toHaveLength(1);
    });
  });

  // ── Boundary conditions ───────────────────────────────────────────────────

  describe('boundary conditions', () => {
    it('exact page-size boundary: returns hasMore=true with nextCursor', async () => {
      // limit=3, db has exactly 3+1=4 rows → hasMore=true
      // Provide 4 rows so limit+1 query gets exactly 4
      const rows = [makeRow('a'), makeRow('b'), makeRow('c'), makeRow('d')];
      mockDbResult(rows, 4);

      const result = await getInvoicesWithPagination({
        pagination: { limit: 3 },
      });

      expect(result.data).toHaveLength(3);
      expect(result.meta.hasMore).toBe(true);
      expect(result.meta.nextCursor).toBeTruthy();
    });

    it('exactly one page of data: returns hasMore=false', async () => {
      const rows = [makeRow('a'), makeRow('b'), makeRow('c')];
      mockDbResult(rows, 3);

      const result = await getInvoicesWithPagination({
        pagination: { limit: 3 },
      });

      expect(result.data).toHaveLength(3);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });
  });

  // ── Limit clamping ────────────────────────────────────────────────────────

  describe('limit clamping', () => {
    it('clamps limit to max 100', async () => {
      mockDbResult([], 0);

      const result = await getInvoicesWithPagination({
        pagination: { limit: 999 },
      });

      expect(result.meta.limit).toBe(100);
    });

    it('defaults limit to 10 when not provided', async () => {
      mockDbResult([], 0);

      const result = await getInvoicesWithPagination({});

      expect(result.meta.limit).toBe(10);
    });

    it('defaults limit to 10 when limit is NaN', async () => {
      mockDbResult([], 0);

      const result = await getInvoicesWithPagination({
        pagination: { limit: 'abc' },
      });

      expect(result.meta.limit).toBe(10);
    });
  });

  // ── Default sorting ───────────────────────────────────────────────────────

  describe('default sorting', () => {
    it('defaults to created_at desc when no sortBy is given', async () => {
      mockDbResult([makeRow('a')], 1);

      await getInvoicesWithPagination({});

      const q = getMockQuery();
      expect(q.orderBy).toHaveBeenCalledWith('created_at', 'desc');
    });
  });
});

describe('invoice cursor contract', () => {
  it('uses the unique id as the deterministic tie-breaker', () => {
    const cursor = decodeInvoiceCursor(
      encodeInvoiceCursor({ id: 10, created_at: '2026-08-20T00:00:00.000Z' }, 'created_at'),
      'created_at',
    );

    expect(cursor.id).toBe('10');
    expect(cursor.sortValue).toBe('2026-08-20T00:00:00.000Z');
  });

  it.each([
    ['asc', 11, 9],
    ['desc', 9, 11],
  ])('orders equal sort values by id in %s mode', (order, idAfter, idBefore) => {
    const cursor = { sortValue: '2026-08-20T00:00:00.000Z', id: '10' };
    expect(isAfterInvoiceCursor({ id: idAfter, created_at: cursor.sortValue }, cursor, 'created_at', order)).toBe(true);
    expect(isAfterInvoiceCursor({ id: idBefore, created_at: cursor.sortValue }, cursor, 'created_at', order)).toBe(false);
  });

  it('does not repeat existing rows when a newer row is inserted between pages', () => {
    const cursor = { sortValue: '2026-08-20T00:00:00.000Z', id: '20' };
    const inserted = { id: 99, created_at: '2026-08-21T00:00:00.000Z' };
    const remainingExisting = { id: 19, created_at: '2026-08-19T00:00:00.000Z' };

    // The new row is ahead of a descending cursor and belongs to the next
    // fresh scan, while the older existing row remains eligible exactly once.
    expect(isAfterInvoiceCursor(inserted, cursor, 'created_at', 'desc')).toBe(false);
    expect(isAfterInvoiceCursor(remainingExisting, cursor, 'created_at', 'desc')).toBe(true);
  });

  it('clamps every service caller to the bounded page size', () => {
    expect(normalizeInvoicePageSize(9999)).toBe(100);
    expect(normalizeInvoicePageSize('25')).toBe(25);
    expect(normalizeInvoicePageSize('not-a-number')).toBe(10);
    expect(normalizeInvoicePageSize(0)).toBe(10);
  });
});
