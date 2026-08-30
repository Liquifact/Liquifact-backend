'use strict';

const {
  decodeCursor,
  CursorError,
} = require('../src/utils/cursorPagination');
const {
  DEFAULT_INVOICE_PAGE_SIZE,
  INVOICE_SORT_COLUMNS,
  MAX_INVOICE_PAGE_SIZE,
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  isAfterInvoiceCursor,
  normalizeInvoicePageSize,
  resolveInvoiceSort,
} = require('../src/utils/invoicePagination');
const { validateInvoiceQueryParams } = require('../src/utils/validators');

function invoice(id, createdAt, amount = 100) {
  return {
    id,
    invoice_id: `inv-${id}`,
    created_at: createdAt,
    date: createdAt.slice(0, 10),
    amount,
  };
}

function compareRows(left, right, sortBy, order) {
  const { column } = resolveInvoiceSort(sortBy, order);
  const primary = left[column] < right[column] ? -1 : left[column] > right[column] ? 1 : 0;
  if (primary !== 0) return order === 'asc' ? primary : -primary;
  const leftId = Number(left.id);
  const rightId = Number(right.id);
  const tie = Number.isSafeInteger(leftId) && Number.isSafeInteger(rightId)
    ? leftId - rightId
    : String(left.id).localeCompare(String(right.id));
  return order === 'asc' ? tie : -tie;
}

function scanPages(rows, limit, sortBy, order, insertedRows = []) {
  const allRows = [...rows];
  const pages = [];
  let cursor = null;
  let firstPage = true;

  while (true) {
    const visibleRows = allRows
      .filter((row) => !cursor || isAfterInvoiceCursor(row, cursor, sortBy, order))
      .sort((left, right) => compareRows(left, right, sortBy, order));
    const page = visibleRows.slice(0, limit);
    pages.push(page);
    if (firstPage) {
      allRows.push(...insertedRows);
      firstPage = false;
    }
    if (visibleRows.length <= limit) return pages;
    const last = page[page.length - 1];
    cursor = decodeInvoiceCursor(encodeInvoiceCursor(last, sortBy), sortBy);
  }
}

