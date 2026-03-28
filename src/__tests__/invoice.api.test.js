const request = require('supertest');
const { createApp } = require('../app');

function createMockInvoiceRepo() {
  return {
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
  };
}

describe('Invoice API Integration', () => {
  let app;
  let mockInvoiceRepo;

  beforeEach(() => {
    mockInvoiceRepo = createMockInvoiceRepo();
    app = createApp({ invoiceRepo: mockInvoiceRepo });
    jest.clearAllMocks();
  });

  describe('GET /api/invoices', () => {
    it('should return 200 and invoices when no query params are provided', async () => {
      const mockInvoices = [{ id: 1, amount: 100 }, { id: 2, amount: 200 }];
      mockInvoiceRepo.findAll.mockResolvedValue(mockInvoices);

      const res = await request(app).get('/api/invoices');

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual(mockInvoices);
      expect(mockInvoiceRepo.findAll).toHaveBeenCalledWith({ includeDeleted: false });
    });

    it('should pass includeDeleted when requested', async () => {
      mockInvoiceRepo.findAll.mockResolvedValue([]);
      const res = await request(app).get('/api/invoices?includeDeleted=true');
      expect(res.statusCode).toBe(200);
      expect(mockInvoiceRepo.findAll).toHaveBeenCalledWith({ includeDeleted: true });
    });

    it('should handle service errors with 500', async () => {
      mockInvoiceRepo.findAll.mockRejectedValue(new Error('Service failure'));
      const res = await request(app).get('/api/invoices');
      expect(res.statusCode).toBe(500);
      expect(res.body.error.code).toBe('INVOICE_FETCH_ERROR');
    });
  });
});
