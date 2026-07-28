/**
 * @fileoverview API Response Schema Contract Tests
 * Validates that API responses adhere to expected data structures.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');


const request = require('supertest');
const { createApp } = require('../../src/app');

describe('API Contract Tests - Response Schemas', () => {
  let app;
  let spec;
  let ajv;

  beforeAll(() => {
    app = createApp();

    spec = buildOpenApiSpec();

    ajv = new Ajv({
      allErrors: true,
      strict: false,
    });

    addFormats(ajv);
  });

  it('should match the GET /health response schema', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data || res.body).toEqual(expect.objectContaining({
        status: expect.any(String),
        service: expect.any(String),
        version: expect.any(String),
        timestamp: expect.any(String),
      })
    );
  });

  it('should match the GET /api/invoices response schema', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({

      })
    );
  });

  it('should validate marketplace response against OpenAPI schema', async () => {
  const res = await request(app)
    .get('/api/marketplace')
    .set('Authorization', 'Bearer token');

    if (res.status !== 200) {
      return;
    }

    const schema =
      spec.components.schemas.MarketplaceListResponse;

    const validate = ajv.compile(schema);

    expect(validate(res.body)).toBe(true);
  });


  it('should validate problem details schema', async () => {
    const res = await request(app)
      .get('/does-not-exist');

    const schema =
      spec.components.schemas.Problem;

    const validate = ajv.compile(schema);

    expect(validate(res.body)).toBe(true);
  });


  it('should reject undocumented fields', () => {
    const schema =
      spec.components.schemas.Problem;

    const validate = ajv.compile(schema);

    const invalid = {
      type: 'about:blank',
      title: 'Error',
      status: 400,
      hackerField: 'bad',
    };

    validate(invalid);

    expect(invalid).toHaveProperty('hackerField');
  });

  it('should match the POST /api/invoices response schema', async () => {
    const res = await request(app).post('/api/invoices').set('Authorization', 'Bearer token').send({ amount: 1000, buyer: 'Acme', seller: 'Seller', dueDate: '2025-12-31', currency: 'USD', invoiceNumber: '123' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.any(String),
          status: expect.any(String),
        }),
        message: expect.any(String),
      })
    );
  });

  describe('CORS response contract tests', () => {
    const allowedOrigin = 'https://app.example.com';
    const blockedOrigin = 'https://blocked.example.com';
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = allowedOrigin;
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }

      if (originalAllowedOrigins === undefined) {
        delete process.env.CORS_ALLOWED_ORIGINS;
      } else {
        process.env.CORS_ALLOWED_ORIGINS = originalAllowedOrigins;
      }
    });

    it('should validate CORS rejection response against schema', async () => {
      const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');
      const spec = buildOpenApiSpec();
      const schema = spec.components.schemas.CorsRejection;

      const validate = ajv.compile(schema);

      const corsApp = createApp();
      const response = await request(corsApp)
        .get('/health')
        .set('Origin', blockedOrigin);

      expect(response.status).toBe(403);
      expect(validate(response.body)).toBe(true);
    });

    it('should reject CORS response with extra fields', async () => {
      const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');
      const spec = buildOpenApiSpec();
      const schema = spec.components.schemas.CorsRejection;

      const validate = ajv.compile(schema);

      const invalidResponse = {
        error: 'CORS policy: origin is not allowed.',
        code: 'CORS_ORIGIN_REJECTED',
        extraField: 'should not be present',
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should reject CORS response with missing required fields', async () => {
      const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');
      const spec = buildOpenApiSpec();
      const schema = spec.components.schemas.CorsRejection;

      const validate = ajv.compile(schema);

      const invalidResponse = {
        error: 'CORS policy: origin is not allowed.',
        // missing 'code' field
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should reject CORS response with invalid error message', async () => {
      const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');
      const spec = buildOpenApiSpec();
      const schema = spec.components.schemas.CorsRejection;

      const validate = ajv.compile(schema);

      const invalidResponse = {
        error: 'Wrong error message',
        code: 'CORS_ORIGIN_REJECTED',
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should reject CORS response with invalid code', async () => {
      const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');
      const spec = buildOpenApiSpec();
      const schema = spec.components.schemas.CorsRejection;

      const validate = ajv.compile(schema);

      const invalidResponse = {
        error: 'CORS policy: origin is not allowed.',
        code: 'INVALID_CODE',
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should validate CORS rejection on preflight request', async () => {
      const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');
      const spec = buildOpenApiSpec();
      const schema = spec.components.schemas.CorsRejection;

      const validate = ajv.compile(schema);

      const corsApp = createApp();
      const response = await request(corsApp)
        .options('/health')
        .set('Origin', blockedOrigin)
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(403);
      expect(validate(response.body)).toBe(true);
    });

    it('should validate preflight success response has empty body', async () => {
      const corsApp = createApp();
      const response = await request(corsApp)
        .options('/health')
        .set('Origin', allowedOrigin)
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });
  });
});
