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
    tags: [{ name: 'System' }, { name: 'Invoices' }, { name: 'Investors' }, { name: 'Escrow' }],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Liveness probe',
          responses: { 200: { description: 'Service is up', ...json({ type: 'object' }) } },
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
          requestBody: {
            required: true,
            ...json({
              type: 'object',
              required: ['amount', 'investor'],
              properties: {
                amount: { type: 'number', example: 1000 },
                investor: { type: 'string', example: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5' },
              },
            }),
          },
          responses: {
            200: { description: 'Updated invoice', ...json({ type: 'object', properties: { data: Invoice } }) },
            400: { description: 'Invalid amount or missing/invalid investor', ...json(ErrorBody) },
            404: { description: 'Not found', ...json(ErrorBody) },
            409: { description: 'Invoice not open', ...json(ErrorBody) },
            422: { description: 'Self-funding not allowed', ...json(ErrorBody) },
          },
        },
      },
      '/api/invoices/{id}/contributions': {
        get: {
          tags: ['Invoices'],
          summary: 'List contributions for an invoice',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'Contributions and totals',
              ...json({
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        investor: { type: 'string' },
                        amount: { type: 'number' },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                  totals: {
                    type: 'object',
                    properties: {
                      funded: { type: 'number' },
                      investors: { type: 'integer' },
                    },
                  },
                  nextCursor: { type: 'string' },
                },
              }),
            },
            400: { description: 'Invalid limit or cursor', ...json(ErrorBody) },
            404: { description: 'Not found', ...json(ErrorBody) },
          },
        },
      },
      '/api/investors/{address}/portfolio': {
        get: {
          tags: ['Investors'],
          summary: 'Investor portfolio summary and expected returns',
          parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Investor portfolio',
              ...json({
                type: 'object',
                properties: {
                  investor: { type: 'string' },
                  positions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        invoiceId: { type: 'string' },
                        status: { type: 'string', enum: ['open', 'funded', 'settled', 'cancelled'] },
                        currency: { type: 'string' },
                        principal: { type: 'number' },
                        yieldBps: { type: 'integer' },
                        dueDate: { type: 'string', format: 'date' },
                        expectedCoupon: { oneOf: [{ type: 'number' }, { type: 'string' }] },
                        expectedPayout: { type: 'number' },
                      },
                    },
                  },
                  totalsByCurrency: {
                    type: 'object',
                    additionalProperties: {
                      type: 'object',
                      properties: {
                        principal: { type: 'number' },
                        expectedCoupon: { type: 'number' },
                        expectedPayout: { type: 'number' },
                      },
                    },
                  },
                },
              }),
            },
            400: { description: 'Invalid investor address', ...json(ErrorBody) },
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
