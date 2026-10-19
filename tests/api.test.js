'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');

beforeEach(() => store.reset());

const invoice = (overrides = {}) => ({
  sme: 'Test SME',
  debtor: 'Buyer Co',
  invoiceNumber: 'TEST-001',
  amount: 500,
  dueDate: '2027-01-01',
  ...overrides,
});

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

  test('GET /docs and /openapi.json documents invoice integrity contract', async () => {
    const docs = await request(app).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger-ui');
    const spec = (await request(app).get('/openapi.json')).body;
    expect(spec.openapi).toBe('3.0.3');
    const post = spec.paths['/api/invoices'].post;
    const schema = post.requestBody.content['application/json'].schema;
    expect(schema.required).toContain('invoiceNumber');
    expect(schema.properties.invoiceNumber).toMatchObject({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._/-]{1,64}$' });
    expect(schema.properties.confirmNotDuplicate.type).toBe('boolean');
    expect(post.responses).toHaveProperty('400');
    expect(post.responses).toHaveProperty('409');
    expect(post.responses['409'].content['application/json'].schema.properties.code.enum).toEqual(['DUPLICATE_INVOICE', 'POSSIBLE_DUPLICATE']);
  });

  test('unknown route is a JSON 404', async () => {
    expect((await request(app).get('/nope')).status).toBe(404);
  });
});

describe('invoices', () => {
  test('list, filter, get, create, and fund retain existing behavior', async () => {
    const all = await request(app).get('/api/invoices');
    expect(all.body.count).toBe(4);
    const open = await request(app).get('/api/invoices?status=open');
    expect(open.body.data.every((i) => i.status === 'open')).toBe(true);
    expect((await request(app).get('/api/invoices?status=weird')).status).toBe(400);
    expect((await request(app).get('/api/invoices/INV_0001')).status).toBe(200);
    expect((await request(app).get('/api/invoices/missing')).status).toBe(404);
    const ok = await request(app).post('/api/invoices').send(invoice());
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('open');
    const funded = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000 });
    expect(funded.body.data.status).toBe('funded');
    expect((await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1 })).status).toBe(409);
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
