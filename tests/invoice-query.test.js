'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { parseInvoiceQuery, queryInvoices, PARAMETERS, SORTS } = require('../src/services/invoice-query');

beforeEach(() => store.reset());

test('limits the list and exposes a cursor and filtered total', async () => {
  const res = await request(app).get('/api/invoices?limit=2');
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(2);
  expect(res.body.count).toBe(2);
  expect(res.body.total).toBe(4);
  expect(typeof res.body.nextCursor).toBe('string');
});

function seedLargeStore() {
  const rows = Array.from({ length: 126 }, (_, index) => ({
    id: `TEST_${String(index).padStart(3, '0')}`, sme: index % 2 ? 'Acme' : 'Other',
    amount: String(index % 9 + 1), fundedAmount: 0, yieldBps: index % 7 * 100,
    status: store.STATUSES[index % 4], currency: index % 3 ? 'USDC' : 'XLM',
    dueDate: `2027-01-${String(index % 28 + 1).padStart(2, '0')}`,
    createdAt: `2026-10-${String(index % 20 + 1).padStart(2, '0')}T00:00:00.000Z`,
    onChain: index % 2 === 0,
  }));
  store.list().splice(0, store.list().length, ...rows);
  return rows;
}

test.each(SORTS)('walks 126 real store records once in stable order with sort=%s', async (sort) => {
  const rows = seedLargeStore();
  const untouched = JSON.stringify(rows);
  const key = sort.replace('-', '');
  const direction = sort.startsWith('-') ? -1 : 1;
  const expected = [...rows].sort((a, b) => {
    const left = key === 'amount' ? Number(a[key]) : a[key];
    const right = key === 'amount' ? Number(b[key]) : b[key];
    return (left < right ? -1 : left > right ? 1 : 0) * direction || a.id.localeCompare(b.id);
  }).map((row) => row.id);
  const ids = [];
  let cursor;
  for (let page = 0; page < 30; page++) {
    const query = { limit: '7', sort, ...(cursor ? { cursor } : {}) };
    const res = await request(app).get('/api/invoices').query(query);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(res.body.data.length);
    expect(res.body.count).toBeLessThanOrEqual(7);
    expect(res.body.total).toBe(126);
    ids.push(...res.body.data.map((row) => row.id));
    cursor = res.body.nextCursor;
    if (cursor === null) {
      break;
    }
  }
  expect(ids).toEqual(expected);
  expect(new Set(ids).size).toBe(126);
  expect(JSON.stringify(rows)).toBe(untouched);
});

test.each([
  [{ status: 'open' }, ['INV_0001', 'INV_0002']],
  [{ status: 'funded,settled' }, ['INV_0003', 'INV_0004']],
  [{ currency: 'XLM' }, ['INV_0001']],
  [{ currency: 'ZZZ' }, []],
  [{ sme: 'NORTHwind' }, ['INV_0002']],
  [{ minAmount: '25000' }, ['INV_0002', 'INV_0003']],
  [{ maxAmount: '100' }, ['INV_0001']],
  [{ minYieldBps: '800' }, ['INV_0001', 'INV_0004']],
  [{ maxYieldBps: '650' }, ['INV_0002']],
  [{ dueBefore: '2026-11-28' }, ['INV_0003', 'INV_0004']],
  [{ dueAfter: '2026-12-30' }, ['INV_0001', 'INV_0002']],
  [{ onChain: 'true' }, ['INV_0001']],
  [{ onChain: 'false' }, ['INV_0002', 'INV_0003', 'INV_0004']],
  [{ status: 'open,funded', currency: 'USDC', minAmount: '20000', maxAmount: '50000', minYieldBps: '600', maxYieldBps: '750', dueBefore: '2026-12-31', dueAfter: '2026-11-01', onChain: 'false', sme: 'North' }, ['INV_0002']],
])('filters %j and reports the filtered total', async (query, ids) => {
  const res = await request(app).get('/api/invoices').query(query);
  expect(res.status).toBe(200);
  expect(res.body.data.map((row) => row.id).sort()).toEqual(ids);
  expect(res.body.total).toBe(ids.length);
  expect(res.body.nextCursor).toBe(null);
});

test('keeps the filtered total on later pages', async () => {
  seedLargeStore();
  const first = await request(app).get('/api/invoices').query({ status: 'open', limit: '7' });
  const second = await request(app).get('/api/invoices').query({ status: 'open', limit: '7', cursor: first.body.nextCursor });
  expect(first.body.total).toBe(32);
  expect(second.body.total).toBe(32);
  expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
});

test.each([
  ['limit=0', 'limit'], ['limit=101', 'limit'], ['limit=1.5', 'limit'], ['limit=2&limit=3', 'limit'],
  ['status=open&status=funded', 'status'], ['status=', 'status'], ['sort=foo', 'sort'],
  ['minAmount=abc', 'minAmount'], ['minAmount=-1', 'minAmount'], ['maxAmount=1e6', 'maxAmount'],
  ['minAmount=2&maxAmount=1', 'maxAmount'], ['minYieldBps=0.5', 'minYieldBps'],
  ['maxYieldBps=10001', 'maxYieldBps'], ['minYieldBps=2&maxYieldBps=1', 'maxYieldBps'],
  ['dueBefore=2027-02-30', 'dueBefore'], ['dueAfter=not-a-date', 'dueAfter'],
  ['dueAfter=2027-01-02&dueBefore=2027-01-01', 'dueBefore'],
  ['onChain=1', 'onChain'], ['currency=BAD!', 'currency'], ['sme=', 'sme'], ['wat=1', 'wat'],
])('rejects query %s with a parameter-specific validation error', async (query, key) => {
  const res = await request(app).get('/api/invoices?' + query);
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('VALIDATION_FAILED');
  expect(res.body.details[key]).toEqual(expect.any(String));
});

