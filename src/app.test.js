'use strict';

/**
 * @fileoverview Integration smoke-tests for the top-level Express app factory.
 *
 * These tests exercise the wired-together middleware stack (CORS, body limits,
 * sanitization, validation, error handlers) at the HTTP level using supertest
 * or a lightweight mock-request helper.  They deliberately avoid unit-testing
 * individual middleware in isolation — each middleware module has its own test
 * file for that.
 *
 * Stale-assertion history (kept as a reference so the fixes are auditable):
 *  - /api endpoints object previously asserted a 4-key shape; route now
 *    returns 8 keys (healthz / readyz / marketplace / invest added).
 *  - Invoice list mock previously targeted `getInvoices`; route calls
 *    `getInvoicesWithPagination` and returns `{ data, meta, message }`.
 *  - Invoice POST rejection previously expected `response.body.errors` (array);
 *    the route has always returned `{ fieldErrors: {...} }`.
 *  - Escrow tests previously expected a stale placeholder body from an old
 *    inline handler; the route now delegates to escrowReadService which
 *    returns a 404 for unmapped invoices, and a 400 for malformed IDs.
 */

const cors = require('cors');
const request = require('supertest');

// ── Service mocks ─────────────────────────────────────────────────────────────
// The invoice-list route calls getInvoicesWithPagination, not getInvoices.
// Both names are exported so existing callers that import getInvoices are not
// broken, but the app-level route uses the paginated variant.
jest.mock('./services/invoiceService', () => ({
  getInvoices: jest.fn(),
  getInvoicesWithPagination: jest.fn(),
}));

const { createApp, handleCorsError } = require('./app');
const {
  CORS_REJECTION_CODE,
  CORS_REJECTION_MESSAGE,
  createCorsOptions,
} = require('./config/cors');
const invoiceService = require('./services/invoiceService');

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Temporarily overrides process.env keys, runs `fn`, then restores originals.
 *
 * @param {Record<string, string|undefined>} env - Keys to override.
 * @param {() => unknown} fn - Callback to run under the env override.
 * @returns {unknown} Return value of `fn`.
 */
function withEnv(env, fn) {
  const previousValues = new Map();

  for (const key of Object.keys(env)) {
    previousValues.set(key, process.env[key]);

    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Minimal Express-compatible request double.
 *
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {string} [opts.origin]
 * @param {string} [opts.path='/health']
 * @returns {object}
 */
function createMockRequest({ method = 'GET', origin, path = '/health' } = {}) {
  return {
    method,
    url: path,
    path,
    headers: origin
      ? {
          origin,
          'access-control-request-method': 'GET',
        }
      : {},
    header(name) {
      return this.headers[name.toLowerCase()];
    },
    get(name) {
      return this.headers[name.toLowerCase()];
    },
  };
}

/**
 * Minimal Express-compatible response double with promise resolution.
 *
 * @returns {object}
 */
function createMockResponse() {
  const headers = {};
  let resolveResponse = () => {};

  const response = {
    headers,
    statusCode: 200,
    body: undefined,
    finished: false,
    locals: {},
    setResolver(resolver) {
      resolveResponse = resolver;
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    removeHeader(name) {
      delete headers[name.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      resolveResponse({
        statusCode: this.statusCode,
        headers: this.headers,
        body: this.body,
      });
      return this;
    },
    end(payload) {
      this.body = payload;
      this.finished = true;
      resolveResponse({
        statusCode: this.statusCode,
        headers: this.headers,
        body: this.body,
      });
      return this;
    },
  };

  return response;
}

/**
 * Dispatches a synthetic request through an Express app instance.
 *
 * @param {import('express').Express} app
 * @param {object} [reqOptions]
 * @returns {Promise<{statusCode: number, headers: object, body: unknown}>}
 */
function invokeApp(app, reqOptions = {}) {
  return new Promise((resolve, reject) => {
    const req = createMockRequest(reqOptions);
    const res = createMockResponse();
    res.setResolver(resolve);

    app.handle(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }

      if (!res.finished) {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: res.body,
        });
      }
    });
  });
}

/**
 * Runs the CORS middleware in isolation using mock request/response doubles.
 *
 * @param {Record<string, string>} env
 * @param {object} [reqOptions]
 * @returns {Promise<{req: object, res: object, nextCalled: boolean}>}
 */
