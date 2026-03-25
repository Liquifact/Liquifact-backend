/**
 * Invoice Model Unit Tests
 * 
 * Tests for invoice validation, sanitization, and schema enforcement.
 */

const {
  validateInvoice,
  sanitizeInvoice,
  createInvoiceFromRequest,
} = require('./invoice');

describe('Invoice Model', () => {
  describe('validateInvoice()', () => {
    const validInvoice = {
      invoiceNumber: 'INV-001',
      sellerName: 'Acme Corp',
      buyerName: 'Tech LLC',
      amount: 5000,
      currency: 'USD',
      dueDate: '2027-12-31T23:59:59Z',
    };

    describe('invoiceNumber validation', () => {
      it('should accept valid invoice number', () => {
        const result = validateInvoice(validInvoice);
        expect(result.valid).toBe(true);
      });

      it('should reject missing invoiceNumber', () => {
      const { invoiceNumber, ...data } = validInvoice; // eslint-disable-line no-unused-vars
        const result = validateInvoice(data);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('invoiceNumber'))).toBe(true);
      });

      it('should reject non-string invoiceNumber', () => {
        const result = validateInvoice({ ...validInvoice, invoiceNumber: 12345 });
        expect(result.valid).toBe(false);
      });

      it('should reject invoiceNumber with invalid characters', () => {
        const result = validateInvoice({ ...validInvoice, invoiceNumber: 'INV@#$%' });
        expect(result.valid).toBe(false);
      });

      it('should reject invoiceNumber longer than 64 chars', () => {
        const result = validateInvoice({
          ...validInvoice,
          invoiceNumber: 'a'.repeat(65),
        });
        expect(result.valid).toBe(false);
      });

      it('should accept invoiceNumber with dashes and underscores', () => {
        const result = validateInvoice({
          ...validInvoice,
          invoiceNumber: 'INV-2026_001',
        });
        expect(result.valid).toBe(true);
      });
    });

    describe('sellerName validation', () => {
      it('should accept valid sellerName', () => {
        const result = validateInvoice(validInvoice);
        expect(result.valid).toBe(true);
      });

      it('should reject missing sellerName', () => {
      const { sellerName, ...data } = validInvoice; // eslint-disable-line no-unused-vars
        const result = validateInvoice(data);
        expect(result.valid).toBe(false);
      });

      it('should reject non-string sellerName', () => {
        const result = validateInvoice({ ...validInvoice, sellerName: 123 });
        expect(result.valid).toBe(false);
      });

      it('should reject sellerName longer than 255 chars', () => {
        const result = validateInvoice({
          ...validInvoice,
          sellerName: 'a'.repeat(256),
        });
        expect(result.valid).toBe(false);
      });
    });

    describe('buyerName validation', () => {
      it('should accept valid buyerName', () => {
        const result = validateInvoice(validInvoice);
        expect(result.valid).toBe(true);
      });

      it('should reject missing buyerName', () => {
      const { buyerName, ...data } = validInvoice; // eslint-disable-line no-unused-vars
        const result = validateInvoice(data);
        expect(result.valid).toBe(false);
      });

      it('should reject buyerName longer than 255 chars', () => {
        const result = validateInvoice({
          ...validInvoice,
          buyerName: 'a'.repeat(256),
        });
        expect(result.valid).toBe(false);
      });
    });

    describe('amount validation', () => {
      it('should accept valid amount', () => {
        const result = validateInvoice(validInvoice);
        expect(result.valid).toBe(true);
      });

      it('should reject missing amount', () => {
      const { amount, ...data } = validInvoice; // eslint-disable-line no-unused-vars
        const result = validateInvoice(data);
        expect(result.valid).toBe(false);
      });

      it('should reject non-numeric amount', () => {
        const result = validateInvoice({ ...validInvoice, amount: 'five thousand' });
        expect(result.valid).toBe(false);
      });

      it('should reject zero amount', () => {
        const result = validateInvoice({ ...validInvoice, amount: 0 });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('greater than 0'))).toBe(true);
      });

      it('should reject negative amount', () => {
        const result = validateInvoice({ ...validInvoice, amount: -1000 });
        expect(result.valid).toBe(false);
      });

      it('should reject amount exceeding maximum', () => {
        const result = validateInvoice({ ...validInvoice, amount: 1000000000 });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('exceeds maximum'))).toBe(true);
      });

      it('should accept decimal amounts', () => {
        const result = validateInvoice({ ...validInvoice, amount: 5000.99 });
        expect(result.valid).toBe(true);
      });

      it('should accept very small amounts', () => {
        const result = validateInvoice({ ...validInvoice, amount: 0.01 });
        expect(result.valid).toBe(true);
      });
    });

    describe('currency validation', () => {
      it('should accept valid currency code', () => {
        const result = validateInvoice(validInvoice);
        expect(result.valid).toBe(true);
      });

      it('should reject missing currency', () => {
      const { currency, ...data } = validInvoice; // eslint-disable-line no-unused-vars
        const result = validateInvoice(data);
        expect(result.valid).toBe(false);
      });

      it('should reject non-3-letter currency code', () => {
        const result = validateInvoice({ ...validInvoice, currency: 'USDA' });
        expect(result.valid).toBe(false);
      });

      it('should reject lowercase currency code', () => {
        const result = validateInvoice({ ...validInvoice, currency: 'usd' });
        expect(result.valid).toBe(false);
      });

      it('should accept various valid currencies', () => {
        const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'XLM'];
        currencies.forEach(currency => {
          const result = validateInvoice({ ...validInvoice, currency });
          expect(result.valid).toBe(true);
        });
      });
    });

    describe('dueDate validation', () => {
      it('should accept valid ISO 8601 date', () => {
        const result = validateInvoice(validInvoice);
        expect(result.valid).toBe(true);
      });

      it('should reject missing dueDate', () => {
      const { dueDate, ...data } = validInvoice; // eslint-disable-line no-unused-vars
        const result = validateInvoice(data);
        expect(result.valid).toBe(false);
      });

      it('should reject non-string dueDate', () => {
        const result = validateInvoice({ ...validInvoice, dueDate: 1234567890 });
        expect(result.valid).toBe(false);
      });

      it('should reject invalid date format', () => {
        const result = validateInvoice({ ...validInvoice, dueDate: 'not-a-date' });
        expect(result.valid).toBe(false);
      });

      it('should reject past due date', () => {
        const result = validateInvoice({ ...validInvoice, dueDate: '2020-01-01T00:00:00Z' });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('future'))).toBe(true);
      });

      it('should accept future date', () => {
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);
        const result = validateInvoice({
          ...validInvoice,
          dueDate: futureDate.toISOString(),
        });
        expect(result.valid).toBe(true);
      });
    });

    describe('optional fields', () => {
      it('should accept invoice without description', () => {
      const { description, ...data } = validInvoice; // eslint-disable-line no-unused-vars
        const result = validateInvoice(data);
        expect(result.valid).toBe(true);
      });

      it('should reject description longer than 2000 chars', () => {
        const result = validateInvoice({
          ...validInvoice,
          description: 'a'.repeat(2001),
        });
        expect(result.valid).toBe(false);
      });

      it('should accept valid status', () => {
        const result = validateInvoice({ ...validInvoice, status: 'verified' });
        expect(result.valid).toBe(true);
      });

      it('should reject invalid status', () => {
        const result = validateInvoice({ ...validInvoice, status: 'invalid' });
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('sanitizeInvoice()', () => {
    it('should trim whitespace from string fields', () => {
      const data = {
        invoiceNumber: '  INV-001  ',
        sellerName: '  Acme Corp  ',
        buyerName: '  Tech LLC  ',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const result = sanitizeInvoice(data);

      expect(result.invoiceNumber).toBe('INV-001');
      expect(result.sellerName).toBe('Acme Corp');
      expect(result.buyerName).toBe('Tech LLC');
    });

    it('should preserve numeric fields', () => {
      const data = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000.99,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const result = sanitizeInvoice(data);

      expect(result.amount).toBe(5000.99);
    });

    it('should exclude unknown fields', () => {
      const data = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
        unknownField: 'should be removed',
        anotherBadField: 12345,
      };

      const result = sanitizeInvoice(data);

      expect(result.unknownField).toBeUndefined();
      expect(result.anotherBadField).toBeUndefined();
    });

    it('should handle missing optional fields', () => {
      const data = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const result = sanitizeInvoice(data);

      expect(result.description).toBeUndefined();
      expect(result.status).toBeUndefined();
    });

    it('should filter invalid status values', () => {
      const data = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
        status: 'invalid_status',
      };

      const result = sanitizeInvoice(data);

      expect(result.status).toBeUndefined();
    });
  });

  describe('createInvoiceFromRequest()', () => {
    it('should create valid invoice from request', () => {
      const requestBody = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const result = createInvoiceFromRequest(requestBody);

      expect(result.success).toBe(true);
      expect(result.invoice).toBeDefined();
      expect(result.invoice.invoiceNumber).toBe('INV-001');
    });

    it('should return validation errors for invalid request', () => {
      const requestBody = {
        invoiceNumber: 'INV-001',
        // missing required fields
      };

      const result = createInvoiceFromRequest(requestBody);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should sanitize before validation', () => {
      const requestBody = {
        invoiceNumber: '  INV-001  ',
        sellerName: '  Acme Corp  ',
        buyerName: '  Tech LLC  ',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const result = createInvoiceFromRequest(requestBody);

      expect(result.success).toBe(true);
      expect(result.invoice.invoiceNumber).toBe('INV-001');
    });
  });
});
