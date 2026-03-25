/**
 * Storage Layer Unit Tests
 * 
 * Tests for persistent storage operations (create, read, update, delete).
 * Tests file I/O, atomic writes, and data consistency.
 */

const fs = require('fs');
const storage = require('./storage');

// Override storage paths for testing
jest.mock('fs');

describe('Storage Layer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset file system mock
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('[]');
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
  });

  describe('getInvoice()', () => {
    it('should retrieve invoice by ID', () => {
      const mockInvoices = [
        { id: 'inv_1', invoiceNumber: 'INV-001' },
        { id: 'inv_2', invoiceNumber: 'INV-002' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.getInvoice('inv_1');

      expect(result).toEqual({ id: 'inv_1', invoiceNumber: 'INV-001' });
    });

    it('should return null for non-existent invoice', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify([]));

      const result = storage.getInvoice('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle corrupted JSON gracefully', () => {
      fs.readFileSync.mockReturnValue('{ invalid json }');

      const result = storage.getInvoice('inv_1');

      expect(result).toBeNull();
    });
  });

  describe('createInvoice()', () => {
    it('should create an invoice with generated ID and timestamps', () => {
      fs.readFileSync.mockReturnValue('[]');

      const invoiceData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        amount: 5000,
      };

      const result = storage.createInvoice(invoiceData);

      expect(result.id).toMatch(/^inv_\d+_[a-z0-9]+$/);
      expect(result.invoiceNumber).toBe('INV-001');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(result.status).toBe('pending_verification');
    });

    it('should preserve existing status if provided', () => {
      fs.readFileSync.mockReturnValue('[]');

      const invoiceData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        amount: 5000,
        status: 'verified',
      };

      const result = storage.createInvoice(invoiceData);

      expect(result.status).toBe('verified');
    });

    it('should call writeFileSync and renameSync for atomic save', () => {
      fs.readFileSync.mockReturnValue('[]');

      const invoiceData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        amount: 5000,
      };

      storage.createInvoice(invoiceData);

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('should clean up temp file on write failure', () => {
      fs.readFileSync.mockReturnValue('[]');
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });
      fs.unlinkSync.mockImplementation(() => {});

      const invoiceData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        amount: 5000,
      };

      expect(() => {
        storage.createInvoice(invoiceData);
      }).toThrow('Failed to save invoices');
    });
  });

  describe('getAllInvoices()', () => {
    it('should return all invoices when no filter provided', () => {
      const mockInvoices = [
        { id: 'inv_1', status: 'verified' },
        { id: 'inv_2', status: 'pending_verification' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.getAllInvoices();

      expect(result).toHaveLength(2);
    });

    it('should filter invoices by status', () => {
      const mockInvoices = [
        { id: 'inv_1', status: 'verified' },
        { id: 'inv_2', status: 'pending_verification' },
        { id: 'inv_3', status: 'verified' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.getAllInvoices({ status: 'verified' });

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('verified');
      expect(result[1].status).toBe('verified');
    });

    it('should filter invoices by multiple fields', () => {
      const mockInvoices = [
        { id: 'inv_1', status: 'verified', currency: 'USD' },
        { id: 'inv_2', status: 'verified', currency: 'EUR' },
        { id: 'inv_3', status: 'pending_verification', currency: 'USD' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.getAllInvoices({ status: 'verified', currency: 'USD' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('inv_1');
    });

    it('should return empty array when no matches found', () => {
      const mockInvoices = [
        { id: 'inv_1', status: 'verified' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.getAllInvoices({ status: 'cancelled' });

      expect(result).toHaveLength(0);
    });
  });

  describe('updateInvoice()', () => {
    it('should update an invoice', () => {
      const mockInvoices = [
        { id: 'inv_1', status: 'pending_verification', createdAt: '2026-01-01T00:00:00Z' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.updateInvoice('inv_1', { status: 'verified' });

      expect(result.status).toBe('verified');
      expect(result.createdAt).toBe('2026-01-01T00:00:00Z');
      expect(result.updatedAt).toBeDefined();
    });

    it('should prevent ID change during update', () => {
      const mockInvoices = [
        { id: 'inv_1', invoiceNumber: 'INV-001' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.updateInvoice('inv_1', { id: 'inv_999' });

      expect(result.id).toBe('inv_1');
    });

    it('should return null for non-existent invoice', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify([]));

      const result = storage.updateInvoice('nonexistent', { status: 'verified' });

      expect(result).toBeNull();
    });

    it('should update updatedAt timestamp', () => {
      const mockInvoices = [
        { id: 'inv_1', status: 'pending_verification', updatedAt: '2026-01-01T00:00:00Z' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.updateInvoice('inv_1', { status: 'verified' });

      expect(result.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    });
  });

  describe('deleteInvoice()', () => {
    it('should delete an invoice', () => {
      const mockInvoices = [
        { id: 'inv_1', invoiceNumber: 'INV-001' },
        { id: 'inv_2', invoiceNumber: 'INV-002' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      const result = storage.deleteInvoice('inv_1');

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should return false for non-existent invoice', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify([]));

      const result = storage.deleteInvoice('nonexistent');

      expect(result).toBe(false);
    });

    it('should save changes when invoice is deleted', () => {
      const mockInvoices = [
        { id: 'inv_1', invoiceNumber: 'INV-001' },
      ];
      fs.readFileSync.mockReturnValue(JSON.stringify(mockInvoices));

      storage.deleteInvoice('inv_1');

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('clearAll()', () => {
    it('should delete database file', () => {
      fs.unlinkSync.mockImplementation(() => {});

      storage.clearAll();

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should handle missing file gracefully', () => {
      fs.existsSync.mockReturnValue(false);

      expect(() => {
        storage.clearAll();
      }).not.toThrow();
    });
  });
});
