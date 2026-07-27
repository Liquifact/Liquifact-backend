'use strict';

/**
 * @fileoverview OpenAPI specification builder.
 *
 * Generates the LiquiFact API OpenAPI 3.0 document by scanning the `@swagger`
 * JSDoc annotations in `src/routes/**` and merging them with the shared
 * components defined below (standardized envelope, RFC 7807 problem details,
 * security scheme, common parameters).
 *
 * The generated spec is the single source of truth used by both the contract
 * tests (`tests/contract/api-schemas.test.js`) and the OpenAPI tests
 * (`tests/openapi.test.js`).
 *
 * Server URLs are derived from the `PUBLIC_API_BASE_URL` environment variable
 * (via `src/config/index.js`) rather than being hardcoded. In development and
 * test environments a localhost fallback is used when the variable is absent.
 * In production the variable is required, must use HTTPS, and must not resolve
 * to a loopback address — all of which are enforced at config validation time
 * by `src/config/index.js`.
 *
 * @module openapi/openapiSpec
 */

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

const ROUTES_GLOB = path.join(__dirname, '..', 'routes', '**', '*.js').replace(/\\/g, '/');

/**
 * The hostname pattern for loopback addresses (localhost, 127.x.x.x, ::1).
 * Used to guard against accidentally publishing a loopback URL in the spec.
 * Handles both bare IPv6 loopback `::1` and bracket-wrapped `[::1]` which is
 * how `new URL('https://[::1]').hostname` appears in Node.js.
 */
const LOOPBACK_HOSTNAME = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$/i;

/**
 * Default fallback server entry used only in development and test.
 */
const DEV_FALLBACK_SERVER = {
  url: 'http://localhost:3001',
  description: 'Local development',
};

/**
 * Build the servers array for the OpenAPI document.
 *
 * Resolution order:
 * 1. `PUBLIC_API_BASE_URL` from the validated config (any env).
 * 2. `PUBLIC_API_BASE_URL` from `process.env` directly (covers the narrow
 *    window before `validate()` has been called, e.g. during spec generation
 *    inside test helpers).
 * 3. Dev/test fallback — `http://localhost:3001`. This path is intentionally
 *    unreachable in production because `src/config/index.js` aborts startup
 *    when `PUBLIC_API_BASE_URL` is absent or invalid in `NODE_ENV=production`.
 *
 * @returns {Array<{url: string, description: string}>} Non-empty servers array.
 * @throws {Error} When called in a production context but no valid base URL
 *   can be resolved (defense-in-depth guard — config validation should have
 *   already caught this at boot time).
 */
function buildServers() {
  // Attempt to read from the already-validated config first.
  let baseUrl = null;
  try {
    const { get } = require('../config');
    const cfg = get();
    baseUrl = cfg.PUBLIC_API_BASE_URL || null;
  } catch (_) {
    // Config not yet validated (e.g. called from a test before validate()).
    // Fall through to direct env read below.
  }

  // Direct env read as a second source (covers pre-validation callers).
  if (!baseUrl) {
    baseUrl = process.env.PUBLIC_API_BASE_URL || null;
  }

  const nodeEnv = process.env.NODE_ENV || 'development';

  if (baseUrl) {
    // Strip trailing slash for consistency.
    const normalised = baseUrl.replace(/\/+$/, '');

    let parsed;
    try { parsed = new URL(normalised); } catch (_) { parsed = null; }

    // Defense-in-depth: reject a loopback URL that somehow slipped through
    // config validation (e.g. spec built before the server starts in prod).
    if (nodeEnv === 'production' && parsed && LOOPBACK_HOSTNAME.test(parsed.hostname)) {
      throw new Error(
        `PUBLIC_API_BASE_URL must not be a loopback address in production. Got: ${normalised}`,
      );
    }
    if (nodeEnv === 'production' && parsed && parsed.protocol !== 'https:') {
      throw new Error(
        `PUBLIC_API_BASE_URL must use HTTPS in production. Got: ${normalised}`,
      );
    }
    if (nodeEnv === 'production' && !parsed) {
      throw new Error(
        `PUBLIC_API_BASE_URL is not a valid URL in production. Got: ${baseUrl}`,
      );
    }

    const description =
      nodeEnv === 'production'
        ? 'Production API'
        : nodeEnv === 'test'
          ? 'Test server'
          : 'API server';

    return [{ url: normalised, description }];
  }

  // No base URL configured.
  if (nodeEnv === 'production') {
    // Should never reach here — config validation prevents startup without
    // PUBLIC_API_BASE_URL in production. Guard anyway so spec generation
    // never silently emits a loopback URL to a production consumer.
    throw new Error(
      'PUBLIC_API_BASE_URL is required in production but was not set. ' +
      'Refusing to build the OpenAPI spec with a loopback server entry.',
    );
  }

  // Development / test — safe to use the localhost fallback.
  return [DEV_FALLBACK_SERVER];
}

