const request = require('supertest');
const app = require('../app');
const { mockInvoices } = require('../services/invoiceService');

describe('GET /api/invoices (Pagination)', () => {
  const TOTAL_INVOICES = mockInvoices.length;

  it('should return 200 and the first 10 invoices by default', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.total).toBe(TOTAL_INVOICES);
    expect(res.body.meta.hasNextPage).toBe(true);
    expect(res.body.meta.hasPreviousPage).toBe(false);
  });

  it('should return custom page and limit', async () => {
    const res = await request(app).get('/api/invoices?page=2&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
    expect(res.body.meta.page).toBe(2);
    expect(res.body.meta.limit).toBe(5);
    expect(res.body.meta.hasNextPage).toBe(true);
    expect(res.body.meta.hasPreviousPage).toBe(true);
  });

  it('should return correctly on the last page', async () => {
    // 25 total, limit 10: page 3 has 5 records
    const res = await request(app).get('/api/invoices?page=3&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
    expect(res.body.meta.hasNextPage).toBe(false);
    expect(res.body.meta.hasPreviousPage).toBe(true);
  });

  it('should handle negative page or limit gracefully (fallback to 1/10)', async () => {
    const res = await request(app).get('/api/invoices?page=-5&limit=-10');
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(1); // Min limit 1
  });

  it('should cap large limits to 100', async () => {
    const res = await request(app).get('/api/invoices?limit=500');
    expect(res.status).toBe(200);
    expect(res).toBeDefined();
    expect(res.body.meta.limit).toBe(100);
  });

  it('should handle empty or alphabetical query parameters (fallback to 1/10)', async () => {
    const res = await request(app).get('/api/invoices?page=abc&limit=efg');
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(10);
  });

  it('should return empty data for pages beyond the total range', async () => {
    const res = await request(app).get('/api/invoices?page=100');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
    expect(res.body.meta.page).toBe(100);
    expect(res.body.meta.hasNextPage).toBe(false);
  });
});

describe('Invoice Listing: Utilities & Misc', () => {
  it('GET /api should remain functional and include pagination details', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.invoices).toBe('GET /api/invoices');
  });

  it('GET /health should remain functional', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('should return 404 for unknown route', async () => {
    const res = await request(app).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('GET /api/escrow/:id should return 200 placeholder', async () => {
    const res = await request(app).get('/api/escrow/123');
    expect(res.status).toBe(200);
    expect(res.body.data.invoiceId).toBe('123');
  });

  it('GET /debug/error should trigger 500 handler', async () => {
    // Hide console.error for clean test output
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/debug/error');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    spy.mockRestore();
  });

  it('GET /api/invoices should return 400 if service throws', async () => {
    const invoiceService = require('../services/invoiceService');
    const spy = jest.spyOn(invoiceService, 'getInvoices').mockImplementation(() => {
        throw new Error('Service Failure');
    });
    
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Bad Request');
    
    spy.mockRestore();
  });
});
