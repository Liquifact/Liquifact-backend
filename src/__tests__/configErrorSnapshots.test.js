
'use strict';

// NOTE: This suite transitively loads src/config/index.js; keep that module syntactically valid.
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
const { configErrorHandler } = require('../middleware/configErrorHandler');
const AppError = require('../errors/AppError');

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeReq(overrides = {}) {
  return {
    app: { locals: {} },
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
  res.locals = {};
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

    it('routes validation failures through the shared config error middleware', () => {
      const req = fakeReq({
        body: {
          section: 'webhook',
          config: { url: 'not-a-url', secret: 'short', events: [] },
        },
      });
      const res = fakeRes();
      const next = jest.fn();

      middleware(req, res, (err) => {
        configErrorHandler(err, req, res, next);
      });

      expect(res._status).toBe(400);
      expect(res._body).toMatchObject({
        type: expect.stringContaining('validation-error'),
        title: 'Validation Error',
        status: 400,
        detail: expect.any(String),
        code: 'VALIDATION_ERROR',
        fieldErrors: expect.any(Object),
      });
      expect(next).not.toHaveBeenCalled();
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

// ── resolveConfig: deterministic failure recovery ────────────────────────────

describe('resolveConfig — deterministic failure recovery', () => {
  const { resolveConfig } = require('../db/resolveConfig');

  const baseEnv = {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-at-least-32-characters-long-string-for-jest',
  };

  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    Object.assign(process.env, baseEnv);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('returns a frozen, deterministic snapshot for identical inputs', () => {
    const first = resolveConfig({ env: baseEnv });
    const second = resolveConfig({ env: baseEnv });

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.values)).toBe(true);
  });

  it('is idempotent across repeated invocations (no state leakage)', () => {
    const a = resolveConfig({ env: baseEnv });
    const b = resolveConfig({ env: baseEnv });
    const c = resolveConfig({ env: baseEnv });

    expect(a.fingerprint).toBe(b.fingerprint);
    expect(b.fingerprint).toBe(c.fingerprint);
  });

  it('rejects invalid input deterministically with a stable error code', () => {
    const attempt = () => resolveConfig({ env: { ...baseEnv, JWT_SECRET: 'short' } });

    let firstErr;
    let secondErr;
    try { attempt(); } catch (e) { firstErr = e; }
    try { attempt(); } catch (e) { secondErr = e; }

    expect(firstErr).toBeDefined();
    expect(secondErr).toBeDefined();
    expect(firstErr.code).toBe(secondErr.code);
    expect(firstErr.message).toBe(secondErr.message);
    expect(firstErr.code).toMatch(/^CONFIG_/);
  });

  it('does not mutate caller-provided env object on success or failure', () => {
    const env = { ...baseEnv };
    const snapshot = JSON.stringify(env);

    resolveConfig({ env });
    expect(JSON.stringify(env)).toBe(snapshot);

    const badEnv = { ...baseEnv, JWT_SECRET: 'short' };
    const badSnapshot = JSON.stringify(badEnv);
    try { resolveConfig({ env: badEnv }); } catch (_) { /* expected */ }
    expect(JSON.stringify(badEnv)).toBe(badSnapshot);
  });

  it('surfaces a retryable failure without losing the previous good config', () => {
    const good = resolveConfig({ env: baseEnv });
    const cache = { current: good };

    const attempt = () => {
      try {
        const next = resolveConfig({ env: { ...baseEnv, JWT_SECRET: 'short' } });
        cache.current = next;
        return { ok: true, value: next };
      } catch (err) {
        return { ok: false, error: err, value: cache.current };
      }
    };

    const result = attempt();
    expect(result.ok).toBe(false);
    expect(result.value).toBe(good);
    expect(cache.current).toBe(good);
    expect(result.error.retryable).toBe(false);
  });

  it('is safe under concurrent resolution (no shared mutable state)', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => resolveConfig({ env: baseEnv })),
      ),
    );

    const fingerprints = new Set(results.map((r) => r.fingerprint));
    expect(fingerprints.size).toBe(1);
    results.forEach((r) => expect(Object.isFrozen(r)).toBe(true));
  });

  it('exposes a redacted diagnostic view that never leaks secrets', () => {
    const resolved = resolveConfig({ env: baseEnv });
    const diagnostic = resolved.describe();

    expect(diagnostic).toBeDefined();
    expect(JSON.stringify(diagnostic)).not.toContain(baseEnv.JWT_SECRET);
    expect(diagnostic.fingerprint).toBe(resolved.fingerprint);
  });
});