test.each(PARAMETERS)('rejects repeated scalar %s', async (key) => {
  const res = await request(app).get('/api/invoices').query(`${key}=a&${key}=b`);
  expect(res.status).toBe(400);
  expect(res.body.details[key]).toEqual(expect.any(String));
});

test('rejects malformed, oversized, mistyped and sort-mismatched cursors', async () => {
  const cursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const first = await request(app).get('/api/invoices?limit=1');
  const inputs = ['!!!', '', 'a'.repeat(2049), cursor(null), cursor([]), cursor({ sort: '-createdAt', id: 'x', sortValue: 'bad' }), cursor({ sort: '-createdAt', id: 'x', sortValue: '2026-02-30T00:00:00.000Z' }), cursor({ sort: '-createdAt', id: 'x', sortValue: '2026-01-01T00:00:00.000Z', extra: true })];
  for (const value of inputs) {
    const res = await request(app).get('/api/invoices').query({ cursor: value });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  }
  const mismatch = await request(app).get('/api/invoices').query({ sort: 'amount', cursor: first.body.nextCursor });
  expect(mismatch.status).toBe(400);
  expect(mismatch.body.code).toBe('INVALID_CURSOR');
});

test('compares decimal filters and amount cursors exactly without float conversion', () => {
  const rows = [
    { ...store.list()[0], id: 'a', amount: '9007199254740993.01' },
    { ...store.list()[0], id: 'b', amount: '9007199254740993.02' },
    { ...store.list()[0], id: 'c', amount: '9007199254740993.03' },
  ];
  const first = queryInvoices(rows, parseInvoiceQuery({ sort: 'amount', limit: '1', minAmount: '9007199254740993.02' }));
  expect(first.data.map((row) => row.id)).toEqual(['b']);
  expect(first.total).toBe(2);
  const second = queryInvoices(rows, parseInvoiceQuery({ sort: 'amount', limit: '1', minAmount: '9007199254740993.02', cursor: first.nextCursor }));
  expect(second.data.map((row) => row.id)).toEqual(['c']);
  expect(second.nextCursor).toBe(null);
});

test('documents all query parameters, page fields and error codes in OpenAPI', async () => {
  const { body } = await request(app).get('/openapi.json');
  const spec = body.paths['/api/invoices'].get;
  expect(spec.parameters.map((param) => param.name).sort()).toEqual([...PARAMETERS].sort());
  expect(spec.parameters.find((param) => param.name === 'sort').schema.enum).toEqual(SORTS);
  expect(spec.parameters.find((param) => param.name === 'limit').schema).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
  expect(spec.responses[200].content['application/json'].schema.required).toEqual(['data', 'count', 'total', 'nextCursor']);
  expect(spec.responses[400].content['application/json'].schema.properties.code.enum).toEqual(['VALIDATION_FAILED', 'INVALID_CURSOR']);
});

test('uses default and maximum page bounds and handles an empty store', async () => {
  seedLargeStore();
  const defaultPage = await request(app).get('/api/invoices');
  expect(defaultPage.body.data).toHaveLength(20);
  const maximum = await request(app).get('/api/invoices?limit=100');
  expect(maximum.body.data).toHaveLength(100);
  store.list().splice(0);
  const empty = await request(app).get('/api/invoices');
  expect(empty.body).toEqual({ data: [], count: 0, total: 0, nextCursor: null });
});

test('rejects oversized scalar inputs and wrong cursor value types', async () => {
  for (const query of [{ sme: 'a'.repeat(121) }, { minAmount: '9'.repeat(129) }, { currency: 'a'.repeat(13) }]) {
    expect((await request(app).get('/api/invoices').query(query)).status).toBe(400);
  }
  for (const [sort, sortValue] of [['amount', -1], ['amount', '1e4'], ['yieldBps', '100'], ['yieldBps', 10001], ['dueDate', '2026-02-30']]) {
    const cursor = Buffer.from(JSON.stringify({ sort, sortValue, id: 'x' })).toString('base64url');
    const res = await request(app).get('/api/invoices').query({ sort, cursor });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  }
});

test('accepts leap-day bounds and tiny numeric amounts without rounding comparisons', () => {
  const query = parseInvoiceQuery({ dueAfter: '2028-02-29', minAmount: '0.00000001', maxAmount: '0.0000001', sort: 'amount' });
  const rows = [
    { ...store.list()[0], id: 'a', dueDate: '2028-02-29', amount: 1e-7 },
    { ...store.list()[0], id: 'b', dueDate: '2028-02-29', amount: 1e-8 },
    { ...store.list()[0], id: 'c', dueDate: '2028-02-29', amount: 1e-9 },
  ];
  expect(queryInvoices(rows, query).data.map((row) => row.id)).toEqual(['b', 'a']);
});
