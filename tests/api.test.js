'use strict';

const request = require('supertest');
const app = require('../src/app');
const { createMemoryRepository } = require('../src/data/memory-repository');

// The same HTTP suite runs against every available repository.
const backends = [['memory', () => createMemoryRepository()]];
if (process.env.TEST_DATABASE_URL) {
  backends.push([
    'postgres',
    () => require('../src/data/pg-repository').createPgRepository({ connectionString: process.env.TEST_DATABASE_URL }),
  ]);
}

describe.each(backends)('HTTP API (%s repository)', (_name, makeRepo) => {
  let repo;

  beforeAll(async () => {
    repo = makeRepo();
    if (repo.knex) {
      await repo.knex.migrate.latest();
    }
    app.locals.repo = repo;
  });

  afterAll(async () => {
    if (repo.destroy) {
      await repo.destroy();
    }
  });

  beforeEach(() => repo.reset());

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
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    const again = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1 });
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

describe('stats and funding rules', () => {
  test('GET /api/stats sums money exactly', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body.invoices).toBe(4);
    expect(res.body.totalFaceValue).toBe('79600');
    expect(res.body.totalFunded).toBe('72500');
  });

  test('created ids fit the contract rule', async () => {
    const ok = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });
    expect(ok.body.data.id).toMatch(/^INV_[A-Z2-7]{12}$/);
  });

  test('over-funding is rejected with 409', async () => {
    const res = await request(app).post('/api/invoices/INV_0001/fund').send({ amount: 100.5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OVERFUNDED');
  });

  test('funding a missing invoice is 404', async () => {
    const res = await request(app).post('/api/invoices/missing/fund').send({ amount: 1 });
    expect(res.status).toBe(404);
  });
});
});
