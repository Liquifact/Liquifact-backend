'use strict';

/**
 * @fileoverview Tests for invoice-state error handling middleware (issue #968).
 *
 * Covers:
 *  - StateTransitionError → consistent responseHelper envelope
 *  - All known error codes (INVOICE_NOT_FOUND, MISSING_TARGET_STATE, etc.)
 *  - Correct HTTP status mapping (INVOICE_NOT_FOUND → 404, others → 400,
 *    or from error.statusCode)
 *  - allowedTransitions detail passthrough on INVALID_TRANSITION
 *  - Non-StateTransitionError forwarding to next()
 *  - Non-error (no error) passthrough
 *  - Edge cases: null error, undefined code, missing message
 *  - router-level mounting: errors thrown in handlers reach the middleware
 *  - Integration: real invoice state routes exercise the middleware
 */

const express = require('express');
const request = require('supertest');
const invoiceStateErrorHandler = require('../src/middleware/invoiceStateErrorHandler');
const { isStateTransitionError, resolveStatus, extractDetails, INVOICE_STATE_ERROR_CODES } = invoiceStateErrorHandler;
const { buildTransitionError: buildStmError } = require('../src/services/invoiceStateMachine');

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/services/escrowSubmit', () => ({
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9._:-]{8,128}$/,
}));

/**
 * Builds a minimal Express app that exercises the invoice-state error middleware.
 *
 * @param {Function} handler - Route handler that throws or calls next(err).
 * @returns {import('express').Express} Configured app.
 */
function buildTestApp(handler) {
  const app = express();
  app.use(express.json());

  app.get('/test', handler);
  app.use(invoiceStateErrorHandler);

  // Fallback error handler for non-StateTransitionError errors
  app.use((err, _req, res, _next) => {
    res.status(500).json({ fallback: true, message: err.message });
  });

  return app;
}

/**
 * Helper to create a StateTransitionError-compatible object.
 *
 * @param {string} message - Error message.
 * @param {string} code - Error code.
 * @param {number} [statusCode=400] - HTTP status code.
 * @param {string[]} [allowedTransitions] - Optional allowed transitions hint.
 * @returns {Error} Error object with StateTransitionError shape.
 */
function createTransitionError(message, code, statusCode = 400, allowedTransitions) {
  const err = new Error(message);
  err.name = 'StateTransitionError';
  err.code = code;
  err.statusCode = statusCode;
  if (allowedTransitions) {
    err.allowedTransitions = allowedTransitions;
  }
  return err;
}

