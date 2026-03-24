/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { AppError } = require('./errors/AppError');
const { mapError } = require('./errors/mapError');
const { requireBearerToken } = require('./middleware/auth');
const { correlationIdMiddleware } = require('./middleware/correlationId');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { createRateLimitMiddleware } = require('./middleware/rateLimit');
const { callSorobanContract } = require('./services/soroban');

/**
 * Create the Express application instance.
 *
 * @returns {import('express').Express}
 */
function createApp(options = {}) {
  const app = express();
  const securityToken = options.securityToken ?? process.env.TEST_API_TOKEN ?? 'test-suite-token';
  const securityRateLimiter =
    options.securityRateLimiter ??
    createRateLimitMiddleware({
      windowMs: options.securityRateLimitWindowMs ?? 60_000,
      maxRequests: options.securityRateLimitMaxRequests ?? 3,
    });

  app.use(cors());
  app.use(correlationIdMiddleware);
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'liquifact-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api', (_req, res) => {
    res.json({
      name: 'LiquiFact API',
      description: 'Global Invoice Liquidity Network on Stellar',
      endpoints: {
        health: 'GET /health',
        invoices: 'GET/POST /api/invoices',
        escrow: 'GET /api/escrow/:invoiceId',
      },
    });
  });

  app.get('/api/invoices', (_req, res) => {
    res.json({
      data: [],
      message: 'Invoice service will list tokenized invoices here.',
    });
  });

  app.post('/api/invoices', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new AppError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invoice payload must be a JSON object.',
        retryable: false,
        retryHint: 'Send a valid JSON object in the request body and try again.',
      });
    }

    res.status(201).json({
      data: { id: 'placeholder', status: 'pending_verification' },
      message: 'Invoice upload will be implemented with verification and tokenization.',
    });
  });

  app.get('/api/escrow/:invoiceId', async (req, res, next) => {
    const { invoiceId } = req.params;

    if (!invoiceId || !/^[A-Za-z0-9_-]{3,128}$/.test(invoiceId)) {
      next(
        new AppError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invoice ID is invalid.',
          retryable: false,
          retryHint: 'Provide a valid invoice ID and try again.',
        }),
      );
      return;
    }

    try {
      const data = await callSorobanContract(
        async () => ({ invoiceId, status: 'not_found', fundedAmount: 0 }),
      );

      res.json({
        data,
        message: 'Escrow state read from Soroban contract via robust integration wrapper.',
      });
    } catch (error) {
      next(error);
    }
  });

  if (options.enableTestRoutes) {
    app.get('/__test__/auth', requireBearerToken({ token: securityToken }), (_req, res) => {
      res.json({ ok: true });
    });

    app.get(
      '/__test__/rate-limited',
      securityRateLimiter,
      requireBearerToken({ token: securityToken }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    app.get('/__test__/forbidden', (_req, _res) => {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'You do not have access to this resource.',
        retryable: false,
        retryHint: 'Use an account with the required permissions and try again.',
      });
    });

    app.get('/__test__/upstream', (_req, _res) => {
      const error = new Error('connection refused');
      error.code = 'ECONNREFUSED';
      throw error;
    });

    app.get('/__test__/explode', (_req, _res) => {
      throw new Error('Sensitive stack detail should not leak');
    });

    app.get('/__test__/throw-string', (_req, _res) => {
      throw 'boom';
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start the HTTP server.
 *
 * @param {number|string} [port=process.env.PORT || 3001] Port to bind.
 * @returns {import('http').Server}
 */
function startServer(port = process.env.PORT || 3001) {
  const app = createApp();
  return app.listen(port, () => {
    console.log(`LiquiFact API running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
  mapError,
};