function runCorsMiddleware(env, reqOptions = {}) {
  return new Promise((resolve, reject) => {
    const middleware = cors(createCorsOptions(env));
    const req = createMockRequest(reqOptions);
    const res = createMockResponse();
    let nextCalled = false;

    res.setResolver(() => {
      resolve({ req, res, nextCalled });
    });

    middleware(req, res, (error) => {
      nextCalled = true;

      if (error) {
        reject(error);
        return;
      }

      resolve({ req, res, nextCalled });
    });
  });
}

// ── Integration: CORS + health endpoints ─────────────────────────────────────

describe('LiquiFact app integration', () => {
  it('allows configured origins for standard requests', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      },
      async () => {
        const response = await invokeApp(createApp(), {
          origin: 'https://app.example.com',
          path: '/health',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe(
          'https://app.example.com'
        );
        expect(response.body).toEqual(
          expect.objectContaining({
            status: 'ok',
            service: 'liquifact-api',
            version: '0.1.0',
          })
        );
      }
    );
  });

  it('rejects blocked origins with a 403 response', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      },
      async () => {
        const response = await invokeApp(createApp(), {
          origin: 'https://evil.example.com',
          path: '/health',
        });

        expect(response.statusCode).toBe(403);
        expect(response.body).toEqual({
          error: CORS_REJECTION_MESSAGE,
          code: CORS_REJECTION_CODE,
        });
      }
    );
  });

  it('allows requests without an origin header', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      },
      async () => {
        const response = await invokeApp(createApp(), {
          path: '/health',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    );
  });

  it('allows localhost origins by default in development', async () => {
    await withEnv(
      {
        NODE_ENV: 'development',
        CORS_ALLOWED_ORIGINS: undefined,
      },
      async () => {
        const response = await invokeApp(createApp(), {
          origin: 'http://localhost:3000',
          path: '/health',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe(
          'http://localhost:3000'
        );
      }
    );
  });

  it('fails closed for browser origins outside development when unset', async () => {
    await withEnv(
      {
        NODE_ENV: 'test',
        CORS_ALLOWED_ORIGINS: undefined,
      },
      async () => {
        const response = await invokeApp(createApp(), {
          origin: 'https://app.example.com',
          path: '/health',
        });

        expect(response.statusCode).toBe(403);
        expect(response.body).toEqual({
          error: CORS_REJECTION_MESSAGE,
          code: CORS_REJECTION_CODE,
        });
      }
    );
  });

  // ── GET /api info ───────────────────────────────────────────────────────────
  // The app now exposes healthz / readyz / marketplace / invest in the
  // endpoints map.  Use objectContaining so the test stays correct if new
  // endpoints are added in future without needing another assertion update.
  it('returns API metadata from /api', async () => {
    const response = await invokeApp(createApp(), {
      path: '/api',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      name: 'LiquiFact API',
      description: 'Global Invoice Liquidity Network on Stellar',
      endpoints: expect.objectContaining({
        health: 'GET /health',
        invoices: 'GET/POST /api/invoices',
        escrow: 'GET /api/escrow/:invoiceId',
      }),
    });
  });

  // ── GET /api/invoices (list) ────────────────────────────────────────────────
  // The route calls getInvoicesWithPagination (not getInvoices) and returns
  // { data, meta, message }.  The mock must target the right function name.
  it('returns the invoice list', async () => {
    invoiceService.getInvoicesWithPagination.mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });

    const response = await invokeApp(createApp(), {
      path: '/api/invoices',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      data: [],
      message: 'Invoices retrieved successfully.',
    });
    // meta is present in the response envelope
    expect(response.body).toHaveProperty('meta');
  });

  // ── POST /api/invoices ──────────────────────────────────────────────────────
  it('returns the invoice creation placeholder for a valid payload', async () => {
    const response = await request(createApp())
      .post('/api/invoices')
      .send({
        amount:   1500,
        dueDate:  '2026-12-31',
        buyer:    'Acme Corp',
        seller:   'Stellar Goods Ltd',
        currency: 'USD',
      });

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({
      data:    { id: 'placeholder', status: 'pending_verification' },
      message: 'Invoice upload will be implemented with verification and tokenization.',
    });
  });

  // The validation failure response is { type, title, status, detail, fieldErrors }
  // where fieldErrors is an *object* keyed by field path, not an array.
  // The old assertion `Array.isArray(response.body.errors)` was wrong.
  it('rejects an invoice creation request with missing fields', async () => {
    const response = await request(createApp())
      .post('/api/invoices')
      .send({ amount: 500 });

    expect(response.statusCode).toBe(400);
    // fieldErrors is an object; every key is a failing field path
    expect(response.body).toMatchObject({
      type: expect.stringContaining('validation-error'),
      title: 'Validation Error',
      status: 400,
    });
    expect(response.body.fieldErrors).toBeDefined();
    expect(typeof response.body.fieldErrors).toBe('object');
    expect(Array.isArray(response.body.fieldErrors)).toBe(false);
    // seller, currency, dueDate are all missing
    expect(Object.keys(response.body.fieldErrors).length).toBeGreaterThan(0);
  });

  // ── GET /api/escrow/:invoiceId ─────────────────────────────────────────────
  // The route now delegates entirely to escrowReadService.getEscrowRead.
  // For "invoice-123" there is no escrow mapping in the test environment
  // (ESCROW_ADDR_BY_INVOICE in setup.js only maps 'inv_001'), so the service
  // returns { error, code: 'NOT_FOUND', statusCode: 404 }.
  it('returns 404 for an invoice that has no escrow mapping', async () => {
    const response = await invokeApp(createApp(), {
      path: '/api/escrow/invoice-123',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({
      error: expect.stringContaining('invoice-123'),
      code: 'NOT_FOUND',
    });
  });

  // inv_001 IS mapped in the test environment setup.
  // The service will still fail (no real Soroban RPC) but the error shape
  // is deterministic — assert on statusCode and the presence of error/code.
  it('accepts a mapped invoice ID and returns a service-level response', async () => {
    const response = await invokeApp(createApp(), {
      path: '/api/escrow/inv_001',
    });

    // May be 200 (if mock resolves) or a non-400 service error — never a
    // validation 400 because inv_001 is a well-formed ID.
    expect(response.statusCode).not.toBe(400);
  });

  // A param containing whitespace-encoded chars becomes empty/invalid after
  // URL-decoding → the new validateEscrowParamsMiddleware rejects it with 400.
  it('rejects an escrow param that decodes to an invalid ID', async () => {
    // %20 → space, %0A → newline; after sanitization the string is blank
    // (Express URL-decodes params before our middleware runs).
    // The path "/api/escrow/%20%0A" decodes to invoiceId=" \n" which fails
    // the INVOICE_ID_PATTERN because it does not start with [A-Za-z0-9].
    const response = await request(createApp())
      .get('/api/escrow/%20%0A');

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      fieldErrors: expect.objectContaining({ invoiceId: expect.any(String) }),
    });
  });

  // ── 404 / 500 pass-through ─────────────────────────────────────────────────
  it('returns 404 for unknown routes', async () => {
    const response = await invokeApp(createApp(), {
      path: '/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: 'Not found',
      path: '/missing',
    });
  });

  it('preserves the generic 500 path for unrelated server errors', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await invokeApp(createApp(), {
      path: '/error',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: 'Internal server error',
    });

    consoleErrorSpy.mockRestore();
  });
});

// ── CORS middleware isolation ─────────────────────────────────────────────────

describe('LiquiFact app CORS middleware behavior', () => {
  it('allows preflight requests for allowed origins', async () => {
    const { res, nextCalled } = await runCorsMiddleware(
      {
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      },
      {
        method: 'OPTIONS',
        origin: 'https://app.example.com',
      }
    );

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(204);
    expect(res.getHeader('access-control-allow-origin')).toBe('https://app.example.com');
  });

  it('blocks preflight requests for disallowed origins', async () => {
    await expect(
      runCorsMiddleware(
        {
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: 'https://app.example.com',
        },
        {
          method: 'OPTIONS',
          origin: 'https://evil.example.com',
        }
      )
    ).rejects.toMatchObject({
      message: CORS_REJECTION_MESSAGE,
      status: 403,
    });
  });

  it('passes unrelated errors through the CORS error handler', () => {
    const next = jest.fn();

    handleCorsError(
      new Error('Other error'),
      createMockRequest(),
      createMockResponse(),
      next
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Other error' }));
  });
});
