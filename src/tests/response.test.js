
const request = require('supertest');
const { createApp } = require('../app');
const app = createApp();

describe('API response shapes', () => {
  it('GET /health uses legacy flat JSON for observability', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('liquifact-api');
    expect(res.body.version).toBe('0.1.0');
  });

  it('GET unknown route returns 404 JSON with path', async () => {
    const res = await request(app).get('/not-found-route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
    expect(res.body.path).toBe('/not-found-route');
  });

  it('POST /api/invoices requires fields and uses success/error helper on validation failure', async () => {
    const res = await request(app).post('/api/invoices').send({});
    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/invoices returns success envelope when valid', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .send({ amount: 100, customer: 'Test' });
    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toBeDefined();
    expect(res.body.meta.version).toBe('0.1.0');
  });

  it('GET /api/invoices returns success envelope', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta.version).toBe('0.1.0');
  });

  it('GET /api/escrow/:id returns success envelope', async () => {
    const res = await request(app).get('/api/escrow/123');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.invoiceId).toBe('123');
  });

  it('GET /debug/error returns 500 RFC 7807 problem details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    const res = await request(app).get('/debug/error');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toContain('problem+json');
    expect(res.body.title).toBe('Internal Server Error');
    expect(res.body.stack).toBeUndefined();
    console.error.mockRestore();
    process.env.NODE_ENV = 'test';
  });

  it('GET /debug/error includes stack outside production', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NODE_ENV = 'development';
    const res = await request(app).get('/debug/error');
    expect(res.status).toBe(500);
    expect(res.body.stack).toBeDefined();
    console.error.mockRestore();
    process.env.NODE_ENV = 'test';
  });

  it('Malformed JSON on POST returns 400 problem details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send('{"invalid": json}');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('problem+json');
    console.error.mockRestore();
  });
});

describe('Response Helper Utility', () => {
  const { success, error } = require('../utils/responseHelper');

  it('success() handles data and optional meta', () => {
    const res = success({ foo: 'bar' }, { page: 1 });
    expect(res.data.foo).toBe('bar');
    expect(res.meta.page).toBe(1);
    expect(res.meta.version).toBeDefined();
    expect(res.error).toBeNull();
  });

  it('success() works with default meta', () => {
    const res = success([]);
    expect(res.data).toEqual([]);
    expect(res.meta.timestamp).toBeDefined();
  });

  it('error() handles message, code, and details', () => {
    const res = error('something failed', 'SOME_CODE', { field: 'id' });
    expect(res.data).toBeNull();
    expect(res.error.message).toBe('something failed');
    expect(res.error.code).toBe('SOME_CODE');
    expect(res.error.details.field).toBe('id');
  });

  it('error() works with default code and null details', () => {
    const res = error('generic failure');
    expect(res.error.code).toBe('INTERNAL_ERROR');
    expect(res.error.details).toBeNull();
  });
});
