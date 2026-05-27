'use strict';

/**
 * @fileoverview Tests for the OpenAPI document built from the `@swagger`
 * JSDoc annotations across `src/routes/**`. Verifies that the spec is
 * structurally valid, contains the expected paths and components, and
 * exposes the standardized envelope and RFC 7807 problem schemas referenced
 * by the contract tests.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { buildOpenApiSpec, _resetCache } = require('../src/openapi/openapiSpec');

describe('OpenAPI document', () => {
  let spec;

  beforeAll(() => {
    _resetCache();
    spec = buildOpenApiSpec();
  });

  it('returns a valid OpenAPI 3.0 envelope', () => {
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toBe('LiquiFact API');
    expect(spec.info.version).toBe('1.0.0');
    expect(spec.servers).toBeDefined();
    expect(Array.isArray(spec.servers)).toBe(true);
  });

  it('defines the bearer security scheme', () => {
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.type).toBe('http');
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('exposes shared envelope and RFC 7807 problem schemas', () => {
    const { schemas } = spec.components;
    expect(schemas.StandardEnvelope).toBeDefined();
    expect(schemas.MarketplaceListResponse).toBeDefined();
    expect(schemas.FundInvoiceResponse).toBeDefined();
    expect(schemas.Problem).toBeDefined();
    expect(schemas.Invoice).toBeDefined();
    expect(schemas.EscrowState).toBeDefined();
  });

  it('exposes reusable problem responses for 400/401/403', () => {
    const { responses } = spec.components;
    expect(responses.Problem400).toBeDefined();
    expect(responses.Problem401).toBeDefined();
    expect(responses.Problem403).toBeDefined();
    for (const name of ['Problem400', 'Problem401', 'Problem403']) {
      const media = responses[name].content['application/problem+json'];
      expect(media.schema.$ref).toBe('#/components/schemas/Problem');
    }
  });

  it('documents the marketplace and invest endpoints from @swagger blocks', () => {
    expect(spec.paths['/api/marketplace']).toBeDefined();
    expect(spec.paths['/api/marketplace'].get).toBeDefined();

    expect(spec.paths['/api/invest/opportunities']).toBeDefined();
    expect(spec.paths['/api/invest/opportunities'].get).toBeDefined();

    expect(spec.paths['/api/invest/list']).toBeDefined();
    expect(spec.paths['/api/invest/list'].get).toBeDefined();

    expect(spec.paths['/api/invest/fund-invoice']).toBeDefined();
    expect(spec.paths['/api/invest/fund-invoice'].post).toBeDefined();
  });

  it('binds marketplace 200 to the MarketplaceListResponse schema', () => {
    const op = spec.paths['/api/marketplace'].get;
    const response200 = op.responses['200'];
    expect(response200.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/MarketplaceListResponse',
    );
  });

  it('binds fund-invoice 201 to the FundInvoiceResponse schema', () => {
    const op = spec.paths['/api/invest/fund-invoice'].post;
    const response201 = op.responses['201'];
    expect(response201.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/FundInvoiceResponse',
    );
  });

  it('binds 4xx error responses on protected routes to the shared Problem responses', () => {
    const fundOp = spec.paths['/api/invest/fund-invoice'].post;
    expect(fundOp.responses['400'].$ref).toBe('#/components/responses/Problem400');
    expect(fundOp.responses['401'].$ref).toBe('#/components/responses/Problem401');
    expect(fundOp.responses['403'].$ref).toBe('#/components/responses/Problem403');

    const marketplaceOp = spec.paths['/api/marketplace'].get;
    expect(marketplaceOp.responses['400'].$ref).toBe('#/components/responses/Problem400');
    expect(marketplaceOp.responses['401'].$ref).toBe('#/components/responses/Problem401');
  });

  it('marks protected operations as requiring bearerAuth', () => {
    const protectedOps = [
      spec.paths['/api/marketplace'].get,
      spec.paths['/api/invest/opportunities'].get,
      spec.paths['/api/invest/list'].get,
      spec.paths['/api/invest/fund-invoice'].post,
    ];
    for (const op of protectedOps) {
      expect(op.security).toEqual(expect.arrayContaining([{ bearerAuth: [] }]));
    }
  });

  it('every component schema is a valid JSON schema accepted by Ajv', () => {
    const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
    addFormats(ajv);

    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      expect(() => ajv.compile(schema)).not.toThrow(
        new Error(`schema ${name} failed to compile`),
      );
    }
  });
});
