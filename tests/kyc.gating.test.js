/**
 * KYC Gating Tests
 * Comprehensive tests for KYC verification and funding gate enforcement
 * 
 * Test coverage includes:
 * - KYC service functionality
 * - KYC middleware gating
 * - Invoice KYC status tracking
 * - Funding endpoint protection
 * 
 * @module tests/kyc.gating.test
 */

const request = require('supertest');
const express = require('express');
const kycService = require('../src/services/kycService');
const { requireKycForFunding } = require('../src/middleware/kycGating');
const AppError = require('../src/errors/AppError');
const invoiceService = require('../src/services/invoiceService');
const investRoutes = require('../src/routes/invest');
const { authenticateToken } = require('../src/middleware/auth');
const logger = require('../src/logger');

describe('KYC Service Tests', () => {
  describe('getKycStatus', () => {
    it('should return pending status for unknown SME', async () => {
      const result = await kycService.getKycStatus('unknown_sme');
      expect(result).toEqual({
        status: kycService.KYC_STATUSES.PENDING,
      });
    });

    it('should throw error for invalid SME ID', async () => {
      await expect(kycService.getKycStatus('')).rejects.toThrow('Invalid SME ID');
      await expect(kycService.getKycStatus(null)).rejects.toThrow('Invalid SME ID');
      await expect(kycService.getKycStatus(123)).rejects.toThrow('Invalid SME ID');
    });

    it('should return verified status for previously verified SME', async () => {
      const smeId = 'sme_test_001';
      await kycService.verifySmeSafe(smeId);

      const result = await kycService.getKycStatus(smeId);
      expect(result.status).toBe(kycService.KYC_STATUSES.VERIFIED);
      expect(result.recordId).toBeDefined();
      expect(result.verifiedAt).toBeDefined();
    });
  });

  describe('verifySmeSafe', () => {
    it('should mark SME as verified', async () => {
      const smeId = 'sme_verify_test';
      const result = await kycService.verifySmeSafe(smeId);

      expect(result).toEqual({
        status: kycService.KYC_STATUSES.VERIFIED,
        recordId: expect.any(String),
        verifiedAt: expect.any(String),
      });
      expect(result.status).toBe('verified');
    });

    it('should generate unique record IDs for same SME', async () => {
      const smeId = 'sme_unique_test';
      const result1 = await kycService.verifySmeSafe(smeId);

      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      const result2 = await kycService.verifySmeSafe(smeId);

      expect(result1.recordId).not.toBe(result2.recordId);
    });

    it('should throw error for invalid SME ID', async () => {
      await expect(kycService.verifySmeSafe('')).rejects.toThrow('Invalid SME ID');
      await expect(kycService.verifySmeSafe(null)).rejects.toThrow('Invalid SME ID');
    });
  });

  describe('rejectSmeKyc', () => {
    it('should mark SME as rejected', async () => {
      const smeId = 'sme_reject_test';
      const result = await kycService.rejectSmeKyc(smeId, 'Failed verification');

      expect(result).toEqual({
        status: kycService.KYC_STATUSES.REJECTED,
        recordId: expect.any(String),
      });
      expect(result.status).toBe('rejected');
    });

    it('should update status for subsequent checks', async () => {
      const smeId = 'sme_reject_update_test';
      await kycService.rejectSmeKyc(smeId, 'Initial rejection');

      const status = await kycService.getKycStatus(smeId);
      expect(status.status).toBe('rejected');
    });
  });

  describe('exemptSmeFromKyc', () => {
    it('should exempt SME from KYC', async () => {
      const smeId = 'sme_exempt_test';
      const result = await kycService.exemptSmeFromKyc(smeId, 'Low-risk vendor');

      expect(result).toEqual({
        status: kycService.KYC_STATUSES.EXEMPTED,
        recordId: expect.any(String),
      });
      expect(result.status).toBe('exempted');
    });

    it('should allow funding with exempted status', async () => {
      const smeId = 'sme_exempt_funding_test';
      await kycService.exemptSmeFromKyc(smeId);

      const canFund = kycService.canFundWithKycStatus('exempted');
      expect(canFund).toBe(true);
    });
  });

  describe('canFundWithKycStatus', () => {
    it('should return true for verified status', () => {
      const result = kycService.canFundWithKycStatus('verified');
      expect(result).toBe(true);
    });

    it('should return true for exempted status', () => {
      const result = kycService.canFundWithKycStatus('exempted');
      expect(result).toBe(true);
    });

    it('should return false for pending status', () => {
      const result = kycService.canFundWithKycStatus('pending');
      expect(result).toBe(false);
    });

    it('should return false for rejected status', () => {
      const result = kycService.canFundWithKycStatus('rejected');
      expect(result).toBe(false);
    });
  });

  describe('getKycProviderConfig', () => {
    it('should indicate disabled provider when env vars missing', () => {
      const config = kycService.getKycProviderConfig();
      expect(config.enabled).toBe(false);
      expect(config.apiKey).toBeNull();
      expect(config.baseUrl).toBeNull();
    });
  });
});

