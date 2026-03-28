'use strict';

/**
 * LiquiFact API Gateway
 * Express server bootstrap for invoice financing, auth, and Stellar integration.
 */

 * Express app configuration for invoice financing, auth, and Stellar integration.
 * Server startup lives in server.js so this module can be imported cleanly in tests.
 */

const express = require('express');
const cors = require('cors');
const { createSecurityMiddleware } = require('./middleware/security');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');
const { sanitizeInput } = require('./middleware/sanitizeInput');
const errorHandler = require('./middleware/errorHandler');
const { callSorobanContract } = require('./services/soroban');

const app = express();
const PORT = process.env.PORT || 3001;

const app = express();

/**
 * Global Middlewares
 */
// Security headers — applied first so every response is protected
app.use(createSecurityMiddleware());
app.use(cors());
app.use(express.json());
app.use(sanitizeInput);
app.use(globalLimiter);

// In-memory storage for invoices (Issue #25)
let invoices = [];

/**
 * Health check endpoint.
 * Returns the current status and version of the service.
 *
 * @param {import('express').Request} _req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/health', (_req, res) => {
  return res.json({
    status: 'ok',
    service: 'liquifact-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * API information endpoint.
 * Lists available endpoints and service description.
 *
 * @param {import('express').Request} _req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/api', (_req, res) => {
  return res.json({
    name: 'LiquiFact API',
    description: 'Global Invoice Liquidity Network on Stellar',
    endpoints: {
      health: 'GET /health',
      invoices: 'GET/POST /api/invoices',
      escrow: 'GET/POST /api/escrow',
    },
  });
});

/**
 * Lists tokenized invoices.
 * Filters out soft-deleted records unless explicitly requested.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/api/invoices', (req, res) => {
  const includeDeleted = req.query.includeDeleted === 'true';
  const filteredInvoices = includeDeleted
    ? invoices
    : invoices.filter((inv) => !inv.deletedAt);

  return res.json({
    data: filteredInvoices,
    message: includeDeleted
      ? 'Showing all invoices (including deleted).'
      : 'Showing active invoices.',
  });
});

/**
 * Uploads and tokenizes a new invoice.
 * Generates a unique ID and sets the creation timestamp.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.post('/api/invoices', authenticateToken, sensitiveLimiter, (req, res) => {
  const { amount, customer } = req.body;

  if (!amount || !customer) {
    return res.status(400).json({ error: 'Amount and customer are required' });
  }

  const newInvoice = {
    id: `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    amount,
    customer,
    status: 'pending_verification',
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };

  invoices.push(newInvoice);

  return res.status(201).json({
    data: newInvoice,
    message: 'Invoice uploaded successfully.',
  });
});

/**
 * Performs a soft delete on an invoice.
 * Sets the deletedAt timestamp instead of removing the record.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.delete('/api/invoices/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const invoiceIndex = invoices.findIndex((inv) => inv.id === id);

  if (invoiceIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (invoices[invoiceIndex].deletedAt) {
    return res.status(400).json({ error: 'Invoice is already deleted' });
  }

  invoices[invoiceIndex].deletedAt = new Date().toISOString();

  return res.json({
    message: 'Invoice soft-deleted successfully.',
    data: invoices[invoiceIndex],
  });
});

/**
 * Restores a soft-deleted invoice.
 * Resets the deletedAt timestamp to null.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.patch('/api/invoices/:id/restore', authenticateToken, (req, res) => {
  const { id } = req.params;
  const invoiceIndex = invoices.findIndex((inv) => inv.id === id);

  if (invoiceIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (!invoices[invoiceIndex].deletedAt) {
    return res.status(400).json({ error: 'Invoice is not deleted' });
  }

  invoices[invoiceIndex].deletedAt = null;

  return res.json({
    message: 'Invoice restored successfully.',
    data: invoices[invoiceIndex],
  });
});

/**
 * Creates escrow state for a specific invoice.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.post('/api/escrow', authenticateToken, sensitiveLimiter, (req, res) => {
  const invoiceId = req.body.invoiceId || 'placeholder_invoice';

  return res.json({
    data: {
      invoiceId,
      status: 'funded',
      fundedAmount: req.body.fundedAmount || 0,
    },
  });
});

/**
 * Retrieves escrow state for a specific invoice.
 * Robust integration wrapper for Soroban contract interaction.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {Promise<void>}
 */
app.get('/api/escrow/:invoiceId', authenticateToken, async (req, res) => {
  const { invoiceId } = req.params;

  try {
    /**
     * Simulated remote contract call.
     *
     * @returns {Promise<object>} The escrow data.
     */
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

/**
 * Simulated escrow operations (e.g. funding).
 */
app.post('/api/escrow', authenticateToken, sensitiveLimiter, (req, res) => {
    res.json({
        data: { status: 'funded' },
        message: 'Escrow operation simulated.'
    });
});

/**
 * 404 handler for unknown routes.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The next middleware function.
 * @returns {void}
 */
app.use((req, res, next) => {
  next(
    new AppError({
      type: 'https://liquifact.com/probs/not-found',
      title: 'Resource Not Found',
      status: 404,
      detail: `The path ${req.path} does not exist.`,
      instance: req.originalUrl,
    })
  );
});

app.use(errorHandler);

/**
 * Starts the Express server.
 *
 * @returns {import('http').Server} The started server.
 */
const startServer = () => {
  const server = app.listen(PORT, () => {
    console.warn(`LiquiFact API running at http://localhost:${PORT}`);
  });
  return server;
};

/**
 * Resets the in-memory store (for testing purposes).
 *
 * @returns {void}
 */
const resetStore = () => {
  invoices = [];
};

// Start server if not in test mode
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  startServer();
}

// Export in both common patterns to avoid breaking existing tests/imports.
module.exports = app;
module.exports.app = app;
module.exports.startServer = startServer;
module.exports.resetStore = resetStore;
