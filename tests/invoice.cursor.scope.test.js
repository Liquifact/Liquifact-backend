'use strict';

/**
 * Signed invoice cursor scoping (#1217).
 *
 * A keyset cursor is a statement about one ordered result set. Before this,
 * the signature protected the *position* but said nothing about which request
 * the position belonged to, so a cursor copied from one filter — or from one
 * tenant's listing — was accepted verbatim and used to seek into a different
 * tenant's rows. That skips records at best and discloses their ordering at
 * worst.
 *
 * The cases below pin the binding and each edge case the issue names:
 *   - cursor reused with another filter
 *   - tampered cursor
 *   - expired cursor
 *   - empty page after deletion
 *   - maximum page size
 *
 * @jest-environment node
 */

// ── Knex mock ────────────────────────────────────────────────────────────────

// Replaces the broad repository fixture with a purpose-built query builder so a
// case can control the count row and the page rows independently — the same
// approach tests/invoice.pagination.test.js takes.
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
    andWhere: jest.fn().mockReturnThis(),
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

const request = require('supertest');
const { createApp } = require('../src/app');
const { encodeCursor, decodeCursor, CursorError } = require('../src/utils/cursorPagination');
const {
  MAX_INVOICE_PAGE_SIZE,
  buildInvoiceCursorScope,
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  normalizeInvoicePageSize,
  normalizeInvoiceQuery,
} = require('../src/utils/invoicePagination');
const { validateInvoiceQueryParams } = require('../src/utils/validators');
const { getInvoicesWithPagination } = require('../src/services/invoiceService');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(id, overrides = {}) {
  return {
    id,
    invoice_id: `inv_${id}`,
    amount: 1000,
    date: '2024-01-15',
    created_at: '2024-01-01T00:00:00Z',
    status: 'pending',
    ...overrides,
  };
}

/** Scope for one specific read, on the list endpoint. */
function listScope(overrides = {}) {
  const { tenantId, filters = {}, sortBy = 'created_at', order = 'desc' } = overrides;
  return buildInvoiceCursorScope({ tenantId, filters, sortBy, order, source: 'invoices' });
}

/** A signed cursor for the read described by `context`. */
function cursorFor(row, context = {}) {
  const { sortBy = 'created_at' } = context;
  return encodeInvoiceCursor(row, sortBy, listScope(context));
}

/**
 * Run `fn` and return the thrown error, failing the case if nothing throws.
 * Keeps the "rejects, and rejects safely" assertions readable.
 */
function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

// ── Query fingerprint ─────────────────────────────────────────────────────────

describe('invoice cursor scope fingerprint', () => {
  it('drops empty values and orders keys so equal queries agree', () => {
    expect(normalizeInvoiceQuery({ status: 'paid', smeId: undefined, buyerId: null }))
      .toEqual({ status: 'paid' });
    expect(normalizeInvoiceQuery({ buyerId: 'b-1', status: 'paid' }))
      .toEqual(normalizeInvoiceQuery({ status: 'paid', buyerId: 'b-1' }));
  });

  it('keeps filter values verbatim rather than folding them together', () => {
    // Folding case here would let two genuinely different filters share one
    // fingerprint — reintroducing the reuse this is meant to stop.
    expect(normalizeInvoiceQuery({ smeId: 'SME-A' })).not.toEqual(normalizeInvoiceQuery({ smeId: 'sme-a' }));
  });

  it('is deterministic for the same read', () => {
    expect(listScope({ tenantId: 'tenant-a', filters: { status: 'open' } }))
      .toBe(listScope({ tenantId: 'tenant-a', filters: { status: 'open' } }));
  });

  it.each([
    ['tenant', { tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }],
    ['filter value', { filters: { status: 'open' } }, { filters: { status: 'paid' } }],
    ['filter presence', { filters: { status: 'open' } }, { filters: {} }],
    ['sort alias', { sortBy: 'created_at' }, { sortBy: 'amount' }],
    ['sort direction', { order: 'desc' }, { order: 'asc' }],
  ])('changes when the %s changes', (_label, left, right) => {
    expect(listScope(left)).not.toBe(listScope(right));
  });

  it('separates result sets that share a tenant and filter', () => {
    // `source` keeps the SME listing and the public list from ever colliding.
    expect(buildInvoiceCursorScope({ tenantId: 't', filters: {}, sortBy: 'created_at', order: 'desc', source: 'invoices' }))
      .not.toBe(buildInvoiceCursorScope({ tenantId: 't', filters: {}, sortBy: 'created_at', order: 'desc', source: 'sme-invoices' }));
  });
});

// ── Binding enforcement ───────────────────────────────────────────────────────

