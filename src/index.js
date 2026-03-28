'use strict';

/**
 * LiquiFact API Gateway
 * Express server bootstrap for invoice financing, auth, and Stellar integration.
 *
 * All /api/* routes now enforce tenant-scoped data isolation:
 *   - `extractTenant` middleware resolves the caller's tenantId from either
 *     the `x-tenant-id` request header or an authenticated JWT claim.
 *   - Every invoice read/write delegates to the tenant-aware repository so
 *     that no tenant can ever observe or mutate another tenant's data.
 */

'use strict';

require('dotenv').config();
/**
 * Express app configuration for invoice financing, auth, and Stellar integration.
 * Server startup lives in server.js so this module can be imported cleanly in tests.
 */

const express = require('express');
const cors = require('cors');
const { createSecurityMiddleware } = require('./middleware/security');
require('dotenv').config();
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');


const { extractTenant } = require('./middleware/tenant');
const invoiceRepo = require('./services/invoice');

// const asyncHandler = require('./utils/asyncHandler');
// const errorHandler = require('./middleware/errorHandler');
const { callSorobanContract } = require('./services/soroban');
const AppError = require('./errors/AppError');

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
// let invoices = [];


// ─── Public routes (no tenant context required) ───────────────────────────────

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

// ─── Tenant-scoped API routes ─────────────────────────────────────────────────
//
// All routes below this point use the `tenantMiddleware` stack:
//   [globalLimiter] → [authenticateToken] → [extractTenant]
//
// `authenticateToken` populates `req.user` (including `req.user.tenantId`
// when the JWT carries that claim). `extractTenant` then resolves the final
// tenantId from the header or the JWT claim and stores it on `req.tenantId`.
//
// Routes do NOT need to trust req.body / req.query for tenant identity —
// the tenant is always taken from the verified middleware context.

/** Reusable middleware stack for all tenant-scoped endpoints. */
const tenantMiddleware = [globalLimiter, authenticateToken, extractTenant];

/**
 * Lists tokenized invoices for the authenticated tenant.
 * Filters out soft-deleted records unless explicitly requested.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/api/invoices', tenantMiddleware, (req, res) => {
  const includeDeleted = req.query.includeDeleted === 'true';
  const data = invoiceRepo.listInvoices(req.tenantId, includeDeleted);

  return res.json({
    data,
    message: includeDeleted
      ? 'Showing all invoices (including deleted).'
      : 'Showing active invoices.',
  });
});

/**
 * Uploads and tokenizes a new invoice for the authenticated tenant.
 * Generates a unique ID and sets the creation timestamp.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.post('/api/invoices', sensitiveLimiter, authenticateToken, tenantMiddleware, (req, res) => {
  const { amount, customer } = req.body;

  if (!amount || !customer) {
    return res.status(400).json({ error: 'Amount and customer are required' });
  }

  const newInvoice = invoiceRepo.createInvoice(req.tenantId, { amount, customer });

  return res.status(201).json({
    data: newInvoice,
    message: 'Invoice uploaded successfully.',
  });
});

/**
 * Performs a soft delete on an invoice owned by the authenticated tenant.
 * Cross-tenant delete attempts are rejected with 404 (the invoice simply
 * does not exist in the requesting tenant's scope).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.delete('/api/invoices/:id', tenantMiddleware, (req, res) => {
  const result = invoiceRepo.softDeleteInvoice(req.tenantId, req.params.id);

  if (result === null) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  if (result === false) {
    return res.status(400).json({ error: 'Invoice is already deleted' });
  }

  return res.json({
    message: 'Invoice soft-deleted successfully.',
    data: result,
  });
});

/**
 * Restores a soft-deleted invoice owned by the authenticated tenant.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.patch('/api/invoices/:id/restore', tenantMiddleware, (req, res) => {
  const result = invoiceRepo.restoreInvoice(req.tenantId, req.params.id);

  if (result === null) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  if (result === false) {
    return res.status(400).json({ error: 'Invoice is not deleted' });
  }

  return res.json({
    message: 'Invoice restored successfully.',
    data: result,
  });
});

/**
 * Retrieves escrow state for a specific invoice.
 * The invoiceId is validated against the requesting tenant's scope before
 * forwarding to the Soroban contract.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.get('/api/escrow/:invoiceId', tenantMiddleware, async (req, res) => {
  const { invoiceId } = req.params;

  // Verify the invoice belongs to this tenant before hitting the contract.
  // A missing invoice (including one owned by a different tenant) returns 404.
  const invoice = invoiceRepo.findInvoice(req.tenantId, invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  
  try {
   /**
 * Retrieves escrow state for a specific invoice.
 * The invoiceId is validated against the requesting tenant's scope before
 * forwarding to the Soroban contract.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
    const operation = async () => ({ invoiceId, tenantId: req.tenantId, status: 'not_found', fundedAmount: 0,});

    const data = await callSorobanContract(operation);

    return res.json({
      data,
      message: 'Escrow state read from Soroban contract via robust integration wrapper.',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error fetching escrow state' });
  }
});

// ─── Fallback handlers ────────────────────────────────────────────────────────

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
 * Logs the error and returns a 500 status.
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

// ─── Server lifecycle ─────────────────────────────────────────────────────────

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
// const resetStore = () => {
//   invoices = [];
// };

// Start server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// Export app and state for testing
module.exports = { app, startServer };
// Export app as default (so `require('./index')` returns the Express app directly),
// with startServer and resetStore attached as properties for tests that need them.
// module.exports = app;
// module.exports.startServer = startServer;
// module.exports.resetStore = resetStore;
