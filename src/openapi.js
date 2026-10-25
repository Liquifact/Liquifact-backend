'use strict';

const config = require('./config');
const { SORTS } = require('./services/invoice-query');

const { OpenApiGeneratorV3 } = require('@asteasolutions/zod-to-openapi');
const { registry } = require('./schemas');

/**
 * Component schemas generated once from the zod registry (src/schemas), the
 * same schemas the routes validate with, so docs cannot drift from behaviour.
 */
const GENERATED_SCHEMAS = new OpenApiGeneratorV3(registry.definitions).generateComponents().components.schemas;

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const Invoice = ref('Invoice');

const FundingError = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string', enum: ['FUNDING_EXCEEDS_CAPACITY', 'INVALID_AMOUNT'] },
    remainingCapacity: { type: 'number', description: 'Remaining capacity at the time of rejection' },
  },
};

/** Fund request body, generated from the FundInvoiceBody zod schema. */
const FundRequest = GENERATED_SCHEMAS.FundInvoiceBody;

const FundResponse = {
  type: 'object',
  properties: {
    data: Invoice,
    accepted: { type: 'number', description: 'Present only when allowPartial is true and the amount was capped' },
    rejected: { type: 'number', description: 'Present only when allowPartial is true and the amount was capped' },
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
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          expected: { type: 'string', nullable: true },
          actual: { type: 'string', nullable: true },
        },
      },
    },
  },
};

const InvestorPosition = {
  type: 'object',
  required: [
    'investor', 'contractId', 'contribution', 'contributionDecimal', 'claimablePayout', 'claimablePayoutDecimal',
    'claimed', 'effectiveYieldBps', 'claimNotBefore', 'claimNotBeforeIso', 'allowlist', 'latestLedger',
  ],
  properties: {
    investor: { type: 'string' },
    contractId: { type: 'string' },
    contribution: { type: 'string', description: 'Raw stroops' },
    contributionDecimal: { type: 'string', description: 'Amount with 7 decimals applied' },
    claimablePayout: { type: 'string', description: 'Raw stroops' },
    claimablePayoutDecimal: { type: 'string' },
    claimed: { type: 'boolean' },
    effectiveYieldBps: { type: 'integer' },
    claimNotBefore: { type: 'integer' },
    claimNotBeforeIso: { type: 'string', format: 'date-time', nullable: true },
    allowlist: {
      type: 'object',
      required: ['active', 'allowlisted', 'eligible'],
      properties: { active: { type: 'boolean' }, allowlisted: { type: 'boolean' }, eligible: { type: 'boolean' } },
    },
    latestLedger: { type: 'integer' },
  },
};

const json = (schema) => ({ content: { 'application/json': { schema } } });
const ErrorBody = {
  type: 'object',
  properties: { error: { type: 'string' }, detail: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } },
};
const DuplicateError = {
  type: 'object',
  required: ['code', 'existingId'],
  properties: {
    code: { type: 'string', enum: ['DUPLICATE_INVOICE', 'POSSIBLE_DUPLICATE'] },
    existingId: { type: 'string', pattern: '^[A-Za-z0-9_]{1,32}$' },
  },
};

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

/** Response of GET /health and GET /healthz. */
const HealthResponse = {
  type: 'object',
  required: ['status', 'service', 'version', 'timestamp', 'uptimeSeconds'],
  properties: {
    status: { type: 'string', enum: ['ok'], description: 'Always "ok": the liveness probe never checks dependencies' },
    service: { type: 'string', example: 'liquifact-api' },
    version: { type: 'string', example: '1.0.0' },
    timestamp: { type: 'string', format: 'date-time' },
    uptimeSeconds: { type: 'integer', minimum: 0, description: 'Seconds since the process started' },
  },
};

/** Short, non-sensitive failure codes reported by the readiness checks. */
const ReadinessErrorCode = {
  type: 'string',
  enum: ['TIMEOUT', 'PASSPHRASE_MISMATCH', 'STALE_LEDGER', 'CONTRACT_NOT_FOUND', 'RPC_ERROR'],
  description: 'Present only on the failing check; raw upstream messages are never returned',
};

