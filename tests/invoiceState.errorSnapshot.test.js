'use strict';

/**
 * @fileoverview Snapshot tests for invoice-state error-response bodies (#967).
 *
 * Locks down the **exact wire shape** of error responses emitted by the
 * invoice-state routes (`/api/invoices/:id/approve`, `/api/invoices/:id/reject`,
 * `/api/invoices/:id/link-escrow`, `/api/invoices/:id/history`) so that any
 * drift — field renames, envelope changes, code regressions — is caught by
 * `npm test`.
 *
 * Coverage of failure codes:
 *   - 400 Bad Request: INVALID_TRANSITION, TERMINAL_STATE, ALREADY_IN_TARGET_STATE,
 *                       MISSING_TRANSITION_REASON, MISSING_TARGET_STATE,
 *                       CANNOT_LINK_TO_ESCROW
 *   - 404 Not Found:   INVOICE_NOT_FOUND (transition-error envelope),
 *                       global problemJson notFoundHandler
 *   - 409 Conflict:     CONCURRENCY_CONFLICT (transition-error envelope, simulated),
 *                       global problemJson 409 handler
 *   - 500 Internal:     unhandled service / DB errors via problemJsonHandler
 *
 * Transition-error envelopes use `responseHelper.error()` which includes a
 * dynamic `meta.timestamp`.  Property matchers (`expect.any(String)`) are used
 * in snapshot assertions so the timestamp does not cause false failures.
 *
 * To intentionally update the snapshots after a contract change, run:
 *
 *     npx jest tests/invoiceState.errorSnapshot.test.js -u
 *
 * Always review the resulting `.snap` diff in the same PR.
 */

const request = require('supertest');
const express = require('express');

// ── Mock dependencies so the route module can be `require`-d safely ──────

jest.mock('../src/db/knex');

jest.mock('../src/metrics', () => ({
  invoiceStateRequestDurationMs: {
    observe: jest.fn(),
  },
  invoiceStateRequestCount: {
    inc: jest.fn(),
  },
  invoiceStateErrorsTotal: {
    inc: jest.fn(),
  },
  normalizeInvoiceStateStatusClass: jest.fn().mockReturnValue('4xx'),
  normalizeInvoiceStateErrorCause: jest.fn().mockReturnValue('none'),
}));

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: jest.fn((req, res, next) => next()),
}));

jest.mock('../src/middleware/rateLimit', () => ({
  invoiceStateLimiter: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/services/escrowSubmit', () => ({
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9._:-]{8,128}$/,
}));

const invoiceService = require('../src/services/invoiceService');
const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const { notFoundHandler, problemJsonHandler } = require('../src/middleware/problemJson');
const AppError = require('../src/errors/AppError');

const TENANT_A = 'tenant-alpha';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Builds a fresh Express app that mounts the invoice-state router plus the
 * project's standard 404 and problem+json error handlers.
 *
 * @param {object} [opts] - Options
 * @param {string} [opts.tenantId] - Tenant context to inject on each request.
 * @returns {express.Application}
 */
function buildApp({ tenantId = TENANT_A } = {}) {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    req.user = { id: 'test-user-123', sub: 'test-user-123' };
    if (tenantId !== undefined) {
      req.tenantId = tenantId;
    }
    next();
  });

  app.use('/api/invoices', invoiceStateRoutes);
  app.use(notFoundHandler);
  app.use(problemJsonHandler);

  return app;
}

/**
 * Builds a fresh Express app **without** the global 404 / error handlers.
 * Used when we want to test only the transition-error envelope that
 * `sendTransitionError` produces (not the problem+json fallback).
 */
function buildAppNoGlobalHandlers({ tenantId = TENANT_A } = {}) {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    req.user = { id: 'test-user-123', sub: 'test-user-123' };
    if (tenantId !== undefined) {
      req.tenantId = tenantId;
    }
    next();
  });

  app.use('/api/invoices', invoiceStateRoutes);

  return app;
}

