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
  });

  test('fund moves invoice to funded when target reached', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    const again = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor });
    expect(again.status).toBe(409);
  });

  test('create rejects non-ISO dueDate', async () => {
    const bad = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: 'January 1, 2027' });
    expect(bad.status).toBe(400);

    const alsoBad = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '01/01/2027' });
    expect(alsoBad.status).toBe(400);
  });

  test('create treats null yieldBps as default', async () => {
    const ok = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01', yieldBps: null });
    expect(ok.status).toBe(201);
    expect(ok.body.data.yieldBps).toBe(800);
  });

  test('settle moves funded invoice to settled', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 25000, investor });
    const res = await request(app).post('/api/invoices/INV_0002/settle');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('settled');
  });

  test('settle rejects non-funded invoice', async () => {
    const res = await request(app).post('/api/invoices/INV_0001/settle');
    expect(res.status).toBe(409);
  });

  test('cancel moves open invoice to cancelled', async () => {
    const res = await request(app).post('/api/invoices/INV_0001/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  test('cancel moves funded invoice to cancelled', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 25000, investor });
    const res = await request(app).post('/api/invoices/INV_0002/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  test('cancel rejects settled invoice', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 25000, investor });
    await request(app).post('/api/invoices/INV_0002/settle');
    const res = await request(app).post('/api/invoices/INV_0002/cancel');
    expect(res.status).toBe(409);
  });

  test('settle and cancel return 404 for missing invoice', async () => {
    expect((await request(app).post('/api/invoices/missing/settle')).status).toBe(404);
    expect((await request(app).post('/api/invoices/missing/cancel')).status).toBe(404);
  });
});

describe('escrow', () => {
  test('GET /api/escrow returns contract metadata', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.explorer).toContain('stellar.expert');
  });
});
