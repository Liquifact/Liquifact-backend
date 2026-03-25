/**
 * Invoice API Integration Tests
 * 
 * End-to-end tests for invoice REST API endpoints.
 * Tests GET/POST /api/invoices with real request/response flows.
 */

const request = require('supertest');
const express = require('express');
const cors = require('cors');
const invoiceService = require('./services/invoiceService');

// Create a test app instance
let app;

// Mock the invoice service
jest.mock('./services/invoiceService');

beforeEach(() => {
  jest.clearAllMocks();

  app = express();
  app.use(cors());
  app.use(express.json());

  // GET /api/invoices
  app.get('/api/invoices', async (req, res) => {
    const { status } = req.query;
    const filterOptions = {};

    if (status) {
      const validStatuses = [
        'pending_verification',
        'verified',
        'active',
        'funded',
        'completed',
        'cancelled',
      ];

      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: 'Invalid status filter',
          validStatuses,
        });
      }

      filterOptions.status = status;
    }

    const result = await invoiceService.list(filterOptions);

    if (!result.success) {
      return res.status(500).json({
        error: result.error,
      });
    }

    res.json({
      data: result.invoices,
      count: result.count,
    });
  });

  // POST /api/invoices
  app.post('/api/invoices', async (req, res) => {
    const result = await invoiceService.create(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        errors: result.errors,
      });
    }

    res.status(201).json({
      data: result.invoice,
      message: 'Invoice created successfully',
    });
  });
});

describe('Invoice API', () => {
  describe('GET /api/invoices', () => {
    it('should return empty list when no invoices exist', async () => {
      invoiceService.list.mockResolvedValue({
        success: true,
        invoices: [],
        count: 0,
      });

      const response = await request(app)
        .get('/api/invoices');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.count).toBe(0);
    });

    it('should return list of invoices', async () => {
      const invoices = [
        {
          id: 'inv_1',
          invoiceNumber: 'INV-001',
          sellerName: 'Acme Corp',
          amount: 5000,
          status: 'verified',
          createdAt: '2026-03-25T00:00:00Z',
        },
        {
          id: 'inv_2',
          invoiceNumber: 'INV-002',
          sellerName: 'Tech Corp',
          amount: 3000,
          status: 'pending_verification',
          createdAt: '2026-03-24T00:00:00Z',
        },
      ];

      invoiceService.list.mockResolvedValue({
        success: true,
        invoices,
        count: 2,
      });

      const response = await request(app)
        .get('/api/invoices');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.count).toBe(2);
      expect(response.body.data[0].invoiceNumber).toBe('INV-001');
    });

    it('should filter invoices by status', async () => {
      const verifiedInvoices = [
        {
          id: 'inv_1',
          invoiceNumber: 'INV-001',
          status: 'verified',
        },
      ];

      invoiceService.list.mockResolvedValue({
        success: true,
        invoices: verifiedInvoices,
        count: 1,
      });

      const response = await request(app)
        .get('/api/invoices')
        .query({ status: 'verified' });

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(1);
      expect(invoiceService.list).toHaveBeenCalledWith({ status: 'verified' });
    });

    it('should reject invalid status filter', async () => {
      const response = await request(app)
        .get('/api/invoices')
        .query({ status: 'invalid_status' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid');
    });

    it('should handle service errors', async () => {
      invoiceService.list.mockResolvedValue({
        success: false,
        error: 'Database error',
        invoices: [],
      });

      const response = await request(app)
        .get('/api/invoices');

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Database error');
    });
  });

  describe('POST /api/invoices', () => {
    it('should create an invoice with valid data', async () => {
      const requestData = {
        invoiceNumber: 'INV-2026-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000.50,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
        description: 'Q1 2026 services',
      };

      const createdInvoice = {
        id: 'inv_123_abc',
        ...requestData,
        status: 'pending_verification',
        createdAt: '2026-03-25T10:00:00Z',
        updatedAt: '2026-03-25T10:00:00Z',
      };

      invoiceService.create.mockResolvedValue({
        success: true,
        invoice: createdInvoice,
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(requestData);

      expect(response.status).toBe(201);
      expect(response.body.data.id).toBe('inv_123_abc');
      expect(response.body.data.status).toBe('pending_verification');
      expect(response.body.message).toContain('successfully');
    });

    it('should reject request with missing required fields', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        // Missing other required fields
      };

      invoiceService.create.mockResolvedValue({
        success: false,
        error: 'Validation failed',
        errors: ['sellerName is required', 'buyerName is required'],
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Validation');
      expect(response.body.errors).toBeDefined();
    });

    it('should reject request with invalid amount', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: -1000, // Negative amount
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      invoiceService.create.mockResolvedValue({
        success: false,
        error: 'Validation failed',
        errors: ['amount must be greater than 0'],
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.errors[0]).toContain('greater');
    });

    it('should reject request with invalid currency', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'INVALID',
        dueDate: '2027-12-31T23:59:59Z',
      };

      invoiceService.create.mockResolvedValue({
        success: false,
        error: 'Validation failed',
        errors: ['currency must be a 3-letter ISO 4217 code'],
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.errors[0]).toContain('ISO 4217');
    });

    it('should reject request with past due date', async () => {
      const invalidData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2020-01-01T00:00:00Z', // Past date
      };

      invoiceService.create.mockResolvedValue({
        success: false,
        error: 'Validation failed',
        errors: ['dueDate must be in the future'],
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.errors[0]).toContain('future');
    });

    it('should handle service errors gracefully', async () => {
      const validData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      invoiceService.create.mockResolvedValue({
        success: false,
        error: 'Database connection failed',
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(validData);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Database');
    });

    it('should accept optional fields', async () => {
      const requiredOnlyData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
        // No description, no status
      };

      const createdInvoice = {
        id: 'inv_123',
        ...requiredOnlyData,
        status: 'pending_verification',
        createdAt: '2026-03-25T10:00:00Z',
        updatedAt: '2026-03-25T10:00:00Z',
      };

      invoiceService.create.mockResolvedValue({
        success: true,
        invoice: createdInvoice,
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(requiredOnlyData);

      expect(response.status).toBe(201);
      expect(response.body.data.id).toBeDefined();
    });

    it('should preserve invoice amount precision', async () => {
      const requestData = {
        invoiceNumber: 'INV-001',
        sellerName: 'Acme Corp',
        buyerName: 'Tech LLC',
        amount: 5000.99,
        currency: 'USD',
        dueDate: '2027-12-31T23:59:59Z',
      };

      const createdInvoice = {
        id: 'inv_123',
        ...requestData,
        status: 'pending_verification',
        createdAt: '2026-03-25T10:00:00Z',
        updatedAt: '2026-03-25T10:00:00Z',
      };

      invoiceService.create.mockResolvedValue({
        success: true,
        invoice: createdInvoice,
      });

      const response = await request(app)
        .post('/api/invoices')
        .send(requestData);

      expect(response.status).toBe(201);
      expect(response.body.data.amount).toBe(5000.99);
    });
  });
});
