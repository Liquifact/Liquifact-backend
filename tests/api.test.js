'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');

beforeEach(() => store.reset());

describe('system', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET / lists endpoints and contract', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.length).toBeGreaterThan(5);
    expect(res.body.contract.id).toMatch(/^C[A-Z0-9]{55}$/);
  });

  test('GET /docs and /openapi.json', async () => {
    const docs = await request(app).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger-ui');
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/api/invoices');
  });

  test('openapi documents funding contract', async () => {
    const spec = await request(app).get('/openapi.json');
    const fund = spec.body.paths['/api/invoices/{id}/fund'].post;
    expect(fund).toBeDefined();
    expect(fund.responses['422']).toBeDefined();
    expect(fund.responses['400']).toBeDefined();
    expect(fund.requestBody.content['application/json'].schema.properties.allowPartial).toBeDefined();
    const schemas = spec.body.components.schemas;
    expect(schemas.Invoice.properties.remainingCapacity).toBeDefined();
    expect(schemas.FundingError).toBeDefined();
    expect(schemas.FundRequest).toBeDefined();
    expect(schemas.FundResponse).toBeDefined();
  });

  test('unknown route is a JSON 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});

describe('invoices', () => {
  test('list and filter', async () => {
    const all = await request(app).get('/api/invoices');
    expect(all.body.count).toBe(4);
    const open = await request(app).get('/api/invoices?status=open');
    expect(open.body.data.every((i) => i.status === 'open')).toBe(true);
    const bad = await request(app).get('/api/invoices?status=weird');
    expect(bad.status).toBe(400);
  });

  test('remainingCapacity is present in list and detail', async () => {
    const list = await request(app).get('/api/invoices');
    const inv = list.body.data.find((i) => i.id === 'INV_0002');
    expect(inv.remainingCapacity).toBe(7000);
    const detail = await request(app).get('/api/invoices/INV_0002');
    expect(detail.body.data.remainingCapacity).toBe(7000);
  });

  test('get by id', async () => {
    expect((await request(app).get('/api/invoices/INV_0001')).status).toBe(200);
    expect((await request(app).get('/api/invoices/missing')).status).toBe(404);
  });

  test('create validates and stores', async () => {
    const bad = await request(app).post('/api/invoices').send({ sme: '' });
    expect(bad.status).toBe(400);
    const ok = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('open');
    expect(ok.body.data.remainingCapacity).toBe(500);
  });

  test('fund moves invoice to funded when target reached', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.remainingCapacity).toBe(0);
    const again = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor });
    expect(again.status).toBe(409);
  });

  test('rejects over-funding with 422 and does not mutate', async () => {
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 100000 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FUNDING_EXCEEDES_CAPACITY');
    expect(res.body.remainingCapacity).toBe(7000);
    const after = await request(app).get('/api/invoices/INV_0002');
    expect(after.body.data.fundedAmount).toBe(0);
    expect(after.body.data.status).toBe('open');
  });

  test('allowPartial caps contribution and reports split', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 100000, allowPartial: true });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(7000);
    expect(res.body.rejected).toBe(93000);
    expect(res.body.data.fundedAmount).toBe(7000);
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.remainingCapacity).toBe(0);
  });

  test('rejects invalid amounts with 400', async () => {
    const cases = [0, -1, 1e308, '100'];
    for (const amount of cases) {
      const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AMOUNT');
    }
  });

  test('rejects amount above face value with 422', async () => {
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7001 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FUNDING_EXCEEDES_CAPACITY');
  });

  test('rejects funding a non-open invoice with 409', async () => {
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000 });
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1 });
    expect(res.status).toBe(409);
  });
});

describe('store.fund', () => {
  test('throws when called over capacity', () => {
    const invoice = store.get('INV_0002');
    expect(() => store.fund(invoice, 100000)).toThrow();
    expect(invoice.fundedAmount).toBe(0);
    expect(invoice.status).toBe('open');
  });
});

describe('escrow', () => {
  test('GET /api/escrow returns contract metadata', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.explorer).toContain('stellar.expert');
  });
});
