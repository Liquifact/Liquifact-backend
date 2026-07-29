/**
 * Invoice-State Examples — Integration Tests
 *
 * Validates that the documented examples in docs/invoice-state-examples.md
 * match the actual route behaviour. Drives each endpoint with supertest and
 * asserts the response envelope shape, status codes, and error codes.
 *
 * @jest-environment node
 */

'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
}));

const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const invoiceService = require('../src/services/invoiceService');
const { clearAuditLogs, getAuditLogs } = require('../src/services/auditLog');

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

function storeKey(tenantId, invoiceId) {
  return `${tenantId}:${invoiceId}`;
}

function buildApp() {
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

describe('Invoice-State Examples — documented response shapes', () => {
  let app;
  /** @type {Map<string, object>} */
  let invoiceStore;

  function seedFixtures() {
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
    invoiceStore.set(storeKey(TENANT_A, 'inv-004'), {
      invoice_id: 'inv-004',
      tenant_id: TENANT_A,
      status: 'rejected',
      amount: 3000,
      customer: 'FailCo',
    });
    invoiceStore.set(storeKey(TENANT_A, 'inv-005'), {
      invoice_id: 'inv-005',
      tenant_id: TENANT_A,
      status: 'cancelled',
      amount: 4000,
      customer: 'CancelCo',
    });
  }

  beforeEach(() => {
    clearAuditLogs();
    invoiceStore = new Map();
    seedFixtures();

    jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
      return invoiceStore.get(storeKey(tenantId, id)) || null;
    });

    jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId) => {
      const key = storeKey(tenantId, id);
      const existing = invoiceStore.get(key);
      if (!existing) return null;
      const updated = { ...existing, ...updates };
      invoiceStore.set(key, updated);
      return updated;
    });

    app = buildApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /* ------------------------------------------------------------------ */
  /*  1. GET /api/invoices/:id/state                                     */
  /* ------------------------------------------------------------------ */
  describe('GET /api/invoices/:id/state', () => {
    it('returns documented shape for a pending invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error', null);
      expect(res.body).toHaveProperty('message');

      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.currentState).toBe('pending');
      expect(Array.isArray(res.body.data.allowedTransitions)).toBe(true);
      expect(res.body.data.allowedTransitions).toContain('approved');
      expect(res.body.data.allowedTransitions).toContain('rejected');
      expect(res.body.data.allowedTransitions).toContain('cancelled');
      expect(res.body.data.isTerminal).toBe(false);

      expect(res.body.meta).toHaveProperty('timestamp');
      expect(res.body.meta).toHaveProperty('version');
    });

    it('returns documented shape for a terminal invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-003/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe('inv-003');
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.allowedTransitions).toEqual([]);
      expect(res.body.data.isTerminal).toBe(true);
    });

    it('returns 404 INVOICE_NOT_FOUND for unknown invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/nonexistent-id/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
      expect(res.body.error.message).toBe('Invoice not found');
      expect(res.body.data).toBeNull();
    });

    it('returns 404 for cross-tenant access', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_B);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. POST /api/invoices/:id/transition                               */
  /* ------------------------------------------------------------------ */
  describe('POST /api/invoices/:id/transition', () => {
    it('returns documented shape for pending → approved', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved', reason: 'Invoice verified by finance team' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error', null);
      expect(res.body).toHaveProperty('message');

      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('approved');
      expect(res.body.data.transitionedBy).toBe('test-user-123');
      expect(res.body.data.reason).toBe('Invoice verified by finance team');
      expect(res.body.data.auditLogId).toBeDefined();
      expect(typeof res.body.data.auditLogId).toBe('string');
      expect(res.body.data.transitionedAt).toBeDefined();

      expect(res.body.message).toContain('pending to approved');
    });

    it('returns documented shape for pending → rejected', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'rejected', reason: 'Missing supporting documentation' });

      expect(res.status).toBe(200);
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('rejected');
      expect(res.body.data.reason).toBe('Missing supporting documentation');
    });

    it('returns MISSING_TARGET_STATE when targetState is absent', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Forgot the target state' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_TARGET_STATE');
      expect(res.body.data).toBeNull();
    });

    it('returns INVALID_TRANSITION with allowedTransitions for silent jump', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'linked_escrow', reason: 'Trying to skip approval' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(res.body.error.details).toBeDefined();
      expect(Array.isArray(res.body.error.details.allowedTransitions)).toBe(true);
      expect(res.body.error.details.allowedTransitions).toContain('approved');
    });

    it('returns MISSING_TRANSITION_REASON for terminal target without reason', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'rejected' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_TRANSITION_REASON');
      expect(res.body.error.message).toContain('Reason is required');
    });

    it('returns TERMINAL_STATE for transition from terminal state', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TERMINAL_STATE');
    });

    it('returns 404 for unknown invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-999/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. POST /api/invoices/:id/approve                                  */
  /* ------------------------------------------------------------------ */
  describe('POST /api/invoices/:id/approve', () => {
    it('returns documented shape for successful approval', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'All documentation checks passed' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error', null);
      expect(res.body).toHaveProperty('message');

      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('approved');
      expect(res.body.data.transitionedBy).toBe('test-user-123');
      expect(res.body.data.auditLogId).toBeDefined();
      expect(res.body.data.transitionedAt).toBeDefined();

      expect(res.body.message).toBe('Invoice approved successfully');
    });

    it('accepts empty body (reason defaults to "Invoice approved")', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.currentState).toBe('approved');
      expect(res.body.message).toBe('Invoice approved successfully');
    });

    it('returns ALREADY_IN_TARGET_STATE for already approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Already approved' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ALREADY_IN_TARGET_STATE');
      expect(res.body.data).toBeNull();
    });

    it('returns TERMINAL_STATE for terminal invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Trying to approve terminal' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TERMINAL_STATE');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. POST /api/invoices/:id/link-escrow                              */
  /* ------------------------------------------------------------------ */
  describe('POST /api/invoices/:id/link-escrow', () => {
    it('returns documented shape with escrowId', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({
          escrowId: 'CESCROW123AAABBBCCCDDDEEEFFFGGGHHH',
          reason: 'Soroban escrow contract deployed and funded',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error', null);
      expect(res.body).toHaveProperty('message');

      expect(res.body.data.invoiceId).toBe('inv-002');
      expect(res.body.data.previousState).toBe('approved');
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.escrowId).toBe('CESCROW123AAABBBCCCDDDEEEFFFGGGHHH');
      expect(res.body.data.transitionedBy).toBe('test-user-123');
      expect(res.body.data.auditLogId).toBeDefined();
      expect(res.body.data.transitionedAt).toBeDefined();

      expect(res.body.message).toBe('Invoice linked to escrow successfully');
    });

    it('returns null escrowId when escrowId is not provided', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Pending escrow contract ID' });

      expect(res.status).toBe(200);
      expect(res.body.data.escrowId).toBeNull();
    });

    it('returns CANNOT_LINK_TO_ESCROW for non-approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CANNOT_LINK_TO_ESCROW');
      expect(res.body.data).toBeNull();
    });

    it('returns CANNOT_LINK_TO_ESCROW for already linked invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-789' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CANNOT_LINK_TO_ESCROW');
    });

    it('returns 404 for unknown invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-999/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });

    it('returns KYC_GATE_FAILED when KYC check fails', async () => {
      const { requireKycForFunding } = require('../src/middleware/kycGating');
      requireKycForFunding.mockImplementationOnce((_req, res, _next) => {
        res.status(403).json({
          data: null,
          error: {
            message: "SME KYC status 'pending' does not permit funding operations.",
            code: 'KYC_GATE_FAILED',
            details: null,
          },
        });
      });

      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-000' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_GATE_FAILED');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. POST /api/invoices/:id/reject                                   */
  /* ------------------------------------------------------------------ */
  describe('POST /api/invoices/:id/reject', () => {
    it('returns documented shape for successful rejection', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({
          reason: 'Invalid supporting documentation — VAT registration number missing',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error', null);
      expect(res.body).toHaveProperty('message');

      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('rejected');
      expect(res.body.data.reason).toBe(
        'Invalid supporting documentation — VAT registration number missing',
      );
      expect(res.body.data.transitionedBy).toBe('test-user-123');
      expect(res.body.data.auditLogId).toBeDefined();
      expect(res.body.data.transitionedAt).toBeDefined();

      expect(res.body.message).toBe('Invoice rejected successfully');
    });

    it('returns MISSING_TRANSITION_REASON when reason is empty', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_TRANSITION_REASON');
      expect(res.body.data).toBeNull();
    });

    it('returns INVALID_TRANSITION when trying to reject approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Cannot reject approved invoice' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(res.body.error.details).toBeDefined();
      expect(Array.isArray(res.body.error.details.allowedTransitions)).toBe(true);
    });

    it('returns ALREADY_IN_TARGET_STATE for already rejected invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-004/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Trying to reject again' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ALREADY_IN_TARGET_STATE');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  6. GET /api/invoices/:id/history                                   */
  /* ------------------------------------------------------------------ */
  describe('GET /api/invoices/:id/history', () => {
    it('returns documented shape with multiple transitions', async () => {
      await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved', reason: 'First transition' });

      await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'linked_escrow', reason: 'Second transition' });

      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body).toHaveProperty('error', null);
      expect(res.body).toHaveProperty('message');

      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(Array.isArray(res.body.data.transitions)).toBe(true);
      expect(res.body.data.transitions).toHaveLength(2);
      expect(res.body.data.totalTransitions).toBe(2);

      const first = res.body.data.transitions[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('timestamp');
      expect(first).toHaveProperty('actor');
      expect(first).toHaveProperty('fromState');
      expect(first).toHaveProperty('toState');
      expect(first).toHaveProperty('reason');
      expect(first).toHaveProperty('ipAddress');
      expect(first.fromState).toBe('approved');
      expect(first.toState).toBe('linked_escrow');
    });

    it('returns documented shape with empty transitions', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.transitions).toEqual([]);
      expect(res.body.data.totalTransitions).toBe(0);
    });

    it('returns 404 INVOICE_NOT_FOUND for unknown invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/nonexistent-id/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
      expect(res.body.data).toBeNull();
    });

    it('returns 404 for cross-tenant access', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_B);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Common errors                                                      */
  /* ------------------------------------------------------------------ */
  describe('Common errors', () => {
    it('returns 400 when tenant context is missing', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state');

      expect(res.status).toBe(400);
    });

    it('returns INVOICE_NOT_FOUND consistently across all endpoints', async () => {
      const endpoints = [
        { method: 'get', path: '/api/invoices/inv-999/state' },
        { method: 'post', path: '/api/invoices/inv-999/transition', body: { targetState: 'approved' } },
        { method: 'post', path: '/api/invoices/inv-999/approve', body: {} },
        { method: 'post', path: '/api/invoices/inv-999/link-escrow', body: { escrowId: 'x' } },
        { method: 'post', path: '/api/invoices/inv-999/reject', body: { reason: 'x' } },
        { method: 'get', path: '/api/invoices/inv-999/history' },
      ];

      for (const ep of endpoints) {
        const req = request(app)[ep.method](ep.path).set('x-tenant-id', TENANT_A);
        const res = ep.body ? await req.send(ep.body) : await req;
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Response envelope integrity                                        */
  /* ------------------------------------------------------------------ */
  describe('Response envelope integrity', () => {
    it('all successful responses include meta.timestamp and meta.version', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.body.meta).toBeDefined();
      expect(typeof res.body.meta.timestamp).toBe('string');
      expect(typeof res.body.meta.version).toBe('string');
      expect(res.body.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('all error responses include meta and error.code', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'linked_escrow' });

      expect(res.status).toBe(400);
      expect(res.body.meta).toBeDefined();
      expect(typeof res.body.error.code).toBe('string');
      expect(typeof res.body.error.message).toBe('string');
    });
  });
});
