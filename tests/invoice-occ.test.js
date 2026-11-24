const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');

async function createInvoice(overrides = {}) {
  const res = await request(app)
    .post('/invoices')
    .send({ amount: 100, currency: 'USD', ...overrides });
  return res.body;
}

describe('invoice optimistic concurrency', () => {
  beforeEach(() => {
    if (typeof store.reset === 'function') store.reset();
    delete process.env.REQUIRE_IF_MATCH;
  });

  afterAll(() => {
    delete process.env.REQUIRE_IF_MATCH;
  });

  test('GET returns version and ETag', async () => {
    const invoice = await createInvoice();
    const res = await request(app).get(`/invoices/${invoice.id}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('number');
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
  });

  test('stale If-Match returns 412 without mutating', async () => {
    const invoice = await createInvoice();
    const before = await request(app).get(`/invoices/${invoice.id}`);
    const res = await request(app)
      .post(`/invoices/${invoice.id}/fund`)
      .set('If-Match', `"${before.body.version + 99}"`)
      .send({});
    expect(res.status).toBe(412);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('PRECONDITION_FAILED');
    const after = await request(app).get(`/invoices/${invoice.id}`);
    expect(after.body.version).toBe(before.body.version);
    expect(after.body.status).toBe(before.body.status);
  });

  test('matching If-Match succeeds and bumps the version', async () => {
    const invoice = await createInvoice();
    const before = await request(app).get(`/invoices/${invoice.id}`);
    const res = await request(app)
      .post(`/invoices/${invoice.id}/fund`)
      .set('If-Match', `"${before.body.version}"`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(before.body.version + 1);
    expect(res.headers.etag).toBe(`"${before.body.version + 1}"`);
  });

  test('concurrent If-Match requests: exactly one succeeds', async () => {
    const invoice = await createInvoice();
    const before = await request(app).get(`/invoices/${invoice.id}`);
    const tag = `"${before.body.version}"`;
    const results = await Promise.all([
      request(app).post(`/invoices/${invoice.id}/fund`).set('If-Match', tag).send({}),
      request(app).post(`/invoices/${invoice.id}/cancel`).set('If-Match', tag).send({}),
      request(app).post(`/invoices/${invoice.id}/settle`).set('If-Match', tag).send({}),
    ]);
    const ok = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status === 412);
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(2);
    const after = await request(app).get(`/invoices/${invoice.id}`);
    expect(after.body.version).toBe(before.body.version + 1);
  });

  test('REQUIRE_IF_MATCH=true returns 428 when header absent', async () => {
    process.env.REQUIRE_IF_MATCH = 'true';
    const invoice = await createInvoice();
    const res = await request(app).post(`/invoices/${invoice.id}/fund`).send({});
    expect(res.status).toBe(428);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});
