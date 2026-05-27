'use strict';

/**
 * @fileoverview Helpers for OpenAPI contract tests.
 *
 * Provides:
 *   - `getValidator()` — a cached Ajv instance preloaded with the LiquiFact
 *     OpenAPI spec (built from `@swagger` annotations).
 *   - `assertResponse(method, pathTemplate, status, response)` — validates an
 *     HTTP response body against the response schema documented for that
 *     operation in the OpenAPI spec, failing the test with a readable diff
 *     when the actual response diverges from the documented contract.
 *   - `buildContractApp(overrides)` — assembles a slim Express app that mounts
 *     the routes under contract (`/api/marketplace`, `/api/invest/*`) with
 *     injectable service stubs, the standardized JSON envelope wrapper, and
 *     the RFC 7807 problem+json error handler.
 */

const express = require('express');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');
const { problemJsonHandler } = require('../../src/middleware/problemJson');

let cachedValidator = null;

/**
 * Compile and cache an Ajv validator preloaded with the OpenAPI spec.
 *
 * @returns {{ajv: import('ajv').default, spec: object}} Validator + spec.
 */
function getValidator() {
  if (cachedValidator) {
    return cachedValidator;
  }

  const spec = buildOpenApiSpec();
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);

  // Register each component schema under `#/components/schemas/*` so `$ref`s
  // in operation responses resolve cleanly when we compile per-operation
  // schemas below.
  const componentSchemas = (spec.components && spec.components.schemas) || {};
  for (const [name, schema] of Object.entries(componentSchemas)) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }

  cachedValidator = { ajv, spec };
  return cachedValidator;
}

/**
 * Resolve the JSON schema documented for a given operation/status code.
 * Follows a single `$ref` indirection when the operation references a
 * shared response under `components.responses` (e.g. `Problem401`).
 *
 * @param {object} spec - OpenAPI document.
 * @param {string} method - HTTP method (lowercase).
 * @param {string} pathTemplate - OpenAPI path template (e.g. `/api/marketplace`).
 * @param {number|string} status - HTTP status code.
 * @returns {object|null} JSON schema, or null when no schema is documented.
 */
function resolveResponseSchema(spec, method, pathTemplate, status) {
  const op = spec.paths && spec.paths[pathTemplate] && spec.paths[pathTemplate][method];
  if (!op || !op.responses) {
    return null;
  }

  let response = op.responses[String(status)];
  if (!response) {
    return null;
  }

  // Resolve `$ref` into `components.responses.*`.
  if (response.$ref) {
    const refName = response.$ref.split('/').pop();
    response = (spec.components && spec.components.responses && spec.components.responses[refName]) || null;
    if (!response) {
      return null;
    }
  }

  const content = response.content || {};
  const media =
    content['application/json'] ||
    content['application/problem+json'] ||
    Object.values(content)[0];

  return (media && media.schema) || null;
}

/**
 * Validate an HTTP response body against the documented OpenAPI schema for
 * the operation. Throws a Jest assertion error with the Ajv error list when
 * the response diverges from the contract.
 *
 * @param {string} method - HTTP method (e.g. `get`, `post`).
 * @param {string} pathTemplate - OpenAPI path template.
 * @param {number} status - Expected HTTP status code.
 * @param {object} response - Supertest response (`{status, body}`).
 * @returns {void}
 */
function assertResponse(method, pathTemplate, status, response) {
  const { ajv, spec } = getValidator();

  if (response.status !== status) {
    throw new Error(
      `Expected ${method.toUpperCase()} ${pathTemplate} -> ${status}, ` +
        `got ${response.status}. Body: ${JSON.stringify(response.body)}`,
    );
  }

  const schema = resolveResponseSchema(spec, method.toLowerCase(), pathTemplate, status);
  if (!schema) {
    throw new Error(
      `No documented response schema for ${method.toUpperCase()} ${pathTemplate} ${status}. ` +
        'Update the @swagger annotations on the route.',
    );
  }

  const validate = ajv.compile(schema);
  const valid = validate(response.body);
  if (!valid) {
    const details = JSON.stringify(validate.errors, null, 2);
    throw new Error(
      `Response for ${method.toUpperCase()} ${pathTemplate} ${status} does not match ` +
        `documented schema:\n${details}\nBody: ${JSON.stringify(response.body)}`,
    );
  }
}

/**
 * Build a slim Express app that mounts the routes covered by the contract
 * tests with injectable service stubs. Avoids touching the real database or
 * KYC provider so the contract tests stay deterministic and hermetic.
 *
 * @param {object} [overrides] - Stub overrides.
 * @param {Function} [overrides.marketplaceList] - Stub for
 *   `marketplaceService.getMarketplaceInvoices`.
 * @param {Function} [overrides.investOpportunities] - Stub for
 *   `investService.getOpportunities`.
 * @param {Function} [overrides.investList] - Stub for
 *   `investService.listInvestments`.
 * @param {Function} [overrides.kycStatus] - Stub for `kycService.getKycStatus`.
 * @param {Function} [overrides.authMiddleware] - Replacement for
 *   `authenticateToken` (defaults to a stub that attaches a test user).
 * @returns {import('express').Express} Express app.
 */
function buildContractApp(overrides = {}) {
  jest.resetModules();

  const marketplaceServicePath = require.resolve('../../src/services/marketplaceService');
  const investServicePath = require.resolve('../../src/services/investService');
  const kycServicePath = require.resolve('../../src/services/kycService');
  const authPath = require.resolve('../../src/middleware/auth');

  jest.doMock(marketplaceServicePath, () => ({
    getMarketplaceInvoices:
      overrides.marketplaceList ||
      jest.fn(async () => ({
        data: [],
        meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
      })),
  }));

  jest.doMock(investServicePath, () => ({
    getOpportunities:
      overrides.investOpportunities ||
      jest.fn(async () => ({
        data: [],
        meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
      })),
    listInvestments:
      overrides.investList ||
      jest.fn(async () => ({
        data: [],
        meta: { limit: 10, next_cursor: null, count: 0, has_more: false },
      })),
  }));

  jest.doMock(kycServicePath, () => ({
    getKycStatus:
      overrides.kycStatus ||
      jest.fn(async () => ({
        status: 'verified',
        recordId: 'kyc_test',
        verifiedAt: '2026-01-01T00:00:00Z',
      })),
    canFundWithKycStatus: (status) => status === 'verified' || status === 'exempted',
  }));

  if (overrides.authMiddleware) {
    jest.doMock(authPath, () => ({ authenticateToken: overrides.authMiddleware }));
  }

  const marketplaceRouter = require('../../src/routes/marketplace');
  const investRouter = require('../../src/routes/invest');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'test-request-id';
    next();
  });
  app.use('/api/marketplace', marketplaceRouter);
  app.use('/api/invest', investRouter);
  app.use(problemJsonHandler);

  return app;
}

module.exports = {
  getValidator,
  assertResponse,
  resolveResponseSchema,
  buildContractApp,
};
