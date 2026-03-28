'use strict';

/**
 * LiquiFact API Gateway
 * Express server bootstrap for invoice financing, auth, and Stellar integration.
 */
require('dotenv').config();

const { createSecurityMiddleware } = require('./middleware/security');

const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');

const { callSorobanContract } = require('./services/soroban');
const { validatePatchFields, detectLockedFieldChange } = require('./middleware/patchInvoice');

const express = require('express');
const cors = require('cors');


const app = express();
const PORT = process.env.PORT || 3001;

/**
 * Global Middlewares
 */
// Security headers — applied first so every response is protected
app.use(createSecurityMiddleware());
app.use(cors());
app.use(express.json());
app.use(globalLimiter);

// In-memory storage for invoices (Issue #25)
let invoices = [];

/**
 * Health check endpoint.
 * Returns the current status and version of the service.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.get('/api', (req, res) => {
  return res.json({
    name: 'LiquiFact API',
    description: 'Global Invoice Liquidity Network on Stellar',
    endpoints: {
      health: 'GET /health',
      invoices: 'GET /api/invoices | POST /api/invoices | PATCH /api/invoices/:id | DELETE /api/invoices/:id | PATCH /api/invoices/:id/restore',
      escrow: 'GET /api/escrow/:invoiceId',
    },
  });
});

/**
 * Lists tokenized invoices.
 * Filters out soft-deleted records unless explicitly requested.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.post('/api/invoices', sensitiveLimiter, authenticateToken, (req, res) => {
  const { amount, customer } = req.body;

  if (!amount || !customer) {
    return res.status(400).json({ error: 'Amount and customer are required' });
  }

  const newInvoice = {
    id: `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    amount,
    customer,
    status: 'pending_verification',
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    deletedAt: null,
  };

  invoices.push(newInvoice);

  return res.status(201).json({
    data: newInvoice,
    message: 'Invoice uploaded successfully.',
  });
});

/**
 * Partially updates an invoice with strict field-level access controls.
 *
 * Allowed mutable fields: `amount`, `customer`, `notes`.
 * `amount` and `customer` are locked once the invoice status is one of:
 * `verified`, `funded`, `settled`, or `cancelled`.
 * `notes` remains editable across all non-deleted statuses.
 *
 * Soft-deleted invoices cannot be updated — restore them first via
 * `PATCH /api/invoices/:id/restore`.
 *
 * @param {import('express').Request & { sanitizedUpdate: Record<string, unknown> }} req
 * @param {import('express').Response} res
 * @returns {void}
 *
 * @example
 * // Allowed — pending invoice
 * PATCH /api/invoices/inv_123
 * { "amount": 5000, "notes": "Updated terms" }
 *
 * @example
 * // Rejected — amount is locked after verification
 * PATCH /api/invoices/inv_456   (status: "verified")
 * { "amount": 9999 }
 * // → 422 Unprocessable Entity
 *
 * @example
 * // Rejected — unknown field stripped, body becomes empty
 * PATCH /api/invoices/inv_789
 * { "status": "funded" }
 * // → 400 Bad Request
 */
app.patch('/api/invoices/:id', validatePatchFields, (req, res) => {
  const { id } = req.params;
  const invoiceIndex = invoices.findIndex((inv) => inv.id === id);

  if (invoiceIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  // eslint-disable-next-line security/detect-object-injection
  const invoice = invoices[invoiceIndex];

  if (invoice.deletedAt) {
    return res.status(409).json({
      error: 'Cannot update a soft-deleted invoice. Restore it first.',
    });
  }

  const { locked, field } = detectLockedFieldChange(req.sanitizedUpdate, invoice.status);
  if (locked) {
    return res.status(422).json({
      error: `Field "${field}" cannot be changed once the invoice status is "${invoice.status}".`,
    });
  }

  // Apply sanitized update
  Object.assign(invoice, req.sanitizedUpdate, {
    updatedAt: new Date().toISOString(),
  });

  // eslint-disable-next-line security/detect-object-injection
  invoices[invoiceIndex] = invoice;

  return res.json({
    data: invoice,
    message: 'Invoice updated successfully.',
  });
});

/**
 * Performs a soft delete on an invoice.
 * Sets the deletedAt timestamp instead of removing the record.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.delete('/api/invoices/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const invoiceIndex = invoices.findIndex((inv) => inv.id === id);

  if (invoiceIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // eslint-disable-next-line security/detect-object-injection
  if (invoices[invoiceIndex].deletedAt) {
    return res.status(400).json({ error: 'Invoice is already deleted' });
  }

  // eslint-disable-next-line security/detect-object-injection
  invoices[invoiceIndex].deletedAt = new Date().toISOString();

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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.patch('/api/invoices/:id/restore', authenticateToken, (req, res) => {
  const { id } = req.params;
  const invoiceIndex = invoices.findIndex((inv) => inv.id === id);

  if (invoiceIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // eslint-disable-next-line security/detect-object-injection
  if (!invoices[invoiceIndex].deletedAt) {
    return res.status(400).json({ error: 'Invoice is not deleted' });
  }
  res.status(201).json({
    data: { id: 'placeholder', status: 'pending_verification' },
    message: 'Invoice upload will be implemented with verification and tokenization.',
  });
});

/**
 * Retrieves escrow state for a specific invoice.
 * Robust integration wrapper for Soroban contract interaction.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.get('/api/escrow/:invoiceId', authenticateToken, async (req, res) => {
  const { invoiceId } = req.params;

  try {
    /**
     * Health check endpoint.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {void}
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
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

/**
 * Global error handler.
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 * @returns {void}
 */
app.use((err, req, res, _next) => {
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

/**
 * Starts the Express server.
 *
 * @returns {import('http').Server}
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

/**
 * Forces an invoice to a given status (for testing purposes only).
 * This bypasses normal status-transition validation.
 *
 * @param {string} id - Invoice ID.
 * @param {string} status - Target status.
 * @returns {void}
 */
const forceInvoiceStatus = (id, status) => {
  const idx = invoices.findIndex((inv) => inv.id === id);
  if (idx !== -1) {
    // eslint-disable-next-line security/detect-object-injection
    invoices[idx].status = status;
  }
};

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

module.exports = { app, startServer, resetStore, forceInvoiceStatus };