describe('invoice cursor binding', () => {
  const row = makeRow(7);

  it('round-trips a cursor under the read it was minted for', () => {
    const scope = listScope({ tenantId: 'tenant-a', filters: { status: 'open' } });
    const decoded = decodeInvoiceCursor(cursorFor(row, { tenantId: 'tenant-a', filters: { status: 'open' } }), 'created_at', scope);

    expect(decoded.id).toBe('7');
    expect(decoded.sortField).toBe('created_at');
  });

  it('refuses to mint or accept an unscoped cursor at all', () => {
    expect(captureThrow(() => encodeInvoiceCursor(row, 'created_at'))).toBeInstanceOf(TypeError);
    expect(captureThrow(() => decodeInvoiceCursor('x.y', 'created_at'))).toBeInstanceOf(TypeError);
    expect(captureThrow(() => encodeInvoiceCursor(row, 'created_at', ''))).toBeInstanceOf(TypeError);
  });

  it('rejects a cursor reused with another filter', () => {
    const cursor = cursorFor(row, { filters: { status: 'open' } });

    expect(captureThrow(() => decodeInvoiceCursor(cursor, 'created_at', listScope({ filters: { status: 'paid' } }))))
      .toBeInstanceOf(CursorError);
  });

  it('rejects a cursor copied to another tenant', () => {
    const cursor = cursorFor(row, { tenantId: 'tenant-a' });

    expect(captureThrow(() => decodeInvoiceCursor(cursor, 'created_at', listScope({ tenantId: 'tenant-b' }))))
      .toBeInstanceOf(CursorError);
    // …and the same cursor is still fine for the tenant it was issued to.
    expect(decodeInvoiceCursor(cursor, 'created_at', listScope({ tenantId: 'tenant-a' })).id).toBe('7');
  });

  it('rejects a cursor replayed with the sort direction flipped', () => {
    const cursor = cursorFor(row, { order: 'desc' });

    expect(captureThrow(() => decodeInvoiceCursor(cursor, 'created_at', listScope({ order: 'asc' }))))
      .toBeInstanceOf(CursorError);
  });

  it('rejects a legacy, unbound cursor once a scope is expected', () => {
    const legacy = encodeCursor({ sortField: 'created_at', sortValue: row.created_at, id: '7' });

    expect(captureThrow(() => decodeInvoiceCursor(legacy, 'created_at', listScope())))
      .toBeInstanceOf(CursorError);
  });

  it('does not echo the foreign scope back to the caller', () => {
    const cursor = cursorFor(row, { tenantId: 'tenant-a', filters: { buyerId: 'buyer-9' } });
    const err = captureThrow(() => decodeInvoiceCursor(
      cursor,
      'created_at',
      listScope({ tenantId: 'tenant-b', filters: { buyerId: 'buyer-9' } }),
    ));

    expect(err).toBeInstanceOf(CursorError);
    expect(err.message).toBe('Cursor does not match the requested query');
    for (const value of ['tenant-a', 'tenant-b', 'buyer-9']) {
      expect(err.message).not.toContain(value);
    }
  });
});

// ── Edge cases named by the issue ─────────────────────────────────────────────

