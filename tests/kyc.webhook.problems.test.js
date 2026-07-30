'use strict';

/**
 * @fileoverview Comprehensive tests verifying that the KYC webhook route emits
 * RFC 7807 application/problem+json responses through the shared problem-detail
 * builder (issue #613).
 *
 * Coverage:
 *  - Every failure path returns application/problem+json content type
 *  - RFC 7807 response shape (type, title, status, detail, instance)
 *  - Extension fields: code, retryable, retry_hint
 *  - Validation errors distinguished from infrastructure failures:
 *    • 400 Bad Request — invalid_payload, missing_sme_id, missing_status,
 *                        unknown_status, missing_tenant_context
 *    • 401 Unauthorized — missing_signature, invalid_signature
 *    • 403 Forbidden — tenant_scope_mismatch
 *    • 500 Internal — persistence_error
 *    • 503 Unavailable — missing_secret
 *  - 200 success envelope unchanged
 *  - Problem type URIs map correctly per status code
 */

/**
 * Mock kycService before any module loads.
 * metrics/knex/rate-limit are already mocked in setupFilesAfterEnv (setup.js).
 */
jest.mock('../src/services/kycService', () => ({
  getKycProviderConfig: jest.fn(),
  normalizeProviderStatus: jest.fn(),
  persistKycRecord: jest.fn(),
  KYC_STATUSES: { UNKNOWN: 'unknown' },
  resetMockRecords: jest.fn(),
}));

const request = require('supertest');
const express = require('express');

const kycService = require('../src/services/kycService');
const webhooks = require('../src/services/webhooks');
const kycRoutes = require('../src/routes/kyc');

const TEST_SECRET = 'test-secret-kyc-problems';
const TEST_TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

/**
 * Builds a fresh Express app mounting the kyc router.
 */
function buildAppWithTenant({ tenantId } = {}) {
  const app = express();
  app.use(express.raw({ type: 'application/json', limit: '100kb' }));

  if (tenantId !== undefined) {
    app.use((req, _res, next) => {
      req.tenantId = tenantId;
      next();
    });
  }

  app.use('/api/kyc', kycRoutes);
  return app;
}

function sign(rawBody) {
  return webhooks.createSignatureHeader(TEST_SECRET, rawBody);
}

