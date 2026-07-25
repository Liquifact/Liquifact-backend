'use strict';

/**
 * Integration tests for health endpoint input validation.
 *
 * Covers:
 * - Request body rejection on GET endpoints
 * - Unknown query parameter rejection
 * - RFC 7807 compliant error responses
 */

const request = require('supertest');
const { createApp } = require('../src/app');

describe('Health endpoint input validation', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  describe('Request body rejection on GET endpoints', () => {
    const testEndpoints = ['/health', '/healthz', '/ready', '/readyz'];

    testEndpoints.forEach((endpoint) => {
      it(`rejects request body on GET ${endpoint} with 400`, async () => {
        const res = await request(app)
          .get(endpoint)
          .send({ unexpected: 'body' })
          .set('Content-Type', 'application/json');

        expect(res.status).toBe(400);
        expect(res.body.type).toBe('https://liquifact.io/problems/validation-error');
        expect(res.body.title).toBe('Validation Error');
        expect(res.body.status).toBe(400);
        expect(res.body.detail).toBe('GET/HEAD requests must not include a request body.');
        expect(res.body.fieldErrors).toBeDefined();
        expect(res.body.fieldErrors.body).toContain('Request body is not allowed on GET/HEAD requests');
      });
    });
  });

  describe('Unknown query parameter rejection', () => {
    const testEndpoints = ['/health', '/healthz', '/ready', '/readyz'];

    testEndpoints.forEach((endpoint) => {
      it(`rejects unknown query parameters on ${endpoint} with 400`, async () => {
        const res = await request(app)
          .get(`${endpoint}?unknown=param`);

        expect(res.status).toBe(400);
        expect(res.body.type).toBe('https://liquifact.io/problems/validation-error');
        expect(res.body.title).toBe('Validation Error');
        expect(res.body.status).toBe(400);
        expect(res.body.detail).toBe('Query parameters contain invalid or unknown fields.');
        expect(res.body.fieldErrors).toBeDefined();
        // Zod strict() reports unknown keys at root level with empty path
        expect(res.body.fieldErrors['']).toContain('Unrecognized key: "unknown"');
      });

      it(`rejects multiple unknown query parameters on ${endpoint}`, async () => {
        const res = await request(app)
          .get(`${endpoint}?param1=value1&param2=value2`);

        expect(res.status).toBe(400);
        // Both unknown params appear at root level, combined in one message
        expect(res.body.fieldErrors['']).toContain('Unrecognized keys: "param1", "param2"');
      });
    });
  });

  describe('Valid requests still work', () => {
    it('GET /health returns 200 with no query params', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('liquifact-api');
    });

    it('GET /healthz returns 200 with no query params', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /ready returns 200 or 503 (depends on deps)', async () => {
      const res = await request(app).get('/ready');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('ready');
      expect(res.body).toHaveProperty('service', 'liquifact-api');
    });

    it('GET /readyz returns 200 or 503', async () => {
      const res = await request(app).get('/readyz');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('ready');
      expect(res.body).toHaveProperty('service', 'liquifact-api');
    });
  });

  describe('RFC 7807 error response structure', () => {
    it('body rejection includes all required RFC 7807 fields', async () => {
      const res = await request(app)
        .get('/health')
        .send({ test: 'body' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.type).toMatch(/^https?:\/\//);
      expect(res.body.title).toBe('Validation Error');
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toBeDefined();
      expect(res.body.instance).toBeDefined();
      expect(res.body.fieldErrors).toBeDefined();
    });

    it('query param rejection includes all required RFC 7807 fields', async () => {
      const res = await request(app).get('/health?invalid=param');

      expect(res.status).toBe(400);
      expect(res.body.type).toMatch(/^https?:\/\//);
      expect(res.body.title).toBe('Validation Error');
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toBeDefined();
      expect(res.body.instance).toBeDefined();
      expect(res.body.fieldErrors).toBeDefined();
    });

    it('fieldErrors uses field path as key with array of messages', async () => {
      const res = await request(app).get('/health?foo=bar&baz=qux');

      expect(res.body.fieldErrors).toBeDefined();
      expect(Array.isArray(res.body.fieldErrors[''])).toBe(true);
      // Zod combines multiple unknown keys into one message
      expect(res.body.fieldErrors['']).toContain('Unrecognized keys: "foo", "baz"');
    });
  });

  describe('HEAD requests also reject bodies', () => {
    it.skip('HEAD requests with body are rejected by middleware', () => {
      // HEAD requests with body are not supported by supertest/superagent
      // The middleware handles it but we can't test via supertest
    });
  });
});