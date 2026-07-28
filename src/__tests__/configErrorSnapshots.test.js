'use strict';

/**
 * @fileoverview Snapshot tests for config error-response bodies.
 *
 * Locks down the RFC 7807 `application/problem+json` shapes returned by:
 *  - POST /api/admin/config (400 validation errors via validateBody)
 *  - notFoundHandler (404)
 *  - problemJsonHandler (500 generic errors)
 *
 * @issue #977
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

jest.mock('../logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const { validateBody } = require('../schemas/config');
const { runtimeConfigSchema } = require('../schemas/config');
const { notFoundHandler } = require('../middleware/problemJson');
const { problemJsonHandler } = require('../middleware/problemJson');
const AppError = require('../errors/AppError');

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeReq(overrides = {}) {
  return {
    method: 'POST',
    originalUrl: '/api/admin/config',
    headers: {},
    id: 'test-request-id',
    ...overrides,
  };
}

function fakeRes() {
  const res = { _status: null, _body: null, _headers: {} };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  res.setHeader = (k, v) => { res._headers[k] = v; return res; };
  return res;
}

// ── 400: Validation Error Snapshots ──────────────────────────────────────────

describe('Config error-response snapshots', () => {
  describe('400 — validation errors', () => {
    const middleware = validateBody(runtimeConfigSchema);

    it('rejects missing section field', () => {
      const req = fakeReq({ body: { config: {} } });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(res._status).toBe(400);
      expect(res._body).toMatchSnapshot();
    });

    it('rejects invalid section enum', () => {
      const req = fakeReq({ body: { section: 'bogus', config: {} } });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(res._status).toBe(400);
      expect(res._body).toMatchSnapshot();
    });

    it('rejects unknown top-level keys', () => {
      const req = fakeReq({ body: { section: 'webhook', config: {}, extra: true } });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(res._status).toBe(400);
      expect(res._body).toMatchSnapshot();
    });

    it('rejects invalid webhook config fields', () => {
      const req = fakeReq({
        body: {
          section: 'webhook',
          config: { url: 'not-a-url', secret: 'short', events: [] },
        },
      });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(res._status).toBe(400);
      expect(res._body).toMatchSnapshot();
    });

    it('rejects invalid fraudThresholds cross-field rule', () => {
      const req = fakeReq({
        body: {
          section: 'fraudThresholds',
          config: { fraudCeiling: 100, manualReviewThreshold: 200 },
        },
      });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(res._status).toBe(400);
      expect(res._body).toMatchSnapshot();
    });

    it('rejects empty body', () => {
      const req = fakeReq({ body: {} });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(res._status).toBe(400);
      expect(res._body).toMatchSnapshot();
    });

    it('rejects non-object body', () => {
      const req = fakeReq({ body: 'just-a-string' });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(res._status).toBe(400);
      expect(res._body).toMatchSnapshot();
    });

    it('passes valid webhook config through (no error snapshot)', () => {
      const req = fakeReq({
        body: {
          section: 'webhook',
          config: {
            url: 'https://example.com/hook',
            secret: 'a'.repeat(16),
            events: ['invoice.created'],
          },
        },
      });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res._status).toBeNull();
      expect(req.validated).toBeDefined();
      expect(req.validated.section).toBe('webhook');
    });
  });

  // ── 404: Not Found Snapshot ────────────────────────────────────────────────

  describe('404 — not found', () => {
    it('returns RFC 7807 shape for unknown route', () => {
      const req = fakeReq({
        method: 'GET',
        originalUrl: '/api/admin/config/nonexistent',
      });
      const res = fakeRes();
      const next = jest.fn();

      notFoundHandler(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(AppError);
      expect(err.status).toBe(404);

      // Simulate what problemJsonHandler would produce
      const { mapError } = require('../errors/mapError');
      const { createProblemDetails, getProblemType } = require('../middleware/problemJson');
      const mapped = mapError(err);
      const problemBody = createProblemDetails({
        type: getProblemType(mapped.status),
        title: 'Not Found',
        status: mapped.status,
        detail: mapped.message,
        instance: `urn:uuid:${req.id}`,
      });

      expect(problemBody).toMatchSnapshot();
    });
  });

  // ── 500: Internal Server Error Snapshots ───────────────────────────────────

  describe('500 — internal server error', () => {
    it('maps generic Error to 500 problem+json', () => {
      const error = new Error('Something broke');
      const { mapError } = require('../errors/mapError');
      const { getProblemType, getStandardTitle } = require('../middleware/problemJson');
      const mapped = mapError(error);

      expect(mapped.status).toBe(500);
      expect(mapped.code).toBe('INTERNAL_SERVER_ERROR');
      expect(mapped.message).toBe('An internal server error occurred.');
      expect(mapped.retryable).toBe(false);
      expect(mapped).toMatchSnapshot();
    });

    it('maps AppError(500) to RFC 7807 shape', () => {
      const err = new AppError({
        type: 'https://liquifact.io/problems/internal-error',
        title: 'Internal Error',
        status: 500,
        detail: 'Database connection lost',
        code: 'DB_CONNECTION_LOST',
        retryable: true,
        retryHint: 'Retry the request in a few moments.',
      });

      expect(err.status).toBe(500);
      expect(err.code).toBe('DB_CONNECTION_LOST');
      expect(err.retryable).toBe(true);

      const { mapError } = require('../errors/mapError');
      const mapped = mapError(err);
      expect(mapped).toMatchSnapshot();
    });

    it('maps ECONNREFUSED to 503', () => {
      const error = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      const { mapError } = require('../errors/mapError');
      const mapped = mapError(error);

      expect(mapped.status).toBe(503);
      expect(mapped.code).toBe('UPSTREAM_ERROR');
      expect(mapped.retryable).toBe(true);
      expect(mapped).toMatchSnapshot();
    });

    it('maps CORS rejection to 403', () => {
      const error = Object.assign(new Error('CORS policy: origin is not allowed.'), {
        isCorsOriginRejected: true,
      });
      const { mapError } = require('../errors/mapError');
      const mapped = mapError(error);

      expect(mapped.status).toBe(403);
      expect(mapped.code).toBe('FORBIDDEN');
      expect(mapped.retryable).toBe(false);
      expect(mapped).toMatchSnapshot();
    });
  });

  // ── 409: Conflict Snapshot ─────────────────────────────────────────────────

  describe('409 — idempotency conflict', () => {
    it('maps AppError(409) to RFC 7807 shape', () => {
      const err = new AppError({
        type: 'https://liquifact.io/problems/conflict',
        title: 'Conflict',
        status: 409,
        detail: 'Idempotency key reused with a different payload.',
        code: 'IDEMPOTENCY_CONFLICT',
      });

      const { mapError } = require('../errors/mapError');
      const mapped = mapError(err);

      expect(mapped.status).toBe(409);
      expect(mapped.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(mapped.retryable).toBe(false);
      expect(mapped).toMatchSnapshot();
    });
  });
});