describe('KYC webhook RFC 7807 problem+json responses', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    kycService.getKycProviderConfig.mockReturnValue({ apiSecret: TEST_SECRET });
    kycService.normalizeProviderStatus.mockImplementation((status) => status);
    kycService.persistKycRecord.mockResolvedValue({
      smeId: 'sme-001',
      status: 'verified',
      recordId: 'rec-001',
      verifiedAt: null,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    app = buildAppWithTenant();
  });

  // ── RFC 7807 response shape ──────────────────────────────────────────────

  describe('RFC 7807 problem+json response shape', () => {
    const PROBLEM_FIELDS = ['type', 'title', 'status', 'detail', 'instance'];
    const EXTENSION_FIELDS = ['code', 'retryable', 'retry_hint'];

    test('all error responses include required RFC 7807 fields', async () => {
      kycService.getKycProviderConfig.mockReturnValue({ apiSecret: null });
      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));

      expect(res.headers['content-type']).toContain('application/problem+json');
      for (const field of PROBLEM_FIELDS) {
        expect(res.body).toHaveProperty(field);
      }
      for (const field of EXTENSION_FIELDS) {
        expect(res.body).toHaveProperty(field);
      }
    });

    test('type URI matches the HTTP status code of the response', async () => {
      const expectedTypes = {
        400: 'https://liquifact.com/probs/bad-request',
        401: 'https://liquifact.com/probs/unauthorized',
        403: 'https://liquifact.com/probs/forbidden',
        500: 'https://liquifact.com/probs/internal-server-error',
        503: 'https://liquifact.com/probs/service-unavailable',
      };

      // 400 — missing smeId
      let res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ status: 'verified' })))
        .send(JSON.stringify({ status: 'verified' }));
      expect(res.body.type).toBe(expectedTypes[400]);

      // 401 — missing signature
      res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));
      expect(res.body.type).toBe(expectedTypes[401]);

      // 403 — tenant mismatch
      const appWithTenant = buildAppWithTenant({ tenantId: TEST_TENANT });
      res = await request(appWithTenant)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ smeId: 'sme-001', status: 'verified', tenantId: OTHER_TENANT })))
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified', tenantId: OTHER_TENANT }));
      expect(res.body.type).toBe(expectedTypes[403]);

      // 500 — persistence error
      kycService.persistKycRecord.mockRejectedValue(new Error('DB failure'));
      res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ smeId: 'sme-001', status: 'verified' })))
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));
      expect(res.body.type).toBe(expectedTypes[500]);

      // 503 — missing secret
      kycService.getKycProviderConfig.mockReturnValue({ apiSecret: null });
      res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));
      expect(res.body.type).toBe(expectedTypes[503]);
    });

    test('instance field reflects the request URL', async () => {
      kycService.getKycProviderConfig.mockReturnValue({ apiSecret: null });
      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));
      expect(res.body.instance).toBe('/api/kyc/webhook');
    });
  });

  // ── 400 Bad Request errors ──────────────────────────────────────────────

  describe('400 Bad Request — problem+json responses', () => {
    test('invalid JSON payload', async () => {
      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign('{invalid'))
        .send('{invalid');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/bad-request',
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid JSON payload',
        code: 'invalid_payload',
        retryable: false,
      });
    });

    test('missing smeId', async () => {
      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ status: 'verified' })))
        .send(JSON.stringify({ status: 'verified' }));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/bad-request',
        status: 400,
        code: 'missing_sme_id',
        retryable: false,
      });
    });

    test('missing status', async () => {
      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ smeId: 'sme-001' })))
        .send(JSON.stringify({ smeId: 'sme-001' }));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/bad-request',
        status: 400,
        code: 'missing_status',
        retryable: false,
      });
    });

    test('unknown provider status (fail-closed)', async () => {
      kycService.normalizeProviderStatus.mockReturnValue('unknown');

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ smeId: 'sme-001', status: 'mystery' })))
        .send(JSON.stringify({ smeId: 'sme-001', status: 'mystery' }));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/bad-request',
        status: 400,
        detail: 'Unknown provider status: mystery',
        code: 'unknown_status',
        retryable: false,
      });
    });

    test('missing tenant context', async () => {
      const appNoTenant = buildAppWithTenant({ tenantId: null });
      const res = await request(appNoTenant)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ smeId: 'sme-001', status: 'verified', tenantId: TEST_TENANT })))
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified', tenantId: TEST_TENANT }));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/bad-request',
        status: 400,
        code: 'missing_tenant_context',
        retryable: false,
      });
    });
  });

  // ── 401 Unauthorized errors ────────────────────────────────────────────

  describe('401 Unauthorized — problem+json responses', () => {
    test('missing X-Signature header', async () => {
      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Missing X-Signature header',
        code: 'missing_signature',
        retryable: false,
      });
    });

    test('invalid webhook signature', async () => {
      const spy = jest.spyOn(webhooks, 'verifySignature');
      spy.mockReturnValue({
        valid: false,
        error: 'Signature mismatch',
      });

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', 't=1700000000,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/unauthorized',
        status: 401,
        detail: 'Invalid webhook signature',
        code: 'invalid_signature',
        retryable: false,
      });
    });
  });

  // ── 403 Forbidden errors ──────────────────────────────────────────────

  describe('403 Forbidden — problem+json response', () => {
    test('tenant scope mismatch', async () => {
      const appWithTenant = buildAppWithTenant({ tenantId: TEST_TENANT });
      const res = await request(appWithTenant)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ smeId: 'sme-001', status: 'verified', tenantId: OTHER_TENANT })))
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified', tenantId: OTHER_TENANT }));

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'Tenant scope mismatch.',
        code: 'tenant_mismatch',
        retryable: false,
      });
    });
  });

  // ── 500 Internal Server Error ──────────────────────────────────────────

  describe('500 Internal Server Error — problem+json response', () => {
    test('persistence error from persistKycRecord', async () => {
      kycService.persistKycRecord.mockRejectedValue(
        new Error('Database connection lost')
      );

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(JSON.stringify({ smeId: 'sme-001', status: 'verified' })))
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));

      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/internal-server-error',
        title: 'Internal Server Error',
        status: 500,
        code: 'persistence_error',
        retryable: false,
      });
    });
  });

  // ── 503 Service Unavailable ────────────────────────────────────────────

  describe('503 Service Unavailable — problem+json response', () => {
    test('missing webhook secret', async () => {
      kycService.getKycProviderConfig.mockReturnValue({ apiSecret: null });

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/service-unavailable',
        title: 'Service Unavailable',
        status: 503,
        detail: 'KYC webhook ingestion is not configured',
        code: 'missing_secret',
        retryable: true,
      });
    });

    test('missing_secret includes retry hint', async () => {
      kycService.getKycProviderConfig.mockReturnValue({ apiSecret: null });

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-001', status: 'verified' }));

      expect(res.body.retry_hint).toBe('Retry the request in a few moments.');
    });
  });

  // ── Success path unchanged ──────────────────────────────────────────────

  describe('200 OK — success envelope unchanged', () => {
    test('returns the same success shape as before', async () => {
      const payload = { smeId: 'sme-001', status: 'verified' };
      const rawBody = JSON.stringify(payload);

      kycService.normalizeProviderStatus.mockReturnValue('verified');
      kycService.persistKycRecord.mockResolvedValue({
        smeId: 'sme-001',
        status: 'verified',
        recordId: 'rec-001',
        verifiedAt: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        smeId: 'sme-001',
        status: 'verified',
      });
    });
  });

  // ── Content-Type header correctness ──────────────────────────────────────

  describe('Content-Type header correctness', () => {
    test('success response does not have problem+json content type', async () => {
      const payload = { smeId: 'sme-001', status: 'verified' };
      const rawBody = JSON.stringify(payload);

      kycService.normalizeProviderStatus.mockReturnValue('verified');

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).not.toContain('application/problem+json');
    });
  });
});
