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

const AuditEntry = {
  type: 'object',
  description:
    'One append-only audit record. `hash` = sha256(prevHash + canonicalJSON(entry without hash)); the first entry ' +
    'links to a prevHash of 64 zeros.',
  required: ['seq', 'at', 'action', 'resourceType', 'outcome', 'statusCode', 'prevHash', 'hash'],
  properties: {
    seq: { type: 'integer', example: 3 },
    at: { type: 'string', format: 'date-time' },
    action: { type: 'string', example: 'invoice.fund' },
    resourceType: { type: 'string', example: 'invoice' },
    resourceId: { type: 'string', nullable: true, example: 'INV_0002' },
    actor: { type: 'string', example: 'anonymous' },
    ip: { type: 'string', nullable: true, description: 'Client IP truncated to /24 (IPv4) or /48 (IPv6)', example: '203.0.113.0/24' },
    requestId: { type: 'string', nullable: true },
    outcome: { type: 'string', enum: ['success', 'rejected'] },
    statusCode: { type: 'integer', example: 200 },
    before: { type: 'object', nullable: true, additionalProperties: true },
    after: { type: 'object', nullable: true, additionalProperties: true },
    metadata: { type: 'object', nullable: true, additionalProperties: true },
    prevHash: { type: 'string', example: '0000000000000000000000000000000000000000000000000000000000000000' },
    hash: { type: 'string' },
  },
};

const AuditList = {
  type: 'object',
  required: ['data', 'count', 'nextAfter'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } },
    count: { type: 'integer' },
    nextAfter: { type: 'integer', nullable: true, description: 'Pass as `after` to get the next page; null on the last page' },
  },
};

const AuditVerification = {
  type: 'object',
  required: ['valid'],
  properties: {
    valid: { type: 'boolean' },
    entries: { type: 'integer', description: 'Number of entries checked (when valid)' },
    brokenAt: { type: 'integer', description: 'seq of the first entry that fails verification (when not valid)' },
  },
};

const adminSecurity = [{ adminBearer: [] }];
const adminErrors = {
  401: { description: 'Missing or invalid admin token', ...json(ErrorBody) },
  503: { description: 'ADMIN_API_TOKEN is not configured on the server', ...json(ErrorBody) },
};

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
    tags: [{ name: 'System' }, { name: 'Invoices' }, { name: 'Escrow' }, { name: 'Audit' }],
    components: {
      securitySchemes: {
        adminBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Shared admin secret: `Authorization: Bearer <ADMIN_API_TOKEN>`',
        },
      },
      schemas: { AuditEntry, AuditList, AuditVerification },
    },
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
          description: 'Every attempt, accepted or rejected, is recorded in the audit log as `invoice.create`.',
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
          description:
            'Every attempt, accepted or rejected (400, 404, 409), is recorded in the audit log as `invoice.fund`, ' +
            'with the invoice `fundedAmount` and `status` before and after.',
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
      '/api/audit': {
        get: {
          tags: ['Audit'],
          summary: 'List audit log entries (admin)',
          description: 'Oldest first. Page with `after` set to the previous response\'s `nextAfter`.',
          security: adminSecurity,
          parameters: [
            { name: 'resourceId', in: 'query', schema: { type: 'string' }, description: 'Only entries for this resource' },
            { name: 'action', in: 'query', schema: { type: 'string' }, description: 'Only this action, e.g. invoice.fund' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
            { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Only entries with seq greater than this' },
          ],
          responses: {
            200: { description: 'A page of entries', ...json({ $ref: '#/components/schemas/AuditList' }) },
            400: { description: 'Invalid query parameter', ...json(ErrorBody) },
            ...adminErrors,
          },
        },
      },
      '/api/audit/verify': {
        get: {
          tags: ['Audit'],
          summary: 'Verify the audit hash chain (admin)',
          description:
            'Recomputes every retained entry\'s hash and checks the links between them, starting from the oldest ' +
            'retained entry\'s prevHash.',
          security: adminSecurity,
          responses: {
            200: { description: 'Chain verification result', ...json({ $ref: '#/components/schemas/AuditVerification' }) },
            ...adminErrors,
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
