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
    escrowContractId: { type: 'string', nullable: true, description: 'Verified linked escrow contract (null when off-chain)' },
    onChain: { type: 'boolean', readOnly: true, description: 'Derived from escrowContractId !== null' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const Escrow = {
  type: 'object',
  properties: {
    invoice_id: { type: 'string' },
    amount: { type: 'string', description: 'Exact 7-decimal stroops' },
    sme_address: { type: 'string' },
    yield_bps: { type: 'integer' },
    status: { type: 'integer', description: '4 means cancelled' },
  },
};
const LinkError = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    error: { type: 'string' },
    mismatches: {
      type: 'array',
      items: { type: 'object', properties: {
        field: { type: 'string' }, expected: { type: 'string', nullable: true }, actual: { type: 'string', nullable: true },
      } },
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
    components: { securitySchemes: { AdminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque admin API token' } }, schemas: { Invoice, Escrow, LinkError } },
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
          requestBody: { required: true, ...json({ type: 'object', properties: { amount: { type: 'number' } } }) },
          responses: {
            200: { description: 'Updated invoice' },
            400: { description: 'Invalid amount' },
            404: { description: 'Not found' },
            409: { description: 'Invoice not open' },
          },
        },
      },
      '/api/invoices/{id}/escrow': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          tags: ['Invoices', 'Escrow'],
          summary: 'Admin-only verified link of a deployed escrow to an invoice',
          description: 'Simulates get_escrow on the supplied contract and verifies invoice ID, exact 7-decimal stroop amount, SME address when supplied, yield and non-cancelled status. Repeating an existing identical link is idempotent.',
          security: [{ AdminBearer: [] }],
          requestBody: {
            required: true,
            ...json({ type: 'object', required: ['contractId'], properties: {
              contractId: { type: 'string', description: 'Valid Stellar C-address' },
            } }),
          },
          responses: {
            200: { description: 'Invoice linked or already linked to the same contract', ...json({ type: 'object', properties: { data: Invoice } }) },
            400: { description: 'INVALID_CONTRACT_ID', ...json(LinkError) },
            401: { description: 'UNAUTHORIZED', ...json(LinkError) },
            404: { description: 'INVOICE_NOT_FOUND', ...json(LinkError) },
            409: { description: 'ALREADY_LINKED or CONTRACT_IN_USE', ...json(LinkError) },
            422: { description: 'ESCROW_TERMS_MISMATCH or ESCROW_NOT_FOUND', ...json(LinkError) },
            503: { description: 'ADMIN_TOKEN_NOT_CONFIGURED', ...json(LinkError) },
          },
        },
        get: {
          tags: ['Invoices', 'Escrow'],
          summary: 'Read this invoice’s linked on-chain escrow',
          responses: {
            200: { description: 'Decoded get_escrow response', ...json({ type: 'object', properties: {
              contractId: { type: 'string' }, escrow: Escrow,
            } }) },
            404: { description: 'INVOICE_NOT_FOUND or NOT_LINKED', ...json(LinkError) },
            422: { description: 'ESCROW_NOT_FOUND', ...json(LinkError) },
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
