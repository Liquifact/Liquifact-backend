/**
 * @fileoverview Express application factory for the LiquiFact API.
 *
 * Wires together all middleware and routes in the correct order:
 * 1. CORS policy (environment-driven allowlist, 403 on blocked origins)
 * 2. Request body-size guardrails (100 KB global JSON, 512 KB invoice limit)
 * 3. URL-encoded body parser (50 KB limit)
 * 4. Application routes (health, api-info, invoices, escrow)
 * 5. 404 catch-all
 * 6. CORS error handler  → 403 JSON
 * 7. Payload-too-large handler → 413 JSON
 * 8. Generic internal-error handler → 500 JSON
 *
 * @module app
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createSecurityMiddleware } = require('./middleware/security');
const { auditMiddleware } = require('./middleware/audit');
const requestId = require('./middleware/requestId');
const { correlationIdMiddleware } = require('./middleware/correlationId');
const invoiceService = require('./services/invoiceService');
const { CursorError } = require('./utils/cursorPagination');
const { resolveEscrowAddress } = require('./config/escrowMap');
const { getEscrowStateWithProjection } = require('./services/escrowRead');
const { createCorsOptions, isCorsOriginRejectedError } = require('./config/cors');
const { get: getConfig } = require('./config');
const { validateInvoiceQueryParams } = require('./utils/validators');
const { computeEscrowDerivedFields } = require('./services/escrowDerived');
const AppError = require('./errors/AppError');
const { invoiceCreateSchema, parseValidationErrors } = require('./schemas/invoice');
const {
  invoiceBodyLimit,
  jsonBodyLimit,
  payloadTooLargeHandler,
  urlencodedBodyLimit,
} = require('./middleware/bodySizeLimits');
const healthRoutes = require('./routes/health');
const { performHealthChecks, performReadinessChecks } = require('./services/health');
const { validateHealthQuery, rejectBodyOnGet } = require('./schemas/health');
const responseHelper = require('./utils/responseHelper');
const logger = require('./logger');
const { metricsAuth, metricsHandler } = require('./metrics');
const { metricsLimiter } = require('./middleware/rateLimit');
const { instrumentHealth } = require('./middleware/healthMetrics');
const smeRoutes = require('./routes/sme');
const invoiceFileRoutes = require('./routes/invoiceFile');
const auditTrailRoutes = require('./routes/auditTrail');
const investRoutes = require('./routes/invest');
const investorRoutes = require('./routes/investor');
const marketplaceRoutes = require('./routes/marketplace');
const retentionRoutes = require('./routes/retention');
const invoiceStateRoutes = require('./routes/invoiceStateRoutes');
const adminEscrowRoutes = require('./routes/adminEscrow');
const adminWebhooksRoutes = require('./routes/adminWebhooks');
const adminConfigRoutes = require('./routes/adminConfig');
const kycRoutes = require('./routes/kyc');
const adminKycRoutes = require('./routes/adminKyc');
const reconciliationRoutes = require('./routes/reconciliation');
const adminIndexerRoutes = require('./routes/adminIndexer');
const v1Routes = require('./routes/v1');
const apiKeysRoutes = require('./routes/apiKeys');
const {
  mountFeatureRouter,
  assertNoDuplicateRouterMounts,
  resetFeatureRouterMounts,
} = require('./utils/routeMountRegistry');
const { createCompressionMiddleware } = require('./middleware/compression');

/**
 * Returns a 403 JSON response only for the dedicated blocked-origin CORS error.
 *
 * @param {Error} err - Request error.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function handleCorsError(err, req, res, next) {
  if (isCorsOriginRejectedError(err)) {
    res.status(403).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

/**
 * Handles uncaught application errors with a generic 500 response.
 *
 * @param {Error} err - Request error.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} _next - Express next callback (unused).
 * @returns {void}
 */