// ── Mocks lifecycle ───────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Default: invoiceService resolves with a pending invoice.
  jest.spyOn(invoiceService, 'resolveInvoiceForTenant').mockResolvedValue({
    invoice_id: 'inv-001',
    tenant_id: TENANT_A,
    status: 'pending',
    amount: 1000,
    customer: 'Acme Corp',
  });

  jest.spyOn(invoiceService, 'transitionInvoice').mockResolvedValue({
    success: true,
    previousState: 'pending',
    newState: 'approved',
    transitionedAt: '2026-01-01T00:00:00.000Z',
    transitionedBy: 'test-user-123',
    auditLog: { id: 'audit-log-001' },
  });

  jest.spyOn(invoiceService, 'updateInvoice').mockResolvedValue({
    invoice_id: 'inv-001',
    status: 'approved',
    amount: 1000,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── 400 Bad Request — transition-error envelope ───────────────────────────

describe('invoice-state error response body snapshots', () => {
  describe('400 Bad Request — transition-error envelope', () => {
    test('INVALID_TRANSITION — disallowed state transition with allowedTransitions hint', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        Object.assign(new Error('Invalid state transition: pending → linked_escrow'), {
          code: 'INVALID_TRANSITION',
          statusCode: 400,
          allowedTransitions: ['approved', 'rejected', 'cancelled'],
        }),
      );

      const res = await request(buildAppNoGlobalHandlers())
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });

    test('TERMINAL_STATE — cannot transition from a terminal state', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        Object.assign(new Error('Cannot transition from terminal state: linked_escrow'), {
          code: 'TERMINAL_STATE',
          statusCode: 400,
        }),
      );

      const res = await request(buildAppNoGlobalHandlers())
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });

    test('ALREADY_IN_TARGET_STATE — invoice already in the requested state', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        Object.assign(new Error('Invoice is already in state: approved'), {
          code: 'ALREADY_IN_TARGET_STATE',
          statusCode: 400,
        }),
      );

      const res = await request(buildAppNoGlobalHandlers())
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });

    test('MISSING_TRANSITION_REASON — reason required for terminal target', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        Object.assign(new Error('Reason is required for this transition.'), {
          code: 'MISSING_TRANSITION_REASON',
          statusCode: 400,
        }),
      );

      const res = await request(buildAppNoGlobalHandlers())
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });

    test('MISSING_TARGET_STATE — no target state in request body', async () => {
      // Simulate the service rejecting a transition with no targetState.
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        Object.assign(new Error('Target state is required'), {
          code: 'MISSING_TARGET_STATE',
          statusCode: 400,
        }),
      );

      const res = await request(buildAppNoGlobalHandlers())
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });

    test('CANNOT_LINK_TO_ESCROW — invoice not in approved state', async () => {
      // linkEscrow calls canLinkToEscrow, which rejects non-approved invoices.
      jest.spyOn(invoiceService, 'resolveInvoiceForTenant').mockResolvedValue({
        invoice_id: 'inv-001',
        tenant_id: TENANT_A,
        status: 'pending',
        amount: 1000,
      });

      const res = await request(buildAppNoGlobalHandlers())
        .post('/api/invoices/inv-001/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-123', reason: 'Link attempt' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });
  });

  // ── 404 Not Found ──────────────────────────────────────────────────────

  describe('404 Not Found', () => {
    test('INVOICE_NOT_FOUND — via transition-error envelope', async () => {
      jest.spyOn(invoiceService, 'resolveInvoiceForTenant').mockResolvedValue(null);

      const res = await request(buildAppNoGlobalHandlers())
        .get('/api/invoices/inv-999/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });

    test('global 404 — unknown sub-route forwards to problemJson notFoundHandler', async () => {
      const res = await request(buildApp())
        .get('/api/invoices/no-such-route')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchSnapshot();
    });
  });

  // ── 409 Conflict ───────────────────────────────────────────────────────

  describe('409 Conflict', () => {
    test('CONCURRENCY_CONFLICT — via transition-error envelope (simulated optimistic-concurrency)', async () => {
      // Invoice-state routes currently don't emit 409 natively, but the
      // `sendTransitionError` helper would render a 409 if a service threw
      // an error with `statusCode: 409` and a `code`.  Snapshot this shape
      // so it is locked if/when 409 branches are added.
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        Object.assign(
          new Error('Optimistic concurrency conflict: the invoice state changed. Please retry.'),
          {
            code: 'CONCURRENCY_CONFLICT',
            statusCode: 409,
          },
        ),
      );

      const res = await request(buildAppNoGlobalHandlers())
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchSnapshot({ meta: { timestamp: expect.any(String) } });
    });

    test('409 — via global problemJson handler', async () => {
      // Validate the problem+json 409 shape rendered by the global error handler.
      const app = express();
      app.use(express.json());

      app.get('/trigger-409', (_req, _res, next) => {
        next(
          new AppError({
            type: 'https://liquifact.com/probs/conflict',
            title: 'Conflict',
            status: 409,
            detail: 'A conflicting resource state was detected.',
            code: 'RESOURCE_CONFLICT',
          }),
        );
      });

      app.use(problemJsonHandler);

      const res = await request(app).get('/trigger-409');

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchSnapshot();
    });
  });

  // ── 500 Internal Server Error ───────────────────────────────────────────

  describe('500 Internal Server Error', () => {
    test('unhandled service error — no error.code, falls through to problemJsonHandler', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        new Error('Simulated invoice service crash'),
      );

      const res = await request(buildApp())
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test' });

      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchSnapshot();
    });

    test('unhandled DB error — falls through to problemJsonHandler', async () => {
      jest.spyOn(invoiceService, 'resolveInvoiceForTenant').mockRejectedValue(
        new Error('Database connection refused'),
      );

      const res = await request(buildApp())
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchSnapshot();
    });
  });
});
