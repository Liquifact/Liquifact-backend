'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const {
  STATUSES,
  CONTRACT_STATUS_CODES,
  TRANSITIONS,
  InvalidTransitionError,
  transition,
} = require('../src/domain/invoice-state');

beforeEach(() => store.reset());

const ALLOWED = [
  ['open', 'funded'],
  ['open', 'cancelled'],
  ['funded', 'withdrawn'],
  ['funded', 'settled'],
  ['withdrawn', 'settled'],
];

describe('transition matrix', () => {
  test('STATUSES and store.STATUSES', () => {
    expect(STATUSES).toEqual(['open', 'funded', 'withdrawn', 'settled', 'cancelled']);
    expect(store.STATUSES).toBe(STATUSES);
  });

  test('CONTRACT_STATUS_CODES match the contract (0 open, 1 funded, 2 settled, 3 withdrawn, 4 cancelled)', () => {
    expect(CONTRACT_STATUS_CODES).toEqual({ open: 0, funded: 1, settled: 2, withdrawn: 3, cancelled: 4 });
  });

  test('TRANSITIONS map', () => {
    expect(TRANSITIONS.open).toEqual(['funded', 'cancelled']);
    expect(TRANSITIONS.funded).toEqual(['withdrawn', 'settled']);
    expect(TRANSITIONS.withdrawn).toEqual(['settled']);
    expect(TRANSITIONS.settled).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
  });

  const pairs = [];
  STATUSES.forEach((from) => STATUSES.forEach((to) => pairs.push([from, to])));

  test.each(pairs)('%s -> %s', (from, to) => {
    const invoice = { status: from, history: [] };
    const isAllowed = ALLOWED.some(([f, t]) => f === from && t === to);
    if (isAllowed) {
      transition(invoice, to, { reason: 'r', at: '2026-01-01T00:00:00.000Z' });
      expect(invoice.status).toBe(to);
      expect(invoice.history).toEqual([{ from, to, at: '2026-01-01T00:00:00.000Z', reason: 'r' }]);
    } else {
      expect(() => transition(invoice, to)).toThrow(InvalidTransitionError);
      expect(invoice.status).toBe(from);
      expect(invoice.history).toEqual([]);
    }
  });

  test('unknown target status throws', () => {
    expect(() => transition({ status: 'open' }, 'bogus')).toThrow(InvalidTransitionError);
  });
});

