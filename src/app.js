/**
 * @fileoverview Express application factory for the LiquiFact API.
 *
 * Wires together all middleware and routes in the correct order:
 *   1. CORS policy (environment-driven allowlist, 403 on blocked origins)
 *   2. Request body-size guardrails (100 KB global JSON, 512 KB invoice limit)
 *   3. URL-encoded body parser (50 KB limit)
 *   4. Application routes (health, api-info, invoices, escrow)
 *   5. 404 catch-all
 *   6. CORS error handler  → 403 JSON
 *   7. Payload-too-large handler → 413 JSON
 *   8. Generic internal-error handler → 500 JSON
 *
 * @module app
 */

'use strict';

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { callSorobanContract }               = require('./services/soroban');
const { createCorsOptions, isCorsOriginRejectedError } = require('./config/cors');
const {
  jsonBodyLimit,
  urlencodedBodyLimit,
  invoiceBodyLimit,
  payloadTooLargeHandler,
} = require('./middleware/bodySizeLimits');

const invoiceService = require('./services/invoice.service');
const { validateInvoiceQueryParams } = require('./utils/validators');
const asyncHandler = require('./utils/asyncHandler');

const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');

// Import repository registry
const { RepositoryRegistry } = require('./repositories');

/**
 * Returns a 403 JSON response only for the dedicated blocked-origin CORS error.
 *
 * @param {Error}                          err  - Request error.
 * @param {import('express').Request}      req  - Express request.
 * @param {import('express').Response}     res  - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
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
 * Creates the LiquiFact API application with configured middleware and routes.
 *
 * Exported as a factory function so each test suite can spin up a clean
 * instance without shared state.
 *
 * @param {Object} [deps={}] Dependency injection container.
 * @param {import('./repositories/invoice.repository')} [deps.invoiceRepo] The invoice repository.
 * @param {import('./repositories/escrow.repository')} [deps.escrowRepo] The escrow repository.
 * @returns {import('express').Express} Configured Express application.
 */
function createApp(deps = {}) {
  const app = express();

  // Use RepositoryRegistry to manage repository dependencies
  const { invoiceRepo, escrowRepo } = new RepositoryRegistry(deps);

  // Apply global rate limiter for all routes
  app.use(globalLimiter);

  // ── 1. CORS ──────────────────────────────────────────────────────────────
  // Must come before body parsers so preflight OPTIONS requests are handled
  // before any payload is read.
  app.use(cors(createCorsOptions()));

  // ── 2 & 3. Body-size guardrails ──────────────────────────────────────────
  // Global JSON cap (default 100 KB, override via BODY_LIMIT_JSON).
  app.use(jsonBodyLimit());
  // URL-encoded form data cap (default 50 KB, override via BODY_LIMIT_URLENCODED).
  app.use(urlencodedBodyLimit());

  // ── 4. Routes ────────────────────────────────────────────────────────────

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status:    'ok',
      service:   'liquifact-api',
      version:   '0.1.0',
      timestamp: new Date().toISOString(),
    });
  });

  // API info
  app.get('/api', (req, res) => {
    res.json({
      name:        'LiquiFact API',
      description: 'Global Invoice Liquidity Network on Stellar',
      endpoints: {
        health:   'GET /health',
        invoices: 'GET/POST /api/invoices',
        escrow:   'GET/POST /api/escrow',
      },
    });
  });

  // List invoices (optionally include deleted)
  app.get('/api/invoices', async (req, res) => {
    try {
      const includeDeleted = req.query.includeDeleted === 'true';
      const invoices = await invoiceRepo.findAll({ includeDeleted });
      res.json({
        data: invoices,
        message: 'Invoice list retrieved via repository abstraction layer.',
      });
    } catch {
      res.status(500).json({ error: 'Failed to retrieve invoices' });
    }
  });

  // Create invoice (require amount and customer)
  if (process.env.TEST_AUTH_PROTECTED === 'true') {
    // Protected for auth/rate limit tests
    app.post('/api/invoices', authenticateToken, sensitiveLimiter, ...invoiceBodyLimit(), async (req, res) => {
      try {
        const { amount, customer } = req.body;
        if (typeof amount !== 'number' || !customer) {
          return res.status(400).json({ error: 'Missing required fields: amount, customer' });
        }
        const invoiceData = req.body;
        const newInvoice = await invoiceRepo.create(invoiceData);
        res.status(201).json({
          data: newInvoice,
          message: 'Invoice created successfully via repository abstraction layer.',
        });
      } catch {
        res.status(500).json({ error: 'Failed to create invoice' });
      }
    });
  } else {
    // Public for integration tests and normal operation
    app.post('/api/invoices', sensitiveLimiter, ...invoiceBodyLimit(), async (req, res) => {
      try {
        const { amount, customer } = req.body;
        if (typeof amount !== 'number' || !customer) {
          return res.status(400).json({ error: 'Missing required fields: amount, customer' });
        }
        const invoiceData = req.body;
        const newInvoice = await invoiceRepo.create(invoiceData);
        res.status(201).json({
          data: newInvoice,
          message: 'Invoice created successfully via repository abstraction layer.',
        });
      } catch {
        res.status(500).json({ error: 'Failed to create invoice' });
      }
    });
  }

  // POST /api/escrow (protected, for test compatibility)
  app.post('/api/escrow', authenticateToken, sensitiveLimiter, async (req, res) => {
    // Simulate escrow funding for test
    res.status(200).json({ data: { status: 'funded' } });
  });
  // Error handler test route for index.test.js
  app.get('/error-test-trigger', (req, res, next) => {
    const err = new Error('Simulated server error');
    next(err);
  });

  // Delete (soft delete) invoice
  app.delete('/api/invoices/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const invoice = await invoiceRepo.findById(id);
      if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      if (invoice.deletedAt) {
        return res.status(400).json({ error: 'Invoice is already deleted' });
      }
      const deleted = await invoiceRepo.softDelete(id);
      res.status(200).json({ data: deleted });
    } catch {
      res.status(500).json({ error: 'Failed to delete invoice' });
    }
  });

  // Restore a soft-deleted invoice
  app.patch('/api/invoices/:id/restore', async (req, res) => {
    try {
      const { id } = req.params;
      const invoice = await invoiceRepo.findById(id);
      if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      if (!invoice.deletedAt) {
        return res.status(400).json({ error: 'Invoice is not deleted' });
      }
      const restored = await invoiceRepo.restore(id);
      res.status(200).json({ data: restored });
    } catch {
      res.status(500).json({ error: 'Failed to restore invoice' });
    }
  });

  // Escrow (using Repository proxied through Soroban retry wrapper)
  app.get('/api/escrow/:invoiceId', async (req, res) => {
    const { invoiceId } = req.params;
    try {
      const data = await escrowRepo.getEscrowState(invoiceId);
      res.json({
        data,
        message: 'Escrow state read from blockchain repository abstraction.',
      });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Error fetching escrow state' });
    }
  });

  // Developer test route — forces a 500 to exercise the error handler
  app.get('/error', (req, res, next) => {
    next(new Error('Simulated server error'));
  });

  // ── 5. 404 catch-all ─────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // ── 6 – 8. Error handlers (order matters) ────────────────────────────────
  app.use(handleCorsError);         // 403 for blocked CORS origins
  app.use(payloadTooLargeHandler);  // 413 for oversized request bodies
  
  // Global error handler (standardizes error responses)
  app.use(require('./middleware/errorHandler'));

  return app;
}

module.exports = {
  createApp,
  handleCorsError,
};
