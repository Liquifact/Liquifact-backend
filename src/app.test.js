const cors = require('cors');

const { createApp, handleCorsError } = require('./app');
const { CORS_REJECTION_MESSAGE } = require('./config/cors');
const { createCorsOptions } = require('./config/cors');
const invoiceService = require('./services/invoice.service');

jest.mock('./services/invoice.service');

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
        });
      }
    );
  });

  it('returns API metadata from /api', async () => {
    const response = await invokeApp(createApp(), {
      path: '/api',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      name: 'LiquiFact API',
      description: 'Global Invoice Liquidity Network on Stellar',
      endpoints: {
        health: 'GET /health',
        invoices: 'GET/POST /api/invoices',
        escrow: 'GET/POST /api/escrow',
      },
    });
  });

  it('returns the invoice list', async () => {
    invoiceService.getInvoices.mockResolvedValue([]);
    const response = await invokeApp(createApp(), {
      path: '/api/invoices',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      data: [],
      message: 'Invoices retrieved successfully.',
    });
  });

  it('returns the invoice creation placeholder', async () => {
    const response = await invokeApp(createApp(), {
      method: 'POST',
      path: '/api/invoices',
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({
      data: { id: 'placeholder', status: 'pending_verification' },
      message: 'Invoice upload will be implemented with verification and tokenization.',
    });
  });

  it('returns the escrow placeholder through the Soroban wrapper', async () => {
    const response = await invokeApp(createApp(), {
      path: '/api/escrow/invoice-123',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      data: { invoiceId: 'invoice-123', status: 'not_found', fundedAmount: 0 },
      message: 'Escrow state read from Soroban contract via robust integration wrapper.',
    });
  });

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
