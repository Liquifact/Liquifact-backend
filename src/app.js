'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const store = require('./data/store');
const { buildSpec } = require('./openapi');
const { computeStats } = require('./services/stats');
const { mountDocs } = require('./docs');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const API_CSP = { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } };
const DOCS_CSP = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
};
const helmetOpts = (csp) => ({ contentSecurityPolicy: csp, crossOriginResourcePolicy: { policy: 'same-site' } });
const apiHelmet = helmet(helmetOpts(API_CSP));
const docsHelmet = helmet(helmetOpts(DOCS_CSP));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Permissions-Policy', 'interest-cohort=()');
  return (/^\/docs(\/|$)/.test(req.path) ? docsHelmet : apiHelmet)(req, res, next);
});
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

mountDocs(app, config);

app.get('/api/stats', (req, res) => {
  const { currency } = req.query;
  if (currency !== undefined && (typeof currency !== 'string' || !/^[a-zA-Z0-9]{1,12}$/.test(currency))) {
    return res.status(400).json({
      error: 'currency must be a 1-12 character alphanumeric asset code',
      code: 'VALIDATION_FAILED',
      details: { currency: 'Invalid asset code' },
    });
  }
  return res.json(computeStats(store.list(), currency));
});

app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/investors', require('./routes/investors'));
app.use('/api/escrow', require('./routes/escrow'));

app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path, docs: '/docs' }));

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

module.exports = app;
