'use strict';

const config = require('./config');

const Invoice = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'INV_0001' },
    sme: { type: 'string', example: 'Acme Components Ltd' },
    smeAddress: { type: 'string', nullable: true },
    debtor: { type: 'string', example: 'Globex Retail' },
    amount: { type: 'number', example: 25000 },
    currency: { type: 'string', example: 'USDC' },
    fundedAmount: { type: 'number', example: 0 },
    yieldBps: { type: 'integer', example: 800 },
    dueDate: { type: 'string', format: 'date' },
    status: { type: 'string', enum: ['open', 'funded', 'settled', 'cancelled'] },
    onChain: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const Health = {
  type: 'object',
  properties: {
    status: { type: 'string', example: 'ok' },
    service: { type: 'string' },
    version: { type: 'string' },
    uptimeSeconds: { type: 'integer' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const checkError = { type: 'string', enum: ['TIMEOUT', 'PASSPHRASE_MISMATCH', 'STALE_LEDGER', 'CONTRACT_NOT_FOUND', 'RPC_ERROR'] };
const Readiness = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    checks: {
      type: 'object',
      properties: {
        rpc: { type: 'object', properties: { ok: { type: 'boolean' }, latencyMs: { type: 'integer' }, error: checkError } },
        network: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, expected: { type: 'string' }, actual: { type: 'string', nullable: true }, error: checkError },
        },
        ledger: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, sequence: { type: 'integer' }, ageSeconds: { type: 'integer' }, error: checkError },
        },
        contract: { type: 'object', properties: { ok: { type: 'boolean' }, error: checkError } },
      },
    },
  },
};

const json = (schema) => ({ content: { 'application/json': { schema } } });
const ErrorBody = { type: 'object', properties: { error: { type: 'string' } } };

/**
 * Builds the OpenAPI document for the given public base URL.
 *
 * @param {string} baseUrl server URL to advertise
 * @returns {object} OpenAPI 3.0 document
 */
function buildSpec(baseUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'LiquiFact API',
      version: config.version,
      description:
        'Invoice liquidity network on Stellar. SMEs tokenize invoices, investors fund them, and a Soroban escrow ' +
        `contract holds funds until settlement. Escrow contract (testnet): ${config.contractId}`,
    },
    servers: [{ url: baseUrl }],
    tags: [{ name: 'System' }, { name: 'Invoices' }, { name: 'Escrow' }],
    components: { schemas: { Health, Readiness } },
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Liveness probe',
          responses: { 200: { description: 'Service is up', ...json({ $ref: '#/components/schemas/Health' }) } },
        },
      },
      '/ready': {
        get: {
          tags: ['System'],
          summary: 'Readiness probe: Soroban RPC health, network passphrase, ledger freshness, contract existence',
          responses: {
            200: { description: 'All checks passed', ...json({ $ref: '#/components/schemas/Readiness' }) },
            503: {
              description: 'At least one check failed (error codes: TIMEOUT, PASSPHRASE_MISMATCH, STALE_LEDGER, CONTRACT_NOT_FOUND, RPC_ERROR)',
              ...json({ $ref: '#/components/schemas/Readiness' }),
            },
          },
        },
      },
      '/api/stats': {
        get: { tags: ['System'], summary: 'Marketplace totals', responses: { 200: { description: 'Totals' } } },
      },
      '/api/invoices': {
        get: {
          tags: ['Invoices'],
          summary: 'List invoices',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'funded', 'settled', 'cancelled'] } },
          ],
          responses: {
            200: { description: 'Invoices', ...json({ type: 'object', properties: { data: { type: 'array', items: Invoice }, count: { type: 'integer' } } }) },
            400: { description: 'Invalid filter', ...json(ErrorBody) },
          },
        },
        post: {
          tags: ['Invoices'],
          summary: 'Submit an invoice for financing',
          requestBody: {
            required: true,
            ...json({
              type: 'object',
              required: ['sme', 'debtor', 'amount', 'dueDate'],
              properties: {
                sme: { type: 'string' },
                debtor: { type: 'string' },
                amount: { type: 'number' },
                currency: { type: 'string', default: 'USDC' },
                yieldBps: { type: 'integer', default: 800 },
                dueDate: { type: 'string', format: 'date' },
                smeAddress: { type: 'string' },
              },
            }),
          },
          responses: {
            201: { description: 'Created', ...json({ type: 'object', properties: { data: Invoice } }) },
            400: { description: 'Validation failed', ...json(ErrorBody) },
          },
        },
      },
      '/api/invoices/{id}': {
        get: {
          tags: ['Invoices'],
          summary: 'Get an invoice',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Invoice', ...json({ type: 'object', properties: { data: Invoice } }) },
            404: { description: 'Not found', ...json(ErrorBody) },
          },
        },
      },
      '/api/invoices/{id}/fund': {
        post: {
          tags: ['Invoices'],
          summary: 'Record an investor contribution (demo, off-chain)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, ...json({ type: 'object', properties: { amount: { type: 'number' } } }) },
          responses: {
            200: { description: 'Updated invoice' },
            400: { description: 'Invalid amount' },
            404: { description: 'Not found' },
            409: { description: 'Invoice not open' },
          },
        },
      },
      '/api/escrow': {
        get: { tags: ['Escrow'], summary: 'Deployed escrow contract metadata', responses: { 200: { description: 'Contract info' } } },
      },
      '/api/escrow/live': {
        get: {
          tags: ['Escrow'],
          summary: 'Live escrow state read from Soroban RPC (falls back to deploy snapshot)',
          responses: { 200: { description: 'Escrow state' } },
        },
      },
    },
  };
}

module.exports = { buildSpec };
