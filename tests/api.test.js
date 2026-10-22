'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { logger } = require('../src/logger');

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

  test('echoes a valid inbound X-Request-Id', async () => {
    const res = await request(app).get('/api/invoices').set('X-Request-Id', 'demo-req-123');
    expect(res.headers['x-request-id']).toBe('demo-req-123');
  });

  test('replaces an invalid inbound X-Request-Id', async () => {
    const res = await request(app).get('/api/invoices').set('X-Request-Id', 'bad id!');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).not.toBe('bad id!');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  test('emits an access log line with templated route and reqId', async () => {
    const lines = [];
    const stream = { write: (line) => lines.push(line) };
    const original = logger[Symbol.for('pino.stream')];
    logger[Symbol.for('pino.stream')] = stream;
    try {
      await request(app).get('/api/invoices/INV_0001').set('X-Request-Id', 'access-log-123');
    } finally {
      logger[Symbol.for('pino.stream')] = original;
    }
    const access = lines.map((l) => JSON.parse(l)).find((l) => l.reqId === 'access-log-123');
    expect(access).toBeDefined();
    expect(access.route).toBe('/api/invoices/:id');
    expect(access.method).toBe('GET');
    expect(access.status).toBe(200);
  });

  test('never logs the Authorization header value', async () => {
    const lines = [];
    const stream = { write: (line) => lines.push(line) };
    const original = logger[Symbol.for('pino.stream')];
    logger[Symbol.for('pino.stream')] = stream;
    try {
      await request(app)
        .get('/api/invoices')
        .set('X-Request-Id', 'auth-log-123')
        .set('Authorization', 'Bearer super-secret-token-value');
    } finally {
      logger[Symbol.for('pino.stream')] = original;
    }
    expect(lines.join('')).not.toContain('super-secret-token-value');
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
});

describe('escrow', () => {
  test('GET /api/escrow returns contract metadata', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.explorer).toContain('stellar.expert');
  });

  test('GET /api/escrow/live logs a warn when RPC fails and falls back', async () => {
    const escrow = require('../src/services/escrow');
    const spy = jest
      .spyOn(escrow, 'readEscrowOnChain')
      .mockRejectedValue(new Error('rpc down'));
    const lines = [];
    const stream = { write: (line) => lines.push(line) };
    const original = logger[Symbol.for('pino.stream')];
    logger[Symbol.for('pino.stream')] = stream;
    try {
      const res = await request(app).get('/api/escrow/live').set('X-Request-Id', 'rpc-warn-123');
      expect(res.status).toBe(200);
    } finally {
      logger[Symbol.for('pino.stream')] = original;
      spy.mockRestore();
    }
    const warn = lines.map((l) => JSON.parse(l)).find((l) => l.level === 40 && l.reqId === 'rpc-warn-123');
    expect(warn).toBeDefined();
    expect(warn.err).toBe('rpc down');
  });
});