describe('KYC Gating Middleware Tests', () => {
  let app;

  beforeEach(() => {
    kycService.resetMockRecords();
    app = express();
    app.use(express.json());

    // Mock authentication middleware
    app.use((req, res, next) => {
      req.user = {
        sub: 'user_123',
        smeId: 'sme_test_001',
      };
      req.id = 'req_123';
      next();
    });
  });

  describe('requireKycForFunding - success cases', () => {
    it('should pass through when KYC is verified', async () => {
      const smeId = 'sme_gate_verified';
      await kycService.verifySmeSafe(smeId);

      app.post('/fund', requireKycForFunding, (req, res) => {
        res.json({ success: true, kyc: req.kyc });
      });

      const res = await request(app)
        .post('/fund')
        .send({ smeId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.kyc.status).toBe('verified');
    });

    it('should pass through when KYC is exempted', async () => {
      const smeId = 'sme_gate_exempt';
      await kycService.exemptSmeFromKyc(smeId);

      app.post('/fund', requireKycForFunding, (req, res) => {
        res.json({ success: true, kyc: req.kyc });
      });

      const res = await request(app)
        .post('/fund')
        .send({ smeId });

      expect(res.status).toBe(200);
      expect(res.body.kyc.status).toBe('exempted');
    });

    it('should attach KYC info to request object', async () => {
      const smeId = 'sme_gate_attach_kyc';
      await kycService.verifySmeSafe(smeId);

      app.post('/fund', requireKycForFunding, (req, res) => {
        expect(req.kyc).toBeDefined();
        expect(req.kyc.status).toBe('verified');
        expect(req.kyc.recordId).toBeDefined();
        res.json({ ok: true });
      });

      await request(app)
        .post('/fund')
        .send({ smeId });
    });
  });

  describe('requireKycForFunding - failure cases', () => {
    it('should reject when KYC is pending', async () => {
      app.post('/fund', requireKycForFunding, (req, res) => {
        res.json({ success: true });
      });

      app.use((err, req, res, next) => {
        res.status(err.status || 500).json({
          error: { code: err.code, message: err.title },
        });
      });

      const res = await request(app)
        .post('/fund')
        .send({ smeId: 'sme_gate_pending' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_GATE_FAILED');
    });

    it('should reject when KYC is rejected', async () => {
      const smeId = 'sme_gate_rejected';
      await kycService.rejectSmeKyc(smeId, 'Failed verification');

      app.post('/fund', requireKycForFunding, (req, res) => {
        res.json({ success: true });
      });

      app.use((err, req, res, next) => {
        res.status(err.status || 500).json({
          error: { code: err.code, message: err.title },
        });
      });

      const res = await request(app)
        .post('/fund')
        .send({ smeId });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_GATE_FAILED');
    });

    it('should return 400 when SME ID is missing', async () => {
      app.post('/fund', requireKycForFunding, (req, res) => {
        res.json({ success: true });
      });

      app.use((err, req, res, next) => {
        res.status(err.status || 500).json({
          error: { code: err.code, message: err.title },
        });
      });

      const res = await request(app)
        .post('/fund')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_SME_ID');
    });

    it('should return 401 when user is not authenticated', async () => {
      const testApp = express();
      testApp.use(express.json());

      testApp.post('/fund', requireKycForFunding, (req, res) => {
        res.json({ success: true });
      });

      testApp.use((err, req, res, next) => {
        res.status(err.status || 500).json({
          error: { code: err.code, message: err.title },
        });
      });

      const res = await request(testApp)
        .post('/fund')
        .send({ smeId: 'sme_test' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });
});

describe('Invoice Service - KYC Integration Tests', () => {
  describe('updateInvoiceKycStatus', () => {
    it('should update invoice KYC status', () => {
      const invoiceId = 'inv_1';
      const result = invoiceService.updateInvoiceKycStatus(invoiceId, 'verified', 'kyc_rec_001');

      expect(result.kycStatus).toBe('verified');
      expect(result.kycRecordId).toBe('kyc_rec_001');
      expect(result.kycStatusUpdatedAt).toBeDefined();
    });

    it('should throw error for invalid KYC status', () => {
      expect(() => {
        invoiceService.updateInvoiceKycStatus('inv_1', 'invalid_status');
      }).toThrow('Invalid KYC status');
    });

    it('should throw error for non-existent invoice', () => {
      expect(() => {
        invoiceService.updateInvoiceKycStatus('inv_nonexistent', 'verified');
      }).toThrow('not found');
    });
  });

  describe('getInvoicesByKycStatus', () => {
    it('should filter invoices by KYC status', () => {
      const verified = invoiceService.getInvoicesByKycStatus('user_1', 'verified');
      expect(verified.length).toBeGreaterThan(0);
      expect(verified.every(inv => inv.kycStatus === 'verified')).toBe(true);
    });

    it('should return all invoices when no KYC filter applied', () => {
      const all = invoiceService.getInvoicesByKycStatus('user_1');
      expect(all.length).toBeGreaterThan(0);
    });

    it('should respect user authorization', () => {
      const user2Invoices = invoiceService.getInvoicesByKycStatus('user_2');
      expect(user2Invoices.every(inv => inv.ownerId === 'user_2')).toBe(true);
    });

    it('should throw error when user ID missing', () => {
      expect(() => {
        invoiceService.getInvoicesByKycStatus(null);
      }).toThrow('User ID required');
    });
  });
});

describe('Invest Routes - KYC Gating Tests', () => {
  let app;

  beforeEach(() => {
      kycService.resetMockRecords();
      app = express();
      app.use(express.json());

      // Mock req.id and req.user
      app.use((req, res, next) => {
        req.id = 'req_test_' + Math.random().toString(36).slice(7);
        req.user = {
          sub: 'investor_123',
          smeId: 'sme_investor_test',
        };
        next();
      });

      app.use('/api/invest', investRoutes);

      // Mock error handler
      app.use((err, req, res, next) => {
        const status = err.status || 500;
        res.status(status).json({
          error: {
            code: err.code || 'UNKNOWN_ERROR',
            message: err.detail || err.message,
            type: err.type,
          },
        });
      });

  describe('POST /api/invest/fund-invoice - KYC Verification', () => {
    it('should fund invoice when KYC is verified', async () => {
      const smeId = 'sme_fund_verified';
      await kycService.verifySmeSafe(smeId);

      app.use((req, res, next) => {
        req.user = {
          sub: 'investor_verified',
          smeId,
        };
        req.id = 'req_fund_verified';
        next();
      });

      // Reset routes with new middleware order
      app.post('/invest/fund-invoice', authenticateToken, requireKycForFunding, (req, res) => {
        res.status(201).json({
          data: {
            investmentId: 'inv_new_001',
            status: 'pending',
          },
        });
      });

      // Workaround: Create new app with correct setup
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, res, next) => {
        req.user = { sub: 'investor_verified', smeId };
        req.id = 'req_fund_verified';
        next();
      });

      testApp.post('/fund-invoice', requireKycForFunding, (req, res) => {
        res.status(201).json({
          data: { investmentId: 'inv_001', status: 'pending' },
          meta: { kycVerified: true, kycStatus: req.kyc.status },
        });
      });

      const res = await request(testApp)
        .post('/fund-invoice')
        .send({
          invoiceId: 'inv_test_001',
          investmentAmount: 1000,
          smeId,
        });

      expect(res.status).toBe(201);
      expect(res.body.meta.kycVerified).toBe(true);
    });

    it('should reject funding when KYC is pending', async () => {
      const testApp = express();
      testApp.use(express.json());

      const smeId = 'sme_fund_pending_test';

      testApp.use((req, res, next) => {
        req.user = { sub: 'investor_test', smeId };
        req.id = 'req_fund_pending';
        next();
      });

      testApp.use((err, req, res, next) => {
        res.status(err.status || 500).json({
          error: { code: err.code, message: err.detail },
        });
      });

      testApp.post('/fund-invoice', requireKycForFunding, (req, res) => {
        res.status(201).json({ data: { status: 'pending' } });
      });

      const res = await request(testApp)
        .post('/fund-invoice')
        .send({
          invoiceId: 'inv_test_002',
          investmentAmount: 2000,
          smeId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_GATE_FAILED');
    });

    it('should validate required fields', async () => {
      const testApp = express();
      testApp.use(express.json());

      const smeId = 'sme_fund_exempt_test';
      await kycService.exemptSmeFromKyc(smeId);

      testApp.use((req, res, next) => {
        req.user = { sub: 'investor_test', smeId };
        req.id = 'req_fund_validate';
        next();
      });

      testApp.use((err, req, res, next) => {
        res.status(err.status || 500).json({
          error: { code: err.code, message: err.detail },
        });
      });

      testApp.post('/fund-invoice', requireKycForFunding, (req, res) => {
        res.status(201).json({ data: { status: 'pending' } });
      });

      // Test missing invoiceId
      let res = await request(testApp)
        .post('/fund-invoice')
        .send({
          investmentAmount: 1000,
          smeId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INVOICE_ID');

      // Test missing investmentAmount
      res = await request(testApp)
        .post('/fund-invoice')
        .send({
          invoiceId: 'inv_123',
          smeId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INVESTMENT_AMOUNT');

      // Test negative amount
      res = await request(testApp)
        .post('/fund-invoice')
        .send({
          invoiceId: 'inv_123',
          investmentAmount: -100,
          smeId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INVESTMENT_AMOUNT');
    });
  });
});

describe('Invoice Schema Validation Tests', () => {
  const { validateInvoiceCreation, validateKycStatusUpdate } = require('../src/schemas/invoice');

  describe('validateInvoiceCreation', () => {
    it('should validate correct invoice data', () => {
      const invoice = {
        id: 'inv_valid_001',
        status: 'verified',
        amount: 1000,
        customer: 'Test Corp',
        ownerId: 'user_123',
        kycStatus: 'verified',
      };

      const result = validateInvoiceCreation(invoice);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid amount', () => {
      const invoice = {
        id: 'inv_test',
        status: 'verified',
        amount: -100,
        customer: 'Test',
        ownerId: 'user_1',
      };

      const result = validateInvoiceCreation(invoice);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject invalid status', () => {
      const invoice = {
        id: 'inv_test',
        status: 'invalid_status',
        amount: 1000,
        customer: 'Test',
        ownerId: 'user_1',
      };

      const result = validateInvoiceCreation(invoice);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid KYC status', () => {
      const invoice = {
        id: 'inv_test',
        status: 'verified',
        amount: 1000,
        customer: 'Test',
        ownerId: 'user_1',
        kycStatus: 'invalid_kyc_status',
      };

      const result = validateInvoiceCreation(invoice);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateKycStatusUpdate', () => {
    it('should validate correct KYC status update', () => {
      const data = {
        kycStatus: 'verified',
        kycRecordId: 'kyc_rec_001',
      };

      const result = validateKycStatusUpdate(data);
      expect(result.valid).toBe(true);
    });

    it('should require kycStatus', () => {
      const data = { kycRecordId: 'kyc_rec_001' };
      const result = validateKycStatusUpdate(data);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('kycStatus is required');
    });

    it('should reject invalid KYC status', () => {
      const data = { kycStatus: 'invalid' };
      const result = validateKycStatusUpdate(data);
      expect(result.valid).toBe(false);
    });
  });
});
