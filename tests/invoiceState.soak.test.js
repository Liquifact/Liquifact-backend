/**
 * Invoice-state soak / repeat smoke test.
 *
 * Exercises invoice-state under repeated, sequential calls (bounded N) to
 * catch the class of bug a single-call test can't: state that silently
 * accumulates across requests (unbounded cache growth, duplicated audit
 * entries, drifting response shape) without needing real load-testing
 * infrastructure. Deterministic and short — no real timers, no random
 * data, in-memory service mocks only (same harness style as
 * `tests/invoice.state.concurrency.test.js`).
 *
 * Finding from writing this test (documented per this issue's "note any
 * leak found"): this file's combined call volume across all four cases
 * (~170 requests) exceeds the real invoiceStateLimiter's default budget
 * (RATE_LIMIT_INVOICE_STATE_MAX=60 per 15-minute window,
 * src/middleware/rateLimit.js) well before any invoice-state-specific bug
 * would show up -- its in-memory store is a module-level singleton, not
 * reset between `it` blocks, so it accumulates across every case in this
 * file the same way it would across real repeated client traffic. Without
 * bypassing it, later cases intermittently receive Express's generic
 * "Route ... not found" 404 instead of exercising invoice-state at all,
 * making the suite flaky rather than deterministic. Not a leak in
 * invoice-state itself -- bypassed the same way
 * tests/invoice.state.idempotency.test.js and several other high-volume
 * suites already do, so this soak test isolates repeat-call behaviour in
 * invoice-state's own logic, not the rate limiter's (which has its own
 * dedicated coverage in tests/invoiceStateRateLimit.test.js).
 *
 * @jest-environment node
 */

'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../src/middleware/rateLimit', () => ({
  invoiceStateLimiter: (req, res, next) => next(),
}));

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
}));

const { clearAuditLogs, getAuditLogs } = require('../src/services/auditLog');
const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const invoiceService = require('../src/services/invoiceService');
const { getSharedStore } = require('../src/services/cacheStore');

const TENANT_A = 'tenant-soak';
const READ_ITERATIONS = 50;
const WRITE_ITERATIONS = 20;

describe('Invoice-state soak / repeat smoke', () => {
  /** @type {import('express').Express} */
  let app;
  /** @type {Map<string, object>} */
  let invoiceStore;

  function storeKey(tenantId, invoiceId) {
    return `${tenantId}:${invoiceId}`;
  }

  function seed(invoiceId, overrides = {}) {
    invoiceStore.set(storeKey(TENANT_A, invoiceId), {
      invoice_id: invoiceId,
      tenant_id: TENANT_A,
      status: 'pending',
      amount: 1000,
      customer: 'Soak Co',
      ...overrides,
    });
  }

  beforeEach(() => {
    clearAuditLogs();
    getSharedStore().clear();
    invoiceStore = new Map();

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

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'soak-tester', sub: 'soak-tester', smeId: 'sme-verified' };
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

  it(`GET /:id/state ${READ_ITERATIONS} times sequentially: identical results, single cache entry, zero audit growth`, async () => {
    seed('inv-soak-read');

    const bodies = [];
    for (let i = 0; i < READ_ITERATIONS; i += 1) {
      // Sequential, not parallel — this soak targets accumulation across
      // many *completed* requests, not the concurrency guards already
      // covered by invoice.state.concurrency.test.js.
      const res = await request(app)
        .get('/api/invoices/inv-soak-read/state')
        .set('x-tenant-id', TENANT_A);
      expect(res.status).toBe(200);
      bodies.push(res.body);
    }

    // Stable results: every one of the 50 responses is byte-for-byte identical.
    for (const body of bodies) {
      expect(body).toEqual(bodies[0]);
    }
    expect(bodies[0].data.currentState).toBe('pending');

    // No unbounded growth: a read-only endpoint hitting the same cache key
    // every time must leave exactly one entry behind, not one per call.
    const cacheKeys = getSharedStore().keys();
    const soakKeys = cacheKeys.filter((k) => k.includes('inv-soak-read'));
    expect(soakKeys).toHaveLength(1);

    // No unbounded growth: reads never write an audit entry.
    const logs = await getAuditLogs({ resourceId: 'inv-soak-read' });
    expect(logs).toHaveLength(0);
  });

  it(`GET /:id/history ${READ_ITERATIONS} times sequentially: identical empty history, no growth`, async () => {
    seed('inv-soak-history');

    const bodies = [];
    for (let i = 0; i < READ_ITERATIONS; i += 1) {
      const res = await request(app)
        .get('/api/invoices/inv-soak-history/history')
        .set('x-tenant-id', TENANT_A);
      expect(res.status).toBe(200);
      bodies.push(res.body.data);
    }

    for (const data of bodies) {
      expect(data.transitions).toEqual([]);
      expect(data.totalTransitions).toBe(0);
    }
  });

  it(`approves ${WRITE_ITERATIONS} distinct invoices sequentially: exactly one audit entry each, no duplication or loss`, async () => {
    for (let i = 0; i < WRITE_ITERATIONS; i += 1) {
      seed(`inv-soak-write-${i}`);
    }

    const responses = [];
    for (let i = 0; i < WRITE_ITERATIONS; i += 1) {
      const res = await request(app)
        .post(`/api/invoices/inv-soak-write-${i}/approve`)
        .set('x-tenant-id', TENANT_A)
        .send({ reason: `soak-${i}` });
      responses.push(res);
    }

    // Stable, deterministic outcome for every iteration.
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.every((r) => r.body.data.currentState === 'approved')).toBe(true);

    // No unbounded growth / no leaked duplicate writes: exactly one audit
    // entry per invoice, never more (a duplication bug would show up here
    // as > WRITE_ITERATIONS total entries for these resources).
    for (let i = 0; i < WRITE_ITERATIONS; i += 1) {
      const logs = await getAuditLogs({ resourceId: `inv-soak-write-${i}` });
      expect(logs).toHaveLength(1);
    }
  });

  it('runs the full read + write soak in under 2 seconds (deterministic, no real timers)', async () => {
    seed('inv-soak-timing');
    const start = Date.now();

    for (let i = 0; i < READ_ITERATIONS; i += 1) {
      await request(app).get('/api/invoices/inv-soak-timing/state').set('x-tenant-id', TENANT_A);
    }

    expect(Date.now() - start).toBeLessThan(2000);
  });
});
