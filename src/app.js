'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const store = require('./data/store');
const { buildSpec } = require('./openapi');
const { computeStats } = require('./services/stats');
const {
  ApiError,
  badRequest,
  notFound,
  internal,
  getCatalogEntry,
  ERROR_BASE_URI,
} = require('./errors');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        imgSrc: ["'self'", 'data:', 'https://unpkg.com'],
        connectSrc: ["'self'"],
      },
    },
  }),
);
app.use(cors({ origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins }));
app.use(express.json({ limit: '100kb' }));

/**
 * @param {import('express').Request} req incoming request
 * @returns {string} public base URL of this deployment
 */
function baseUrl(req) {
  return process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

const ENDPOINTS = [
  { method: 'GET', path: '/', description: 'This index' },
  { method: 'GET', path: '/health', description: 'Liveness probe' },
  { method: 'GET', path: '/docs', description: 'Interactive API docs (Swagger UI)' },
  { method: 'GET', path: '/openapi.json', description: 'OpenAPI 3 document' },
  { method: 'GET', path: '/api/stats', description: 'Marketplace totals' },
  { method: 'GET', path: '/api/invoices', description: 'List invoices (?status=open|funded|settled|cancelled)' },
  { method: 'GET', path: '/api/invoices/:id', description: 'Get one invoice' },
  { method: 'GET', path: '/api/invoices/:id/quote', description: 'Quote an investment contribution and annualised returns' },
  { method: 'POST', path: '/api/invoices', description: 'Submit an invoice for financing' },
  { method: 'POST', path: '/api/invoices/:id/fund', description: 'Record an investor contribution' },
  { method: 'GET', path: '/api/invoices/:id/contributions', description: 'List contributions for an invoice' },
  { method: 'GET', path: '/api/investors/:address/portfolio', description: 'Investor portfolio summary and expected returns' },
  { method: 'GET', path: '/api/escrow', description: 'Deployed Soroban escrow contract metadata' },
  { method: 'GET', path: '/api/escrow/live', description: 'Live escrow state from Soroban RPC' },
  { method: 'GET', path: '/api/escrow/attestations', description: 'On-chain attestation log (paginated)' },
  { method: 'POST', path: '/api/escrow/attestations/verify', description: 'Verify a document digest against on-chain attestations' },
  { method: 'GET', path: '/errors/:code', description: 'Error catalog entry by code' },
];

app.get('/', (req, res) => {
  res.json({
    name: 'LiquiFact API',
    description: 'Invoice liquidity network on Stellar',
    version: config.version,
    docs: `${baseUrl(req)}/docs`,
    openapi: `${baseUrl(req)}/openapi.json`,
    frontend: config.frontendUrl,
    contract: { id: config.contractId, network: config.network, explorer: config.explorerUrl },
    endpoints: ENDPOINTS,
  });
});

const health = (req, res) =>
  res.json({ status: 'ok', service: 'liquifact-api', version: config.version, timestamp: new Date().toISOString() });
app.get('/health', health);
app.get('/healthz', health);

app.get('/openapi.json', (req, res) => res.json(buildSpec(baseUrl(req))));

const SWAGGER = 'https://unpkg.com/swagger-ui-dist@5.17.14';
app.get('/docs', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LiquiFact API Docs</title><link rel="stylesheet" href="${SWAGGER}/swagger-ui.css">
<style>body{margin:0;background:#fafafa}.lf-bar{background:#0b1020;color:#fff;padding:14px 20px;font:600 16px system-ui}
.lf-bar a{color:#7dd3fc;margin-left:16px;font-weight:400;text-decoration:none}</style></head>
<body><div class="lf-bar">LiquiFact API<a href="/">Index</a><a href="/openapi.json">openapi.json</a>
<a href="${config.frontendUrl}">Website</a><a href="${config.explorerUrl}">Escrow contract</a></div>
<div id="swagger-ui"></div><script src="${SWAGGER}/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>`);
});
app.get('/docs/init.js', (req, res) => {
  res.type('application/javascript').send("window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'});");
});

app.get('/api/stats', (req, res) => {
  const { currency } = req.query;
  if (currency !== undefined && (typeof currency !== 'string' || !/^[a-zA-Z0-9]{1,12}$/.test(currency))) {
    throw badRequest('VALIDATION_FAILED', 'Invalid currency parameter', [{ field: 'currency', message: 'Invalid asset code' }]);
  }
  return res.json(computeStats(store.list(), currency));
});

app.get('/errors/:code', (req, res) => {
  const entry = getCatalogEntry(req.params.code);
  if (!entry) {
    throw notFound('ROUTE_NOT_FOUND', `Error code "${req.params.code}" not found in catalog`);
  }
  res.json({ code: req.params.code, ...entry, type: `${ERROR_BASE_URI}${req.params.code}` });
});

app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/investors', require('./routes/investors'));
app.use('/api/escrow', require('./routes/escrow'));

// 404 handler for unknown routes
app.use((_req, _res, _next) => {
  throw notFound('ROUTE_NOT_FOUND');
});

// Global error handler
app.use((err, req, res, _next) => {
  // Handle express.json() parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).type('application/problem+json').json(
        badRequest('MALFORMED_JSON', 'The request body contains invalid JSON').toProblem(req)
      );
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).type('application/problem+json').json(
        badRequest('PAYLOAD_TOO_LARGE', 'The request body exceeds the maximum allowed size').toProblem(req)
      );
    }
  }

  // Handle express.json() limit error (sent as a different error type)
  if (err.type === 'entity.too.large') {
    return res.status(413).type('application/problem+json').json(
      badRequest('PAYLOAD_TOO_LARGE', 'The request body exceeds the maximum allowed size').toProblem(req)
    );
  }

  // Handle unsupported media type
  if (err.type === 'entity.unsupported') {
    return res.status(415).type('application/problem+json').json(
      badRequest('UNSUPPORTED_MEDIA_TYPE', 'The request Content-Type is not supported. Use application/json').toProblem(req)
    );
  }

  // Handle ApiError instances
  if (err instanceof ApiError) {
    return res.status(err.status).type('application/problem+json').json(err.toProblem(req));
  }

  // Handle errors with status property (from routes that haven't been migrated yet)
  const status = err.status || err.statusCode || 500;
  if (status !== 500) {
    // For non-500 errors, use the error message but don't leak internals
    const error = new ApiError(status, 'UNKNOWN_ERROR', 'Request Failed', { detail: err.message });
    return res.status(status).type('application/problem+json').json(error.toProblem(req));
  }

  // 500 errors: log stack server-side only, return generic message
  console.error('Unhandled error:', err);
  const error = internal('An unexpected error occurred');
  return res.status(500).type('application/problem+json').json(error.toProblem(req));
});

module.exports = app;