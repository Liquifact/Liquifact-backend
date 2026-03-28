const request = require('supertest');
const app = require('../../src/index');

describe('API Integration Tests (errors and core routes)', () => {
  test('GET /api/invoices returns invoice list', async () => {
    const response = await request(app).get('/api/invoices');

    expect(response.status).toBe(200);
    expect(response.body.error).toBeNull();
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  test('POST /api/invoices without required fields returns 400', async () => {
    const response = await request(app).post('/api/invoices').send({});

    expect(response.status).toBe(400);
    expect(response.body.data).toBeNull();
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  test('GET /debug/error should return 500 with problem details in tests', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(app).get('/debug/error');

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.title).toBe('Internal Server Error');

    console.error.mockRestore();
  });

  test('GET /unknown-route should return 404 with path', async () => {
    const response = await request(app).get('/unknown-route');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Not found');
    expect(response.body.path).toBe('/unknown-route');
  });

  test('GET /health should return status ok', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  test('GET /api should return api info', async () => {
    const response = await request(app).get('/api');
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('LiquiFact API');
  });

  test('GET /api/escrow/:invoiceId should return escrow data', async () => {
    const response = await request(app).get('/api/escrow/test-invoice');
    expect(response.status).toBe(200);
    expect(response.body.data.invoiceId).toBe('test-invoice');
  });

  test('POST /api/invoices with amount and customer should succeed', async () => {
    const response = await request(app)
      .post('/api/invoices')
      .send({ amount: 100, customer: 'ACME' });
    expect(response.status).toBe(201);
    expect(response.body.error).toBeNull();
    expect(response.body.data).toBeDefined();
  });
});
