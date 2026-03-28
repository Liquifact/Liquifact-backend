const request = require('supertest');
const { createApp } = require('../app');
const app = createApp();

describe('Standard Response Envelope (Issue 19)', () => {
  it('Success response should have data, meta, and error=null', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toBeNull();
    expect(res.body.meta.version).toBe('0.1.0');
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('Error response should have data=null, meta, and error object', async () => {
    const res = await request(app).get('/not-found-route');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toBeNull();
    expect(res.body).toHaveProperty('meta');
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error).toHaveProperty('message');
  });

  it('POST /api/invoices should return 201 and standardized success envelope', async () => {
    const res = await request(app).post('/api/invoices').send({});
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('placeholder');
    expect(res.body.error).toBeNull();
  });

  it('All routes should return standard response format', async () => {
    const routes = ['/api', '/api/invoices', '/api/escrow/123'];
    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toBeNull();
    }
  });

  it('GET /debug/error should return 500 and standardized internal error', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app).get('/debug/error');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Internal Server Error');
    expect(res.body.error.details).toBeNull();
  });

  it('Internal server errors should return stack trace in development', async () => {
    process.env.NODE_ENV = 'development';
    const res = await request(app).get('/debug/error');
    expect(res.status).toBe(500);
    expect(res.body.error.details).toContain('Error: Triggered Error');
  });

  it('Internal server errors should return standard error envelope (e.g. malformed JSON)', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send('{"invalid": json}'); // Malformed JSON

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('BAD_REQUEST');
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
