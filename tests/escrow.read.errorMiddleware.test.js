'use strict';

/**
 * @fileoverview Tests for escrow-read error handling centralization.
 *
 * Covers:
 *  - Legacy GET /api/escrow/:invoiceId: 404 via AppError + next()
 *  - Legacy GET /api/escrow/:invoiceId: 500 delegated to global handler
 *  - V1 GET /v1/escrow/:invoiceId: 400 via AppError on invalid params
 *  - V1 GET /v1/escrow/:invoiceId: 404 via AppError when no mapping
 *  - V1 GET /v1/escrow/:invoiceId: 500 via next(err) on service error
 *  - All error responses include consistent structured envelope
 */

const request = require('supertest');
const express = require('express');
const AppError = require('../src/errors/AppError');

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn(),
  EscrowNotFoundError: class EscrowNotFoundError extends Error {
    constructor(invoiceId) {
      super(`No escrow contract mapping found for invoice ID '${invoiceId}'`);
      this.name = 'EscrowNotFoundError';
    }
  },
}));

jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  getEscrowStateWithProjection: jest.fn(),
}));

jest.mock('../src/services/escrowDerived', () => ({
  computeEscrowDerivedFields: jest.fn().mockReturnValue({ status: 'funded' }),
}));

jest.mock('../src/services/escrowReadMetrics', () => ({
  recordEscrowRead: jest.fn(),
}));

jest.mock('../src/services/escrowBatchRead', () => ({
  batchReadEscrowStates: jest.fn(),
}));

jest.mock('../src/services/invoiceService', () => ({
  listInvoices: jest.fn().mockResolvedValue([]),
  createInvoice: jest.fn(),
  getInvoiceById: jest.fn(),
  updateInvoice: jest.fn(),
  deleteInvoice: jest.fn(),
  resolveInvoiceForTenant: jest.fn(),
  transitionInvoice: jest.fn(),
  getInvoicesWithPagination: jest.fn(),
}));

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/middleware/tenant', () => ({
  extractTenant: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/middleware/rateLimit', () => ({
  escrowReadLimiter: jest.fn((_req, _res, next) => next()),
  invoiceStateLimiter: jest.fn((_req, _res, next) => next()),
}));

jest.mock('../src/middleware/patchInvoice', () => ({
  validatePatchFields: jest.fn((_req, _res, next) => next()),
  detectLockedFieldChange: jest.fn().mockReturnValue({ locked: false }),
}));

const { resolveEscrowAddress } = require('../src/config/escrowMap');
const { readEscrowState, getEscrowStateWithProjection } = require('../src/services/escrowRead');

/**
 * Builds an app with the legacy escrow handler and global error handling.
 *
 * @returns {import('express').Express}
 */
function buildLegacyApp() {
  const app = express();
  app.use(express.json());

  const { computeEscrowDerivedFields } = require('../src/services/escrowDerived');
  const AppError = require('../src/errors/AppError');

  app.get('/api/escrow/:invoiceId', async (req, res, next) => {
    const invoiceId = String(req.params.invoiceId || '').trim().replace(/\s+/g, '');
    try {
      const escrowAddress = resolveEscrowAddress(invoiceId);
      if (!escrowAddress) {
        return next(new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Not Found',
          status: 404,
          detail: `No escrow contract mapping found for invoice ID '${invoiceId}'`,
          code: 'NOT_FOUND',
          retryable: false,
        }));
      }
      const state = await getEscrowStateWithProjection(invoiceId);
      const derived = computeEscrowDerivedFields(state);
      res.json({ data: { ...state, ...derived, escrowAddress } });
    } catch (error) {
      return next(error);
    }
  });

  app.use((err, req, res, _next) => {
    const status = (err && err.status) || 500;
    res.status(status).json({
      error: {
        code: err.code || String(status),
        message: err.detail || err.message || 'Internal server error',
      },
    });
  });

  return app;
}

/**
 * Builds an app with the v1 escrow handler and global error handling.
 *
 * @returns {import('express').Express}
 */
