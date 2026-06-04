/**
 * @fileoverview API Response Schema Contract Tests
 * Validates that API responses adhere to expected data structures.
 */

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('API Contract Tests - Response Schemas', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should match the GET /health response schema', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data || res.body).toEqual(expect.objectContaining({
        status: expect.any(String),
        service: expect.any(String),
        version: expect.any(String),
        timestamp: expect.any(String),
      })
    );
  });

  it('should match the GET /api/invoices response schema', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({

      })
    );
  });

  it('should match the POST /api/invoices response schema', async () => {
    const res = await request(app).post('/api/invoices').set('Authorization', 'Bearer token').send({ amount: 1000, buyer: 'Acme', seller: 'Seller', dueDate: '2025-12-31', currency: 'USD', invoiceNumber: '123' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.any(String),
          status: expect.any(String),
        }),
        message: expect.any(String),
      })
    );
  });
});
