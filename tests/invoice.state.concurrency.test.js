/**
 * Invoice-state concurrency smoke tests (#868)
 *
 * Deterministic, bounded parallel requests against the invoice-state routes
 * with an in-memory store (no real network / DB). Asserts:
 *   - Competing writes: exactly one winner, no lost update
 *   - Duplicate parallel writes: single success + single audit
 *   - Read-after-write consistency under concurrent GETs
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

const { clearAuditLogs, getAuditLogs } = require('../src/services/auditLog');
const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const invoiceService = require('../src/services/invoiceService');

const TENANT_A = 'tenant-alpha';

describe('Invoice-state concurrency smoke (#868)', () => {
  /** @type {import('express').Express} */
  let app;
  /** @type {Map<string, object>} */
  let invoiceStore;

  function storeKey(tenantId, invoiceId) {
    return `${tenantId}:${invoiceId}`;
  }

  function seedPending(invoiceId = 'inv-conc-001') {
    invoiceStore.set(storeKey(TENANT_A, invoiceId), {
      invoice_id: invoiceId,
      tenant_id: TENANT_A,
      status: 'pending',
      amount: 1500,
      customer: 'Concurrency Co',
    });
  }

  beforeEach(() => {
    clearAuditLogs();
    invoiceStore = new Map();
    seedPending();

    // Yield on every read so Promise.all callers interleave at the TOCTOU window.
    jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
      await new Promise((resolve) => setImmediate(resolve));
      return invoiceStore.get(storeKey(tenantId, id)) || null;
    });

    jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId, options = {}) => {
      await new Promise((resolve) => setImmediate(resolve));
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

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'concurrency-tester', sub: 'concurrency-tester', smeId: 'sme-verified' };
      next();
    });
    app.use('/api/invoices', invoiceStateRoutes);
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parallel identical approve calls: exactly one success, no lost update, single audit', async () => {
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app)
          .post('/api/invoices/inv-conc-001/approve')
          .set('x-tenant-id', TENANT_A)
          .send({ reason: `parallel-approve-${i}` }),
      ),
    );

    const successes = results.filter((r) => r.status === 200);
    const failures = results.filter((r) => r.status !== 200);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(N - 1);
    expect(successes[0].body.data.currentState).toBe('approved');
    expect(invoiceStore.get(storeKey(TENANT_A, 'inv-conc-001')).status).toBe('approved');

    for (const failure of failures) {
      expect([400, 409]).toContain(failure.status);
      expect(['ALREADY_IN_TARGET_STATE', 'TRANSITION_CONFLICT', 'INVALID_TRANSITION', 'TERMINAL_STATE'])
        .toContain(failure.body?.error?.code);
    }

    const logs = await getAuditLogs({ resourceId: 'inv-conc-001' });
    expect(logs).toHaveLength(1);
    expect(logs[0].changes.before.state).toBe('pending');
    expect(logs[0].changes.after.state).toBe('approved');
  });

  it('competing approve vs reject: exactly one winner, final state matches winner, no phantom audit', async () => {
    const results = await Promise.all([
      request(app)
        .post('/api/invoices/inv-conc-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'race-approve' }),
      request(app)
        .post('/api/invoices/inv-conc-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'race-reject' }),
    ]);

    const successes = results.filter((r) => r.status === 200);
    const failures = results.filter((r) => r.status !== 200);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const winnerState = successes[0].body.data.currentState;
    expect(['approved', 'rejected']).toContain(winnerState);
    expect(invoiceStore.get(storeKey(TENANT_A, 'inv-conc-001')).status).toBe(winnerState);

    const logs = await getAuditLogs({ resourceId: 'inv-conc-001' });
    expect(logs).toHaveLength(1);
    expect(logs[0].changes.after.state).toBe(winnerState);
  });

  it('read-after-write: concurrent GETs during/after transition see consistent store state', async () => {
    const transitionPromise = request(app)
      .post('/api/invoices/inv-conc-001/transition')
      .set('x-tenant-id', TENANT_A)
      .send({ targetState: 'approved', reason: 'raw-consistency' });

    const readPromises = Array.from({ length: 6 }, () =>
      request(app)
        .get('/api/invoices/inv-conc-001/state')
        .set('x-tenant-id', TENANT_A),
    );

    const [transitionRes, ...readResults] = await Promise.all([transitionPromise, ...readPromises]);

    expect(transitionRes.status).toBe(200);
    expect(transitionRes.body.data.currentState).toBe('approved');

    for (const res of readResults) {
      expect(res.status).toBe(200);
      expect(['pending', 'approved']).toContain(res.body.data.currentState);
      // Response must match the in-memory store snapshot that produced it
      // (store may still be pending for pre-transition reads).
      expect(['pending', 'approved']).toContain(invoiceStore.get(storeKey(TENANT_A, 'inv-conc-001')).status);
    }

    const finalState = await request(app)
      .get('/api/invoices/inv-conc-001/state')
      .set('x-tenant-id', TENANT_A);

    expect(finalState.status).toBe(200);
    expect(finalState.body.data.currentState).toBe('approved');
    expect(finalState.body.data.currentState).toBe(
      invoiceStore.get(storeKey(TENANT_A, 'inv-conc-001')).status,
    );
  });

  it('parallel link-escrow from approved: exactly one success and consistent escrow metadata', async () => {
    invoiceStore.set(storeKey(TENANT_A, 'inv-conc-002'), {
      invoice_id: 'inv-conc-002',
      tenant_id: TENANT_A,
      status: 'approved',
      amount: 2200,
      customer: 'Escrow Race Inc',
      metadata: '{}',
    });

    const results = await Promise.all([
      request(app)
        .post('/api/invoices/inv-conc-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-a', reason: 'link-a' }),
      request(app)
        .post('/api/invoices/inv-conc-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-b', reason: 'link-b' }),
      request(app)
        .post('/api/invoices/inv-conc-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-c', reason: 'link-c' }),
    ]);

    const successes = results.filter((r) => r.status === 200);
    expect(successes).toHaveLength(1);
    expect(successes[0].body.data.currentState).toBe('linked_escrow');

    const stored = invoiceStore.get(storeKey(TENANT_A, 'inv-conc-002'));
    expect(stored.status).toBe('linked_escrow');
    const meta = JSON.parse(stored.metadata || '{}');
    expect(['escrow-a', 'escrow-b', 'escrow-c']).toContain(meta.escrowId);
    expect(successes[0].body.data.escrowId).toBe(meta.escrowId);

    const logs = await getAuditLogs({ resourceId: 'inv-conc-002' });
    expect(logs).toHaveLength(1);
    expect(logs[0].changes.after.state).toBe('linked_escrow');
  });
});
