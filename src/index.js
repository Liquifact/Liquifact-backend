/**
 * LiquiFact API Gateway
 * Express server bootstrap for invoice financing, auth, and Stellar integration.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');
const webhookService = require('./services/webhook');

const asyncHandler = require('./utils/asyncHandler');
const errorHandler = require('./middleware/errorHandler');
const { callSorobanContract } = require('./services/soroban');

const app = express();
const PORT = process.env.PORT || 3001;

/**
 * Global Middlewares
 */
app.use(cors());
app.use(express.json());

// In-memory storage for invoices (Issue #25)
let invoices = [];

/**
 * Health check endpoint.
 * Returns the current status and version of the service.
 * 
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/health', (req, res) => {
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
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/api', (req, res) => {
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
 * Registers a new webhook subscription.
 * 
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.post('/api/webhooks/register', (req, res) => {
  const { url, secret } = req.body;
  if (!url || !secret) {
    return res.status(400).json({ error: 'URL and secret are required for webhook registration.' });
  }

  webhookService.register(url, secret);
  return res.status(201).json({ message: 'Webhook registered successfully.' });
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
    : invoices.filter(inv => !inv.deletedAt);

  return res.json({
    data: filteredInvoices,
    message: includeDeleted ? 'Showing all invoices (including deleted).' : 'Showing active invoices.',
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
app.post('/api/invoices', (req, res) => {
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

  // Trigger webhook notification (asynchronous)
  webhookService.notifyInvoiceStatusChange(newInvoice, 'pending_verification').catch(err => {
    console.error(`Webhook notification failed for invoice ${newInvoice.id}:`, err);
  });

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
app.delete('/api/invoices/:id', (req, res) => {
  const { id } = req.params;
  const invoiceIndex = invoices.findIndex(inv => inv.id === id);

  if (invoiceIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // eslint-disable-next-line security/detect-object-injection
  if (invoices[invoiceIndex].deletedAt) {
    return res.status(400).json({ error: 'Invoice is already deleted' });
  }

  // eslint-disable-next-line security/detect-object-injection
  invoices[invoiceIndex].deletedAt = new Date().toISOString();

  // Trigger webhook notification (asynchronous)
  webhookService.notifyInvoiceStatusChange(invoices[invoiceIndex], 'void').catch(err => {
    console.error(`Webhook notification failed for invoice ${id}:`, err);
  });

  return res.json({
    message: 'Invoice soft-deleted successfully.',
    // eslint-disable-next-line security/detect-object-injection
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
app.patch('/api/invoices/:id/restore', (req, res) => {
  const { id } = req.params;
  const invoiceIndex = invoices.findIndex(inv => inv.id === id);

  if (invoiceIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // eslint-disable-next-line security/detect-object-injection
  if (!invoices[invoiceIndex].deletedAt) {
    return res.status(400).json({ error: 'Invoice is not deleted' });
  }

  // eslint-disable-next-line security/detect-object-injection
  invoices[invoiceIndex].deletedAt = null;

  // Trigger webhook notification (asynchronous)
  webhookService.notifyInvoiceStatusChange(invoices[invoiceIndex], 'pending_verification').catch(err => {
    console.error(`Webhook notification failed for invoice ${id}:`, err);
  });

  return res.json({
    message: 'Invoice restored successfully.',
    // eslint-disable-next-line security/detect-object-injection
    data: invoices[invoiceIndex],
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
app.get('/api/escrow/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;

  try {
    /**
     * Simulated remote contract call.
     * 
     * @returns {Promise<Object>} The escrow data.
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
 * 404 handler for unknown routes.
 * 
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The next middleware function.
 * @returns {void}
 */
app.use((req, res, next) => {
  if (req.path === '/error-test-trigger') {
    return next(new Error('Test error'));
  }
  return res.status(404).json({ error: 'Not found', path: req.path });
});

/**
 * Global error handler.
 * Logs the error and returns a 500 status.
 * 
 * @param {Error} err - The error object.
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} _next - The next middleware function.
 * @returns {void}
 */
app.use((err, req, res, _next) => {
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

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
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// Export app and state for testing
module.exports = { app, startServer, resetStore };
