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
 * Handles uncaught application errors with a generic 500 response.
 *
 * @param {Error}                          err   - Request error.
 * @param {import('express').Request}      req   - Express request.
 * @param {import('express').Response}     res   - Express response.
 * @param {import('express').NextFunction} _next - Express next callback (unused).
 * @returns {void}
 */
function handleInternalError(err, req, res, _next) {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * Creates the LiquiFact API application with configured middleware and routes.
 *
 * Exported as a factory function so each test suite can spin up a clean
 * instance without shared state.
 *
 * @returns {import('express').Express} Configured Express application.
 */
function createApp() {
  const app = express();

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

  // Invoices — GET (list)
  app.get('/api/invoices', (req, res) => {
    res.json({
      data:    [],
      message: 'Invoice service will list tokenized invoices here.',
    });
  });

  // Invoices — POST (create) with strict 512 KB body limit
  app.post('/api/invoices', ...invoiceBodyLimit(), (req, res) => {
    res.status(201).json({
      data:    { id: 'placeholder', status: 'pending_verification' },
      message: 'Invoice upload will be implemented with verification and tokenization.',
    });
  });

  // Escrow — GET by invoiceId (proxied through Soroban retry wrapper)
  app.get('/api/escrow/:invoiceId', async (req, res) => {
    const { invoiceId } = req.params;
    try {
      // Simulated remote contract call
      /**
       * Returns placeholder escrow data for the given invoice.
       * @returns {Promise<Object>} The escrow state object
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
  app.use(handleInternalError);     // 500 for everything else

  return app;
}

module.exports = {
  createApp,
  handleCorsError,
  handleInternalError,
};