function handleInternalError(err, req, res, _next) {
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    res.status(400).json({ error: 'Bad Request' });
    return;
  }

  // AppError: use the status it carries (400–599).
  // This covers both 4xx client errors and 5xx upstream errors (e.g. 502).
  if (err && err.status && err.status >= 400 && err.status <= 599) {
    res.status(err.status).json({
      error: {
        code: err.code || String(err.status),
        message: err.detail || err.title || err.message,
      },
    });
    return;
  }

  logger.error({ err, reqId: req.id }, 'Internal server error');
  if (isDevelopment) {
    res.status(500).json({
      error: {
        message: err && err.message ? err.message : 'Internal server error',
        stack: err && err.stack ? err.stack : null,
      },
    });
    return;
  }

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
  resetFeatureRouterMounts();
  const app = express();

  // ── 1. CORS ──────────────────────────────────────────────────────────────
  app.use(cors(createCorsOptions()));

  // ── 1.a. KYC webhook raw body parser ──────────────────────────────────────
  // Incoming provider webhooks must be verified against the raw JSON body.
  app.use('/api/kyc/webhook', express.raw({ type: 'application/json', limit: '100kb' }));

  // ── 2 & 3. Body-size guardrails ──────────────────────────────────────────
  app.use(...jsonBodyLimit());
  app.use(...urlencodedBodyLimit());

  // Apply security headers middleware
  app.use(createSecurityMiddleware());
  app.use(auditMiddleware);
  app.use(requestId);
  app.use(correlationIdMiddleware);

  // ── 4. Routes ────────────────────────────────────────────────────────────

  // ── Health / Liveness / Readiness ──────────────────────────────────────
  // Issue #769 — per-client rate limiter before individual handlers.
  // Mounted first so monitoring scrapers and K8s probes all share the same
  // per-client budget and a flood of unauthenticated requests is gated
  // before it reaches the dependency checks.

  // Liveness probe — no external dependencies
  app.get('/health', rejectBodyOnGet, validateHealthQuery, instrumentHealth('health_liveness', (req, res) => {
    res.json({
      status: 'ok',
      service: 'liquifact-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  }));

  // Liveness alias (Kubernetes convention)
  app.get('/healthz', rejectBodyOnGet, validateHealthQuery, instrumentHealth('health_liveness', (req, res) => {
    res.json({
      status: 'ok',
      service: 'liquifact-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  }));

  // Full health check (all dependencies)
  app.get('/ready', rejectBodyOnGet, validateHealthQuery, instrumentHealth('health_full', async (req, res) => {
    try {
      const { healthy, checks } = await performHealthChecks();
      const status = healthy ? 200 : 503;

      res.status(status).json({
        ready: healthy,
        service: 'liquifact-api',
        timestamp: new Date().toISOString(),
        checks,
      });
    } catch (error) {
      res.status(503).json({
        ready: false,
        service: 'liquifact-api',
        timestamp: new Date().toISOString(),
        error: error.message,
      });
    }
  }));

  // Readiness probe (critical deps only: DB, Soroban RPC)
  app.get('/readyz', rejectBodyOnGet, validateHealthQuery, instrumentHealth('health_readiness', async (req, res) => {
    try {
      const { healthy, checks } = await performReadinessChecks();
      const status = healthy ? 200 : 503;

      res.status(status).json({
        ready: healthy,
        service: 'liquifact-api',
        timestamp: new Date().toISOString(),
        checks,
      });
    } catch (error) {
      res.status(503).json({
        ready: false,
        service: 'liquifact-api',
        timestamp: new Date().toISOString(),
        error: error.message,
      });
    }
  }));

  // API info
  app.get('/api', (req, res) => {
    res.json({
      name: 'LiquiFact API',
      description: 'Global Invoice Liquidity Network on Stellar',
      endpoints: {
        health: 'GET /health',
        healthz: 'GET /healthz',
        ready: 'GET /ready',
        readyz: 'GET /readyz',
        invoices: 'GET/POST /api/invoices',
        escrow: 'GET /api/escrow/:invoiceId',
        marketplace: 'GET /api/marketplace',
        invest: 'GET /api/invest/opportunities, GET /api/invest/list',
      },
    });
  });

  app.use('/api/api-keys', apiKeysRoutes);

  // Invoices — GET (list)
  app.get('/api/invoices', async (req, res) => {
    const { isValid, fieldErrors, validatedParams } = validateInvoiceQueryParams(req.query);
    if (!isValid) {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Query parameters contain invalid values.',
        fieldErrors,
      });
    }

    let result;
    try {
      result = await invoiceService.getInvoicesWithPagination(validatedParams);
    } catch (err) {
      if (err instanceof CursorError) {
        return res.status(400).json({
          type: 'https://liquifact.io/problems/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'Query parameters contain invalid values.',
          fieldErrors: {
            cursor: err.message,
          },
        });
      }
      throw err;
    }

    res.json({
      data: result.data,
      meta: result.meta,
      message: 'Invoices retrieved successfully.',
    });
  });

  // Invoices — POST (create) with strict payload validation and 512 KB body limit
  app.post('/api/invoices', ...invoiceBodyLimit(), (req, res) => {
    const result = invoiceCreateSchema.safeParse(req.body);

    if (!result.success) {
      const fieldErrors = parseValidationErrors(result.error);
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invoice payload contains invalid or missing fields.',
        fieldErrors,
      });
    }

    res.status(201).json({
      data: { id: 'placeholder', status: 'pending_verification' },
      message: 'Invoice upload will be implemented with verification and tokenization.',
    });
  });

  // Escrow — GET by invoiceId (proxied through Soroban retry wrapper with address mapping)
<<<<<<< HEAD
  // Compression middleware: gzip/deflate for large escrow-read responses (issue #961).
  // Threshold: 1 KB (DEFAULT_THRESHOLD). Respects Accept-Encoding; small responses
  // pass through uncompressed. Vary: Accept-Encoding is always set.
  app.get('/api/escrow/:invoiceId', createCompressionMiddleware(), async (req, res) => {
=======
  app.get('/api/escrow/:invoiceId', async (req, res, next) => {
>>>>>>> pr-1067
    const invoiceId = String(req.params.invoiceId || '')
      .trim()
      .replace(/\s+/g, '');

    try {
      // Resolve escrow contract address using the mapping system
      const escrowAddress = resolveEscrowAddress(invoiceId);
      
      if (!escrowAddress) {
        return next(new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Not Found',
          status: 404,
          detail: `No escrow contract mapping found for invoice ID '${invoiceId}'`,
          code: 'NOT_FOUND',
          retryable: false,
        }));
      }

      // Read from projection, cache, or live read fallback
      const state = await getEscrowStateWithProjection(invoiceId);

      const derived = computeEscrowDerivedFields(state);

      const data = {
        ...state,
        ...derived,
        escrowAddress
      };

      // Include escrow address in response headers
      res.set('X-Escrow-Address', escrowAddress);
      res.json({
        data,
        message: state.fromProjection 
          ? 'Escrow state read from event projection.'
          : 'Escrow state read from live Soroban contract.',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * Simulated error route for testing error handling middleware.
   *
   * @param {import('express').Request} req Express request.
   * @param {import('express').Response} res Express response.
   * @param {import('express').NextFunction} next Express next callback.
   * @returns {void}
   */
  app.get('/error', (req, res, next) => {
    next(new Error('Simulated server error'));
  });

  app.get('/debug/error', (req, res, next) => {
    next(new Error('Triggered Error'));
  });

  app.get('/prod-error', (req, res, next) => {
    next(new Error('Sensitive'));
  });

  /**
   * Feature router mounts — order is intentional.
   *
   * Each router is imported once and mounted once via `mountFeatureRouter`.
   * Multiple routers may share a base path only when they are distinct instances
   * (e.g. invoice file upload + invoice state machine both use `/api/invoices`).
   * The investor router (`/api/investor`) must never be mounted twice; duplicate
   * mounts are rejected at bootstrap by `assertNoDuplicateRouterMounts`.
   *
   * Investor handlers apply `authenticateToken` then `extractTenant` before
   * lock list or detail logic runs (see `routes/investor.js`).
   *
   * @see docs/request-lifecycle-middleware-order.md
   */
  mountFeatureRouter(app, '/api/sme', smeRoutes);
  mountFeatureRouter(app, '/api/invoices', invoiceFileRoutes);
  if (getConfig().INVOICE_STATE_ENABLED === 'true') {
    mountFeatureRouter(app, '/api/invoices', invoiceStateRoutes);
  }
  mountFeatureRouter(app, '/api/invest', investRoutes);
  mountFeatureRouter(app, '/api/investor', investorRoutes);
  mountFeatureRouter(app, '/api/kyc', kycRoutes);
  mountFeatureRouter(app, '/api/marketplace', marketplaceRoutes);
  mountFeatureRouter(app, '/api/health', healthRoutes);
  mountFeatureRouter(app, '/api/retention', retentionRoutes);
  mountFeatureRouter(app, '/api/admin/audit', auditTrailRoutes);
  mountFeatureRouter(app, '/api/admin/escrow', adminEscrowRoutes);
  mountFeatureRouter(app, '/api/admin/webhooks', adminWebhooksRoutes);
  mountFeatureRouter(app, '/api/admin/config', adminConfigRoutes);
  mountFeatureRouter(app, '/api/admin/reconciliation', reconciliationRoutes);
  mountFeatureRouter(app, '/api/admin/indexer', adminIndexerRoutes);
  mountFeatureRouter(app, '/api/admin/kyc', adminKycRoutes);
  mountFeatureRouter(app, '/v1', v1Routes);
  mountFeatureRouter(app, '/api', apiKeysRoutes);

  assertNoDuplicateRouterMounts();

  // ── 6. Prometheus metrics ────────────────────────────────────────────────
  // Rate limiter mounted BEFORE metricsAuth so unauthenticated attempts
  // still consume quota — defending against brute-force token guessing
  // on the metrics surface (issue #744).
  app.get('/metrics', metricsLimiter, metricsAuth, metricsHandler);

  // ── 7. 404 catch-all ─────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // ── 8 – 10. Error handlers (order matters) ───────────────────────────────
  app.use(handleCorsError);
  app.use(payloadTooLargeHandler);
  app.use(handleInternalError);

  return app;
}

/**
 * Maps HTTP status to default API error code.
 *
 * @param {number} statusCode - HTTP status code.
 * @returns {string} Standardized error code.
 */
function getErrorCode(statusCode) {
  if (statusCode === 400) {
    return 'BAD_REQUEST';
  }
  if (statusCode === 401) {
    return 'UNAUTHORIZED';
  }
  if (statusCode === 403) {
    return 'FORBIDDEN';
  }
  if (statusCode === 404) {
    return 'NOT_FOUND';
  }
  return 'INTERNAL_ERROR';
}

/**
 * Builds a standardized envelope from an outgoing JSON payload.
 *
 * @param {number} statusCode - Response status code.
 * @param {unknown} payload - Outgoing payload.
 * @returns {Object} Standardized response envelope.
 */
function toStandardEnvelope(statusCode, payload) {
  const isDev = process.env.NODE_ENV === 'development';
  const isObjectPayload = payload !== null && typeof payload === 'object';

  if (
    isObjectPayload &&
    Object.prototype.hasOwnProperty.call(payload, 'data') &&
    Object.prototype.hasOwnProperty.call(payload, 'meta') &&
    Object.prototype.hasOwnProperty.call(payload, 'error')
  ) {
    return payload;
  }

  if (statusCode < 400) {
    const data =
      isObjectPayload && Object.prototype.hasOwnProperty.call(payload, 'data')
        ? payload.data
        : payload;
    return responseHelper.success(data);
  }

  const payloadError =
    isObjectPayload && Object.prototype.hasOwnProperty.call(payload, 'error')
      ? payload.error
      : null;

  let message = 'Internal server error';
  if (typeof payloadError === 'string') {
    message = payloadError;
  } else if (payloadError && typeof payloadError.message === 'string') {
    message = payloadError.message;
  } else if (isObjectPayload && typeof payload.message === 'string') {
    message = payload.message;
  }

  if (statusCode >= 500 && !isDev) {
    message = 'Internal server error';
  }

  const details = isDev
    ? (payloadError && payloadError.stack) ||
      (payloadError && payloadError.details) ||
      (isObjectPayload && payload.stack) ||
      (isObjectPayload && payload.message) ||
      message
    : null;

  return responseHelper.error(message, getErrorCode(statusCode), details);
}

/**
 * Creates app instance that always returns standardized response envelopes.
 *
 * @returns {import('express').Express} Standardized app instance.
 */
function createStandardizedApp() {
  const standardizedApp = express();
  const rawApp = createApp();

  standardizedApp.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    /**
     * Wraps outgoing JSON payloads in the standard response envelope.
     *
     * @param {unknown} payload - Outgoing JSON payload.
     * @returns {import('express').Response} Express response.
     */
    res.json = function sendEnvelopedJson(payload) {
      const envelope = toStandardEnvelope(res.statusCode, payload);
      return originalJson(envelope);
    };
    next();
  });

  standardizedApp.use(rawApp);
  return standardizedApp;
}

const app = createStandardizedApp();

module.exports = app;
module.exports.createApp = createApp;
module.exports.createStandardizedApp = createStandardizedApp;
module.exports.handleCorsError = handleCorsError;
module.exports.handleInternalError = handleInternalError;
