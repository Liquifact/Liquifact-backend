const cors = require('cors');

const { createApp, handleCorsError } = require('./app');
const { CORS_REJECTION_MESSAGE } = require('./config/cors');
const { createCorsOptions } = require('./config/cors');

/**
 * Temporarily overrides process.env variables for the duration of a function.
 * @param {Object} env - Environment variables to set.
 * @param {Function} fn - Function to execute with overridden env.
 * @returns {*} The return value of fn.
 */
/**
 * Executes a function with overridden environment variables.
 * @param {Object} env - Environment variables to override.
 * @param {Function} fn - Function to execute with overridden env.
 * @returns {*} The return value of fn.
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
 * Creates a mock Express request object for testing.
 * @param {Object} [root0]
 * @param {string} [root0.method]
 * @param {string} [root0.origin]
 * @param {string} [root0.path]
 * @param {Object} [root0.body]
 * @returns {Object} Mock request object.
 */
/**
 * Creates a mock request object for testing.
 * @param {Object} [options]
 * @param options.method
 * @param options.origin
 * @param options.path
 * @param options.body
 * @returns {Object} Mock request object.
 */
function createMockRequest({ method = 'GET', origin, path = '/health', body } = {}) {
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
    body,
    /**
     * Gets a header value from the request.
     * @param {string} name - Header name.
     * @returns {*} Header value.
     */
    header(name) {
      return this.headers[name.toLowerCase()];
    },
    /**
     * Gets a header value from the request.
     * @param {string} name - Header name.
     * @returns {*} Header value.
     */
    get(name) {
      return this.headers[name.toLowerCase()];
    },
  };
}

/**
 * Creates a mock Express response object for testing.
 * @returns {Object} Mock response object.
 */
/**
 * Creates a mock response object for testing.
 * @returns {Object} Mock response object.
 */
function createMockResponse() {
  const headers = {};
  /**
   * Resolver function for the response.
   * @returns {void}
   */
  let resolveResponse = () => {};

  const response = {
    headers,
    statusCode: 200,
    body: undefined,
    finished: false,
    locals: {},
    /**
     * Sets the resolver function for the response.
     * @param {Function} resolver - Resolver function.
     * @returns {void}
     */
    setResolver(resolver) {
      resolveResponse = resolver;
    },
    /**
     * Sets a header on the response.
     * @param {string} name - Header name.
     * @param {*} value - Header value.
     * @returns {void}
     */
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    /**
     * Gets a header value from the response.
     * @param {string} name - Header name.
     * @returns {*} Header value.
     */
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    /**
     * Removes a header from the response.
     * @param {string} name - Header name.
     * @returns {void}
     */
    removeHeader(name) {
      delete headers[name.toLowerCase()];
    },
    /**
     * Sets the status code for the response.
     * @param {number} code - Status code.
     * @returns {Object} The response object.
     */
    status(code) {
      this.statusCode = code;
      return this;
    },
    /**
     * Sends a JSON response.
     * @param {*} payload - Response payload.
     * @returns {Object} The response object.
     */
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
    /**
     * Ends the response.
     * @param {*} payload - Response payload.
     * @returns {Object} The response object.
     */
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
 * Invokes an Express app with a mock request and response.
 * @param {Object} app - Express app instance.
 * @param {Object} [reqOptions] - Request options.
 * @returns {Promise<Object>} Resolves with response data.
 */
/**
 * Invokes the app with a mock request and response.
 * @param {Object} app - The app instance.
 * @param {Object} [reqOptions]
 * @returns {Promise<Object>} Resolves with the response object.
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
 * Runs the CORS middleware with a mock request/response.
 * @param {Object} env - Environment variables.
 * @param {Object} [reqOptions] - Request options.
 * @returns {Promise<{req: Object, res: Object, nextCalled: boolean}>}
 */
/**
 * Runs the CORS middleware for a given environment and request options.
 * @param {Object} env - Environment variables.
 * @param {Object} [reqOptions]
 * @returns {Promise<Object>} Resolves with the response object.
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

  it('returns the invoice placeholder list', async () => {
    const response = await invokeApp(createApp(), {
      path: '/api/invoices',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      data: [],
      message: 'Invoice list retrieved via repository abstraction layer.',
    });
  });

  it('returns the invoice creation placeholder', async () => {
    const response = await invokeApp(createApp(), {
      method: 'POST',
      path: '/api/invoices',
      body: { amount: 100, currency: 'XLM', customer: 'Test Customer' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.message).toBe('Invoice created successfully via repository abstraction layer.');
    expect(response.body.data).toMatchObject({
      amount: 100,
      currency: 'XLM',
      status: 'pending_verification'
    });
  });

  it('returns the escrow placeholder through the Soroban wrapper', async () => {
    const response = await invokeApp(createApp(), {
      path: '/api/escrow/invoice-123',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe('Escrow state read from blockchain repository abstraction.');
    expect(response.body.data).toMatchObject({
      invoiceId: 'invoice-123',
      status: 'not_found',
      fundedAmount: 0
    });
    expect(response.body.data.lastUpdated).toBeDefined();
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
      error: { message: 'Simulated server error' },
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
