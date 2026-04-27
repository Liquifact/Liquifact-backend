'use strict';

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const config = require('./config');
// Fail-fast boot validation
if (process.env.NODE_ENV !== 'test') {
  config.validate();
}

const { createSecurityMiddleware } = require('./middleware/security');
const { createCorsOptions } = require('./config/cors');
const { correlationIdMiddleware } = require('./middleware/correlationId');
const {
  jsonBodyLimit,
  urlencodedBodyLimit,
  payloadTooLargeHandler,
} = require('./middleware/bodySizeLimits');
const { auditMiddleware } = require('./middleware/audit');
const { auditLogMiddleware } = require('./middleware/auditLog');
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');
const { extractTenant } = require('./middleware/tenant');
const smeRouter = require('./routes/sme');
const errorHandler = require('./middleware/errorHandler');
const { callSorobanContract } = require('./services/soroban');
const { performHealthChecks } = require('./services/health');
const invoiceService = require('./services/invoiceService');
const AppError = require('./errors/AppError');
const logger = require('./logger');
const requestId = require('./middleware/requestId');
const pinoHttp = require('pino-http');
const investRoutes = require('./routes/invest');
const invoiceRoutes = require('./routes/invoiceRoutes');
const invoiceFileRouter = require('./routes/invoiceFile');
/**
 * Combined authentication middleware: allows JWT or API key for admin/service auth.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Next middleware.
 */
function adminAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return apiKeyAuth(req, res, next);
  } else {
    return authenticateToken(req, res, next);
  }
}

// /**
//  * Create the Express application instance.
//  *
//  * @param {object} [options={}] - App options.
//  * @param {boolean} [options.enableTestRoutes=false] - Whether to expose test-only routes.
//  * @returns {import('express').Express}
//  */
// function createApp(options = {}) {
//   const { enableTestRoutes = false } = options;
//   const app = express();

//   app.use(requestId);
//   app.use(pinoHttp({
//     logger,
//     genReqId: (req) => req.id,
//     customLogLevel: (req, res, err) => {
//       if (res.statusCode >= 500 || err) return 'error';
//       if (res.statusCode >= 400) return 'warn';
//       return 'info';
//     },
//     serializers: {
//       req: (req) => ({
//         id: req.id,
//         method: req.method,
//         url: req.url,
//         query: req.query,
//         headers: {
//           'x-tenant-id': req.headers['x-tenant-id'],
//           'user-agent': req.headers['user-agent'],
//         },
//       }),
//     },
//   }));

//   app.use(createSecurityMiddleware());
//   app.use(correlationIdMiddleware);
//   app.use(cors(createCorsOptions()));
//   app.use(jsonBodyLimit());
//   app.use(urlencodedBodyLimit());
//   app.use(globalLimiter);
//   app.use(auditMiddleware);

//   app.use('/api/sme', smeRouter);

//   app.get('/health', (req, res) => {
//     return res.json({
//       status: 'ok',
//       service: 'liquifact-api',
//       version: '0.1.0',
//       timestamp: new Date().toISOString(),
//     });
//   });

//   app.get('/api', (req, res) => {
//     return res.json({
//       name: 'LiquiFact API',
//       description: 'Global Invoice Liquidity Network on Stellar',
//       endpoints: {
//         health: 'GET /health',
//         invoices: 'GET/POST /api/invoices',
//         escrow: 'GET/POST /api/escrow',
//       },
//     });
//   });

//   app.use('/api/invest', investRoutes);

//   app.get('/api/invoices', (req, res) => {
//     const includeDeleted = req.query.includeDeleted === 'true';
//     const filteredInvoices = includeDeleted
//       ? invoices
//       : invoices.filter((inv) => !inv.deletedAt);

//     return res.json({
//       data: filteredInvoices,
//       message: includeDeleted ? 'Showing all invoices (including deleted).' : 'Showing active invoices.',
//     });
//   });

//   app.post('/api/invoices', adminAuth, sensitiveLimiter, (req, res) => {
//     const { amount, customer } = req.body;

//     if (!amount || !customer) {
//       return res.status(400).json({ error: 'Amount and customer are required' });
//     }

