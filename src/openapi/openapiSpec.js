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
 * @module openapi/openapiSpec
 */

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

const ROUTES_GLOB = path.join(__dirname, '..', 'routes', '**', '*.js');

/**
 * Base OpenAPI document. Route-specific operations are merged in by
 * `swagger-jsdoc` from the `@swagger` JSDoc blocks in route files.
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
  servers: [{ url: 'http://localhost:3001', description: 'Local development' }],
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
        additionalProperties: true,
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
            additionalProperties: true,
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
            additionalProperties: true,
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
            additionalProperties: true,
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
        additionalProperties: true,
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
    },
  },
  paths: {},
};

let cached = null;

/**
 * Build the OpenAPI document. The result is memoised because spec generation
 * walks every route file with `swagger-jsdoc` and is non-trivial.
 *
 * @returns {object} OpenAPI 3.0 document.
 */
function buildOpenApiSpec() {
  if (cached) {
    return cached;
  }

  const generated = swaggerJsdoc({
    definition: baseDefinition,
    apis: [ROUTES_GLOB],
  });

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
  baseDefinition,
  _resetCache,
};
