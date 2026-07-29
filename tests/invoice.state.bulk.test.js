'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: jest.fn((req, res, next) => next()),
}));

jest.mock('../src/services/escrowSubmit', () => ({
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9._:-]{8,128}$/,
}));

const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const invoiceService = require('../src/services/invoiceService');
const { clearAuditLogs } = require('../src/services/auditLog');

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

function storeKey(tenantId, invoiceId) {
  return `${tenantId}:${invoiceId}`;
}

function createTestApp() {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    req.user = { id: 'test-user-123', sub: 'test-user-123', smeId: 'sme-verified' };
    next();
  });

  app.use('/api/invoices', invoiceStateRoutes);

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

function seedInvoiceStore(invoiceStore) {
  invoiceStore.set(storeKey(TENANT_A, 'inv-001'), {
    invoice_id: 'inv-001',
    tenant_id: TENANT_A,
    status: 'pending',
    amount: 1000,
    customer: 'Acme Corp',
  });
  invoiceStore.set(storeKey(TENANT_A, 'inv-002'), {
    invoice_id: 'inv-002',
    tenant_id: TENANT_A,
    status: 'approved',
    amount: 2000,
    customer: 'TechCo',
  });
  invoiceStore.set(storeKey(TENANT_A, 'inv-003'), {
    invoice_id: 'inv-003',
    tenant_id: TENANT_A,
    status: 'linked_escrow',
    amount: 5000,
    customer: 'GlobalInc',
  });
  invoiceStore.set(storeKey(TENANT_B, 'inv-001'), {
    invoice_id: 'inv-001',
    tenant_id: TENANT_B,
    status: 'pending',
    amount: 1000,
    customer: 'Other Corp',
  });
}