//     const newInvoice = {
//       id: `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
//       amount,
//       customer,
//       status: 'pending_verification',
//       createdAt: new Date().toISOString(),
//       deletedAt: null,
//     };

//     invoices.push(newInvoice);

//     return res.status(201).json({
//       data: newInvoice,
//       message: 'Invoice uploaded successfully.',
//     });
//   });

//   app.delete('/api/invoices/:id', adminAuth, (req, res) => {
//     const { id } = req.params;
//     const invoiceIndex = invoices.findIndex((inv) => inv.id === id);

//     if (invoiceIndex === -1) {
//       return res.status(404).json({ error: 'Invoice not found' });
//     }

     
//     if (invoices[invoiceIndex].deletedAt) {
//       return res.status(400).json({ error: 'Invoice is already deleted' });
//     }

     
//     invoices[invoiceIndex].deletedAt = new Date().toISOString();

//     return res.json({
//       message: 'Invoice soft-deleted successfully.',
       
//       data: invoices[invoiceIndex],
//     });
//   });

//   app.patch('/api/invoices/:id/restore', adminAuth, (req, res) => {
//     const { id } = req.params;
//     const invoiceIndex = invoices.findIndex((inv) => inv.id === id);

//     if (invoiceIndex === -1) {
//       return res.status(404).json({ error: 'Invoice not found' });
//     }

     
//     if (!invoices[invoiceIndex].deletedAt) {
//       return res.status(400).json({ error: 'Invoice is not deleted' });
//     }

     
//     invoices[invoiceIndex].deletedAt = null;

//     return res.status(200).json({
//       message: 'Invoice restored successfully.',
       
//       data: invoices[invoiceIndex],
//     });
//   });

//   app.get('/api/escrow/:invoiceId', authenticateToken, async (req, res) => {
//     const { invoiceId } = req.params;

//     try {
//       /**
//        * Simulates a Soroban operation for escrow lookup.
//        *
//        * @returns {Promise<object>} Placeholder escrow state.
//        */
//       const operation = async () => {
//         return { invoiceId, status: 'not_found', fundedAmount: 0 };
//       };

//       const data = await callSorobanContract(operation);
//       return res.json({
//         data,
//         message: 'Escrow state read from Soroban contract via robust integration wrapper.',
//       });
//     } catch (error) {
//       return res.status(500).json({ error: error.message || 'Error fetching escrow state' });
//     }
//   });

//   app.post('/api/escrow', authenticateToken, sensitiveLimiter, (req, res) => {
//     return res.json({
//       data: { status: 'funded' },
//       message: 'Escrow operation simulated.',
//     });
//   });

//   app.get('/error-test-trigger', (req, res, next) => {
//     next(new Error('Simulated server error'));
//   });

//   if (enableTestRoutes) {
//     app.get('/__test__/forbidden', (_req, _res) => {
//       throw new AppError({
//         type: 'https://liquifact.com/probs/forbidden',
//         title: 'Forbidden',
//         status: 403,
//         detail: 'Forbidden test route',
//       });
//     });

//     app.get('/__test__/upstream', (_req, _res) => {
//       const error = new Error('connection refused');
//       error.code = 'ECONNREFUSED';
//       throw error;
//     });

//     app.get('/__test__/explode', (_req, _res) => {
//       throw new Error('Sensitive stack detail should not leak');
//     });

//     app.get('/__test__/throw-string', (_req, _res) => {
//       throw 'boom';
//     });
//   }

//   app.use(payloadTooLargeHandler);

//   app.use((req, res, next) => {
//     next(
//       new AppError({
//         type: 'https://liquifact.com/probs/not-found',
//         title: 'Resource Not Found',
//         status: 404,
//         detail: `The path ${req.path} does not exist.`,
//         instance: req.originalUrl,
//       })
//     );
//   });

//   // RFC 7807 error handler — handles AppError + generic errors.
//   app.use(errorHandler);

//   return app;
// }

// const app = createApp({ enableTestRoutes: process.env.NODE_ENV === 'test' });

// // ─── Server lifecycle ─────────────────────────────────────────────────────────

