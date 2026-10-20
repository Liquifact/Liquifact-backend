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
      '/api/escrow/attestations': {
        get: {
          tags: ['Escrow'],
          summary: 'On-chain attestation log (paginated)',
          description:
            'Returns the primary attestation hash and a page of the append-only attestation log. ' +
            'Page size is capped at 20 (MAX_ATTESTATION_READ_PAGE). Use `nextCursor` to fetch subsequent pages.',
          parameters: [
            {
              name: 'cursor',
              in: 'query',
              description: 'Zero-based start index for the log page (default: 0)',
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Number of log entries to return (1–20, default: 20)',
              schema: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
            },
          ],
          responses: {
            200: {
              description: 'Attestation state',
              ...json({
                type: 'object',
                properties: {
                  primary: {
                    type: 'string',
                    nullable: true,
                    description: 'Lowercase hex SHA-256 of the primary attestation, or null if not set',
                    example: 'a'.repeat(64),
                  },
                  log: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        index: { type: 'integer', description: 'Zero-based position in the append log' },
                        digest: { type: 'string', description: 'Lowercase 64-char hex SHA-256' },
                        revoked: { type: 'boolean' },
                      },
                      required: ['index', 'digest', 'revoked'],
                    },
                  },
                  total: {
                    type: 'integer',
                    nullable: true,
                    description: 'Total number of log entries, or null if unavailable',
                  },
                  nextCursor: {
                    type: 'integer',
                    nullable: true,
                    description: 'Start index for the next page, or null if this is the last page',
                  },
                },
                required: ['primary', 'log', 'total', 'nextCursor'],
              }),
            },
            400: { description: 'Invalid cursor or limit', ...json(ErrorBody) },
            502: { description: 'Soroban RPC read failed', ...json(ErrorBody) },
          },
        },
      },
      '/api/escrow/attestations/verify': {
        post: {
          tags: ['Escrow'],
          summary: 'Verify a document digest against on-chain attestations',
          description:
            'Accepts either a JSON body `{ sha256: "<64 hex>" }` or a `multipart/form-data` upload ' +
            '(file ≤ 5 MiB, hashed with SHA-256 while streaming — the file is never stored). ' +
            'Returns whether the digest matches the primary hash or a non-revoked log entry.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sha256'],
                  properties: {
                    sha256: {
                      type: 'string',
                      description: '64-character hex SHA-256 digest to verify',
                      example: 'a'.repeat(64),
                    },
                  },
                },
              },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'Document file (≤ 5 MiB). The server hashes it with SHA-256 and discards the bytes.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Verification result',
              ...json({
                type: 'object',
                properties: {
                  sha256: { type: 'string', description: 'The digest that was checked (normalised to lowercase)' },
                  match: {
                    type: 'string',
                    enum: ['primary', 'log', 'none'],
                    description: '"primary" if it matches the primary hash, "log" if found in the append log, "none" otherwise',
                  },
                  index: {
                    type: 'integer',
                    nullable: true,
                    description: 'Zero-based log index when match is "log"; omitted otherwise',
                  },
                  revoked: {
                    type: 'boolean',
                    description: 'true if the matched log entry has been revoked',
                  },
                  verified: {
                    type: 'boolean',
                    description: 'true when match !== "none" && !revoked',
                  },
                },
                required: ['sha256', 'match', 'revoked', 'verified'],
              }),
            },
            400: { description: 'Invalid or missing digest (INVALID_DIGEST / NO_FILE)', ...json(ErrorBody) },
            413: { description: 'Uploaded file exceeds 5 MiB', ...json(ErrorBody) },
            502: { description: 'Soroban RPC read failed', ...json(ErrorBody) },
          },
        },
      },
    },
  };
}

module.exports = { buildSpec };
