const request = require('supertest');
const { createApp } = require('../app');

const app = createApp();

describe('Standard Response Envelope (Issue 19)', () => {
  it('GET /health returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('version', '0.1.0');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('GET /not-found-route returns 404', async () => {
    const res = await request(app).get('/not-found-route');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Not found');
  });

  it('POST /api/invoices returns 201', async () => {
    const res = await request(app).post('/api/invoices').set('Authorization', 'Bearer token').send({ amount: 1000, buyer: 'Acme', seller: 'Seller', dueDate: '2025-12-31', currency: 'USD' });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('placeholder');
  });

  it('GET /api returns 200 with API name', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('LiquiFact API');
  });

  it('GET /error returns 500', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/error');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error', 'Internal server error');
    consoleSpy.mockRestore();
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
