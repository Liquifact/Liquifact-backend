'use strict';

/**
 * @fileoverview Integration tests for KYC Webhook Quarantine (Issue #1197).
 *
 * Covers:
 *  - Edge case 1: invalid JSON
 *  - Edge case 2: valid envelope with invalid event
 *  - Edge case 3: oversized payload
 *  - Edge case 4: unknown event type
 *  - Edge case 5: sensitive fields in the quarantine record (redaction verification)
 *  - Success path: valid webhooks persist and are not quarantined
 *  - Authorized inspection: GET /api/admin/kyc/quarantine (listing, filtering, pagination)
 *  - Authorized inspection: GET /api/admin/kyc/quarantine/:id
 *  - Authorization & Tenant Isolation: unauthenticated, forbidden, cross-tenant isolation
 */

jest.mock('../src/services/kycService', () => ({
  getKycProviderConfig: jest.fn(),
  normalizeProviderStatus: jest.fn(),
  persistKycRecord: jest.fn(),
  KYC_STATUSES: { UNKNOWN: 'unknown', VERIFIED: 'verified', PENDING: 'pending', REJECTED: 'rejected' },
  resetMockRecords: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const kycService = require('../src/services/kycService');
const webhooks = require('../src/services/webhooks');
const kycRoutes = require('../src/routes/kyc');
const adminKycRoutes = require('../src/routes/adminKyc');
const { kycWebhookQuarantine } = require('../src/services/kycQuarantineService');

const TEST_SECRET = 'test-secret-quarantine-suite';
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'development-jwt-secret-not-for-production';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const db = require('../src/db/knex');

function sign(rawBody) {
  return webhooks.createSignatureHeader(TEST_SECRET, rawBody);
}

function generateAdminToken(tenantId = TENANT_A) {
  return jwt.sign(
    {
      sub: 'admin-user-1',
      userId: 'admin-user-1',
      role: 'admin',
      scope: 'admin',
      tenantId,
    },
    TEST_JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function buildApp({ tenantId = null } = {}) {
  const app = express();
  app.use(express.raw({ type: 'application/json', limit: '100kb' }));

  if (tenantId) {
    app.use((req, _res, next) => {
      req.tenantId = tenantId;
      next();
    });
  }

  app.use('/api/kyc', kycRoutes);
  app.use('/api/admin/kyc', adminKycRoutes);

  // Fallback error handler
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({
      type: err.type || 'https://liquifact.com/probs/internal-server-error',
      title: err.title || 'Error',
      status: err.status || 500,
      detail: err.detail || err.message,
    });
  });

  return app;
}

describe('KYC Webhook Quarantine — Integration Tests (Issue #1197)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    inMemoryQuarantineStore = [];
    kycService.getKycProviderConfig.mockReturnValue({ apiSecret: TEST_SECRET });
    kycService.normalizeProviderStatus.mockImplementation((status) => {
      if (status === 'verified' || status === 'approved') return 'verified';
      if (status === 'pending') return 'pending';
      if (status === 'rejected') return 'rejected';
      return 'unknown';
    });
    kycService.persistKycRecord.mockResolvedValue({
      smeId: 'sme-001',
      status: 'verified',
      recordId: 'rec-001',
      verifiedAt: null,
      updatedAt: new Date('2026-08-29T10:00:00.000Z'),
    });
    app = buildApp({ tenantId: TENANT_A });
    db('kyc_webhook_quarantine').delete();
  });

  // ── Edge Case 1: invalid JSON ──────────────────────────────────────────────

  describe('Edge case 1: invalid JSON', () => {
    test('quarantines malformed JSON and returns 400 Bad Request', async () => {
      const rawBody = '{ bad json content here';
      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        type: 'https://liquifact.com/probs/bad-request',
        code: 'invalid_payload',
        detail: 'Invalid JSON payload',
      });

      const rows = await db('kyc_webhook_quarantine');
      expect(rows).toHaveLength(1);
      const quarantined = rows[0];
      expect(quarantined.error_code).toBe('invalid_payload');
      expect(quarantined.reason).toBe('Invalid JSON payload');
      expect(quarantined.tenant_id).toBe(TENANT_A);
    });
  });

  // ── Edge Case 2: valid envelope with invalid event payload ─────────────────

  describe('Edge case 2: valid envelope with invalid event', () => {
    test('quarantines valid envelope having invalid event data (e.g. non-object data)', async () => {
      const payload = {
        event: 'kyc.verified',
        data: 'this-is-not-an-object',
      };
      const rawBody = JSON.stringify(payload);

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_payload');

      const rows = await db('kyc_webhook_quarantine');
      expect(rows).toHaveLength(1);
      const quarantined = rows[0];
      expect(quarantined.event).toBe('kyc.verified');
      expect(quarantined.reason).toMatch(/Invalid event data/i);
    });

    test('quarantines valid envelope missing required smeId in event data', async () => {
      const payload = {
        event: 'kyc.verified',
        data: { status: 'verified' },
      };
      const rawBody = JSON.stringify(payload);

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('missing_sme_id');

      const rows = await db('kyc_webhook_quarantine');
      expect(rows).toHaveLength(1);
      const quarantined = rows[0];
      expect(quarantined.error_code).toBe('missing_sme_id');
      expect(quarantined.reason).toBe('Missing or invalid smeId');
    });
  });

  // ── Edge Case 3: oversized payload ─────────────────────────────────────────

  describe('Edge case 3: oversized payload', () => {
    test('quarantines payload exceeding maximum byte limit with PAYLOAD_TOO_LARGE', async () => {
      process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = '100';

      const payload = {
        smeId: 'sme-001',
        status: 'verified',
        extraPadding: 'x'.repeat(200),
      };
      const rawBody = JSON.stringify(payload);

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');

      const rows = await db('kyc_webhook_quarantine');
      expect(rows).toHaveLength(1);
      const quarantined = rows[0];
      expect(quarantined.error_code).toBe('PAYLOAD_TOO_LARGE');
      expect(quarantined.reason).toBe('KYC webhook payload exceeds maximum size limit');
    });
  });

  // ── Edge Case 4: unknown event type ────────────────────────────────────────

  describe('Edge case 4: unknown event type', () => {
    test('quarantines payload with unknown event type', async () => {
      const payload = {
        event: 'billing.payment.completed',
        data: { smeId: 'sme-001', status: 'verified' },
      };
      const rawBody = JSON.stringify(payload);

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);

      const rows = await db('kyc_webhook_quarantine');
      expect(rows).toHaveLength(1);
      const quarantined = rows[0];
      expect(quarantined.error_code).toBe('unknown_event_type');
      expect(quarantined.event).toBe('billing.payment.completed');
      expect(quarantined.reason).toContain('Unknown KYC webhook event type');
    });
  });

  // ── Edge Case 5: sensitive fields in the quarantine record ─────────────────

  describe('Edge case 5: sensitive fields in the quarantine record', () => {
    test('redacts passwords, secrets, tokens, api keys, and SSNs in quarantine storage', async () => {
      const payload = {
        smeId: 'sme-sensitive',
        status: 'invalid_status_xyz',
        password: 'clear-text-password-1234',
        secret: 'super-confidential-secret',
        apiKey: 'api-key-value-secret',
        authToken: 'bearer-jwt-token-xyz',
        ssn: '000-12-3456',
        cardNumber: '4111222233334444',
      };
      const rawBody = JSON.stringify(payload);

      const res = await request(app)
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);

      const rows = await db('kyc_webhook_quarantine');
      expect(rows).toHaveLength(1);
      const quarantined = rows[0];
      const parsedStored = JSON.parse(quarantined.payload);

      expect(parsedStored.password).toBe('***REDACTED***');
      expect(parsedStored.secret).toBe('***REDACTED***');
      expect(parsedStored.apiKey).toBe('***REDACTED***');
      expect(parsedStored.authToken).toBe('***REDACTED***');
      expect(parsedStored.ssn).toBe('***REDACTED***');
      expect(parsedStored.cardNumber).toBe('***REDACTED***');
      expect(parsedStored.smeId).toBe('sme-sensitive');
    });
  });

  // ── Success path: valid webhooks are NOT quarantined ───────────────────────

  describe('Success path', () => {
    test('persists valid KYC webhook and does not write to quarantine', async () => {
      const payload = {
        smeId: 'sme-clean-01',
        status: 'verified',
        recordId: 'rec-123',
      };
      const rawBody = JSON.stringify(payload);

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

      const rows = await db('kyc_webhook_quarantine');
      expect(rows).toHaveLength(0);
    });
  });

  // ── Authorized Quarantine Inspection Routes ────────────────────────────────

  describe('Authorized inspection: GET /api/admin/kyc/quarantine', () => {
    beforeEach(() => {
      db('kyc_webhook_quarantine').delete();
      db('kyc_webhook_quarantine').insert([
        {
          id: 'quar-tenant-a-1',
          tenant_id: TENANT_A,
          sme_id: 'sme-001',
          event: 'kyc.verified',
          payload: JSON.stringify({ smeId: 'sme-001', status: 'unknown_status' }),
          raw_payload: '{"smeId":"sme-001"}',
          reason: 'Unknown provider status: unknown_status',
          error_code: 'unknown_status',
          error_details: null,
          actor: 'kyc-provider',
          ip_address: '1.2.3.4',
          user_agent: 'test-agent',
          created_at: new Date('2026-08-29T08:00:00.000Z'),
          updated_at: new Date('2026-08-29T08:00:00.000Z'),
        },
        {
          id: 'quar-tenant-a-2',
          tenant_id: TENANT_A,
          sme_id: 'sme-002',
          event: 'unknown',
          payload: JSON.stringify({ raw: '{ broken', malformed: true }),
          raw_payload: '{ broken',
          reason: 'Invalid JSON payload',
          error_code: 'invalid_payload',
          error_details: null,
          actor: 'kyc-provider',
          ip_address: '1.2.3.4',
          user_agent: 'test-agent',
          created_at: new Date('2026-08-29T07:00:00.000Z'),
          updated_at: new Date('2026-08-29T07:00:00.000Z'),
        },
        {
          id: 'quar-tenant-b-1',
          tenant_id: TENANT_B,
          sme_id: 'sme-003',
          event: 'kyc.rejected',
          payload: JSON.stringify({ smeId: 'sme-003', password: 'b-secret' }),
          raw_payload: '{"smeId":"sme-003"}',
          reason: 'Invalid payload',
          error_code: 'invalid_payload',
          error_details: null,
          actor: 'kyc-provider',
          ip_address: '5.6.7.8',
          user_agent: 'test-agent',
          created_at: new Date('2026-08-29T06:00:00.000Z'),
          updated_at: new Date('2026-08-29T06:00:00.000Z'),
        },
      ]);
    });

    test('admin with valid JWT can list quarantine records scoped to their tenant', async () => {
      const token = generateAdminToken(TENANT_A);

      const res = await request(app)
        .get('/api/admin/kyc/quarantine')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.map((r) => r.id)).toEqual(['quar-tenant-a-1', 'quar-tenant-a-2']);
      expect(res.body.meta).toMatchObject({
        limit: 20,
        count: 2,
      });
    });

    test('preserves tenant isolation: Tenant B only sees Tenant B records', async () => {
      const token = generateAdminToken(TENANT_B);

      const res = await request(app)
        .get('/api/admin/kyc/quarantine')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', TENANT_B);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('quar-tenant-b-1');
      expect(res.body.data[0].tenantId).toBe(TENANT_B);
    });

    test('rejects unauthenticated request with 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/admin/kyc/quarantine');

      expect(res.status).toBe(401);
    });

    test('validates pagination bounds: reject limit > 100 with 400', async () => {
      const token = generateAdminToken(TENANT_A);

      const res = await request(app)
        .get('/api/admin/kyc/quarantine?limit=500')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', TENANT_A);

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain('limit must be an integer between 1 and 100');
    });

    test('fetches single quarantine record by ID via GET /api/admin/kyc/quarantine/:id', async () => {
      const token = generateAdminToken(TENANT_A);

      const res = await request(app)
        .get('/api/admin/kyc/quarantine/quar-tenant-a-1')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBe('quar-tenant-a-1');
      expect(res.body.data.smeId).toBe('sme-001');
      expect(res.body.data.tenantId).toBe(TENANT_A);
    });

    test('returns 404 for nonexistent quarantine ID or cross-tenant record lookup', async () => {
      const token = generateAdminToken(TENANT_A);

      // Attempting to access Tenant B's record using Tenant A auth
      const res = await request(app)
        .get('/api/admin/kyc/quarantine/quar-tenant-b-1')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.body.detail).toContain('Quarantine record not found');
    });
  });
});
