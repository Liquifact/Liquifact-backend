'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { couponMinor, toMinor, fromMinor, annualisedBps } = require('../src/domain/returns');

beforeEach(() => store.reset());

describe('investment return math', () => {
  test.each([
    ['one stroop principal rounds coupon down to zero', '0.0000001', 800, '0'],
    ['fractional stroop coupon is floored', '0.0000003', 5000, '0.0000001'],
    ['whole amount', '1000', 800, '80'],
  ])('%s', (_name, principal, yieldBps, expected) => {
    expect(fromMinor(couponMinor(toMinor(principal), yieldBps))).toBe(expected);
  });

  test.each([[30, 800, 9733, 15507], [90, 800, 3244, 3663], [365, 800, 800, 800], [1, 720, 262800, 1049776037499497]])(
    'annualises %i day tenor at %i bps', (days, yieldBps, simple, effective) => {
      expect(annualisedBps(yieldBps, days)).toEqual({ simpleAnnualisedBps: simple, effectiveAnnualisedBps: effective });
    },
  );

  test('coupon matches the Soroban funded_amount * yield_bps / 10000 integer formula', () => {
    let seed = 0x1556;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    for (let i = 0; i < 50; i += 1) {
      const principalMinor = BigInt(random()) * 10000000n + BigInt(random() % 10000000);
      const yieldBps = random() % 10001;
      expect(couponMinor(principalMinor, yieldBps)).toBe((principalMinor * BigInt(yieldBps)) / 10000n);
    }
  });
});

describe('GET /api/invoices/:id/quote', () => {
  test('returns fixed-date quote with decimal string amounts', async () => {
    const { status, body } = await request(app).get('/api/invoices/INV_0002/quote?amount=1000&asOf=2026-10-19');
    expect(status).toBe(200);
    expect(body).toEqual({
      invoiceId: 'INV_0002', currency: 'USDC', principal: '1000', yieldBps: 650, coupon: '65', payout: '1065',
      protocolFeeBps: 0, daysToMaturity: 72, simpleAnnualisedBps: 3295, effectiveAnnualisedBps: 3761,
      maturity: '2026-12-30', asOf: '2026-10-19',
    });
    for (const key of ['principal', 'coupon', 'payout']) {
      expect(typeof body[key]).toBe('string');
    }
  });

  test.each(['0', '-1', '1e3', '1.00000001', 'bad'])('rejects invalid amount %s', async (amount) => {
    const res = await request(app).get(`/api/invoices/INV_0002/quote?amount=${encodeURIComponent(amount)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('rejects amount above remaining capacity', async () => {
    const res = await request(app).get('/api/invoices/INV_0002/quote?amount=7000.0000001&asOf=2026-10-19');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EXCEEDS_CAPACITY');
  });

  test('rejects non-open, matured, and unknown invoices', async () => {
    const closed = await request(app).get('/api/invoices/INV_0003/quote?amount=1&asOf=2026-10-19');
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('INVOICE_NOT_OPEN');
    const matured = await request(app).get('/api/invoices/INV_0002/quote?amount=1&asOf=2026-12-30');
    expect(matured.status).toBe(409);
    expect(matured.body.code).toBe('INVOICE_MATURED');
    const missing = await request(app).get('/api/invoices/missing/quote?amount=1&asOf=2026-10-19');
    expect(missing.status).toBe(404);
  });

  test('documents quote path, parameters, fields, and errors in OpenAPI', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    const operation = spec.paths['/api/invoices/{id}/quote'].get;
    expect(operation.parameters.map((p) => p.name)).toEqual(['id', 'amount', 'asOf']);
    const response = operation.responses[200].content['application/json'].schema;
    expect(response.required).toEqual(expect.arrayContaining(['principal', 'coupon', 'payout', 'simpleAnnualisedBps', 'effectiveAnnualisedBps']));
    expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['400', '404', '409', '422']));
  });
});