describe('state machine endpoints', () => {
  test('settle is routed: INV_0003 settle returns 200 (404 on main, where route is missing)', async () => {
    const res = await request(app).post('/api/invoices/INV_0003/settle').send({ settledAmount: 45024 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('settled');
  });

  test('cancel success with no funds has no refundDue', async () => {
    const res = await request(app).post('/api/invoices/INV_0001/cancel').send({ reason: 'duplicate' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    expect(res.body.refundDue).toBeUndefined();
    expect(res.body.data.history[0]).toMatchObject({ from: 'open', to: 'cancelled', reason: 'duplicate' });
  });

  test('cancel with funds returns refundDue', async () => {
    const res = await request(app).post('/api/invoices/INV_0002/cancel').send({ reason: 'fraud' });
    expect(res.status).toBe(200);
    expect(res.body.refundDue).toBe(18000);
  });

  test('cancel failure paths', async () => {
    expect((await request(app).post('/api/invoices/nope/cancel').send({ reason: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/invoices/INV_0001/cancel').send({})).status).toBe(400);
    expect((await request(app).post('/api/invoices/INV_0001/cancel').send({ reason: '' })).status).toBe(400);
    expect((await request(app).post('/api/invoices/INV_0001/cancel').send({ reason: 'x'.repeat(281) })).status).toBe(400);
    expect((await request(app).post('/api/invoices/INV_0001/cancel').send({ reason: 5 })).status).toBe(400);
    const res = await request(app).post('/api/invoices/INV_0003/cancel').send({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION', from: 'funded', to: 'cancelled' });
  });

  test('withdraw success and failures', async () => {
    const ok = await request(app).post('/api/invoices/INV_0003/withdraw');
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('withdrawn');
    const again = await request(app).post('/api/invoices/INV_0003/withdraw');
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'INVALID_TRANSITION', from: 'withdrawn', to: 'withdrawn' });
    expect((await request(app).post('/api/invoices/INV_0001/withdraw')).status).toBe(409);
    expect((await request(app).post('/api/invoices/nope/withdraw')).status).toBe(404);
  });

  test('settle failure paths', async () => {
    expect((await request(app).post('/api/invoices/nope/settle').send({ settledAmount: 1 })).status).toBe(404);
    expect((await request(app).post('/api/invoices/INV_0003/settle').send({})).status).toBe(400);
    expect((await request(app).post('/api/invoices/INV_0003/settle').send({ settledAmount: '5' })).status).toBe(400);
    const wrong = await request(app).post('/api/invoices/INV_0001/settle').send({ settledAmount: 999999 });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: 'INVALID_TRANSITION', from: 'open', to: 'settled' });
    const low = await request(app).post('/api/invoices/INV_0003/settle').send({ settledAmount: 45023 });
    expect(low.status).toBe(422);
    expect(low.body.code).toBe('INSUFFICIENT_SETTLEMENT');
    expect(store.get('INV_0003').status).toBe('funded');
  });

  test('history after open -> funded -> withdrawn -> settled', async () => {
    expect((await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000 })).status).toBe(200);
    expect((await request(app).post('/api/invoices/INV_0002/withdraw')).status).toBe(200);
    // funded 25000 + floor(25000 * 650 / 10000) = 26625
    const res = await request(app).post('/api/invoices/INV_0002/settle').send({ settledAmount: 26625 });
    expect(res.status).toBe(200);
    expect(res.body.data.history.map((h) => [h.from, h.to])).toEqual([
      ['open', 'funded'],
      ['funded', 'withdrawn'],
      ['withdrawn', 'settled'],
    ]);
    res.body.data.history.forEach((h) => expect(typeof h.at).toBe('string'));
  });

  test('cancelled and settled invoices cannot be funded', async () => {
    await request(app).post('/api/invoices/INV_0001/cancel').send({ reason: 'x' });
    expect((await request(app).post('/api/invoices/INV_0001/fund').send({ amount: 1 })).status).toBe(409);
    expect((await request(app).post('/api/invoices/INV_0004/fund').send({ amount: 1 })).status).toBe(409);
  });

  test('filter by withdrawn', async () => {
    await request(app).post('/api/invoices/INV_0003/withdraw');
    const res = await request(app).get('/api/invoices?status=withdrawn');
    expect(res.status).toBe(200);
    expect(res.body.data.map((i) => i.id)).toEqual(['INV_0003']);
  });

  test('openapi documents new paths and schemas', async () => {
    const { body } = await request(app).get('/openapi.json');
    ['cancel', 'withdraw', 'settle'].forEach((p) => {
      expect(body.paths).toHaveProperty(`/api/invoices/{id}/${p}`);
    });
    const settle = body.paths['/api/invoices/{id}/settle'].post;
    expect(Object.keys(settle.responses)).toEqual(expect.arrayContaining(['200', '400', '404', '409', '422']));
    expect(settle.requestBody.content['application/json'].schema.required).toContain('settledAmount');
    const cancel = body.paths['/api/invoices/{id}/cancel'].post;
    expect(cancel.requestBody.content['application/json'].schema.properties.reason.maxLength).toBe(280);
    expect(cancel.responses[200].content['application/json'].schema.properties).toHaveProperty('refundDue');
    const listStatus = body.paths['/api/invoices'].get.parameters[0].schema.enum;
    expect(listStatus).toContain('withdrawn');
  });
});
