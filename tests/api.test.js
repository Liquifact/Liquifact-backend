'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { parseAmount } = require('../src/lib/money');

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

  test('unknown route is a JSON 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });

  test('JSON serialization guard converts BigInt values to strings', () => {
    expect(app.get('json replacer')(null, 10000000n)).toBe('10000000');
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
    expect(ok.body.data.amount).toBe('500');
    expect(ok.body.data.fundedAmount).toBe('0');
    expect(ok.body.data.decimals).toBe(7);
  });

  test('seed XLM invoice matches the deploy snapshot in minor units', () => {
    expect(store.get('INV_0001').amountMinor).toBe(1000000000n);
    expect(store.get('INV_0001').amountMinor).toBe(parseAmount('100'));
  });

  test('funding 0.7 with decimal-string contributions reaches the exact target', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    const created = await request(app).post('/api/invoices').send({
      sme: 'Decimal SME', debtor: 'Buyer', amount: '0.7', dueDate: '2027-01-01',
    });
    expect(created.status).toBe(201);

    for (const amount of ['0.1', '0.2', '0.4']) {
      const result = await request(app)
        .post(`/api/invoices/${created.body.data.id}/fund`)
        .send({ amount, investor });
      expect(result.status).toBe(200);
    }

    const invoice = (await request(app).get(`/api/invoices/${created.body.data.id}`)).body.data;
    expect(invoice.status).toBe('funded');
    expect(invoice.fundedAmount).toBe('0.7');
  });

  test.each(['0.00000001', '1e5', '-1', '0', 'abc', Number.MAX_SAFE_INTEGER + 2])(
    'rejects invalid create amount %s with INVALID_AMOUNT', async (amount) => {
      const response = await request(app).post('/api/invoices').send({
        sme: 'Invalid SME', debtor: 'Buyer', amount, dueDate: '2027-01-01',
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_AMOUNT');
    },
  );

  test('fund rejects amounts with unsupported precision using INVALID_AMOUNT', async () => {
    const response = await request(app).post('/api/invoices/INV_0002/fund').send({
      amount: '0.00000001',
      investor: 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_AMOUNT');
  });

  test('OpenAPI documents decimal invoice schemas and amount validation', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    const invoice = spec.paths['/api/invoices'].get.responses['200'].content['application/json'].schema.properties.data.items;
    expect(invoice.properties.amount.type).toBe('string');
    expect(invoice.properties.fundedAmount.type).toBe('string');
    expect(invoice.properties.decimals.enum).toEqual([7]);

    const create = spec.paths['/api/invoices'].post;
    expect(create.requestBody.content['application/json'].schema.properties.amount.oneOf).toHaveLength(2);
    expect(create.responses['400']).toBeDefined();
    const fund = spec.paths['/api/invoices/{id}/fund'].post;
    expect(fund.requestBody.content['application/json'].schema.properties.amount.oneOf).toHaveLength(2);
    expect(fund.responses['400']).toBeDefined();
  });

  test('fund moves invoice to funded when target reached', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    const again = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor });
    expect(again.status).toBe(409);
  });
});

describe('escrow', () => {
  test('GET /api/escrow returns contract metadata', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.explorer).toContain('stellar.expert');
  });
});
