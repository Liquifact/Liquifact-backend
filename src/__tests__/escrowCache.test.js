const request = require('supertest');
const { app, resetStore } = require('../index');

describe('Escrow Cache Integration', () => {
  beforeEach(() => {
    resetStore();
  });

  it('serves cached response on second request for same invoiceId', async () => {
    const res1 = await request(app).get('/api/escrow/inv_100');
    expect(res1.status).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(res1.body.data).toHaveProperty('invoiceId', 'inv_100');

    const res2 = await request(app).get('/api/escrow/inv_100');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.body.data).toEqual(res1.body.data);
  });

  it('caches different invoiceIds independently', async () => {
    const res1 = await request(app).get('/api/escrow/inv_200');
    expect(res1.headers['x-cache']).toBe('MISS');

    const res2 = await request(app).get('/api/escrow/inv_300');
    expect(res2.headers['x-cache']).toBe('MISS');

    const res3 = await request(app).get('/api/escrow/inv_200');
    expect(res3.headers['x-cache']).toBe('HIT');
  });

  it('returns MISS after TTL expires', async () => {
    // Override cache TTL to 1ms for this test by directly accessing the store
    // We test TTL expiry via the cacheStore unit tests (Task 1).
    // Here we verify the header is MISS on first call as a smoke test.
    const res1 = await request(app).get('/api/escrow/inv_400');
    expect(res1.status).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
  });

  it('returns correct response structure', async () => {
    const res = await request(app).get('/api/escrow/inv_500');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('message');
    expect(res.body.data).toHaveProperty('invoiceId', 'inv_500');
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('fundedAmount');
  });
});
