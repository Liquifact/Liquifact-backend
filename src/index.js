/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { AppError } = require('./errors/AppError');
const { correlationIdMiddleware } = require('./middleware/correlationId');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

/**
 * Create the Express application instance.
 *
 * @returns {import('express').Express}
 */
function createApp(options = {}) {
  const app = express();

  app.use(cors());
  app.use(correlationIdMiddleware);
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'liquifact-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  });

  // API info
  app.get('/api', (req, res) => {
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

  // Placeholder: Invoices (to be wired to Invoice Service + DB)
  app.get('/api/invoices', (req, res) => {
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

  // Placeholder: Escrow (to be wired to Soroban)
  app.get('/api/escrow/:invoiceId', (req, res) => {
    const { invoiceId } = req.params;

    if (!invoiceId || !/^[A-Za-z0-9_-]{3,128}$/.test(invoiceId)) {
      throw new AppError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invoice ID is invalid.',
        retryable: false,
        retryHint: 'Provide a valid invoice ID and try again.',
      });
    }

    res.json({
      data: { invoiceId, status: 'not_found', fundedAmount: 0 },
      message: 'Escrow state will be read from Soroban contract.',
    });
  });

  if (options.enableTestRoutes) {
    app.get('/__test__/auth', (req, res) => {
      if (!req.header('authorization')) {
        throw new AppError({
          status: 401,
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required for this endpoint.',
          retryable: false,
          retryHint: 'Provide valid credentials and try again.',
        });
      }

      res.json({ ok: true });
    });

    app.get('/__test__/forbidden', (req, res) => {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'You do not have access to this resource.',
        retryable: false,
        retryHint: 'Use an account with the required permissions and try again.',
      });
    });

    app.get('/__test__/upstream', (req, res) => {
      const error = new Error('connection refused');
      error.code = 'ECONNREFUSED';
      throw error;
    });

    app.get('/__test__/explode', (req, res) => {
      throw new Error('Sensitive stack detail should not leak');
    });

    app.get('/__test__/throw-string', (req, res) => {
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
};