// /**
//  * Starts the HTTP server.
//  *
//  * @returns {import('http').Server}
//  */
// const startServer = () => {
//   const server = app.listen(PORT, () => {
//     logger.warn(`LiquiFact API running at http://localhost:${PORT}`);
//   });
//   return server;
// };

// /**
//  * Resets the in-memory invoice collection for tests.
//  *
//  * @returns {void}
//  */
// function resetStore() {
//   invoices.length = 0;
// }

// if (process.env.NODE_ENV !== 'test') {
//   startServer();
// }

// module.exports = app;
// module.exports.createApp = createApp;
// module.exports.startServer = startServer;
// module.exports.resetStore = resetStore;
'use strict';

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const config = require('./config');
// Fail-fast boot validation
if (process.env.NODE_ENV !== 'test') {
  config.validate();
}

const { createSecurityMiddleware } = require('./middleware/security');
const { createCorsOptions } = require('./config/cors');
const { correlationIdMiddleware } = require('./middleware/correlationId');
const {
  jsonBodyLimit,
  urlencodedBodyLimit,
  payloadTooLargeHandler,
} = require('./middleware/bodySizeLimits');
const { auditMiddleware } = require('./middleware/audit');
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');
const { apiKeyAuth } = require('./middleware/apiKey');
const smeRouter = require('./routes/sme');
const { problemJsonHandler, notFoundHandler } = require('./middleware/problemJson');
const { callSorobanContract } = require('./services/soroban');
const { performHealthChecks } = require('./services/health');
const { resolveEscrowAddress, validateMappingConfig } = require('./config/escrowMap');
const AppError = require('./errors/AppError');
const logger = require('./logger');
const sentry = require('./observability/sentry');
const requestId = require('./middleware/requestId');
const pinoHttp = require('pino-http');
const investRoutes = require('./routes/invest');
const invoiceFileRouter = require('./routes/invoiceFile');
const investorRoutes = require('./routes/investor');

const PORT = process.env.PORT || 3001;

// In-memory storage for escrow (database migration pending)
const escrowSummaryCache = createRedisEscrowSummaryCache();
// In-memory storage
let invoices = [];

