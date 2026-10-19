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
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Liveness probe',
          responses: { 200: { description: 'Service is up', ...json({ type: 'object' }) } },
        },
      },
      '/api/stats': {
        get: {
          tags: ['System'],
          summary: 'Marketplace statistics grouped by asset (no FX conversion)',
          parameters: [{ name: 'currency', in: 'query', schema: { type: 'string', pattern: '^[a-zA-Z0-9]{1,12}$' }, description: 'Exact asset code; an unknown valid code returns empty statistics. Repeated values are rejected.' }],
          responses: {
            200: {
              description: 'Statistics for the selected currency, or all currencies',
              ...json({
                type: 'object',
                required: ['invoices', 'open', 'byStatus', 'byCurrency', 'generatedAt', 'deprecated'],
                properties: {
                  invoices: { type: 'integer', minimum: 0 },
                  open: { type: 'integer', minimum: 0 },
                  byStatus: {
                    type: 'object',
                    required: ['open', 'funded', 'settled', 'cancelled'],
                    properties: Object.fromEntries(['open', 'funded', 'settled', 'cancelled'].map((key) => [key, { type: 'integer', minimum: 0 }])),
                  },
                  byCurrency: {
                    type: 'object',
                    additionalProperties: {
                      type: 'object',
                      required: ['invoices', 'faceValue', 'funded', 'outstanding', 'weightedYieldBps'],
                      properties: {
                        invoices: { type: 'integer', minimum: 0, description: 'Includes cancelled invoices in this currency' },
                        faceValue: { type: 'string', pattern: '^\\d+(\\.\\d+)?$', description: 'Non-cancelled principal, as a decimal string' },
                        funded: { type: 'string', pattern: '^\\d+(\\.\\d+)?$', description: 'Non-cancelled funded principal' },
                        outstanding: { type: 'string', pattern: '^\\d+(\\.\\d+)?$', description: 'Funded principal of invoices currently in funded status' },
                        weightedYieldBps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Principal-weighted, rounded basis points; zero for zero principal' },
                      },
                    },
                  },
                  generatedAt: { type: 'string', format: 'date-time' },
                  totalFaceValue: { type: 'number', deprecated: true, description: 'Compatibility alias of deprecated.totalFaceValue for one release only' },
                  totalFunded: { type: 'number', deprecated: true, description: 'Compatibility alias of deprecated.totalFunded for one release only' },
                  averageYieldBps: { type: 'number', deprecated: true, description: 'Compatibility alias of deprecated.averageYieldBps for one release only' },
                  deprecated: {
                    type: 'object', deprecated: true,
                    description: 'Legacy mixed-currency calculations retained here for one release only. Not meaningful financial totals.',
                    required: ['totalFaceValue', 'totalFunded', 'averageYieldBps'],
                    properties: {
                      totalFaceValue: { type: 'number', deprecated: true },
                      totalFunded: { type: 'number', deprecated: true },
                      averageYieldBps: { type: 'number', deprecated: true },
                    },
                  },
                },
              }),
            },
            400: { description: 'Invalid or repeated currency', ...json({ type: 'object', required: ['error', 'code', 'details'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['VALIDATION_FAILED'] }, details: { type: 'object', properties: { currency: { type: 'string' } } } } }) },
          },
        },
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