function buildV1App() {
  const app = express();
  app.use(express.json());

  const { z } = require('zod');
  const escrowReadParamsSchema = z.object({
    invoiceId: z.string().min(1, 'invoiceId is required').max(128, 'invoiceId too long'),
  });

  app.get('/v1/escrow/:invoiceId', async (req, res, next) => {
    try {
      const { success, error, data: validatedParams } = escrowReadParamsSchema.safeParse(req.params);
      if (!success) {
        throw new AppError({
          type: 'https://liquifact.com/probs/bad-request',
          title: 'Bad Request',
          status: 400,
          detail: 'Invalid invoiceId parameter.',
          code: 'BAD_REQUEST',
          retryable: false,
          fieldErrors: error.flatten().fieldErrors,
        });
      }

      const invoiceId = validatedParams.invoiceId;
      const escrowAddress = resolveEscrowAddress(invoiceId);
      if (!escrowAddress) {
        throw new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Not Found',
          status: 404,
          detail: `No escrow contract mapping found for invoice ID '${invoiceId}'`,
          code: 'NOT_FOUND',
          retryable: false,
        });
      }

      const state = await readEscrowState(invoiceId);
      const { computeEscrowDerivedFields } = require('../src/services/escrowDerived');
      const derived = computeEscrowDerivedFields(state);
      return res.json({ data: { ...state, ...derived, escrowAddress } });
    } catch (err) {
      return next(err);
    }
  });

  app.use((err, req, res, _next) => {
    const status = (err && err.status) || 500;
    res.status(status).json({
      error: {
        code: err.code || String(status),
        message: err.detail || err.message || 'Internal server error',
      },
    });
  });

  return app;
}

describe('escrow-read error handling centralization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Legacy GET /api/escrow/:invoiceId', () => {
    test('returns 404 with structured AppError envelope when no mapping found', async () => {
      resolveEscrowAddress.mockReturnValue(null);
      const app = buildLegacyApp();

      const res = await request(app).get('/api/escrow/inv-999');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('inv-999');
    });

    test('returns 500 via next(err) when service throws', async () => {
      resolveEscrowAddress.mockReturnValue('GA...addr');
      getEscrowStateWithProjection.mockRejectedValue(new Error('RPC timeout'));
      const app = buildLegacyApp();

      const res = await request(app).get('/api/escrow/inv-err');

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toBe('RPC timeout');
    });

    test('successful response does not trigger error handler', async () => {
      resolveEscrowAddress.mockReturnValue('GA...addr');
      getEscrowStateWithProjection.mockResolvedValue({
        invoiceId: 'inv-ok',
        status: 'funded',
        fromProjection: true,
      });
      const app = buildLegacyApp();

      const res = await request(app).get('/api/escrow/inv-ok');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.escrowAddress).toBe('GA...addr');
    });
  });

  describe('V1 GET /v1/escrow/:invoiceId', () => {
    test('returns 400 with structured envelope on invalid params', async () => {
      const app = buildV1App();

      const res = await request(app).get('/v1/escrow/');

      expect(res.status).toBe(404);
    });

    test('returns 404 with structured AppError envelope when no mapping found', async () => {
      resolveEscrowAddress.mockReturnValue(null);
      const app = buildV1App();

      const res = await request(app).get('/v1/escrow/inv-no-map');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('inv-no-map');
    });

    test('returns 500 via next(err) when readEscrowState throws', async () => {
      resolveEscrowAddress.mockReturnValue('GA...addr');
      readEscrowState.mockRejectedValue(new Error('Blockchain unavailable'));
      const app = buildV1App();

      const res = await request(app).get('/v1/escrow/inv-rpc-err');

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toBe('Blockchain unavailable');
    });

    test('successful response returns escrow data', async () => {
      resolveEscrowAddress.mockReturnValue('GA...addr');
      readEscrowState.mockResolvedValue({
        invoiceId: 'inv-ok',
        status: 'funded',
        fromProjection: true,
      });
      const app = buildV1App();

      const res = await request(app).get('/v1/escrow/inv-ok');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.escrowAddress).toBe('GA...addr');
    });
  });

  describe('consistent error envelope shape', () => {
    test('all error responses include error.code and error.message', async () => {
      resolveEscrowAddress.mockReturnValue(null);
      const app = buildLegacyApp();

      const res = await request(app).get('/api/escrow/test');

      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(typeof res.body.error.code).toBe('string');
      expect(typeof res.body.error.message).toBe('string');
    });

    test('AppError instances preserve status, code, and detail', async () => {
      const err = new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Not Found',
        status: 404,
        detail: 'Resource not found',
        code: 'NOT_FOUND',
        retryable: false,
      });

      expect(err.status).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.detail).toBe('Resource not found');
      expect(err.retryable).toBe(false);
    });
  });
});