describe('invoice cursor contract integration', () => {
  const sameTimestamp = '2026-08-20T00:00:00.000Z';
  const rows = [
    invoice(1, sameTimestamp, 100),
    invoice(2, sameTimestamp, 200),
    invoice(3, sameTimestamp, 300),
    invoice(4, '2026-08-19T00:00:00.000Z', 400),
    invoice(5, '2026-08-18T00:00:00.000Z', 500),
  ];

  it('exposes only the supported public sort aliases', () => {
    expect(INVOICE_SORT_COLUMNS).toEqual({
      amount: 'amount',
      date: 'date',
      created_at: 'created_at',
    });
  });

  it('resolves unknown sort input to the documented default', () => {
    expect(resolveInvoiceSort('not-a-column', 'sideways')).toEqual({
      alias: 'created_at',
      column: 'created_at',
      order: 'desc',
    });
  });

  it.each([
    ['amount', 'asc'],
    ['amount', 'desc'],
    ['date', 'asc'],
    ['date', 'desc'],
    ['created_at', 'asc'],
    ['created_at', 'desc'],
  ])('round-trips an opaque cursor for %s/%s', (sortBy, order) => {
    const source = invoice(42, '2026-08-21T00:00:00.000Z', 4200);
    const encoded = encodeInvoiceCursor(source, sortBy);
    const decoded = decodeInvoiceCursor(encoded, sortBy);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(decoded.id).toBe('42');
    expect(decoded.sortValue).toBe(source[INVOICE_SORT_COLUMNS[sortBy]]);
    expect(decoded.sortField).toBe(sortBy);
    expect(order).toBeDefined();
  });

  it('rejects a row without a unique database id', () => {
    expect(() => encodeInvoiceCursor({ created_at: sameTimestamp }, 'created_at'))
      .toThrow('unique id tiebreaker');
  });

  it('rejects a signed cursor when the requested sort alias changes', () => {
    const cursor = encodeInvoiceCursor(rows[0], 'created_at');

    expect(() => decodeInvoiceCursor(cursor, 'amount')).toThrow(CursorError);
  });

  it('rejects a cursor whose signature was changed', () => {
    const cursor = encodeInvoiceCursor(rows[0], 'created_at');
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`;

    expect(() => decodeCursor(tampered, 'created_at')).toThrow(CursorError);
  });

  it('rejects a cursor with an invalid shape before any row can be selected', () => {
    expect(() => decodeInvoiceCursor('not-a-cursor', 'created_at')).toThrow(CursorError);
    expect(() => decodeInvoiceCursor('a.', 'created_at')).toThrow(CursorError);
  });

  it('rejects expired cursors when expiry enforcement is enabled', () => {
    const previousEnabled = process.env.CURSOR_TTL_ENABLED;
    const previousTtl = process.env.CURSOR_TTL_SECONDS;
    process.env.CURSOR_TTL_ENABLED = 'true';
    process.env.CURSOR_TTL_SECONDS = '1';

    try {
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now - 10000);
      const staleCursor = encodeInvoiceCursor(rows[0], 'created_at');
      clock.mockRestore();

      expect(() => decodeInvoiceCursor(staleCursor, 'created_at')).toThrow(CursorError);
    } finally {
      if (previousEnabled === undefined) delete process.env.CURSOR_TTL_ENABLED;
      else process.env.CURSOR_TTL_ENABLED = previousEnabled;
      if (previousTtl === undefined) delete process.env.CURSOR_TTL_SECONDS;
      else process.env.CURSOR_TTL_SECONDS = previousTtl;
    }
  });

  it('returns every original row exactly once across descending pages', () => {
    const pages = scanPages(rows, 2, 'created_at', 'desc');
    const ids = pages.flat().map((row) => row.id);

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(ids).toEqual([3, 2, 1, 4, 5]);
    expect(new Set(ids).size).toBe(rows.length);
  });

  it('returns every original row exactly once across ascending pages', () => {
    const pages = scanPages(rows, 2, 'created_at', 'asc');
    const ids = pages.flat().map((row) => row.id);

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(ids).toEqual([5, 4, 1, 2, 3]);
    expect(new Set(ids).size).toBe(rows.length);
  });

  it('does not add a newer row to an in-progress descending scan', () => {
    const inserted = invoice(99, '2026-08-21T00:00:00.000Z', 999);
    const pages = scanPages(rows, 2, 'created_at', 'desc', [inserted]);
    const ids = pages.flat().map((row) => row.id);

    expect(ids).toEqual([3, 2, 1, 4, 5]);
    expect(ids).not.toContain(99);
  });

  it('includes a row inserted behind the cursor exactly once', () => {
    const inserted = invoice(99, '2026-08-19T12:00:00.000Z', 999);
    const pages = scanPages(rows, 2, 'created_at', 'desc', [inserted]);
    const ids = pages.flat().map((row) => row.id);

    expect(ids).toContain(99);
    expect(new Set(ids).size).toBe(rows.length + 1);
  });

  it('returns a short final page and never creates a terminal cursor', () => {
    const pages = scanPages(rows.slice(0, 2), 2, 'created_at', 'desc');

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(2);
    expect(isAfterInvoiceCursor(rows[0], {
      sortValue: rows[1].created_at,
      id: String(rows[1].id),
    }, 'created_at', 'desc')).toBe(true);
  });

  it('uses numeric id ordering for tied database values', () => {
    const cursor = { sortValue: sameTimestamp, id: '10' };

    expect(isAfterInvoiceCursor(invoice(2, sameTimestamp), cursor, 'created_at', 'asc')).toBe(false);
    expect(isAfterInvoiceCursor(invoice(11, sameTimestamp), cursor, 'created_at', 'asc')).toBe(true);
    expect(isAfterInvoiceCursor(invoice(9, sameTimestamp), cursor, 'created_at', 'desc')).toBe(true);
  });
});

describe('invoice pagination validation boundary', () => {
  it('uses the default and maximum constants consistently', () => {
    expect(DEFAULT_INVOICE_PAGE_SIZE).toBe(10);
    expect(MAX_INVOICE_PAGE_SIZE).toBe(100);
    expect(normalizeInvoicePageSize(undefined)).toBe(DEFAULT_INVOICE_PAGE_SIZE);
    expect(normalizeInvoicePageSize(null)).toBe(DEFAULT_INVOICE_PAGE_SIZE);
  });

  it.each([
    ['1', 1],
    ['100', 100],
    ['101', 100],
    ['999999', 100],
    [1.9, 1],
  ])('normalizes limit %s to %s', (input, expected) => {
    expect(normalizeInvoicePageSize(input)).toBe(expected);
  });

  it.each([0, -1, NaN, '0', '-10', 'garbage'])('defaults unusable limit %s', (input) => {
    expect(normalizeInvoicePageSize(input)).toBe(DEFAULT_INVOICE_PAGE_SIZE);
  });

  it('clamps an oversized HTTP limit without changing other query fields', () => {
    const result = validateInvoiceQueryParams({
      limit: '1000',
      status: 'pending',
      sortBy: 'created_at',
      order: 'desc',
    });

    expect(result.isValid).toBe(true);
    expect(result.validatedParams.pagination.limit).toBe(100);
    expect(result.validatedParams.filters.status).toBe('pending');
    expect(result.validatedParams.sorting).toEqual({ sortBy: 'created_at', order: 'desc' });
  });

  it('still rejects zero and negative HTTP limits', () => {
    for (const limit of ['0', '-1']) {
      const result = validateInvoiceQueryParams({ limit });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors.limit).toBe('limit must be an integer between 1 and 100');
    }
  });

  it('keeps the cursor request envelope separate from offset pagination', () => {
    const cursorRequest = validateInvoiceQueryParams({ cursor: 'signed.cursor', limit: '25' });
    const offsetRequest = validateInvoiceQueryParams({ page: '3', limit: '25' });

    expect(cursorRequest.validatedParams.pagination).toEqual({ cursor: 'signed.cursor', limit: 25 });
    expect(offsetRequest.validatedParams.pagination).toEqual({ page: 3, limit: 25 });
  });
});
