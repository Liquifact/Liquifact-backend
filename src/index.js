/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

/**
 * Create the Express application instance.
 *
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  app.use(cors());
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
    res.status(201).json({
      data: { id: 'placeholder', status: 'pending_verification' },
      message: 'Invoice upload will be implemented with verification and tokenization.',
    });
  });

  // Placeholder: Escrow (to be wired to Soroban)
  app.get('/api/escrow/:invoiceId', (req, res) => {
    const { invoiceId } = req.params;
    res.json({
      data: { invoiceId, status: 'not_found', fundedAmount: 0 },
      message: 'Escrow state will be read from Soroban contract.',
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

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