describe('invoice cursor edge cases', () => {
  const row = makeRow(7);

  it('rejects a tampered cursor', () => {
    const cursor = cursorFor(row, {});
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`;

    expect(captureThrow(() => decodeInvoiceCursor(tampered, 'created_at', listScope()))).toBeInstanceOf(CursorError);
  });

  it('rejects an expired cursor when expiry enforcement is enabled', () => {
    const previousEnabled = process.env.CURSOR_TTL_ENABLED;
    const previousTtl = process.env.CURSOR_TTL_SECONDS;
    process.env.CURSOR_TTL_ENABLED = 'true';
    process.env.CURSOR_TTL_SECONDS = '1';

    try {
      const scope = listScope();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 10_000);
      const stale = encodeInvoiceCursor(row, 'created_at', scope);
      clock.mockRestore();

      const err = captureThrow(() => decodeInvoiceCursor(stale, 'created_at', scope));
      expect(err).toBeInstanceOf(CursorError);
      expect(err.message).toMatch(/expired/);
    } finally {
      if (previousEnabled === undefined) delete process.env.CURSOR_TTL_ENABLED;
      else process.env.CURSOR_TTL_ENABLED = previousEnabled;
      if (previousTtl === undefined) delete process.env.CURSOR_TTL_SECONDS;
      else process.env.CURSOR_TTL_SECONDS = previousTtl;
    }
  });

  it('returns an empty page with no next cursor once the tail is deleted', async () => {
    mockTotal = { total: 3 };
    mockRows = [makeRow(3), makeRow(2), makeRow(1)];

    const first = await getInvoicesWithPagination({ pagination: { limit: 2 } });
    expect(first.data).toHaveLength(2);
    expect(first.meta.hasMore).toBe(true);
    expect(first.meta.nextCursor).toBeTruthy();

    // Everything the cursor still pointed at has since been soft-deleted. The
    // page must come back empty and hand out no further cursor, so a client
    // refreshing cannot loop on a page that no longer exists.
    mockTotal = { total: 0 };
    mockRows = [];

    const second = await getInvoicesWithPagination({
      pagination: { limit: 2, cursor: first.meta.nextCursor },
    });

    expect(second.data).toEqual([]);
    expect(second.meta.hasMore).toBe(false);
    expect(second.meta.nextCursor).toBeNull();
  });

  it('clamps to the maximum page size and keeps the cursor valid across the change', async () => {
    expect(normalizeInvoicePageSize(1000)).toBe(MAX_INVOICE_PAGE_SIZE);
    expect(validateInvoiceQueryParams({ limit: '1000' }).validatedParams.pagination.limit)
      .toBe(MAX_INVOICE_PAGE_SIZE);

    mockTotal = { total: 3 };
    mockRows = [makeRow(3), makeRow(2), makeRow(1)];

    const first = await getInvoicesWithPagination({ pagination: { limit: 2 } });

    mockRows = [makeRow(1)];
    const second = await getInvoicesWithPagination({
      pagination: { limit: 100, cursor: first.meta.nextCursor },
    });

    // `limit` is deliberately not part of the fingerprint: it changes how many
    // rows come back, not which rows the ordering describes.
    expect(second.meta.limit).toBe(MAX_INVOICE_PAGE_SIZE);
    expect(second.data).toHaveLength(1);
  });
});

// ── Service enforcement ───────────────────────────────────────────────────────

describe('getInvoicesWithPagination scope enforcement', () => {
  it('continues the page for the same read', async () => {
    mockTotal = { total: 5 };
    mockRows = [makeRow(3), makeRow(2)];

    const cursor = cursorFor(makeRow(4), {});
    const result = await getInvoicesWithPagination({ pagination: { cursor, limit: 2 } });

    expect(result.data).toHaveLength(2);
  });

  it('rejects a cursor carried across filters', async () => {
    const cursor = cursorFor(makeRow(4), { filters: { status: 'open' } });

    await expect(
      getInvoicesWithPagination({
        filters: { status: 'paid' },
        pagination: { cursor, limit: 2 },
      }),
    ).rejects.toThrow(CursorError);
  });

  it('rejects a cursor carried across tenants', async () => {
    const cursor = cursorFor(makeRow(4), { tenantId: 'tenant-a' });

    await expect(
      getInvoicesWithPagination({
        tenantId: 'tenant-b',
        pagination: { cursor, limit: 2 },
      }),
    ).rejects.toThrow(CursorError);
  });

  it('reports the mismatch as a scoped CursorError carrying no foreign values', async () => {
    const cursor = cursorFor(makeRow(4), { tenantId: 'tenant-a', filters: { smeId: 'sme-1' } });

    await expect(
      getInvoicesWithPagination({
        tenantId: 'tenant-b',
        filters: { smeId: 'sme-2' },
        pagination: { cursor, limit: 2 },
      }),
    ).rejects.toThrow('Cursor does not match the requested query');
  });
});

// ── Route enforcement ─────────────────────────────────────────────────────────

describe('GET /api/invoices cursor scoping', () => {
  it('answers a foreign cursor with a structured 400 and no internals', async () => {
    const app = createApp();
    // Minted for `pending`, replayed against `paid` — both valid statuses, so
    // the only thing wrong with the request is the cursor.
    const cursor = cursorFor(makeRow(4), { filters: { status: 'pending' } });

    const res = await request(app).get(`/api/invoices?status=paid&cursor=${encodeURIComponent(cursor)}`);

    expect(res.statusCode).toBe(400);
    expect(res.body.type).toBe('https://liquifact.io/problems/validation-error');
    expect(res.body.fieldErrors.cursor).toBe('Cursor does not match the requested query');
    // The query itself was valid; only the cursor was rejected.
    expect(res.body.fieldErrors.status).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|\.js:\d+/);
  });

  it('serves the page when the cursor matches the query', async () => {
    const app = createApp();
    mockTotal = { total: 5 };
    mockRows = [makeRow(3), makeRow(2)];
    const cursor = cursorFor(makeRow(4), { filters: { status: 'pending' } });

    const res = await request(app)
      .get(`/api/invoices?status=pending&cursor=${encodeURIComponent(cursor)}&limit=2`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta.limit).toBe(2);
  });
});

// ── Cross-cutting guarantee ───────────────────────────────────────────────────

describe('position-only cursor consumers', () => {
  it('leaves unscoped cursors working for endpoints that never pass a scope', () => {
    // marketplaceService, indexerService, kycWebhookService, kycQuarantineService,
    // adminWebhooks and apiKeys all call encodeCursor/decodeCursor without a
    // scope. That path must stay byte-identical.
    const legacy = encodeCursor({ sortField: 'amount', sortValue: 42, id: 'inv_1' });

    expect(legacy).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(decodeCursor(legacy, 'amount').id).toBe('inv_1');
    expect(decodeCursor(legacy, 'amount').scope).toBeUndefined();
  });
});
