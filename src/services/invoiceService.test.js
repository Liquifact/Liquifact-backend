/**
 * Invoice Service Unit Tests
 * 
 * Tests for invoice business logic, validation, and storage operations.
 * Coverage includes: create, read, update, list, and delete operations.
 */

const invoiceService = require('./invoiceService');
const storage = require('../db/storage');

// Mock storage module
jest.mock('../db/storage');

describe('Invoice Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('create()', () => {
    it('should create a valid invoice', async () => {
      const validData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
        description: 'Services',
      };

      const createdInvoice = {
        id: 'inv_123_abc',
        ...validData,
        status: 'pending_verification',
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
      };

      storage.createInvoice.mockReturnValue(createdInvoice);

      const result = await invoiceService.create(validData);

      expect(result.success).toBe(true);
      expect(result.invoice).toEqual(createdInvoice);
      expect(storage.createInvoice).toHaveBeenCalledWith(expect.objectContaining(validData));
    });

    it('should reject invoice with missing required fields', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        // missing other required fields
      };

      const result = await invoiceService.create(invalidData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Validation failed');
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject invoice with negative amount', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: -100,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const result = await invoiceService.create(invalidData);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('greater than 0'))).toBe(true);
    });

    it('should reject invoice with invalid currency code', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'INVALID',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const result = await invoiceService.create(invalidData);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('ISO 4217'))).toBe(true);
    });

    it('should reject invoice with past due date', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2020-01-01T00:00:00Z',
      };

      const result = await invoiceService.create(invalidData);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('future'))).toBe(true);
    });

    it('should trim whitespace from string fields', async () => {
      const dataWithWhitespace = {
        invoiceNumber: '  INV-001  ',
        sellerName: '  Acme Corp  ',
        buyerName: '  Tech LLC  ',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      storage.createInvoice.mockReturnValue({
        id: 'inv_123',
        ...dataWithWhitespace,
        status: 'pending_verification',
      });

      await invoiceService.create(dataWithWhitespace);

      const callArgs = storage.createInvoice.mock.calls[0][0];
      expect(callArgs.invoiceNumber).toBe('INV-001');
      expect(callArgs.sellerName).toBe('Acme Corp');
      expect(callArgs.buyerName).toBe('Tech LLC');
    });

    it('should handle storage errors gracefully', async () => {
      const validData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      storage.createInvoice.mockImplementation(() => {
        throw new Error('Storage error');
      });

      const result = await invoiceService.create(validData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create invoice');
    });
  });

  describe('getById()', () => {
    it('should retrieve an existing invoice', async () => {
      const existingInvoice = {
        id: 'inv_123',
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        amount: 5000,
        status: 'verified',
      };

      storage.getInvoice.mockReturnValue(existingInvoice);

      const result = await invoiceService.getById('inv_123');

      expect(result.success).toBe(true);
      expect(result.invoice).toEqual(existingInvoice);
      expect(storage.getInvoice).toHaveBeenCalledWith('inv_123');
    });

    it('should return error for non-existent invoice', async () => {
      storage.getInvoice.mockReturnValue(null);

      const result = await invoiceService.getById('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should reject invalid invoice ID', async () => {
      const result = await invoiceService.getById(null);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });
  });

  describe('list()', () => {
    it('should list all invoices', async () => {
      const invoices = [
        {
          id: 'inv_1',
          invoiceNumber: 'INV-001',
          status: 'verified',
          createdAt: '2026-03-20T00:00:00Z',
        },
        {
          id: 'inv_2',
          invoiceNumber: 'INV-002',
          status: 'pending_verification',
          createdAt: '2026-03-24T00:00:00Z',
        },
      ];

      storage.getAllInvoices.mockReturnValue(invoices);

      const result = await invoiceService.list();

      expect(result.success).toBe(true);
      expect(result.invoices).toHaveLength(2);
      expect(result.count).toBe(2);
    });

    it('should sort invoices by creation date (newest first)', async () => {
      const invoices = [
        {
          id: 'inv_1',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'inv_2',
          createdAt: '2026-03-25T00:00:00Z',
        },
      ];

      storage.getAllInvoices.mockReturnValue(invoices);

      const result = await invoiceService.list();

      expect(result.invoices[0].id).toBe('inv_2');
      expect(result.invoices[1].id).toBe('inv_1');
    });

    it('should filter invoices by status', async () => {
      const verifiedInvoices = [
        {
          id: 'inv_1',
          status: 'verified',
        },
      ];

      storage.getAllInvoices.mockReturnValue(verifiedInvoices);

      const result = await invoiceService.list({ status: 'verified' });

      expect(result.invoices).toHaveLength(1);
      expect(storage.getAllInvoices).toHaveBeenCalledWith({ status: 'verified' });
    });

    it('should handle empty invoice list', async () => {
      storage.getAllInvoices.mockReturnValue([]);

      const result = await invoiceService.list();

      expect(result.success).toBe(true);
      expect(result.invoices).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should handle storage errors', async () => {
      storage.getAllInvoices.mockImplementation(() => {
        throw new Error('Storage error');
      });

      const result = await invoiceService.list();

      expect(result.success).toBe(false);
      expect(result.invoices).toHaveLength(0);
      expect(result.count).toBe(0);
    });
  });

  describe('updateStatus()', () => {
    it('should update invoice status', async () => {
      const existingInvoice = {
        id: 'inv_123',
        status: 'pending_verification',
      };

      const updatedInvoice = {
        id: 'inv_123',
        status: 'verified',
        updatedAt: '2026-03-25T01:00:00Z',
      };

      storage.getInvoice.mockReturnValue(existingInvoice);
      storage.updateInvoice.mockReturnValue(updatedInvoice);

      const result = await invoiceService.updateStatus('inv_123', 'verified');

      expect(result.success).toBe(true);
      expect(result.invoice.status).toBe('verified');
      expect(storage.updateInvoice).toHaveBeenCalledWith('inv_123', { status: 'verified' });
    });

    it('should reject invalid status', async () => {
      const result = await invoiceService.updateStatus('inv_123', 'invalid_status');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid status');
    });

    it('should reject update for non-existent invoice', async () => {
      storage.getInvoice.mockReturnValue(null);

      const result = await invoiceService.updateStatus('nonexistent', 'verified');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should accept all valid status values', async () => {
      const validStatuses = [
        'pending_verification',
        'verified',
        'active',
        'funded',
        'completed',
        'cancelled',
      ];

      storage.getInvoice.mockReturnValue({ id: 'inv_123' });
      storage.updateInvoice.mockReturnValue({ id: 'inv_123', status: 'verified' });

      for (const status of validStatuses) {
        const result = await invoiceService.updateStatus('inv_123', status);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('delete()', () => {
    it('should delete an invoice', async () => {
      storage.deleteInvoice.mockReturnValue(true);

      const result = await invoiceService.delete('inv_123');

      expect(result.success).toBe(true);
      expect(storage.deleteInvoice).toHaveBeenCalledWith('inv_123');
    });

    it('should return error for non-existent invoice', async () => {
      storage.deleteInvoice.mockReturnValue(false);

      const result = await invoiceService.delete('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should reject invalid invoice ID', async () => {
      const result = await invoiceService.delete(null);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('should handle storage errors', async () => {
      storage.deleteInvoice.mockImplementation(() => {
        throw new Error('Storage error');
      });

      const result = await invoiceService.delete('inv_123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to delete');
    });
  });
});
