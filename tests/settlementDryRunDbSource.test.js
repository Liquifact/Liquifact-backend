'use strict';

/**
 * Tests for `createTenantInvoiceFundingDbSource` against a fake Knex query
 * builder. Strategy mirrors `tests/reconcileEscrow.test.js`: each table name
 * returns a chainable builder whose terminal `await` resolves the next
 * queued row set for that table, so the test controls exactly what each
 * query returns without a real database.
 */

const { MAX_PAGE_SIZE, createTenantInvoiceFundingDbSource } = require('../src/jobs/settlementDryRunDbSource');

function makeFakeDb() {
  const calls = []; // records every table + terminal chain call for assertions
  const queues = { invoices: [], escrow_operations: [] };

  function makeBuilder(tableName) {
    const record = { table: tableName, wheres: [], whereNulls: [], whereIns: [], joins: [], selects: [], limit: null, orderBy: null };
    calls.push(record);

    const builder = {
      leftJoin(table, a, b) { record.joins.push({ table, a, b }); return builder; },
      where(col, opOrVal, maybeVal) {
        if (maybeVal === undefined) { record.wheres.push([col, opOrVal]); }
        else { record.wheres.push([col, opOrVal, maybeVal]); }
        return builder;
      },
      whereNull(col) { record.whereNulls.push(col); return builder; },
      whereIn(col, vals) { record.whereIns.push([col, vals]); return builder; },
      select(...cols) { record.selects.push(...cols); return builder; },
      orderBy(col, dir) { record.orderBy = [col, dir]; return builder; },
      limit(n) { record.limit = n; return builder; },
      then(resolve, reject) {
        const queue = queues[tableName];
        if (!queue) { return Promise.reject(new Error(`no queue configured for table ${tableName}`)).then(resolve, reject); }
        if (queue.__fail) { return Promise.reject(queue.__fail).then(resolve, reject); }
        const rows = queue.length ? queue.shift() : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  }

  const db = jest.fn((tableName) => makeBuilder(tableName));
  db.__calls = calls;
  db.__queues = queues;
  return db;
}

describe('createTenantInvoiceFundingDbSource — construction guards', () => {
  it('throws synchronously without dbClient', () => {
    expect(() => createTenantInvoiceFundingDbSource({ tenantId: 't1' })).toThrow(/dbClient/);
  });

  it('throws synchronously without a non-empty tenantId', () => {
    const dbClient = makeFakeDb();
    expect(() => createTenantInvoiceFundingDbSource({ dbClient })).toThrow(/tenantId/);
    expect(() => createTenantInvoiceFundingDbSource({ dbClient, tenantId: '' })).toThrow(/tenantId/);
    expect(() => createTenantInvoiceFundingDbSource({ dbClient, tenantId: 42 })).toThrow(/tenantId/);
  });
});

describe('createTenantInvoiceFundingDbSource — readBatch', () => {
  it('scopes both queries to the given tenantId and excludes soft-deleted invoices', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([
      { id: 'inv-1', amount: '100.00', currency: 'USD', status: 'funded', fundedAmount: '100.00' },
    ]);
    dbClient.__queues.escrow_operations.push([
      { id: 'op-1', invoiceId: 'inv-1', amount: '60.00' },
      { id: 'op-2', invoiceId: 'inv-1', amount: '40.00' },
    ]);

    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    const result = await source.readBatch(null, 100);

    const invoiceCall = dbClient.__calls.find((c) => c.table === 'invoices');
    expect(invoiceCall.wheres).toEqual(expect.arrayContaining([['invoices.tenant_id', 'tenant-a']]));
    expect(invoiceCall.whereNulls).toEqual(['invoices.deleted_at']);

    const fundingCall = dbClient.__calls.find((c) => c.table === 'escrow_operations');
    expect(fundingCall.wheres).toEqual(expect.arrayContaining([
      ['escrow_operations.tenant_id', 'tenant-a'],
      ['escrow_operations.operation_type', 'fund'],
      ['escrow_operations.status', 'completed'],
    ]));

    expect(result).toEqual({
      records: [{
        id: 'inv-1',
        amount: '100.00',
        currency: 'USD',
        status: 'funded',
        fundedAmount: '100.00',
        fundingRecords: [{ id: 'op-1', amount: '60.00' }, { id: 'op-2', amount: '40.00' }],
      }],
      nextCursor: null,
    });
  });

  it('defaults fundedAmount to "0" when no escrow_summaries row exists (left join miss)', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([
      { id: 'inv-1', amount: '100.00', currency: 'USD', status: 'pending_verification', fundedAmount: null },
    ]);
    dbClient.__queues.escrow_operations.push([]);

    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    const result = await source.readBatch(null, 10);
    expect(result.records[0].fundedAmount).toBe('0');
    expect(result.records[0].fundingRecords).toEqual([]);
  });

  it('does not query escrow_operations at all when the invoice page is empty', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([]);

    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    const result = await source.readBatch(null, 10);

    expect(result).toEqual({ records: [], nextCursor: null });
    expect(dbClient.__calls.some((c) => c.table === 'escrow_operations')).toBe(false);
  });

  it('paginates with keyset cursor on invoices.id and reports nextCursor from the last row', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([
      { id: 'inv-1', amount: '10.00', currency: 'USD', status: 'funded', fundedAmount: '10.00' },
      { id: 'inv-2', amount: '10.00', currency: 'USD', status: 'funded', fundedAmount: '10.00' },
    ]);
    dbClient.__queues.escrow_operations.push([]);

    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    const result = await source.readBatch(null, 2);

    expect(result.nextCursor).toBe('inv-2');
    const invoiceCall = dbClient.__calls.find((c) => c.table === 'invoices');
    // No cursor filter on the first page.
    expect(invoiceCall.wheres.some(([col]) => col === 'invoices.id')).toBe(false);
  });

  it('applies the cursor as a > filter on invoices.id for subsequent pages', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([]);
    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    await source.readBatch('inv-2', 2);

    const invoiceCall = dbClient.__calls.find((c) => c.table === 'invoices');
    expect(invoiceCall.wheres).toEqual(expect.arrayContaining([['invoices.id', '>', 'inv-2']]));
  });

  it('returns nextCursor: null when the page is shorter than the requested limit (last page)', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([
      { id: 'inv-1', amount: '10.00', currency: 'USD', status: 'funded', fundedAmount: '10.00' },
    ]);
    dbClient.__queues.escrow_operations.push([]);

    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    const result = await source.readBatch(null, 50);
    expect(result.nextCursor).toBeNull();
  });

  it('clamps an absurd limit into [1, MAX_PAGE_SIZE] without throwing', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([]);
    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    await source.readBatch(null, 999_999);
    const invoiceCall = dbClient.__calls.find((c) => c.table === 'invoices');
    expect(invoiceCall.limit).toBe(MAX_PAGE_SIZE);

    await source.readBatch(null, -5);
    const secondCall = dbClient.__calls.filter((c) => c.table === 'invoices')[1];
    expect(secondCall.limit).toBe(1);
  });

  it('propagates a DB read failure to the caller (no swallowing)', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.__fail = new Error('connection terminated unexpectedly');
    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    await expect(source.readBatch(null, 10)).rejects.toThrow('connection terminated unexpectedly');
  });

  it('groups multiple funding rows per invoice correctly across a multi-invoice page', async () => {
    const dbClient = makeFakeDb();
    dbClient.__queues.invoices.push([
      { id: 'inv-1', amount: '100.00', currency: 'USD', status: 'funded', fundedAmount: '100.00' },
      { id: 'inv-2', amount: '50.00', currency: 'USD', status: 'partially_funded', fundedAmount: '20.00' },
    ]);
    dbClient.__queues.escrow_operations.push([
      { id: 'op-1', invoiceId: 'inv-1', amount: '100.00' },
      { id: 'op-2', invoiceId: 'inv-2', amount: '20.00' },
    ]);

    const source = createTenantInvoiceFundingDbSource({ dbClient, tenantId: 'tenant-a' });
    const result = await source.readBatch(null, 10);

    expect(result.records.find((r) => r.id === 'inv-1').fundingRecords).toEqual([{ id: 'op-1', amount: '100.00' }]);
    expect(result.records.find((r) => r.id === 'inv-2').fundingRecords).toEqual([{ id: 'op-2', amount: '20.00' }]);
  });
});
