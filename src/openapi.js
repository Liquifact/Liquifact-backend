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
      '/api/invoices/{id}/quote': {
        get: {
          tags: ['Invoices'],
          summary: 'Quote an investment contribution and annualised returns',
          description: 'Coupon uses floor(principal minor units × yieldBps / 10,000), matching escrow. The protocol fee is shown separately and is deducted from SME withdrawal on-chain, so it is not subtracted from investor payout. Effective annualisation uses floating-point arithmetic solely as a comparison metric.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'amount', in: 'query', required: true, description: 'Positive decimal contribution, with at most 7 fractional digits', schema: { type: 'string', pattern: '^(?:0|[1-9]\\d*)(?:\\.\\d{1,7})?$' } },
            { name: 'asOf', in: 'query', required: false, description: 'Valuation date in UTC; defaults to today UTC', schema: { type: 'string', format: 'date' } },
          ],
          responses: {
            200: { description: 'Investment quote; monetary values are decimal strings', ...json({
              type: 'object',
              required: ['invoiceId', 'currency', 'principal', 'yieldBps', 'coupon', 'payout', 'protocolFeeBps', 'daysToMaturity', 'simpleAnnualisedBps', 'effectiveAnnualisedBps', 'maturity', 'asOf'],
              properties: {
                invoiceId: { type: 'string' }, currency: { type: 'string' },
                principal: { type: 'string', pattern: '^\\d+(?:\\.\\d{1,7})?$' },
                yieldBps: { type: 'integer', minimum: 0, maximum: 10000 },
                coupon: { type: 'string', pattern: '^\\d+(?:\\.\\d{1,7})?$' },
                payout: { type: 'string', pattern: '^\\d+(?:\\.\\d{1,7})?$' },
                protocolFeeBps: { type: 'integer', minimum: 0 }, daysToMaturity: { type: 'integer', minimum: 1 },
                simpleAnnualisedBps: { type: 'integer', minimum: 0 }, effectiveAnnualisedBps: { type: 'integer', minimum: 0 },
                maturity: { type: 'string', format: 'date' }, asOf: { type: 'string', format: 'date' },
              },
            }) },
            400: { description: 'Invalid amount or asOf', ...json({ type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['INVALID_AMOUNT', 'INVALID_AS_OF'] } } }) },
            404: { description: 'Unknown invoice', ...json({ type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['INVOICE_NOT_FOUND'] } } }) },
            409: { description: 'Invoice is not open or has matured', ...json({ type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['INVOICE_NOT_OPEN', 'INVOICE_MATURED'] } } }) },
            422: { description: 'Contribution exceeds remaining capacity', ...json({ type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['EXCEEDS_CAPACITY'] } } }) },
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
