const { validateInvoiceQueryParams } = require('../../src/utils/validators');

describe('Validators Utility', () => {
  describe('validateInvoiceQueryParams', () => {
    it('should validate valid status', () => {
      const query = { status: 'paid' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(true);
      expect(result.validatedParams.filters.status).toBe('paid');
    });

    it('should reject invalid status', () => {
      const query = { status: 'invalid' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid status. Must be one of: paid, pending, overdue');
    });

    it('should validate valid SME ID', () => {
      const query = { smeId: 'sme-123' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(true);
      expect(result.validatedParams.filters.smeId).toBe('sme-123');
    });

    it('should validate valid Buyer ID', () => {
      const query = { buyerId: 'buyer-456' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(true);
      expect(result.validatedParams.filters.buyerId).toBe('buyer-456');
    });

    it('should reject empty Buyer ID', () => {
      const query = { buyerId: '' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid buyerId format');
    });

    it('should validate valid dates', () => {
      const query = { dateFrom: '2023-01-01', dateTo: '2023-12-31' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(true);
      expect(result.validatedParams.filters.dateFrom).toBe('2023-01-01');
      expect(result.validatedParams.filters.dateTo).toBe('2023-12-31');
    });

    it('should reject invalid date format', () => {
      const query = { dateFrom: '01-01-2023' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid dateFrom format. Use YYYY-MM-DD');
    });

    it('should reject logically invalid dates', () => {
      const query = { dateFrom: '2023-13-01' }; // Invalid month
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(false);
    });

    it('should validate sorting parameters', () => {
      const query = { sortBy: 'amount', order: 'asc' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(true);
      expect(result.validatedParams.sorting.sortBy).toBe('amount');
      expect(result.validatedParams.sorting.order).toBe('asc');
    });

    it('should reject invalid sortBy', () => {
      const query = { sortBy: 'unsupported' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid sortBy. Must be one of: amount, date');
    });

    it('should reject invalid order', () => {
      const query = { order: 'sideways' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid order. Must be "asc" or "desc"');
    });

    it('should handle multiple errors', () => {
      const query = { status: 'none', sortBy: 'unknown' };
      const result = validateInvoiceQueryParams(query);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBe(2);
    });
  });
});