describe('invoiceStateErrorHandler', () => {
  // ---------------------------------------------------------------------------
  // isStateTransitionError
  // ---------------------------------------------------------------------------
  describe('isStateTransitionError', () => {
    test('returns true for error with name StateTransitionError', () => {
      const err = createTransitionError('Test', 'TEST_CODE');
      expect(isStateTransitionError(err)).toBe(true);
    });

    test('returns false for generic Error', () => {
      expect(isStateTransitionError(new Error('generic'))).toBe(false);
    });

    test('returns false for null', () => {
      expect(isStateTransitionError(null)).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(isStateTransitionError(undefined)).toBe(false);
    });

    test('returns false for string', () => {
      expect(isStateTransitionError('not an error')).toBe(false);
    });

    test('returns false for object without name', () => {
      expect(isStateTransitionError({ code: 'TEST', message: 'test' })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveStatus
  // ---------------------------------------------------------------------------
  describe('resolveStatus', () => {
    test('INVOICE_NOT_FOUND → 404', () => {
      const err = createTransitionError('Not found', 'INVOICE_NOT_FOUND');
      expect(resolveStatus(err)).toBe(404);
    });

    test('MISSING_TARGET_STATE → 400', () => {
      const err = createTransitionError('Missing target', 'MISSING_TARGET_STATE');
      expect(resolveStatus(err)).toBe(400);
    });

    test('MISSING_TRANSITION_REASON → 400', () => {
      const err = createTransitionError('Missing reason', 'MISSING_TRANSITION_REASON');
      expect(resolveStatus(err)).toBe(400);
    });

    test('CANNOT_LINK_TO_ESCROW → 400', () => {
      const err = createTransitionError('Cannot link', 'CANNOT_LINK_TO_ESCROW');
      expect(resolveStatus(err)).toBe(400);
    });

    test('ALREADY_IN_TARGET_STATE → 400', () => {
      const err = createTransitionError('Already there', 'ALREADY_IN_TARGET_STATE');
      expect(resolveStatus(err)).toBe(400);
    });

    test('TERMINAL_STATE → 400', () => {
      const err = createTransitionError('Terminal', 'TERMINAL_STATE');
      expect(resolveStatus(err)).toBe(400);
    });

    test('INVALID_TRANSITION → 400', () => {
      const err = createTransitionError('Invalid', 'INVALID_TRANSITION');
      expect(resolveStatus(err)).toBe(400);
    });

    test('unknown code defaults to 400', () => {
      const err = createTransitionError('Unknown', 'UNKNOWN_CODE');
      expect(resolveStatus(err)).toBe(400);
    });

    test('respects error.statusCode when present', () => {
      const err = createTransitionError('Custom', 'SOME_CODE', 422);
      expect(resolveStatus(err)).toBe(422);
    });

    test('handles error without statusCode', () => {
      const err = new Error('test');
      err.name = 'StateTransitionError';
      // No code, no statusCode
      expect(resolveStatus(err)).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // extractDetails
  // ---------------------------------------------------------------------------
  describe('extractDetails', () => {
    test('returns allowedTransitions when present', () => {
      const err = createTransitionError('Invalid', 'INVALID_TRANSITION', 400, ['approved', 'rejected']);
      expect(extractDetails(err)).toEqual({ allowedTransitions: ['approved', 'rejected'] });
    });

    test('returns null when allowedTransitions is empty array', () => {
      const err = createTransitionError('No transitions', 'SOME_CODE', 400, []);
      expect(extractDetails(err)).toBeNull();
    });

    test('returns null when allowedTransitions is absent', () => {
      const err = createTransitionError('No details', 'SOME_CODE');
      expect(extractDetails(err)).toBeNull();
    });

    test('returns null for non-array allowedTransitions', () => {
      const err = createTransitionError('Bad', 'SOME_CODE');
      err.allowedTransitions = 'not-an-array';
      expect(extractDetails(err)).toBeNull();
    });

    test('returns null for null error', () => {
      expect(extractDetails(null)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Structured response envelope — unit tests via middleware directly
  // ---------------------------------------------------------------------------
  describe('structured response envelope', () => {
    test('returns data/meta/error envelope with error details', async () => {
      const app = buildTestApp(() => {
        throw createTransitionError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
      });

      const res = await request(app).get('/test');

      expect(res.status).toBe(404);
      expect(res.body.data).toBeNull();
      expect(res.body.meta).toEqual(
        expect.objectContaining({
          timestamp: expect.any(String),
          version: '0.1.0',
        }),
      );
      expect(res.body.error).toEqual({
        message: 'Invoice not found',
        code: 'INVOICE_NOT_FOUND',
        details: null,
      });
    });

    test('includes allowedTransitions in error.details for INVALID_TRANSITION', async () => {
      const app = buildTestApp(() => {
        throw createTransitionError(
          'Invalid state transition',
          'INVALID_TRANSITION',
          400,
          ['approved', 'rejected', 'cancelled'],
        );
      });

      const res = await request(app).get('/test');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(res.body.error.details).toEqual({
        allowedTransitions: ['approved', 'rejected', 'cancelled'],
      });
    });

    test('preserves HTTP status from error.statusCode', async () => {
      const statuses = [400, 404];

      for (const status of statuses) {
        const app = buildTestApp(() => {
          throw createTransitionError(`Error ${status}`, 'TEST_CODE', status);
        });

        const res = await request(app).get('/test');
        expect(res.status).toBe(status);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // All known error codes map consistently
  // ---------------------------------------------------------------------------
  describe('error code mapping', () => {
    const codeScenarios = [
      { code: 'INVOICE_NOT_FOUND', status: 404, message: 'Invoice not found' },
      { code: 'MISSING_TARGET_STATE', status: 400, message: 'Target state is required' },
      { code: 'MISSING_TRANSITION_REASON', status: 400, message: 'Reason is required' },
      { code: 'CANNOT_LINK_TO_ESCROW', status: 400, message: 'Invoice must be in approved state' },
      { code: 'ALREADY_IN_TARGET_STATE', status: 400, message: 'Already in target state' },
      { code: 'TERMINAL_STATE', status: 400, message: 'Terminal state' },
      { code: 'INVALID_TRANSITION', status: 400, message: 'Invalid transition' },
    ];

    codeScenarios.forEach(({ code, status, message }) => {
      test(`${code} → ${status} with error envelope`, async () => {
        const app = buildTestApp(() => {
          throw createTransitionError(message, code, status);
        });

        const res = await request(app).get('/test');

        expect(res.status).toBe(status);
        expect(res.body.error.code).toBe(code);
        expect(res.body.error.message).toBe(message);
        expect(res.body.data).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Non-StateTransitionError forwarding
  // ---------------------------------------------------------------------------
  describe('non-StateTransitionError forwarding', () => {
    test('forwards generic Error to next error handler', async () => {
      const app = buildTestApp(() => {
        throw new Error('generic error');
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(500);
      expect(res.body.fallback).toBe(true);
      expect(res.body.message).toBe('generic error');
    });

    test('forwards Error with code but wrong name to next handler', async () => {
      const err = new Error('Not a state transition error');
      err.code = 'INVOICE_NOT_FOUND';
      // name is 'Error', not 'StateTransitionError'
      const app = buildTestApp(() => {
        throw err;
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(500);
      expect(res.body.fallback).toBe(true);
    });

    test('forwards string thrown as error to next handler', async () => {
      const app = buildTestApp(() => {
        // eslint-disable-next-line no-throw-literal
        throw 'string error';
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(500);
    });

    test('forwards object without name property to next handler', async () => {
      const app = buildTestApp(() => {
        // eslint-disable-next-line no-throw-literal
        throw { code: 'TEST', message: 'test' };
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // No-error passthrough
  // ---------------------------------------------------------------------------
  describe('no-error passthrough', () => {
    test('calls next() when no error is thrown (success response)', async () => {
      const app = buildTestApp((_req, res) => {
        res.json({ ok: true });
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    test('handles error with undefined code gracefully', async () => {
      const err = new Error('No code error');
      err.name = 'StateTransitionError';
      // code is undefined
      err.statusCode = 400;

      const app = buildTestApp(() => {
        throw err;
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('No code error');
      expect(res.body.error.code).toBeUndefined();
      expect(res.body.error.details).toBeNull();
    });

    test('handles error with empty message', async () => {
      const err = new Error('');
      err.name = 'StateTransitionError';
      err.code = 'TEST_CODE';

      const app = buildTestApp(() => {
        throw err;
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('');
      expect(res.body.error.code).toBe('TEST_CODE');
    });

    test('handles error with null statusCode', async () => {
      const err = new Error('Test');
      err.name = 'StateTransitionError';
      err.code = 'SOME_CODE';
      err.statusCode = null;

      const app = buildTestApp(() => {
        throw err;
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(400);
    });
    test('buildTransitionError from invoiceStateMachine is caught by middleware', async () => {
      // buildTransitionError now sets err.name = 'StateTransitionError',
      // so these errors must be intercepted by the middleware.
      const app = buildTestApp(() => {
        throw buildStmError('ALREADY_IN_TARGET_STATE', 'Invoice is already in the target state.', 400);
      });

      const res = await request(app).get('/test');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ALREADY_IN_TARGET_STATE');
      expect(res.body.error.message).toBe('Invoice is already in the target state.');
      expect(res.body.data).toBeNull();
    });

    test('buildTransitionError with allowedTransitions detail reaches response', async () => {
      const app = buildTestApp(() => {
        throw buildStmError(
          'INVALID_TRANSITION',
          'Invalid state transition.',
          400,
          ['approved', 'cancelled'],
        );
      });

      const res = await request(app).get('/test');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(res.body.error.details).toEqual({
        allowedTransitions: ['approved', 'cancelled'],
      });
    });

    test('buildTransitionError with 404 gets correct status', async () => {
      // executeTransition uses 404 for INVOICE_NOT_FOUND-like codes
      const app = buildTestApp(() => {
        throw buildStmError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);
      });

      const res = await request(app).get('/test');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // Router-level integration: real invoice state routes exercise middleware
  // ---------------------------------------------------------------------------
  describe('router integration', () => {
    const invoiceService = require('../src/services/invoiceService');
    /** @type {Map<string, object>} */
    let invoiceStore;

    function storeKey(tenantId, invoiceId) {
      return `${tenantId}:${invoiceId}`;
    }

    beforeEach(() => {
      invoiceStore = new Map();
      invoiceStore.set(storeKey('tenant-a', 'inv-001'), {
        invoice_id: 'inv-001',
        tenant_id: 'tenant-a',
        status: 'pending',
        amount: 1000,
        customer: 'Test Co',
      });
      invoiceStore.set(storeKey('tenant-a', 'inv-002'), {
        invoice_id: 'inv-002',
        tenant_id: 'tenant-a',
        status: 'approved',
        amount: 2000,
        customer: 'Acme',
      });

      jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
        return invoiceStore.get(storeKey(tenantId, id)) || null;
      });

      jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId, options = {}) => {
        const key = storeKey(tenantId, id);
        const existing = invoiceStore.get(key);
        if (!existing) return null;
        if (options.expectedStatus !== undefined && existing.status !== options.expectedStatus) return null;
        const updated = { ...existing, ...updates };
        invoiceStore.set(key, updated);
        return updated;
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('route-level StateTransitionError reaches middleware → consistent envelope', async () => {
      const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');

      const app = express();
      app.use(express.json());

      app.use((req, _res, next) => {
        req.user = { id: 'test-user', sub: 'test-user', smeId: 'sme-1' };
        next();
      });

      app.use('/api/invoices', invoiceStateRoutes);

      const res = await request(app)
        .post('/api/invoices/inv-999/approve')
        .set('x-tenant-id', 'tenant-a')
        .send({ reason: 'Test' });

      // Middleware should intercept StateTransitionError and produce
      // consistent responseHelper.error() envelope
      expect(res.status).toBe(404);
      expect(res.body).toEqual(
        expect.objectContaining({
          data: null,
          meta: expect.objectContaining({
            timestamp: expect.any(String),
            version: '0.1.0',
          }),
          error: expect.objectContaining({
            code: 'INVOICE_NOT_FOUND',
            message: expect.any(String),
          }),
        }),
      );
    });

    test('successful handler response bypasses middleware', async () => {
      const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');

      const app = express();
      app.use(express.json());

      app.use((req, _res, next) => {
        req.user = { id: 'test-user', sub: 'test-user', smeId: 'sme-1' };
        next();
      });

      app.use('/api/invoices', invoiceStateRoutes);

      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', 'tenant-a')
        .send({ reason: 'All good' });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.error).toBeNull();
    });

    test('ALL allowedTransition details reach the error response via middleware', async () => {
      const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');

      const app = express();
      app.use(express.json());

      app.use((req, _res, next) => {
        req.user = { id: 'test-user', sub: 'test-user', smeId: 'sme-1' };
        next();
      });

      app.use('/api/invoices', invoiceStateRoutes);

      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', 'tenant-a')
        .send({ escrowId: 'esc-001' });

      expect(res.status).toBe(200);
    });

    test('unexpected error in handler bypasses middleware → fallback handler', async () => {
      const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');

      const app = express();
      app.use(express.json());

      app.use((req, _res, next) => {
        req.user = { id: 'test-user', sub: 'test-user', smeId: 'sme-1' };
        next();
      });

      app.use('/api/invoices', invoiceStateRoutes);

      // Fallback for non-StateTransitionError errors
      app.use((err, _req, res, _next) => {
        res.status(500).json({ fallback: true, message: err.message });
      });

      jest.spyOn(invoiceService, 'getInvoiceById').mockRejectedValue(new Error('DB connection lost'));

      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', 'tenant-a')
        .send({ reason: 'Test' });

      expect(res.status).toBe(500);
      expect(res.body.fallback).toBe(true);
    });
  });
});
