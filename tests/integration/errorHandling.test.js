const request = require('supertest');
const app = require('../../src/index');

describe('API Integration Tests (RFC 7807)', () => {
  test('GET /api/invoices should return 501 Not Implemented with Problem Details', async () => {
    const response = await request(app).get('/api/invoices');

    expect(response.status).toBe(501);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      type: 'https://liquifact.com/probs/service-not-implemented',
      title: 'Service Not Implemented',
      status: 501,
      detail: 'The invoice service is currently under development.',
      instance: '/api/invoices',
    });
    expect(response.body.stack).toBeDefined(); // Since we are in test environment
  });

  test('POST /api/invoices without amount should return 400 Bad Request', async () => {
    const response = await request(app)
      .post('/api/invoices')
      .send({}); // Missing 'amount'

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.title).toBe('Validation Error');
    expect(response.body.status).toBe(400);
  });

  test('GET /api/escrow/error-test should return 500 fallback for unknown error', async () => {
    // Suppress console.error output for expected error log
    jest.spyOn(console, 'error').mockImplementation(() => {});
    
    const response = await request(app).get('/api/escrow/error-test');

    expect(response.status).toBe(500);
    expect(response.body.title).toBe('Internal Server Error');
    
    console.error.mockRestore();
  });

  test('GET /unknown-route should return 404 Not Found in RFC 7807 format', async () => {
    const response = await request(app).get('/unknown-route');

    expect(response.status).toBe(404);
    expect(response.body.type).toBe('https://liquifact.com/probs/not-found');
    expect(response.body.title).toBe('Resource Not Found');
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

  test('POST /api/invoices with amount should succeed', async () => {
    const response = await request(app).post('/api/invoices').send({ amount: 100 });
    expect(response.status).toBe(201);
  });
});
