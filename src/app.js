const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { callSorobanContract } = require('./services/soroban');
const {
  createCorsOptions,
  isCorsOriginRejectedError,
} = require('./config/cors');

/**
 * Returns a 403 JSON response only for the dedicated blocked-origin CORS error.
 *
 * @param {Error} err Request error.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express next callback.
 * @returns {void}
 */
function handleCorsError(err, req, res, next) {
  if (isCorsOriginRejectedError(err)) {
    res.status(403).json({ error: err.message });
    return;
  }

  next(err);
}

/**
 * Handles uncaught application errors with a generic 500 response.
 *
 * @param {Error} err Request error.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} _next Express next callback.
 * @returns {void}
 */
function handleInternalError(err, req, res, _next) {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * Creates the LiquiFact API application with configured middleware and routes.
 *
 * @returns {import('express').Express} Configured Express application.
 */
function createApp() {
  const isTest = process.env.NODE_ENV === 'test';
  const app = express();

  app.use(cors(createCorsOptions()));
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
        escrow: 'GET/POST /api/escrow',
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
    res.status(201).json({
      data: { id: 'placeholder', status: 'pending_verification' },
      message: 'Invoice upload will be implemented with verification and tokenization.',
    });
  });

  // Placeholder: Escrow (to be wired to Soroban)
  app.get('/api/escrow/:invoiceId', async (req, res) => {
    const { invoiceId } = req.params;

    try {
      // Simulated remote contract call
      const operation = async () => {
        return { invoiceId, status: 'not_found', fundedAmount: 0 };
      };

      const data = await callSorobanContract(operation);

      res.json({
        data,
        message: 'Escrow state read from Soroban contract via robust integration wrapper.',
      });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Error fetching escrow state' });
    }
  });

  app.get('/error', (req, res, next) => {
    next(new Error('Simulated server error'));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  app.use(handleCorsError);
  app.use(handleInternalError);

  return app;
}

module.exports = {
  createApp,
  handleCorsError,
  handleInternalError,
};
