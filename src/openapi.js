'use strict';

const config = require('./config');
const { SORTS } = require('./services/invoice-query');

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
const ErrorBody = { type: 'object', properties: { error: { type: 'string' }, detail: { type: 'string' } } };

const DocumentMeta = {
  type: 'object',
  properties: {
    sha256Hex: { type: 'string', description: 'SHA-256 hex digest of the PDF bytes', example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    sizeBytes: { type: 'integer', description: 'File size in bytes', example: 12345 },
    uploadedAt: { type: 'string', format: 'date-time', description: 'ISO 8601 upload timestamp' },
    originalName: { type: 'string', description: 'Sanitised original filename (≤120 chars)', example: 'invoice-001.pdf' },
  },
};

/** Raw stroop amount as a decimal integer string (7 decimals). */
const StroopString = { type: 'string', pattern: '^\\d+$', example: '1000000000' };

/** Amount converted to whole units with a fixed 7 decimal places. */
const DecimalString = { type: 'string', pattern: '^\\d+\\.\\d{7}$', example: '100.0000000' };

/**
 * Typed escrow state returned identically by the live (Soroban RPC) and
 * snapshot read paths.
 */
const EscrowState = {
  type: 'object',
  required: [
    'invoiceId',
    'admin',
    'smeAddress',
    'amount',
    'fundingTarget',
    'fundedAmount',
    'amountDecimal',
    'fundingTargetDecimal',
    'fundedAmountDecimal',
    'yieldBps',
    'maturity',
    'maturityIso',
    'status',
    'statusCode',
  ],
  properties: {
    invoiceId: { type: 'string', example: 'INV_0001' },
    admin: { type: 'string', example: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5' },
    smeAddress: { type: 'string', example: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5' },
    amount: { ...StroopString, description: 'Raw amount in stroops (7 decimals)' },
    fundingTarget: { ...StroopString, description: 'Raw funding target in stroops' },
    fundedAmount: { ...StroopString, description: 'Raw funded amount in stroops' },
    amountDecimal: { ...DecimalString, description: 'Amount as a fixed 7-decimal string' },
    fundingTargetDecimal: { ...DecimalString, description: 'Funding target as a fixed 7-decimal string' },
    fundedAmountDecimal: { ...DecimalString, description: 'Funded amount as a fixed 7-decimal string' },
    yieldBps: { type: 'integer', minimum: 0, maximum: 10000, example: 800 },
    maturity: { type: 'integer', minimum: 0, description: 'Maturity as unix seconds', example: 1800132005 },
    maturityIso: { type: 'string', format: 'date-time', example: '2027-01-17T00:13:25.000Z' },
    status: {
      type: 'string',
      enum: ['open', 'funded', 'settled', 'withdrawn', 'cancelled', 'unknown'],
      description: 'Human-readable status; unknown contract codes map to "unknown"',
    },
    statusCode: { type: 'integer', minimum: 0, description: 'Raw contract status code (0 open, 1 funded, 2 settled, 3 withdrawn, 4 cancelled)' },
  },
};

/** Response of GET /api/escrow/live. */
const EscrowLiveResponse = {
  type: 'object',
  required: ['source', 'contractId', 'network', 'escrow'],
  properties: {
    source: { type: 'string', enum: ['soroban-rpc', 'snapshot'], description: 'Where the payload came from' },
    contractId: { type: 'string' },
    network: { type: 'string', example: 'testnet' },
    escrow: { $ref: '#/components/schemas/EscrowState' },
    latestLedger: { type: 'integer', description: 'Ledger the live read came from (present only when source is soroban-rpc)' },
    snapshotCapturedAt: { type: 'string', format: 'date-time', description: 'When the fallback snapshot was captured (present only when source is snapshot)' },
    warning: {
      type: 'object',
      required: ['code'],
      description: 'Present only when the live read failed and the snapshot was served',
      properties: { code: { type: 'string', enum: ['LIVE_READ_FAILED'] } },
    },
  },
};

const Mismatch = {
  type: 'object',
  properties: {
    field: { type: 'string', example: 'fundedAmount' },
    offChain: { example: '1000000000' },
    onChain: { example: '0' },
    severity: { type: 'string', enum: ['critical', 'warning'] },
  },
  required: ['field', 'offChain', 'onChain', 'severity'],
};

const ReconciliationResult = {
  type: 'object',
  properties: {
    invoiceId: { type: 'string', example: 'INV_0001' },
    contractId: { type: 'string', example: 'CDQCKR2YU...' },
    status: {
      type: 'string',
      enum: ['in_sync', 'drift', 'missing_on_chain', 'error'],
    },
    code: { type: 'string', example: 'RPC_ERROR', description: 'Only present when status is error' },
    detail: { type: 'string', description: 'Human-readable error detail (status=error only)' },
    mismatches: { type: 'array', items: Mismatch },
  },
  required: ['invoiceId', 'contractId', 'status', 'mismatches'],
};

const ReconciliationReport = {
  type: 'object',
  properties: {
    checkedAt: { type: 'string', format: 'date-time' },
    summary: {
      type: 'object',
      properties: {
        inSync: { type: 'integer' },
        drift: { type: 'integer' },
        missing: { type: 'integer' },
        error: { type: 'integer' },
      },
      required: ['inSync', 'drift', 'missing', 'error'],
    },
    results: { type: 'array', items: ReconciliationResult },
  },
  required: ['checkedAt', 'summary', 'results'],
};

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
        `contract holds funds until settlement. Escrow contract (${config.network}): ${config.contractId}`,
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: 'System' },
      { name: 'Invoices' },
      { name: 'Investors' },
      { name: 'Escrow' },
      { name: 'Reconciliation' },
      { name: 'Audit' },
    ],
    components: {
      securitySchemes: {
        adminBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Shared admin secret: `Authorization: Bearer <ADMIN_API_TOKEN>`',
        },
      },
      schemas: {
        EscrowState,
        EscrowLiveResponse,
        AuditEntry,
        AuditList,
        AuditVerification,
      },
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
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 2048 }, description: 'Opaque base64url cursor from nextCursor; bound to sort. Reuse the same filters.' },
            { name: 'status', in: 'query', schema: { type: 'string', pattern: '^(open|funded|settled|cancelled)(,(open|funded|settled|cancelled))*$' }, description: 'Comma-separated invoice statuses' },
            { name: 'currency', in: 'query', schema: { type: 'string', pattern: '^[a-zA-Z0-9]{1,12}$' }, description: 'Case-sensitive asset code' },
            { name: 'sme', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 120 }, description: 'Case-insensitive name substring' },
            ...['minAmount', 'maxAmount'].map((name) => ({ name, in: 'query', schema: { type: 'string', pattern: '^\\d+(\\.\\d+)?$', maxLength: 128 }, description: 'Inclusive exact decimal bound, without exponent notation' })),
            ...['minYieldBps', 'maxYieldBps'].map((name) => ({ name, in: 'query', schema: { type: 'integer', minimum: 0, maximum: 10000 }, description: 'Inclusive yield bound in basis points' })),
            ...['dueBefore', 'dueAfter'].map((name) => ({ name, in: 'query', schema: { type: 'string', format: 'date' }, description: 'Inclusive real calendar date, YYYY-MM-DD' })),
            { name: 'onChain', in: 'query', schema: { type: 'boolean' } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: SORTS, default: '-createdAt' }, description: 'Primary order; ties always use ascending id. Unknown and repeated query parameters are rejected.' },
          ],
          responses: {
            200: { description: 'Filtered invoice page', ...json({ type: 'object', required: ['data', 'count', 'total', 'nextCursor'], properties: { data: { type: 'array', maxItems: 100, items: Invoice }, count: { type: 'integer', minimum: 0, description: 'Page length (legacy meaning preserved)' }, total: { type: 'integer', minimum: 0, description: 'Filtered count before applying cursor and limit' }, nextCursor: { type: 'string', nullable: true, description: 'Null when no further records remain' } } }) },
            400: { description: 'Invalid/unknown/repeated query parameter or malformed/sort-mismatched cursor', ...json({ type: 'object', required: ['error', 'code', 'details'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['VALIDATION_FAILED', 'INVALID_CURSOR'] }, details: { type: 'object', additionalProperties: { type: 'string' } } } }) },
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
          description:
            'Every attempt, accepted or rejected (400, 404, 409, 422), is recorded in the audit log as `invoice.fund`, ' +
            'with the invoice `fundedAmount` and `status` before and after.',
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
      '/api/invoices/{id}/settle': {
        post: {
          tags: ['Invoices'],
          summary: 'Mark a fully funded invoice as settled',
          description: 'Every attempt, accepted or rejected, is recorded in the audit log as `invoice.settle`.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Invoice settled', ...json({ type: 'object', properties: { data: Invoice } }) },
            404: { description: 'Not found', ...json(ErrorBody) },
            409: { description: 'Invoice not funded', ...json(ErrorBody) },
          },
        },
      },
      '/api/invoices/{id}/cancel': {
        post: {
          tags: ['Invoices'],
          summary: 'Cancel an open or funded invoice',
          description: 'Every attempt, accepted or rejected, is recorded in the audit log as `invoice.cancel`.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Invoice cancelled', ...json({ type: 'object', properties: { data: Invoice } }) },
            404: { description: 'Not found', ...json(ErrorBody) },
            409: { description: 'Invoice not cancellable', ...json(ErrorBody) },
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
      '/api/invoices/{id}/document': {
        post: {
          tags: ['Invoices'],
          summary: 'Upload a PDF document for an invoice',
          description:
            'Accepts a single `multipart/form-data` upload with field name `file`. ' +
            'Validates PDF magic bytes (`%PDF-` header and `%%EOF` trailer) and rejects unsafe ' +
            'PDFs containing `/JavaScript` or `/Launch` actions. Computes a SHA-256 digest. ' +
            'Only allowed while the invoice is `open` and has no document yet.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Invoice ID' }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary', description: 'The PDF file (max 5 MiB)' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Document accepted; returns metadata including SHA-256 digest',
              ...json({
                type: 'object',
                properties: {
                  data: DocumentMeta,
                },
              }),
            },
            400: { description: 'Missing or extra file field', ...json(ErrorBody) },
            404: { description: 'Invoice not found', ...json(ErrorBody) },
            409: { description: 'Invoice not open or document already exists', ...json(ErrorBody) },
            413: { description: 'File exceeds the 5 MiB limit', ...json(ErrorBody) },
            415: { description: 'File is not a valid PDF (magic-byte check failed)', ...json(ErrorBody) },
            422: { description: 'PDF contains unsafe actions (/JavaScript or /Launch)', ...json(ErrorBody) },
          },
        },
        get: {
          tags: ['Invoices'],
          summary: 'Download the invoice PDF document',
          description: 'Streams the stored PDF with correct security headers.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Invoice ID' }],
          responses: {
            200: {
              description: 'PDF binary stream',
              headers: {
                'Content-Disposition': { schema: { type: 'string' }, description: 'attachment; filename="<sanitised name>"' },
                'X-Content-Type-Options': { schema: { type: 'string' }, description: 'nosniff' },
                ETag: { schema: { type: 'string' }, description: '"<sha256Hex>"' },
              },
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            404: { description: 'Invoice or document not found', ...json(ErrorBody) },
          },
        },
      },
      '/api/invoices/{id}/document/meta': {
        get: {
          tags: ['Invoices'],
          summary: 'Invoice document metadata + attestation hash',
          description:
            'Returns document metadata and `attestationHash` — the same SHA-256 hex ' +
            'digest suitable for passing to `bind_primary_attestation_hash(digest: BytesN<32>)` on the Soroban escrow contract.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Invoice ID' }],
          responses: {
            200: {
              description: 'Document metadata with on-chain attestation hash',
              ...json({
                type: 'object',
                properties: {
                  data: {
                    allOf: [
                      DocumentMeta,
                      {
                        type: 'object',
                        properties: {
                          attestationHash: {
                            type: 'string',
                            description: 'SHA-256 hex digest, same as sha256Hex; pass to bind_primary_attestation_hash',
                            example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                          },
                        },
                      },
                    ],
                  },
                },
              }),
            },
            404: { description: 'Invoice or document not found', ...json(ErrorBody) },
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
        get: {
          tags: ['Escrow'],
          summary: 'Deployed escrow contract metadata (decoded deploy snapshot)',
          responses: {
            200: {
              description: 'Contract info with the deploy snapshot decoded as EscrowState',
              ...json({
                type: 'object',
                required: ['contractId', 'network', 'snapshot'],
                properties: {
                  contractId: { type: 'string' },
                  network: { type: 'string' },
                  rpcUrl: { type: 'string' },
                  explorer: { type: 'string' },
                  snapshot: { $ref: '#/components/schemas/EscrowState' },
                  snapshotCapturedAt: { type: 'string', format: 'date-time' },
                },
              }),
            },
          },
        },
      },
      '/api/escrow/live': {
        get: {
          tags: ['Escrow'],
          summary: 'Live escrow state read from Soroban RPC (falls back to deploy snapshot)',
          description:
            'Returns the same typed EscrowState from both paths: the live Soroban RPC read and the deploy ' +
            'snapshot fallback. Set `strict=true` to fail instead of falling back to the snapshot.',
          parameters: [
            {
              name: 'strict',
              in: 'query',
              required: false,
              description: 'When true, respond 503 instead of falling back to the deploy snapshot',
              schema: { type: 'boolean', default: false },
            },
          ],
          responses: {
            200: { description: 'Escrow state (live read, or snapshot fallback with a warning)', ...json({ $ref: '#/components/schemas/EscrowLiveResponse' }) },
            503: {
              description: 'Live read failed and strict mode was requested',
              ...json({
                type: 'object',
                required: ['error', 'code'],
                properties: { error: { type: 'string' }, code: { type: 'string', enum: ['ESCROW_LIVE_UNAVAILABLE'] } },
              }),
            },
          },
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
      '/api/reconciliation': {
        get: {
          tags: ['Reconciliation'],
          summary: 'Reconcile all on-chain invoices against escrow state',
          description:
            'For every invoice with onChain: true, reads get_escrow from the Soroban RPC and reports ' +
            'field-level mismatches. RPC reads are deduplicated per contract and bounded to 4 concurrent calls. ' +
            'Always returns 200; individual RPC failures are reported per-invoice with status "error".',
          responses: {
            200: {
              description: 'Reconciliation report',
              ...json(ReconciliationReport),
            },
          },
        },
      },
      '/api/reconciliation/{invoiceId}': {
        get: {
          tags: ['Reconciliation'],
          summary: 'Reconcile one invoice against escrow state',
          parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Reconciliation result for the invoice',
              ...json(ReconciliationResult),
            },
            404: { description: 'Invoice not found', ...json(ErrorBody) },
            409: {
              description: 'Invoice is not tracked on-chain (onChain: false)',
              ...json({
                type: 'object',
                properties: { error: { type: 'string', example: 'NOT_ON_CHAIN' }, detail: { type: 'string' } },
              }),
            },
          },
        },
      },
    },
  };
}

module.exports = { buildSpec };