/**
 * Base OpenAPI document. Route-specific operations are merged in by
 * `swagger-jsdoc` from the `@swagger` JSDoc blocks in route files.
 *
 * The `servers` array is intentionally left empty here; it is populated
 * dynamically by `buildOpenApiSpec()` via `buildServers()` so the published
 * spec always reflects the runtime environment rather than a hardcoded value.
 */
const baseDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'LiquiFact API',
    version: '1.0.0',
    description:
      'Global Invoice Liquidity Network on Stellar. ' +
      'Successful responses use a standardized envelope (`data`/`meta`/`message`); ' +
      'error responses follow RFC 7807 (`application/problem+json`).',
  },
  servers: [],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      /**
       * Reusable invoice projection used by the marketplace and invoice
       * list endpoints. Kept permissive so it tolerates additional columns
       * surfaced by `marketplaceService`.
       */
      Invoice: {
        type: 'object',
        additionalProperties: true,
      },
      /**
       * Read-side projection of the on-chain LiquifactEscrow contract.
       */
      EscrowState: {
        type: 'object',
        additionalProperties: true,
      },
      /**
       * Standardized success envelope used by routes wired through
       * `createStandardizedApp` and by the marketplace/invest routes.
       */
      StandardEnvelope: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: {},
          meta: {
            type: 'object',
            additionalProperties: true,
          },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * Successful response from `GET /api/marketplace`.
       */
      MarketplaceListResponse: {
        type: 'object',
        required: ['data', 'meta', 'message'],
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Invoice' } },
          meta: {
            type: 'object',
            required: ['total', 'page', 'limit'],
            properties: {
              total: { type: 'integer', minimum: 0 },
              page: { type: 'integer', minimum: 1 },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              totalPages: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
          message: { type: 'string' },
        },
      },
      /**
       * Successful response from `POST /api/invest/fund-invoice`.
       */
      FundInvoiceResponse: {
        type: 'object',
        required: ['data', 'meta', 'message'],
        properties: {
          data: {
            type: 'object',
            required: ['investmentId', 'invoiceId', 'status'],
            properties: {
              investmentId: { type: 'string', minLength: 1 },
              invoiceId: { type: 'string', minLength: 1 },
              smeId: { type: 'string' },
              investmentAmount: { type: 'number', exclusiveMinimum: 0 },
              status: {
                type: 'string',
                enum: ['pending', 'confirmed', 'escrow', 'settled'],
              },
              onChain: {
                type: 'object',
                properties: {
                  escrowAddress: { type: 'string' },
                  ledgerIndex: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
            additionalProperties: false,
          },
          meta: {
            type: 'object',
            required: ['timestamp'],
            properties: {
              timestamp: { type: 'string', format: 'date-time' },
              version: { type: 'string' },
              kycVerified: { type: 'boolean' },
              kycStatus: { type: 'string' },
            },
            additionalProperties: false,
          },
          message: { type: 'string' },
        },
      },
      /**
       * RFC 7807 problem details envelope. Returned for 4xx/5xx responses
       * from routes that flow through `problemJsonHandler`.
       *
       * @see https://tools.ietf.org/html/rfc7807
       */
      Problem: {
        type: 'object',
        required: ['type', 'title', 'status'],
        properties: {
          type: { type: 'string', format: 'uri-reference' },
          title: { type: 'string' },
          status: { type: 'integer', minimum: 100, maximum: 599 },
          detail: { type: 'string' },
          instance: { type: 'string' },
          code: { type: 'string' },
          retryable: { type: 'boolean' },
          retry_hint: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * CORS origin rejection error. Returned when a request Origin header
       * is not in the configured allowlist.
       */
      CorsRejection: {
        type: 'object',
        required: ['error', 'code'],
        properties: {
          error: {
            type: 'string',
            enum: ['CORS policy: origin is not allowed.'],
          },
          code: {
            type: 'string',
            enum: ['CORS_ORIGIN_REJECTED'],
          },
        },
        additionalProperties: false,
      },
      /**
       * Summary row from the `reconciliation_runs` table.
       * Intentionally excludes the per-invoice `results` column so that
       * raw on-chain funding values are not surfaced in bulk list responses.
       */
      ReconciliationRun: {
        type: 'object',
        required: ['id', 'total', 'matches', 'mismatches', 'errors', 'reconciled_at', 'created_at'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Unique identifier for the reconciliation run.',
          },
          total: {
            type: 'integer',
            minimum: 0,
            description: 'Total number of invoices inspected in this run.',
          },
          matches: {
            type: 'integer',
            minimum: 0,
            description: 'Number of invoices where DB and on-chain funded amounts matched.',
          },
          mismatches: {
            type: 'integer',
            minimum: 0,
            description: 'Number of invoices where a funded-amount discrepancy was detected.',
          },
          errors: {
            type: 'integer',
            minimum: 0,
            description: 'Number of invoices that could not be compared due to an error.',
          },
          reconciled_at: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601 timestamp when the reconciliation run completed.',
          },
          created_at: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601 timestamp when the row was inserted.',
          },
        },
        additionalProperties: false,
      },
      /**
       * Successful response from `POST /api/invoices/:id/approve`.
       */
      InvoiceStateApproveResponse: {
        type: 'object',
        required: ['data', 'meta', 'error', 'message'],
        properties: {
          data: {
            type: 'object',
            required: [
              'invoiceId',
              'previousState',
              'currentState',
              'transitionedAt',
              'transitionedBy',
              'auditLogId',
            ],
            properties: {
              invoiceId: { type: 'string', minLength: 1 },
              previousState: { type: 'string' },
              currentState: { type: 'string' },
              transitionedAt: { type: 'string' },
              transitionedBy: { type: 'string' },
              auditLogId: { type: 'string' },
            },
            additionalProperties: false,
          },
          meta: {
            type: 'object',
            required: ['timestamp', 'version'],
            properties: {
              timestamp: { type: 'string' },
              version: { type: 'string' },
            },
            additionalProperties: false,
          },
          error: { type: 'null' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * Successful response from `POST /api/invoices/:id/link-escrow`.
       */
      InvoiceStateLinkEscrowResponse: {
        type: 'object',
        required: ['data', 'meta', 'error', 'message'],
        properties: {
          data: {
            type: 'object',
            required: [
              'invoiceId',
              'previousState',
              'currentState',
              'escrowId',
              'transitionedAt',
              'transitionedBy',
              'auditLogId',
            ],
            properties: {
              invoiceId: { type: 'string', minLength: 1 },
              previousState: { type: 'string' },
              currentState: { type: 'string' },
              escrowId: { type: ['string', 'null'] },
              transitionedAt: { type: 'string' },
              transitionedBy: { type: 'string' },
              auditLogId: { type: 'string' },
            },
            additionalProperties: false,
          },
          meta: {
            type: 'object',
            required: ['timestamp', 'version'],
            properties: {
              timestamp: { type: 'string' },
              version: { type: 'string' },
            },
            additionalProperties: false,
          },
          error: { type: 'null' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * Successful response from `POST /api/invoices/:id/reject`.
       */
      InvoiceStateRejectResponse: {
        type: 'object',
        required: ['data', 'meta', 'error', 'message'],
        properties: {
          data: {
            type: 'object',
            required: [
              'invoiceId',
              'previousState',
              'currentState',
              'reason',
              'transitionedAt',
              'transitionedBy',
              'auditLogId',
            ],
            properties: {
              invoiceId: { type: 'string', minLength: 1 },
              previousState: { type: 'string' },
              currentState: { type: 'string' },
              reason: { type: 'string' },
              transitionedAt: { type: 'string' },
              transitionedBy: { type: 'string' },
              auditLogId: { type: 'string' },
            },
            additionalProperties: false,
          },
          meta: {
            type: 'object',
            required: ['timestamp', 'version'],
            properties: {
              timestamp: { type: 'string' },
              version: { type: 'string' },
            },
            additionalProperties: false,
          },
          error: { type: 'null' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * Successful response from `GET /api/invoices/:id/history`.
       */
      InvoiceStateHistoryResponse: {
        type: 'object',
        required: ['data', 'meta', 'error', 'message'],
        properties: {
          data: {
            type: 'object',
            required: ['invoiceId', 'currentState', 'transitions', 'totalTransitions'],
            properties: {
              invoiceId: { type: 'string', minLength: 1 },
              currentState: { type: 'string' },
              transitions: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'timestamp', 'actor'],
                  properties: {
                    id: { type: 'string' },
                    timestamp: { type: 'string' },
                    actor: { type: 'string' },
                    fromState: { type: 'string' },
                    toState: { type: 'string' },
                    reason: { type: 'string' },
                    ipAddress: { type: 'string' },
                  },
                  additionalProperties: false,
                },
              },
              totalTransitions: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
          meta: {
            type: 'object',
            required: ['timestamp', 'version'],
            properties: {
              timestamp: { type: 'string' },
              version: { type: 'string' },
            },
            additionalProperties: false,
          },
          error: { type: 'null' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      /**
       * Error response from invoice-state transition validation or execution failures.
       */
      InvoiceStateErrorResponse: {
        type: 'object',
        required: ['data', 'meta', 'error'],
        properties: {
          data: { type: 'null' },
          meta: {
            type: 'object',
            required: ['timestamp', 'version'],
            properties: {
              timestamp: { type: 'string' },
              version: { type: 'string' },
            },
            additionalProperties: false,
          },
          error: {
            type: 'object',
            required: ['message', 'code'],
            properties: {
              message: { type: 'string' },
              code: { type: 'string' },
              details: {
                type: ['object', 'null'],
                additionalProperties: true,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    responses: {
      Problem400: {
        description: 'Validation error (RFC 7807)',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      },
      Problem401: {
        description: 'Unauthorized (RFC 7807)',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      },
      Problem403: {
        description: 'Forbidden — typically KYC gate failure (RFC 7807)',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        },
      },
      CorsRejection403: {
        description: 'CORS origin rejection',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CorsRejection' },
          },
        },
      },
    },
  },
  paths: {},
};

let cached = null;

/**
 * Build the OpenAPI document. The result is memoised because spec generation
 * walks every route file with `swagger-jsdoc` and is non-trivial.
 *
 * The `servers` array is derived at call time from `PUBLIC_API_BASE_URL` via
 * `buildServers()`, so the published spec always reflects the runtime
 * environment rather than a hardcoded localhost value.
 *
 * @returns {object} OpenAPI 3.0 document.
 * @throws {Error} In production when `PUBLIC_API_BASE_URL` is absent, uses
 *   HTTP, or resolves to a loopback address.
 */
function buildOpenApiSpec() {
  if (cached) {
    return cached;
  }

  // Resolve servers dynamically — must happen before swagger-jsdoc merges the
  // definition so the generated document carries the correct server entries.
  const servers = buildServers();

  const generated = swaggerJsdoc({
    definition: { ...baseDefinition, servers },
    apis: [ROUTES_GLOB],
  });

  // ── operationId Validation ─────────────────────────────────────────────────
  // Client SDK generators (openapi-typescript-codegen, @openapitools/openapi-generator-cli)
  // require every operation to have a unique operationId. Duplicate or missing
  // operationIds break SDK method generation and cause client-side confusion.

  const seenOperationIds = new Map(); // operationId -> { path, method }
  const missing = []; // { path, method }

  for (const [path, pathItem] of Object.entries(generated.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      const operationId = operation.operationId;

      if (!operationId) {
        missing.push({ path, method: method.toUpperCase() });
      } else {
        const firstSeen = seenOperationIds.get(operationId);
        if (firstSeen) {
          throw new Error(
            `Duplicate operationId "${operationId}" found:\n` +
              `  First:  ${firstSeen.method} ${firstSeen.path}\n` +
              `  Second: ${method.toUpperCase()} ${path}\n` +
              `Every operation must have a unique operationId.`,
          );
        }
        seenOperationIds.set(operationId, { path, method: method.toUpperCase() });
      }
    }
  }

  if (missing.length > 0) {
    const lines = missing.map(({ path, method }) => `  ${method} ${path}`);
    throw new Error(
      `The following operations are missing an operationId:\n${lines.join('\n')}\n\n` +
        `Add a unique operationId to each @swagger JSDoc block.\n` +
        `Example:\n` +
        `  @swagger\n` +
        `  /api/marketplace:\n` +
        `    get:\n` +
        `      operationId: listMarketplaceInvoices\n` +
        `      summary: ...\n`,
    );
  }

  cached = generated;
  return generated;
}

/**
 * Reset the memoised spec. Exposed for tests that mutate the spec.
 *
 * @returns {void}
 */
function _resetCache() {
  cached = null;
}

module.exports = {
  buildOpenApiSpec,
  buildServers,
  baseDefinition,
  _resetCache,
};