/** Response of GET /ready. */
const ReadinessResponse = {
  type: 'object',
  required: ['status', 'checks'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    checks: {
      type: 'object',
      required: ['rpc', 'network', 'ledger', 'contract'],
      properties: {
        rpc: {
          type: 'object',
          required: ['ok'],
          description: 'The Soroban RPC answers and reports itself as healthy',
          properties: {
            ok: { type: 'boolean' },
            latencyMs: { type: 'integer', minimum: 0, description: 'Round-trip time of the health call' },
            error: ReadinessErrorCode,
          },
        },
        network: {
          type: 'object',
          required: ['ok', 'expected', 'actual'],
          description: 'The RPC serves the network the API is configured for',
          properties: {
            ok: { type: 'boolean' },
            expected: { type: 'string', description: 'Configured network passphrase' },
            actual: { type: 'string', nullable: true, description: 'Network passphrase reported by the RPC' },
            error: ReadinessErrorCode,
          },
        },
        ledger: {
          type: 'object',
          required: ['ok'],
          description: 'The latest ledger is recent enough to be served by a healthy node',
          properties: {
            ok: { type: 'boolean' },
            sequence: { type: 'integer', nullable: true, description: 'Sequence of the latest ledger' },
            ageSeconds: {
              type: 'integer',
              nullable: true,
              minimum: 0,
              description: 'Age of the latest ledger; null when the RPC does not expose a ledger close time',
            },
            error: ReadinessErrorCode,
          },
        },
        contract: {
          type: 'object',
          required: ['ok'],
          description: 'The configured escrow contract is deployed on the RPC network',
          properties: {
            ok: { type: 'boolean' },
            error: ReadinessErrorCode,
          },
        },
      },
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

const WebhookSubscription = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'wh_a1b2c3d4e5f6a7b8' },
    url: { type: 'string', format: 'uri', example: 'https://example.com/hooks' },
    events: {
      type: 'array',
      items: { type: 'string', enum: ['invoice.created', 'invoice.funding_received', 'invoice.funded'] },
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const WebhookCreatedResponse = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'wh_a1b2c3d4e5f6a7b8' },
    secret: {
      type: 'string',
      description: 'base64url-encoded 32-byte signing secret. Shown once — store it securely.',
      example: 'abc123...',
    },
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const DeliveryAttempt = {
  type: 'object',
  properties: {
    attempt: { type: 'integer', example: 1 },
    status: { type: 'integer', nullable: true, example: 200 },
    durationMs: { type: 'integer', example: 142 },
    error: { type: 'string', nullable: true },
  },
};

const DeliveryRecord = {
  type: 'object',
  properties: {
    deliveryId: { type: 'string', example: 'dlv_a1b2c3d4e5f6' },
    eventId: { type: 'string', example: 'evt_a1b2c3d4e5f6a7b8' },
    eventType: { type: 'string', example: 'invoice.created' },
    webhookId: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    status: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
    attempts: { type: 'array', items: DeliveryAttempt },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const IdempotencyKeyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Idempotency key for safe retries (8-128 chars: letters, digits, _ and -). A repeat with the same key and ' +
    'payload replays the first response; required when IDEMPOTENCY_REQUIRED=true.',
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
};

const IdempotencyHeaders = {
  'Idempotency-Key': { description: 'Echo of the request Idempotency-Key', schema: { type: 'string' } },
  'Idempotent-Replayed': {
    description: 'Present with value "true" when the response is a replay of a cached request',
    schema: { type: 'string' },
  },
};

const IdempotencyErrors = {
  422: { description: 'IDEMPOTENCY_KEY_REUSED: the key was used with a different payload', ...json(ErrorBody) },
};

const authErrorBody = (codes) => ({
  type: 'object',
  required: ['error', 'code'],
  properties: { error: { type: 'string' }, code: { type: 'string', enum: codes } },
});

/** Mutating operations guarded by `requireRole` (src/middleware/auth.js) and the roles they accept. */
const API_KEY_OPERATIONS = [
  ['/api/invoices', 'post', ['sme', 'admin']],
  ['/api/invoices/{id}/fund', 'post', ['investor', 'admin']],
  ['/api/invoices/{id}/settle', 'post', ['admin']],
  ['/api/invoices/{id}/cancel', 'post', ['sme', 'admin']],
  ['/api/invoices/{id}/document', 'post', ['sme', 'admin']],
  ['/api/escrow/attestations/verify', 'post', ['sme', 'investor', 'admin']],
  ['/api/smes', 'post', ['sme', 'admin']],
];

/**
 * Applies the ApiKeyAuth scheme and its 401/403/503 responses to every
 * API-key-guarded operation.
 *
 * @param {object} spec OpenAPI document
 * @returns {object} the same document
 */
function applyApiKeySecurity(spec) {
  for (const [path, method, roles] of API_KEY_OPERATIONS) {
    const operation = spec.paths[path] && spec.paths[path][method];
    if (!operation) {
      continue;
    }
    operation.security = [{ ApiKeyAuth: [] }];
    operation.description = `${operation.description ? `${operation.description} ` : ''}Requires an API key with role: ${roles.join(' or ')}.`;
    // Keep any route-specific 403 (e.g. SME_NOT_VERIFIED) alongside FORBIDDEN.
    const existing403 = operation.responses[403];
    const extraCode = existing403 && /^[A-Z_]+/.exec(existing403.description);
    operation.responses = {
      ...operation.responses,
      401: { description: 'Missing, malformed or unknown API key', ...json(authErrorBody(['UNAUTHENTICATED'])) },
      403: {
        description: `API key role not allowed (needs ${roles.join(' or ')})${existing403 ? `; or ${existing403.description}` : ''}`,
        ...json(authErrorBody(extraCode ? ['FORBIDDEN', extraCode[0]] : ['FORBIDDEN'])),
      },
      503: { description: 'API_KEYS not configured in production (fail closed)', ...json(authErrorBody(['AUTH_NOT_CONFIGURED'])) },
    };
  }
  return spec;
}

// Built documents are memoised per base URL (bounded, since the base URL can come from the Host header).
const SPEC_CACHE_LIMIT = 16;
const specCache = new Map();

/**
 * Builds the OpenAPI document for the given public base URL.
 *
 * @param {string} baseUrl server URL to advertise
 * @returns {object} OpenAPI 3.0 document
 */
function buildSpec(baseUrl) {
  if (specCache.has(baseUrl)) {
    return specCache.get(baseUrl);
  }
  const spec = createSpec(baseUrl);
  if (specCache.size >= SPEC_CACHE_LIMIT) {
    specCache.delete(specCache.keys().next().value);
  }
  specCache.set(baseUrl, spec);
  return spec;
}

/**
 * Creates the OpenAPI document for the given public base URL.
 *
 * @param {string} baseUrl server URL to advertise
 * @returns {object} OpenAPI 3.0 document
 */
function createSpec(baseUrl) {
  return applyApiKeySecurity({
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
      { name: 'Webhooks' },
      { name: 'SMEs' },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'API key (`Authorization: Bearer <key>` or `X-API-Key: <key>`) configured in API_KEYS with a role: ' +
            'sme, investor or admin. Required on mutating invoice/SME/attestation routes; GET routes are public.',
        },
        adminBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Shared admin secret: `Authorization: Bearer <ADMIN_API_TOKEN>`',
        },
      },
      schemas: {
        ...GENERATED_SCHEMAS,
        FundingError,
        FundRequest,
        FundResponse,
        Escrow,
        LinkError,
        InvestorPosition,
        EscrowState,
        EscrowLiveResponse,
        HealthResponse,
        ReadinessResponse,
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
          description: 'Dependency-free liveness probe. It never calls the Soroban RPC.',
          responses: { 200: { description: 'Service is up', ...json({ $ref: '#/components/schemas/HealthResponse' }) } },
        },
      },
      '/ready': {
        get: {
          tags: ['System'],
          summary: 'Readiness probe (Soroban RPC, network, ledger freshness, contract)',
          description:
            'Runs four checks in parallel against the configured Soroban RPC: `rpc` (the RPC reports itself ' +
            'healthy), `network` (the RPC serves the configured network passphrase), `ledger` (the latest ledger ' +
            `is at most READY_MAX_LEDGER_AGE_SECONDS old, default 60) and \`contract\` (the configured escrow ` +
            'contract is deployed). Every check is bounded by READY_CHECK_TIMEOUT_MS (default 2000) and the ' +
            'result is reused for READY_CACHE_SECONDS (default 10) so probes cannot hammer the RPC. A failing ' +
            'check reports a short error code (TIMEOUT, PASSPHRASE_MISMATCH, STALE_LEDGER, CONTRACT_NOT_FOUND, ' +
            'RPC_ERROR); raw upstream messages are never returned.',
          responses: {
            200: { description: 'All checks passed', ...json({ $ref: '#/components/schemas/ReadinessResponse' }) },
            503: { description: 'At least one check failed', ...json({ $ref: '#/components/schemas/ReadinessResponse' }) },
          },
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
          parameters: [IdempotencyKeyParam],
          requestBody: { required: true, ...json(GENERATED_SCHEMAS.CreateInvoiceBody) },
          responses: {
            201: { description: 'Created', headers: IdempotencyHeaders, ...json({ type: 'object', properties: { data: Invoice } }) },
            400: {
              description: 'Validation failed (VALIDATION_FAILED, unknown keys rejected), or missing/invalid Idempotency-Key',
              ...json(ref('ErrorResponse')),
            },
            403: { description: 'SME_NOT_VERIFIED (REQUIRE_SME_VERIFICATION=true and the SME is not verified)', ...json(ref('ErrorResponse')) },
            404: { description: 'SME_NOT_FOUND (unknown smeId)', ...json(ref('ErrorResponse')) },
            409: {
              description: 'Duplicate invoice or possible duplicate receivable, or IDEMPOTENCY_IN_PROGRESS (retry after Retry-After)',
              headers: { 'Retry-After': { schema: { type: 'string' } } },
              ...json(DuplicateError),
            },
            415: { description: 'Content-Type must be application/json (UNSUPPORTED_MEDIA_TYPE)', ...json(ref('ErrorResponse')) },
            ...IdempotencyErrors,
          },
        },
      },
      '/api/invoices/{id}': {
        get: {
          tags: ['Invoices'],
          summary: 'Get an invoice',
          parameters: [{ name: 'id', in: 'path', required: true, schema: GENERATED_SCHEMAS.InvoiceIdParam.properties.id }],
          responses: {
            200: { description: 'Invoice', ...json({ type: 'object', properties: { data: Invoice } }) },
            400: { description: 'Invalid id (VALIDATION_FAILED)', ...json(ref('ErrorResponse')) },
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
            'with the invoice `fundedAmount` and `status` before and after. A contribution is either accepted in full ' +
            'or rejected with a 422; set allowPartial to true to explicitly cap it at the remaining capacity.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, IdempotencyKeyParam],
          requestBody: { required: true, ...json(FundRequest) },
          responses: {
            200: { description: 'Updated invoice', headers: IdempotencyHeaders, ...json(FundResponse) },
            400: {
              description: 'Invalid amount (non-finite, non-positive, above face value), missing/invalid investor, ' +
                'unknown body key or invalid id (VALIDATION_FAILED)',
              ...json(FundingError),
            },
            404: { description: 'Not found', ...json(ErrorBody) },
            409: {
              description: 'Invoice not open, or IDEMPOTENCY_IN_PROGRESS (retry after Retry-After)',
              headers: { 'Retry-After': { schema: { type: 'string' } } },
              ...json(ErrorBody),
            },
            415: { description: 'Content-Type must be application/json (UNSUPPORTED_MEDIA_TYPE)', ...json(ref('ErrorResponse')) },
            422: {
              description: 'Contribution exceeds remaining capacity, self-funding not allowed, or IDEMPOTENCY_KEY_REUSED',
              ...json(FundingError),
            },
          },
        },
      },
      '/api/invoices/{id}/escrow': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          tags: ['Invoices', 'Escrow'],
          summary: 'Admin-only verified link of a deployed escrow to an invoice',
          description:
            'Simulates get_escrow on the supplied contract and verifies invoice ID, exact 7-decimal stroop amount, ' +
            'SME address when supplied, yield and non-cancelled status. Repeating an existing identical link is idempotent.',
          security: [{ adminBearer: [] }],
          requestBody: {
            required: true,
            ...json({
              type: 'object',
              required: ['contractId'],
              properties: { contractId: { type: 'string', description: 'Valid Stellar C-address' } },
            }),
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
          summary: 'Read this invoice\u2019s linked on-chain escrow',
          responses: {
            200: {
              description: 'Decoded get_escrow response',
              ...json({ type: 'object', properties: { contractId: { type: 'string' }, escrow: Escrow } }),
            },
            404: { description: 'INVOICE_NOT_FOUND or NOT_LINKED', ...json(LinkError) },
            422: { description: 'ESCROW_NOT_FOUND', ...json(LinkError) },
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
      '/api/escrow/investors/{address}': {
        get: {
          tags: ['Escrow'],
          summary: 'Query an investor position from the deployed Soroban escrow',
          description:
            'Seven read-only contract view simulations plus the latest ledger; responses are cached for 5 seconds per ' +
            'address (maximum 1000 addresses).',
          parameters: [{
            name: 'address',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Stellar G-account or C-contract address (muxed addresses rejected)',
          }],
          responses: {
            200: { description: 'Investor position snapshot', ...json({ $ref: '#/components/schemas/InvestorPosition' }) },
            400: { description: 'INVALID_ADDRESS', ...json({ type: 'object', properties: { code: { type: 'string', enum: ['INVALID_ADDRESS'] } } }) },
            502: {
              description: 'ESCROW_READ_FAILED (no partial data)',
              ...json({
                type: 'object',
                required: ['code', 'method'],
                properties: { code: { type: 'string', enum: ['ESCROW_READ_FAILED'] }, method: { type: 'string' } },
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
      '/api/smes': {
        post: {
          tags: ['SMEs'],
          summary: 'Register an SME for KYB review',
          description: 'Creates the SME with status `pending`. contactEmail and registrationNumber are PII and are only returned to admins.',
          requestBody: { required: true, ...json(ref('CreateSmeRequest')) },
          responses: {
            201: { description: 'SME created (pending review)', ...json({ type: 'object', properties: { data: ref('SmeRecord') } }) },
            400: { description: 'Invalid SME fields (VALIDATION_FAILED)', ...json(ref('ErrorResponse')) },
            409: { description: 'SME_DUPLICATE: same country + registration number, or same Stellar address', ...json(ref('ErrorResponse')) },
            415: { description: 'Content-Type must be application/json', ...json(ref('ErrorResponse')) },
          },
        },
      },
      '/api/smes/{id}': {
        get: {
          tags: ['SMEs'],
          summary: 'Get an SME',
          description: 'contactEmail and registrationNumber are omitted unless a valid admin token is presented.',
          security: [{ adminBearer: [] }, {}],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'SME record (PII omitted for non-admin callers)', ...json({ type: 'object', properties: { data: ref('SmeRecord') } }) },
            404: { description: 'SME_NOT_FOUND', ...json(ref('ErrorResponse')) },
          },
        },
      },
      '/api/smes/{id}/review': {
        post: {
          tags: ['SMEs'],
          summary: 'Review an SME (admin)',
          description: 'Allowed transitions: pending → verified | rejected, verified → suspended. Each decision is appended to reviewHistory.',
          security: adminSecurity,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, ...json(ref('ReviewSmeRequest')) },
          responses: {
            200: { description: 'Review recorded', ...json({ type: 'object', properties: { data: ref('SmeRecord') } }) },
            400: { description: 'Invalid review request (VALIDATION_FAILED)', ...json(ref('ErrorResponse')) },
            404: { description: 'SME_NOT_FOUND', ...json(ref('ErrorResponse')) },
            409: { description: 'INVALID_TRANSITION', ...json(ref('ErrorResponse')) },
            ...adminErrors,
          },
        },
      },
      '/api/webhooks': {
        post: {
          tags: ['Webhooks'],
          summary: 'Register a webhook subscription',
          description:
            'Requires `Authorization: Bearer <ADMIN_API_TOKEN>`. Returns 503 if ADMIN_API_TOKEN is not configured. ' +
            'Deliveries are signed with the returned secret (`LiquiFact-Signature` header).',
          security: adminSecurity,
          requestBody: {
            required: true,
            ...json({
              type: 'object',
              required: ['url', 'events'],
              properties: {
                url: {
                  type: 'string',
                  format: 'uri',
                  description: 'HTTPS endpoint to receive events. HTTP allowed only for localhost in non-production.',
                  example: 'https://example.com/hooks',
                },
                events: {
                  type: 'array',
                  items: { type: 'string', enum: ['invoice.created', 'invoice.funding_received', 'invoice.funded'] },
                  example: ['invoice.created', 'invoice.funded'],
                },
              },
            }),
          },
          responses: {
            201: {
              description: 'Subscription created. The `secret` field is shown exactly once — store it securely.',
              ...json({ type: 'object', properties: { data: WebhookCreatedResponse } }),
            },
            400: { description: 'Validation failed (bad URL, invalid events, SSRF)', ...json(ErrorBody) },
            ...adminErrors,
          },
        },
        get: {
          tags: ['Webhooks'],
          summary: 'List webhook subscriptions',
          security: adminSecurity,
          responses: {
            200: {
              description: 'List of subscriptions (secrets not included)',
              ...json({ type: 'object', properties: { data: { type: 'array', items: WebhookSubscription } } }),
            },
            ...adminErrors,
          },
        },
      },
      '/api/webhooks/{id}': {
        delete: {
          tags: ['Webhooks'],
          summary: 'Delete a webhook subscription',
          security: adminSecurity,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            204: { description: 'Deleted' },
            404: { description: 'Webhook not found', ...json(ErrorBody) },
            ...adminErrors,
          },
        },
      },
      '/api/webhooks/{id}/deliveries': {
        get: {
          tags: ['Webhooks'],
          summary: 'Last 50 delivery records for a webhook',
          security: adminSecurity,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Delivery log (most recent first)',
              ...json({ type: 'object', properties: { data: { type: 'array', items: DeliveryRecord } } }),
            },
            404: { description: 'Webhook not found', ...json(ErrorBody) },
            ...adminErrors,
          },
        },
      },
    },
  });
}

module.exports = { buildSpec };