describe('Invoice State Bulk Operations', () => {
  let app;
  /** @type {Map<string, object>} */
  let invoiceStore;

  beforeEach(() => {
    clearAuditLogs();
    invoiceStore = new Map();
    seedInvoiceStore(invoiceStore);

    jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
      return invoiceStore.get(storeKey(tenantId, id)) || null;
    });

    jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId, options = {}) => {
      const key = storeKey(tenantId, id);
      const existing = invoiceStore.get(key);
      if (!existing) {
        return null;
      }
      if (options.expectedStatus !== undefined && existing.status !== options.expectedStatus) {
        return null;
      }
      const updated = { ...existing, ...updates };
      invoiceStore.set(key, updated);
      return updated;
    });

    app = createTestApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Batch validation', () => {
    it('should reject empty batch', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EMPTY_BATCH');
    });

    it('should reject non-array body', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send({ items: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_BATCH_TYPE');
    });

    it('should reject over-cap batch', async () => {
      const payload = Array.from({ length: 26 }, (_, index) => ({
        invoiceId: `inv-001`,
        action: 'approve',
      }));

      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BATCH_OVER_CAP');
    });

    it('should accept batch at exactly the cap', async () => {
      const payload = Array.from({ length: 25 }, (_, index) => ({
        invoiceId: 'inv-001',
        action: 'approve',
      }));

      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(25);
    });
  });

  describe('Per-item validation', () => {
    it('should reject missing invoiceId in an item', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ action: 'approve' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(1);
      expect(res.body.data.summary.failed).toBe(1);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('MISSING_INVOICE_ID');
    });

    it('should reject missing action in an item', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(1);
      expect(res.body.data.summary.failed).toBe(1);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('MISSING_ACTION');
    });

    it('should reject unknown action in an item', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'unknown-action' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(1);
      expect(res.body.data.summary.failed).toBe(1);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('INVALID_ACTION');
    });

    it('should reject missing targetState for transition action', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'transition' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(1);
      expect(res.body.data.summary.failed).toBe(1);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('MISSING_TARGET_STATE');
    });

    it('should reject empty invoiceId string', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: '', action: 'approve' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(1);
      expect(res.body.data.summary.failed).toBe(1);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('MISSING_INVOICE_ID');
    });
  });

  describe('Partial failure', () => {
    it('should return per-item success and failure without failing the batch', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([
          { invoiceId: 'inv-001', action: 'approve', reason: 'All checks passed' },
          { invoiceId: 'inv-999', action: 'approve', reason: 'Missing invoice' },
          { invoiceId: 'inv-002', action: 'reject', reason: 'Invalid data' },
        ]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(3);
      expect(res.body.data.summary.succeeded).toBe(2);
      expect(res.body.data.summary.failed).toBe(1);

      expect(res.body.data.results[0].success).toBe(true);
      expect(res.body.data.results[0].action).toBe('approve');
      expect(res.body.data.results[0].result.invoiceId).toBe('inv-001');
      expect(res.body.data.results[0].result.previousState).toBe('pending');
      expect(res.body.data.results[0].result.currentState).toBe('approved');

      expect(res.body.data.results[1].success).toBe(false);
      expect(res.body.data.results[1].code).toBe('INVOICE_NOT_FOUND');

      expect(res.body.data.results[2].success).toBe(true);
      expect(res.body.data.results[2].action).toBe('reject');
      expect(res.body.data.results[2].result.currentState).toBe('rejected');
    });

    it('should handle all items failing', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([
          { invoiceId: 'inv-999', action: 'approve' },
          { invoiceId: 'inv-003', action: 'approve' },
          { invoiceId: 'inv-001', action: 'transition', targetState: 'linked_escrow' },
        ]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(3);
      expect(res.body.data.summary.succeeded).toBe(0);
      expect(res.body.data.summary.failed).toBe(3);

      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[1].success).toBe(false);
      expect(res.body.data.results[2].success).toBe(false);
    });

    it('should handle all items succeeding', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([
          { invoiceId: 'inv-001', action: 'approve', reason: 'Check 1' },
          { invoiceId: 'inv-002', action: 'reject', reason: 'Check 2' },
        ]);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.total).toBe(2);
      expect(res.body.data.summary.succeeded).toBe(2);
      expect(res.body.data.summary.failed).toBe(0);

      expect(res.body.data.results[0].success).toBe(true);
      expect(res.body.data.results[1].success).toBe(true);
    });
  });

  describe('Action-specific behaviour', () => {
    it('should process approve action correctly in bulk', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'approve', reason: 'Bulk approve' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].success).toBe(true);
      expect(res.body.data.results[0].result.previousState).toBe('pending');
      expect(res.body.data.results[0].result.currentState).toBe('approved');
      expect(res.body.data.results[0].result.reason).toBe('Bulk approve');
      expect(invoiceStore.get(storeKey(TENANT_A, 'inv-001')).status).toBe('approved');
    });

    it('should process reject action correctly in bulk', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'reject', reason: 'Bulk reject' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].success).toBe(true);
      expect(res.body.data.results[0].result.currentState).toBe('rejected');
      expect(invoiceStore.get(storeKey(TENANT_A, 'inv-001')).status).toBe('rejected');
    });

    it('should process link-escrow action correctly in bulk', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-002', action: 'link-escrow', escrowId: 'escrow-bulk-1', reason: 'Bulk link' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].success).toBe(true);
      expect(res.body.data.results[0].result.currentState).toBe('linked_escrow');
      expect(res.body.data.results[0].result.escrowId).toBe('escrow-bulk-1');
    });

    it('should process transition action correctly in bulk', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'transition', targetState: 'approved', reason: 'Bulk transition' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].success).toBe(true);
      expect(res.body.data.results[0].result.currentState).toBe('approved');
    });

    it('should reject missing reason for reject action in bulk', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'reject' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('MISSING_TRANSITION_REASON');
    });

    it('should reject invalid transition in bulk', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'transition', targetState: 'linked_escrow', reason: 'Invalid jump' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('INVALID_TRANSITION');
    });
  });

  describe('Cross-tenant isolation', () => {
    it('should return 404 for cross-tenant invoice access in bulk', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_B)
        .send([{ invoiceId: 'inv-999', action: 'approve' }]);

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].success).toBe(false);
      expect(res.body.data.results[0].code).toBe('INVOICE_NOT_FOUND');
    });
  });

  describe('Response envelope', () => {
    it('should return the standard success envelope with results and summary', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([{ invoiceId: 'inv-001', action: 'approve' }]);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('message');

      expect(res.body.error).toBeNull();
      expect(res.body.message).toBe('Bulk invoice-state operation completed');
      expect(res.body.data.results).toBeInstanceOf(Array);
      expect(res.body.data.summary).toEqual(expect.objectContaining({
        total: expect.any(Number),
        succeeded: expect.any(Number),
        failed: expect.any(Number),
      }));
    });

    it('should include index in each result item', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([
          { invoiceId: 'inv-001', action: 'approve' },
          { invoiceId: 'inv-002', action: 'reject', reason: 'test' },
        ]);

      expect(res.body.data.results[0].index).toBe(0);
      expect(res.body.data.results[1].index).toBe(1);
    });
  });

});