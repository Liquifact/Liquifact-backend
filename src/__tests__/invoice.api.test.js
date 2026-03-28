const request = require('supertest');
const { createApp } = require('../app');
const invoiceService = require('../services/invoice.service');

// Mock the service
jest.mock('../services/invoice.service');

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
});
