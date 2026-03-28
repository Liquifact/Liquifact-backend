const request = require('supertest');
const { createApp } = require('../app');
const invoiceService = require('../services/invoice.service');

// Mock the service — use a factory to avoid loading the real module (which requires knex)
jest.mock('../services/invoice.service', () => ({
  getInvoices: jest.fn(),
}));

describe('Invoice API Integration', () => {
  let app;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
  });

  describe('GET /api/invoices', () => {
    it('should return 200 and invoices when no query params are provided', async () => {
      const mockInvoices = [{ id: 1, amount: 100 }, { id: 2, amount: 200 }];
      invoiceService.getInvoices.mockResolvedValue(mockInvoices);

      const res = await request(app).get('/api/invoices');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual(mockInvoices);
      expect(res.body.message).toBe('Invoices retrieved successfully.');
      expect(invoiceService.getInvoices).toHaveBeenCalledWith({
        filters: {},
        sorting: {}
      });
    });

    it('should filter by status', async () => {
      invoiceService.getInvoices.mockResolvedValue([]);
      
      const res = await request(app).get('/api/invoices?status=paid');

      expect(res.statusCode).toBe(200);
      expect(invoiceService.getInvoices).toHaveBeenCalledWith({
        filters: { status: 'paid' },
        sorting: {}
      });
    });

    it('should filter by SME ID', async () => {
      invoiceService.getInvoices.mockResolvedValue([]);
      
      const res = await request(app).get('/api/invoices?smeId=sme-123');

      expect(res.statusCode).toBe(200);
      expect(invoiceService.getInvoices).toHaveBeenCalledWith({
        filters: { smeId: 'sme-123' },
        sorting: {}
      });
    });

    it('should filter by date range', async () => {
      invoiceService.getInvoices.mockResolvedValue([]);
      
      const res = await request(app).get('/api/invoices?dateFrom=2023-01-01&dateTo=2023-12-31');

      expect(res.statusCode).toBe(200);
      expect(invoiceService.getInvoices).toHaveBeenCalledWith({
        filters: { dateFrom: '2023-01-01', dateTo: '2023-12-31' },
        sorting: {}
      });
    });

    it('should apply sorting', async () => {
      invoiceService.getInvoices.mockResolvedValue([]);
      
      const res = await request(app).get('/api/invoices?sortBy=amount&order=asc');

      expect(res.statusCode).toBe(200);
      expect(invoiceService.getInvoices).toHaveBeenCalledWith({
        filters: {},
        sorting: { sortBy: 'amount', order: 'asc' }
      });
    });

    it('should reject invalid status with 400', async () => {
      const res = await request(app).get('/api/invoices?status=invalid');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('Invalid status. Must be one of: paid, pending, overdue');
      expect(invoiceService.getInvoices).not.toHaveBeenCalled();
    });

    it('should reject invalid date format with 400', async () => {
      const res = await request(app).get('/api/invoices?dateFrom=2023/01/01');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('Invalid dateFrom format. Use YYYY-MM-DD');
    });

    it('should reject an invalid smeId with 400', async () => {
      const res = await request(app).get('/api/invoices?smeId=');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('Invalid smeId format');
    });

    it('should filter by buyer ID', async () => {
      invoiceService.getInvoices.mockResolvedValue([]);

      const res = await request(app).get('/api/invoices?buyerId=buyer-456');

      expect(res.statusCode).toBe(200);
      expect(invoiceService.getInvoices).toHaveBeenCalledWith({
        filters: { buyerId: 'buyer-456' },
        sorting: {}
      });
    });

    it('should reject an invalid buyerId with 400', async () => {
      const res = await request(app).get('/api/invoices?buyerId=');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('Invalid buyerId format');
    });

    it('should reject an invalid dateTo format with 400', async () => {
      const res = await request(app).get('/api/invoices?dateTo=2023/12/31');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('Invalid dateTo format. Use YYYY-MM-DD');
    });

    it('should reject an invalid order value with 400', async () => {
      const res = await request(app).get('/api/invoices?order=sideways');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('Invalid order. Must be "asc" or "desc"');
    });

    it('should reject multiple invalid inputs with 400', async () => {
      const res = await request(app).get('/api/invoices?status=bad&sortBy=wrong');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors.length).toBe(2);
    });

    it('should handle service errors with 500', async () => {
      invoiceService.getInvoices.mockRejectedValue(new Error('Service failure'));

      const res = await request(app).get('/api/invoices');

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Internal server error');
    });
  });

  describe('POST /api/invoices — payload validation', () => {
    const validPayload = {
      amount:   1500,
      dueDate:  '2026-12-31',
      buyer:    'Acme Corp',
      seller:   'Stellar Goods Ltd',
      currency: 'USD',
    };

    it('should return 201 for a fully valid payload', async () => {
      const res = await request(app).post('/api/invoices').send(validPayload);
      expect(res.statusCode).toBe(201);
      expect(res.body.data).toHaveProperty('id', 'placeholder');
    });

    it('should return 201 and normalise currency to uppercase', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, currency: 'eur' });
      expect(res.statusCode).toBe(201);
    });

    it('should return 400 when no body is sent', async () => {
      const res = await request(app).post('/api/invoices');
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('amount is required');
    });

    it('should return 400 when all fields are missing', async () => {
      const res = await request(app).post('/api/invoices').send({});
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('amount is required');
      expect(res.body.errors).toContain('dueDate is required');
      expect(res.body.errors).toContain('buyer is required');
      expect(res.body.errors).toContain('seller is required');
      expect(res.body.errors).toContain('currency is required');
    });

    it('should return 400 when amount is zero', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, amount: 0 });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('amount must be a positive number');
    });

    it('should return 400 when amount is negative', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, amount: -100 });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('amount must be a positive number');
    });

    it('should return 400 when amount is a string', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, amount: '1500' });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('amount must be a positive number');
    });

    it('should return 400 when dueDate is in wrong format', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, dueDate: '31/12/2026' });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('dueDate must be a valid date in YYYY-MM-DD format');
    });

    it('should return 400 when dueDate is an impossible date', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, dueDate: '2026-13-01' });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('dueDate must be a valid date in YYYY-MM-DD format');
    });

    it('should return 400 when buyer is an empty string', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, buyer: '   ' });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('buyer must be a non-empty string');
    });

    it('should return 400 when seller is an empty string', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, seller: '' });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain('seller must be a non-empty string');
    });

    it('should return 400 when currency is unsupported', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ ...validPayload, currency: 'XYZ' });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toContain(
        'currency must be a supported ISO 4217 code (e.g. USD, EUR, GBP)'
      );
    });

    it('should return 400 and collect multiple errors at once', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .send({ amount: -1, dueDate: 'not-a-date' });
      expect(res.statusCode).toBe(400);
      expect(res.body.errors.length).toBeGreaterThanOrEqual(2);
      expect(res.body.errors).toContain('amount must be a positive number');
      expect(res.body.errors).toContain('dueDate must be a valid date in YYYY-MM-DD format');
    });
  });
});