function parseLedgerSequence(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function createApp(options = {}) {
  const { enableTestRoutes = false } = options;

  const app = express();

  // ✅ 1. Request ID
  app.use(requestId);

  // ✅ 2. Logging
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customLogLevel: (req, res, err) => {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          query: req.query,
          headers: {
            'x-tenant-id': req.headers['x-tenant-id'],
            'user-agent': req.headers['user-agent'],
          },
        }),
      },
    })
  );

  // ✅ 3. Correlation ID
  app.use(correlationIdMiddleware);

  // ✅ 4. SECURITY (Helmet)
  app.use(createSecurityMiddleware());

  // ✅ 5. CORS
  app.use(cors(createCorsOptions()));

  // ✅ 6. Body parsing
  app.use(jsonBodyLimit());
  app.use(urlencodedBodyLimit());

  // ✅ 7. Rate limit + audit
  app.use(globalLimiter);
  app.use(auditLogMiddleware);
  app.use(auditMiddleware);

  // ───────── ROUTES ─────────

  app.use('/api/sme', smeRouter);
  app.use('/api/invest', investRoutes);
  app.use('/api/investor', investorRoutes);
  app.use('/api/invoices', invoiceFileRouter);
  app.use('/api/retention', retentionRoutes);

  app.get('/health', async (req, res) => {
    const health = await performHealthChecks();
    const status = health.healthy ? 200 : 503;
    res.status(status).json({
      status: health.healthy ? 'ok' : 'error',
      service: 'liquifact-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      checks: health.checks,
    });
  });

  // OpenAPI routes
  app.get('/openapi.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({
      openapi: '3.0.0',
      info: { title: 'LiquiFact API', version: '1.0.0', description: 'Global Invoice Liquidity Network on Stellar' },
      servers: [{ url: '/v1' }, { url: '/' }],
      components: {
        schemas: {
          Invoice: { type: 'object', properties: { id: { type: 'string' }, amount: { type: 'number' } } },
          EscrowState: { type: 'object', properties: { invoiceId: { type: 'string' }, status: { type: 'string' }, legal_hold: { type: 'boolean' } } },
        },
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      paths: {
        '/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
        '/api': { get: { summary: 'API info', responses: { '200': { description: 'OK' } } } },
        '/api/invoices': { get: { summary: 'List invoices', responses: { '200': { description: 'OK' } } }, post: { summary: 'Create invoice', security: [{ bearerAuth: [] }], responses: { '201': { description: 'Created' } } } },
        '/api/invoices/{id}': { delete: { summary: 'Delete invoice', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } }, patch: { summary: 'Restore invoice', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } },
        '/api/escrow/{invoiceId}': { get: { summary: 'Get escrow state', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } },
        '/api/escrow': { post: { summary: 'Fund escrow', security: [{ bearerAuth: [] }], responses: { '202': { description: 'Accepted' } } } },
        '/api/invest/opportunities': { get: { summary: 'Investment opportunities', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } },
        '/api/sme/metrics': { get: { summary: 'SME metrics', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } },
      },
    });
  });

  app.get('/docs', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><title>LiquiFact API Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css">
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });</script>
</body></html>`);
  });

  /**
   * @swagger
   * /api:
   *   get:
   *     summary: API information
   *     description: Returns basic information about the API
   *     tags: [Info]
   *     responses:
   *       200:
   *         description: API information
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 name:
   *                   type: string
   *                 description:
   *                   type: string
   *                 endpoints:
   *                   type: object
   */
  app.get('/api', (req, res) => {
    res.json({
      name: 'LiquiFact API',
      description: 'Global Invoice Liquidity Network on Stellar',
      endpoints: {
        health: 'GET /health',
        invoices: 'GET/POST /api/invoices',
        escrow: 'GET/POST /v1/escrow',
      },
    });
  });

  app.use('/api/invest', investRoutes);
  app.use('/api/invoices', invoiceFileRouter);

  app.get('/api/invoices', authenticateToken, extractTenant, async (req, res) => {
    try {
      const { status } = req.query;
      const invoices = await invoiceService.getInvoices(req.tenantId, status);
      return res.json({
        data: invoices,
        message: status ? `Showing invoices with status: ${status}` : 'Showing all invoices',
      });
    } catch (error) {
      logger.error('Error fetching invoices:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post(
    '/api/invoices',
    authenticateToken,
    extractTenant,
    sensitiveLimiter,
    async (req, res) => {
      try {
        const { amount, customer, metadata } = req.body;

        if (!amount || !customer) {
          return res
            .status(400)
            .json({ error: 'Amount and customer are required' });
        }

        const newInvoice = await invoiceService.createInvoice(
          { amount, customer, metadata },
          req.tenantId
        );

        res.status(201).json({
          data: newInvoice,
          message: 'Invoice created successfully.',
        });
      } catch (error) {
        logger.error('Error creating invoice:', error);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  /**
   * @swagger
   * /api/invoices/{id}:
   *   get:
   *     summary: Get a single invoice
   *     description: Retrieve a single invoice by its ID
   *     tags: [Invoices]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Invoice ID
   *     responses:
   *       200:
   *         description: Invoice retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   $ref: '#/components/schemas/Invoice'
   *                 message:
   *                   type: string
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden - not the owner
   *       404:
   *         description: Invoice not found
   */
  app.get('/api/invoices/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id || req.user?.sub || req.headers['x-user-id']; // Placeholder for auth

    // Basic validation
    if (!id || id.trim() === '') {
      return res.status(400).json({ error: 'Bad Request', message: 'Missing or invalid invoice ID' });
  // Invoice routes (standard API)
  app.get('/api/invoices', validateQuery(paginationQuerySchema), (req, res) => {
    const includeDeleted = req.query.includeDeleted === 'true';
    const filtered = includeDeleted
      ? invoices
      : invoices.filter((inv) => !inv.deletedAt);

    const q = req.validatedQuery || {};
    const page = q.page || 1;
    const limit = q.limit || 20;

    res.json({
      data: filtered,
      pagination: {
        page,
        limit,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / limit),
      },
      message: includeDeleted
        ? 'Showing all invoices (including deleted).'
        : 'Showing active invoices.',
    });
  });

  app.post(
    '/api/invoices',
    authenticateToken,
    sensitiveLimiter,
    (req, res) => {
      const { amount, customer } = req.body;

      if (!amount || !customer) {
        throw new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'Amount and customer are required fields',
          instance: req.originalUrl,
        });
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

      res.status(201).json({
        data: newInvoice,
        message: 'Invoice uploaded successfully.',
      });
    }
  );

  /**
   * @swagger
   * /api/invoices/{id}:
   *   get:
   *     summary: Get a single invoice
   *     description: Retrieve a single invoice by its ID
   *     tags: [Invoices]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Invoice ID
   *     responses:
   *       200:
   *         description: Invoice retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   $ref: '#/components/schemas/Invoice'
   *                 message:
   *                   type: string
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden - not the owner
   *       404:
   *         description: Invoice not found
   */
  app.get('/api/invoices/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id || req.user?.sub || req.headers['x-user-id']; // Placeholder for auth

    // Basic validation
    if (!id || id.trim() === '') {
      throw new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Missing or invalid invoice ID',
        instance: req.originalUrl,
      });
    }

    // Find invoice
    const invoice = invoices.find((inv) => inv.id === id);

    if (!invoice) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Invoice Not Found',
        status: 404,
        detail: `Invoice with ID '${id}' not found`,
        instance: req.originalUrl,
      });
    }

    // Check if deleted
    if (invoice.deletedAt) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Invoice Not Found',
        status: 404,
        detail: `Invoice with ID '${id}' not found`,
        instance: req.originalUrl,
      });
    }

    // Authorization check (placeholder)
    // In real app, check if user owns the invoice
    // For now, allow all authenticated users

    return res.json({
      data: invoice,
      message: 'Invoice retrieved successfully',
    });
  });

  /**
   * @swagger
   * /api/invoices/{id}:
   *   delete:
   *     summary: Soft delete an invoice
   *     description: Mark an invoice as deleted (soft delete)
   *     tags: [Invoices]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Invoice ID
   *     responses:
   *       200:
   *         description: Invoice soft-deleted successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 data:
   *                   $ref: '#/components/schemas/Invoice'
   *       400:
   *         description: Invoice is already deleted
   *       404:
   *         description: Invoice not found
   *       401:
   *         description: Unauthorized
   */
  app.delete('/api/invoices/:id', authenticateToken, (req, res) => {
    const invoice = invoices.find((inv) => inv.id === req.params.id);

    if (!invoice) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Invoice Not Found',
        status: 404,
        detail: `Invoice with ID '${req.params.id}' not found`,
        instance: req.originalUrl,
      });
    }

    if (invoice.deletedAt) {
      throw new AppError({
        type: 'https://liquifact.com/probs/conflict',
        title: 'Conflict',
        status: 400,
        detail: 'Invoice is already deleted',
        instance: req.originalUrl,
      });
    }

    invoice.deletedAt = new Date().toISOString();

    res.json({
      message: 'Invoice soft-deleted successfully.',
      data: invoice,
    });
  });

  app.patch(
    '/api/invoices/:id/restore',
    authenticateToken,
    (req, res) => {
      const invoice = invoices.find((inv) => inv.id === req.params.id);

      if (!invoice) {
        throw new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Invoice Not Found',
          status: 404,
          detail: `Invoice with ID '${req.params.id}' not found`,
          instance: req.originalUrl,
        });
      }

      if (!invoice.deletedAt) {
        throw new AppError({
          type: 'https://liquifact.com/probs/conflict',
          title: 'Conflict',
          status: 400,
          detail: 'Invoice is not deleted',
          instance: req.originalUrl,
        });
      }

      invoice.deletedAt = null;

      return res.status(200).json({
        message: 'Invoice restored successfully.',
        data: invoice,
      });
    }
  );

  /**
   * @swagger
   * /api/escrow/{invoiceId}:
   *   get:
   *     summary: Get escrow state for an invoice
   *     description: Retrieve the escrow state from the Soroban contract for a specific invoice
   *     tags: [Escrow]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: invoiceId
   *         required: true
   *         schema:
   *           type: string
   *         description: Invoice ID
   *     responses:
   *       200:
   *         description: Escrow state retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   $ref: '#/components/schemas/EscrowState'
   *                 message:
   *                   type: string
   *       401:
   *         description: Unauthorized
   *       500:
   *         description: Error fetching escrow state
   */
  app.get('/api/escrow/:invoiceId', authenticateToken, async (req, res) => {
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
    return res.status(201).json({ data: newInvoice, message: 'Invoice uploaded successfully.' });
  });

  app.delete('/api/invoices/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const idx = invoices.findIndex((inv) => inv.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (invoices[idx].deletedAt) {
      return res.status(400).json({ error: 'Invoice is already deleted' });
    }
    invoices[idx].deletedAt = new Date().toISOString();
    return res.json({ message: 'Invoice soft-deleted successfully.', data: invoices[idx] });
  });

  app.patch('/api/invoices/:id/restore', authenticateToken, (req, res) => {
    const { id } = req.params;
    const idx = invoices.findIndex((inv) => inv.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (!invoices[idx].deletedAt) {
      return res.status(400).json({ error: 'Invoice is not deleted' });
    }
    invoices[idx].deletedAt = null;
    return res.status(200).json({ message: 'Invoice restored successfully.', data: invoices[idx] });
  });

  // V1 API Namespace
  const v1Router = express.Router();

  // Escrow read — uses readEscrowState with legal_hold
  v1Router.get('/escrow/:invoiceId', authenticateToken, async (req, res, next) => {
    const { invoiceId } = req.params;
    try {
      // Resolve escrow contract address using the mapping system
      const escrowAddress = resolveEscrowAddress(invoiceId);
      
      if (!escrowAddress) {
        throw new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Escrow Not Found',
          status: 404,
          detail: `No escrow contract mapping found for invoice ID '${invoiceId}'`,
          instance: req.originalUrl,
        });
      }

      if (escrowSummaryCache) {
        const cached = await escrowSummaryCache.getSummary(invoiceId, currentLedger);
        if (cached.hit) {
          res.set('X-Cache', 'HIT');
          res.set('X-Escrow-Address', escrowAddress);
          return res.json({
            data: {
              ...cached.value,
              escrowAddress,
            },
            message: 'Escrow summary served from Redis cache.',
          });
        }
      }

      /**
       * Soroban operation for escrow lookup using resolved contract address.
       *
       * @returns {Promise<object>} Escrow state with contract address.
       */
      const operation = async () => {
        return {
          invoiceId,
          escrowAddress,
          status: 'not_found',
          fundedAmount: 0,
          ledgerSequence: currentLedger,
        };
      };

      const data = await callSorobanContract(operation);
      if (escrowSummaryCache) {
        await escrowSummaryCache.setSummary(invoiceId, data, currentLedger);
      }
      res.set('X-Cache', 'MISS');
      res.set('X-Escrow-Address', escrowAddress);
      const operation = async () => ({
        invoiceId,
        status: 'not_found',
        fundedAmount: 0,
        ledgerSequence: currentLedger,
      });

      const data = await callSorobanContract(operation);
      return res.json({
        data,
        message: 'Escrow state read from Soroban contract (mocked).',
      });
    } catch (error) {
      throw new AppError({
        type: 'https://liquifact.com/probs/service-unavailable',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Error fetching escrow state',
        instance: req.originalUrl,
      });
    }
  });
      return res.status(500).json({ error: error.message || 'Error fetching escrow state' });
    }
  });

  // POST /v1/escrow — funding intent (202)
  v1Router.post('/escrow', authenticateToken, sensitiveLimiter, async (req, res, next) => {
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    try {
      const result = await submitEscrowFunding(req.body, {
        env: process.env,
        idempotencyKey,
        userId: req.user && req.user.id,
        now: new Date(),
      });
      return res.status(202).json({
        data: result,
        message: 'Escrow funding transaction prepared; no live transaction was signed or submitted.',
      });
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({
          error: {
            code: err.code || 'VALIDATION_ERROR',
            message: err.detail || err.message,
            retryable: false,
            retry_hint: 'Fix the escrow funding payload and try again.',
          },
        });
      }
      return next(err);
    }
  });

  // POST /v1/escrow/:invoiceId/fund — legal-hold gated funding
  v1Router.post('/escrow/:invoiceId/fund', authenticateToken, legalHoldGate(), async (req, res) => {
    return res.json({
      data: { status: 'funded' },
      message: 'Escrow funded.',
    });
  });

  // Versioned routes
  app.use('/v1', v1Router);

// if (enableTestRoutes) {
//   app.get('/__test__/explode', () => {
//     throw new Error('Test error');
//   });
// }
if (enableTestRoutes) {
  // Auth test route
  app.get('/__test__/auth', authenticateToken, (req, res) => {
    res.json({ ok: true });
  });
  // Backward compatibility for /api/escrow
  app.get('/api/escrow/:invoiceId', (req, res, next) => {
    res.set('Warning', '299 - "This endpoint is deprecated. Use /v1/escrow instead."');
    next();
  }, v1Router.stack.find(s => s.route && s.route.path === '/escrow/:invoiceId').handle);

  app.post('/api/escrow/:invoiceId/fund', (req, res, next) => {
    next();
  }, v1Router.stack.find(s => s.route && s.route.path === '/escrow/:invoiceId/fund').handle);

  // Legacy POST /api/escrow — gates on body.invoiceId if present
  app.post('/api/escrow', authenticateToken, sensitiveLimiter, async (req, res, next) => {
    res.set('Warning', '299 - "This endpoint is deprecated. Use /v1/escrow instead."');
    const body = req.body || {};
    const invoiceId = body.invoiceId;

    // If full funding payload (has funderPublicKey), delegate to submitEscrowFunding
    if (body.funderPublicKey) {
      const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
      try {
        const result = await submitEscrowFunding(body, {
          env: process.env,
          idempotencyKey,
          userId: req.user && req.user.id,
          now: new Date(),
        });
        return res.status(202).json({
          data: result,
          message: 'Escrow funding transaction prepared; no live transaction was signed or submitted.',
        });
      } catch (err) {
        if (err.status === 400) {
          return res.status(400).json({
            error: {
              code: err.code || 'VALIDATION_ERROR',
              message: err.detail || err.message,
              retryable: false,
              retry_hint: 'Fix the escrow funding payload and try again.',
            },
          });
        }
        return next(err);
      }
    }

    // Simple payload — gate on legal hold if invoiceId present
    if (invoiceId) {
      // Validate invoiceId format
      const INVOICE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
      if (!INVOICE_ID_RE.test(invoiceId)) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'invoiceId contains unsupported characters.',
            retryable: false,
            retry_hint: 'Fix the escrow funding payload and try again.',
          },
        });
      }
      try {
        const held = await fetchLegalHold(invoiceId);
        if (held) {
          return res.status(502).json({ error: 'Escrow is under legal hold' });
        }
      } catch (err) {
        return next(err);
      }
    }

    return res.json({
      data: { status: 'funded' },
      message: 'Escrow operation simulated.',
    });
  });

  // Error test trigger
  app.get('/error-test-trigger', (req, res, next) => {
    next(new Error('Simulated server error'));
  });


  if (enableTestRoutes) {
    // Auth test route
    app.get('/__test__/auth', authenticateToken, (req, res) => {
      res.json({ ok: true });
    });

    // Rate limit test route
    app.get('/__test__/rate-limited', authenticateToken, sensitiveLimiter, (req, res) => {
      res.json({ ok: true });
    });

    // Existing test route
    app.get('/__test__/explode', () => {
      throw new Error('Test error');
    });
  }

  // Existing test route
  app.get('/__test__/explode', () => {
    throw new Error('Test error');
  });
}

  // ───────── ERRORS ─────────

  app.use(payloadTooLargeHandler);

  app.use((req, res, next) => {
    next(
      new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Resource Not Found',
        status: 404,
        detail: `Path ${req.path} not found`,
      })
    );
  });

  app.use(problemJsonHandler);

  return app;
}

const appInstance = createApp({
  enableTestRoutes: process.env.NODE_ENV === 'test',
});

function startServer() {
  return appInstance.listen(PORT, () => {
    logger.warn(`API running at http://localhost:${PORT}`);
  });
}

function resetStore() {
  invoices.length = 0;
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

module.exports = appInstance;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
module.exports.resetStore = resetStore;