'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { computeStats } = require('../src/services/stats');

beforeEach(() => store.reset());

test('reports seeded amounts separately by currency instead of mixing assets', async () => {
  const res = await request(app).get('/api/stats');
  expect(res.status).toBe(200);
  expect(res.body.byCurrency).toEqual({
    XLM: { invoices: 1, faceValue: '100', funded: '0', outstanding: '0', weightedYieldBps: 800 },
    USDC: { invoices: 3, faceValue: '79500', funded: '72500', outstanding: '42000', weightedYieldBps: 726 },
  });
  expect(res.body.invoices).toBe(4);
  expect(res.body.open).toBe(2);
});

test('exposes deprecated totals and retains their old aliases for one migration release', async () => {
  const { body } = await request(app).get('/api/stats');
  expect(body.deprecated).toEqual({ totalFaceValue: 79600, totalFunded: 72500, averageYieldBps: 768 });
  for (const key of ['totalFaceValue', 'totalFunded', 'averageYieldBps']) {
    expect(body[key]).toBe(body.deprecated[key]);
  }
  expect(body.byStatus).toEqual({ open: 2, funded: 1, settled: 1, cancelled: 0 });
  expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
});

const invoice = (overrides = {}) => ({
  currency: 'USDC', amount: '1', fundedAmount: '0', yieldBps: 100, status: 'open', ...overrides,
});

test('weights principal, excludes cancellation and treats only funded principal as outstanding', () => {
  const rows = [
    invoice({ amount: '1', yieldBps: 100 }),
    invoice({ amount: '3', yieldBps: 0, fundedAmount: '2', status: 'funded' }),
    invoice({ amount: '4', yieldBps: 100, fundedAmount: '4', status: 'settled' }),
    invoice({ amount: '1000', yieldBps: 10000, fundedAmount: '1000', status: 'cancelled' }),
  ];
  const before = JSON.stringify(rows);
  const stats = computeStats(rows, undefined, new Date('2026-10-19T00:00:00Z'));
  expect(stats.byCurrency.USDC).toEqual({ invoices: 4, faceValue: '8', funded: '6', outstanding: '2', weightedYieldBps: 63 });
  expect(stats.byStatus).toEqual({ open: 1, funded: 1, settled: 1, cancelled: 1 });
  expect(stats.generatedAt).toBe('2026-10-19T00:00:00.000Z');
  expect(JSON.stringify(rows)).toBe(before);
});

test('preserves decimal fractions and values beyond the safe integer range', () => {
  const stats = computeStats([
    invoice({ amount: '9007199254740993.1', fundedAmount: '9007199254740993.01', status: 'funded', yieldBps: 800 }),
    invoice({ amount: '0.2', fundedAmount: '0.09', yieldBps: 800 }),
  ]);
  expect(stats.byCurrency.USDC).toEqual({
    invoices: 2, faceValue: '9007199254740993.3', funded: '9007199254740993.1',
    outstanding: '9007199254740993.01', weightedYieldBps: 800,
  });
});

test('supports tiny numeric fractions and exact half-up yield rounding', () => {
  const stats = computeStats([invoice({ amount: 1e-7, fundedAmount: 1e-7, yieldBps: 1 }), invoice({ amount: 1e-7, yieldBps: 0 })]);
  expect(stats.byCurrency.USDC.faceValue).toBe('0.0000002');
  expect(stats.byCurrency.USDC.weightedYieldBps).toBe(1);
});

test('handles empty, zero-principal and cancelled-only groups without division by zero', () => {
  expect(computeStats([]).byCurrency).toEqual({});
  for (const row of [invoice({ amount: '0' }), invoice({ status: 'cancelled' })]) {
    expect(computeStats([row]).byCurrency.USDC).toEqual({ invoices: 1, faceValue: '0', funded: '0', outstanding: '0', weightedYieldBps: 0 });
  }
});

test('filters the entire response by currency and returns empty results for a valid unknown code', async () => {
  const { body } = await request(app).get('/api/stats?currency=XLM');
  expect(Object.keys(body.byCurrency)).toEqual(['XLM']);
  expect(body.invoices).toBe(1);
  expect(body.open).toBe(1);
  expect(body.deprecated.totalFaceValue).toBe(100);
  const unknown = await request(app).get('/api/stats?currency=ZZZ');
  expect(unknown.status).toBe(200);
  expect(unknown.body.byCurrency).toEqual({});
  expect(unknown.body.invoices).toBe(0);
  expect(unknown.body.byStatus).toEqual({ open: 0, funded: 0, settled: 0, cancelled: 0 });
  expect(unknown.body.deprecated.averageYieldBps).toBe(0);
});

test.each(['currency=', 'currency=BAD%21', 'currency=TOOLONGASSET123', 'currency=XLM&currency=USDC'])('rejects invalid currency query %s', async (query) => {
  const res = await request(app).get('/api/stats?' + query);
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('VALIDATION_FAILED');
  expect(res.body.details.currency).toEqual(expect.any(String));
});

test('documents all statistics fields and the currency error response in OpenAPI', async () => {
  const { body } = await request(app).get('/openapi.json');
  const spec = body.paths['/api/stats'].get;
  expect(spec.parameters[0].name).toBe('currency');
  const shape = spec.responses[200].content['application/json'].schema;
  expect(shape.required).toEqual(expect.arrayContaining(['invoices', 'open', 'byStatus', 'byCurrency', 'generatedAt', 'deprecated']));
  expect(Object.keys(shape.properties.byCurrency.additionalProperties.properties)).toEqual(['invoices', 'faceValue', 'funded', 'outstanding', 'weightedYieldBps']);
  expect(shape.properties.deprecated.deprecated).toBe(true);
  expect(spec.responses[400].content['application/json'].schema.properties.code.enum).toEqual(['VALIDATION_FAILED']);
});
