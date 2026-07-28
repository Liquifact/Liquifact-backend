'use strict';

/**
 * @fileoverview Unit and integration tests for KYC webhook audit logging.
 * Covers CREATE, UPDATE, DELETE (soft delete), RESTORE, PURGE, secret redaction,
 * and read view endpoints (GET /api/kyc/webhooks/audit and GET /api/admin/kyc/webhooks/audit).
 */

const express = require('express');
const request = require('supertest');
const knex = require('knex');

const mockDb = require('../../src/db/knex');
const kycService = require('../../src/services/kycService');
const {
  softDeleteKycWebhook,
  restoreKycWebhook,
  purgeExpiredSoftDeletes,
} = require('../../src/services/kycWebhookSoftDelete');
const { getAuditLogs, createAuditLog } = require('../../src/services/auditLog');
const { redactValue, appendAuditEvent } = require('../../src/services/auditLogStore');
const kycRoutes = require('../../src/routes/kyc');
const adminKycRoutes = require('../../src/routes/adminKyc');

const realDb = knex({
  client: 'sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
});

let originalMockImpl;

beforeAll(async () => {
  originalMockImpl = mockDb.getMockImplementation?.();

  mockDb.mockImplementation((table) => realDb(table));
  mockDb.raw = realDb.raw;
  mockDb.schema = realDb.schema;
  mockDb.migrate = realDb.migrate;
  mockDb.fn = realDb.fn;
  mockDb.transaction = realDb.transaction;

  // Create kyc_records table
  await realDb.schema.createTableIfNotExists('kyc_records', (table) => {
    table.string('sme_id').primary();
    table.string('status').notNullable();
    table.string('provider_record_id');
    table.timestamp('verified_at');
    table.timestamp('updated_at');
    table.timestamp('deleted_at');
    table.string('deleted_by');
    table.text('delete_reason');
    table.timestamp('restored_at');
    table.string('restored_by');
  });

  // Create audit_log_events table
  await realDb.schema.createTableIfNotExists('audit_log_events', (table) => {
    table.increments('id').primary();
    table.string('event_type', 64);
    table.string('action', 128);
    table.string('actor_type', 64);
    table.string('actor_id', 255);
    table.string('target_type', 128);
    table.string('target_id', 255);
    table.string('request_id', 128);
    table.text('route');
    table.string('method', 16);
    table.integer('status_code');
    table.string('ip_address', 64);
    table.text('user_agent');
    table.text('metadata');
    table.timestamp('created_at').defaultTo(realDb.fn.now());
  });
});

afterAll(async () => {
  if (originalMockImpl) {
    mockDb.mockImplementation(originalMockImpl);
  }
  await realDb.destroy();
});

beforeEach(async () => {
  await realDb('kyc_records').del();
  await realDb('audit_log_events').del();
  kycService.resetMockRecords();
  process.env.KYC_WEBHOOK_ENABLED = 'true';
  process.env.KYC_PROVIDER_SECRET = 'test-secret-key-12345';
});

describe('KYC Webhooks Audit Trail', () => {

  describe('1. Service level mutation audit logging (CREATE, UPDATE, DELETE, RESTORE, PURGE)', () => {
    it('creates an audit log with action CREATE on new KYC record persistence', async () => {
      const smeId = 'sme_audit_create_01';
      const result = await kycService.persistKycRecord(
        { smeId, status: 'verified', providerRecordId: 'rec_100' },
        { actor: 'admin_user_1', ipAddress: '127.0.0.1', userAgent: 'test-agent' }
      );

      expect(result.smeId).toBe(smeId);
      expect(result.status).toBe('verified');

      const logs = await getAuditLogs({ resourceType: 'kyc-webhook', resourceId: smeId });
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('CREATE');
      expect(logs[0].actor).toBe('admin_user_1');
      expect(logs[0].resourceId).toBe(smeId);
      expect(logs[0].changes.before).toBeNull();
      expect(logs[0].changes.after.status).toBe('verified');
    });

    it('creates an audit log with action UPDATE when updating an existing KYC record', async () => {
      const smeId = 'sme_audit_update_01';
      await kycService.persistKycRecord({ smeId, status: 'pending' }, { actor: 'system' });
      await kycService.persistKycRecord({ smeId, status: 'verified' }, { actor: 'webhook_worker' });

      const logs = await getAuditLogs({ resourceType: 'kyc-webhook', resourceId: smeId });
      expect(logs).toHaveLength(2);
      // Returned ordered by created_at desc
      const updateLog = logs.find((l) => l.action === 'UPDATE');
      expect(updateLog).toBeDefined();
      expect(updateLog.actor).toBe('webhook_worker');
      expect(updateLog.changes.before.status).toBe('pending');
      expect(updateLog.changes.after.status).toBe('verified');
    });

    it('creates an audit log with action DELETE on soft deleting a KYC record', async () => {
      const smeId = 'sme_audit_delete_01';
      await kycService.persistKycRecord({ smeId, status: 'verified' });

      await softDeleteKycWebhook(smeId, { actor: 'operator_007', reason: 'Duplicated entity' });

      const logs = await getAuditLogs({ resourceType: 'kyc-webhook', resourceId: smeId, action: 'DELETE' });
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('DELETE');
      expect(logs[0].actor).toBe('operator_007');
      expect(logs[0].changes.after.deleted).toBe(true);
      expect(logs[0].changes.after.deleteReason).toBe('Duplicated entity');
    });

    it('creates an audit log with action UPDATE on restoring a soft-deleted KYC record', async () => {
      const smeId = 'sme_audit_restore_01';
      await kycService.persistKycRecord({ smeId, status: 'verified' });
      await softDeleteKycWebhook(smeId, { actor: 'operator_007' });

      await restoreKycWebhook(smeId, { actor: 'operator_008' });

      const logs = await getAuditLogs({ resourceType: 'kyc-webhook', resourceId: smeId });
      const restoreLog = logs.find((l) => l.action === 'UPDATE' && l.actor === 'operator_008');
      expect(restoreLog).toBeDefined();
      expect(restoreLog.changes.before.deleted).toBe(true);
      expect(restoreLog.changes.after.deleted).toBe(false);
    });

    it('creates an audit log with action DELETE for each record purged', async () => {
      const smeId = 'sme_audit_purge_01';
      await kycService.persistKycRecord({ smeId, status: 'rejected' });
      const pastNow = Date.now() - 31 * 24 * 60 * 60 * 1000;
      await softDeleteKycWebhook(smeId, { actor: 'admin', now: pastNow });

      const summary = await purgeExpiredSoftDeletes({ now: Date.now(), actor: 'purge_job' });
      expect(summary.purged).toBe(1);

      const logs = await getAuditLogs({ resourceType: 'kyc-webhook', resourceId: smeId, action: 'DELETE' });
      const purgeLog = logs.find((l) => l.actor === 'purge_job');
      expect(purgeLog).toBeDefined();
      expect(purgeLog.resourceId).toBe(smeId);
    });
  });

  describe('2. Secret Redaction in Audit Entries', () => {
    it('redacts sensitive fields like apiKey, secret, password, token in metadata and state', async () => {
      const smeId = 'sme_audit_secret_01';
      await kycService.persistKycRecord(
        { smeId, status: 'verified' },
        {
          actor: 'admin',
          metadata: {
            apiKey: 'super-secret-key-999',
            password: 'my-password-123',
            customInfo: 'safe_value',
          },
        }
      );

      const logs = await getAuditLogs({ resourceType: 'kyc-webhook', resourceId: smeId });
      expect(logs).toHaveLength(1);
      const metadata = logs[0].metadata;
      expect(metadata.apiKey).toBe('***REDACTED***');
      expect(metadata.password).toBe('***REDACTED***');
      expect(metadata.customInfo).toBe('safe_value');
    });

    it('redacts secrets when passing objects through redactValue', () => {
      const sensitiveObj = {
        smeId: 'sme_123',
        api_key: 'secret_api_key_abc',
        authorization: 'Bearer token123',
        nested: {
          private_key: '---PEM PRIVATE KEY---',
          normalField: 'ok',
        },
      };

      const sanitized = redactValue(sensitiveObj);
      expect(sanitized.api_key).toBe('***REDACTED***');
      expect(sanitized.authorization).toBe('***REDACTED***');
      expect(sanitized.nested.private_key).toBe('***REDACTED***');
      expect(sanitized.nested.normalField).toBe('ok');
    });
  });

  describe('3. HTTP Read View Endpoints (GET /api/kyc/webhooks/audit & GET /api/admin/kyc/webhooks/audit)', () => {
    let app;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/kyc', kycRoutes);
      app.use('/api/admin/kyc', adminKycRoutes);
      app.use((err, req, res, _next) => {
        res.status(err.status || 500).json({ error: err.message || 'Error', code: err.code });
      });
    });

    it('GET /api/kyc/webhooks/audit returns audit log entries for kyc-webhooks', async () => {
      await kycService.persistKycRecord({ smeId: 'sme_http_01', status: 'verified' });
      await kycService.persistKycRecord({ smeId: 'sme_http_02', status: 'pending' });

      const res = await request(app).get('/api/kyc/webhooks/audit');
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.meta).toEqual(
        expect.objectContaining({
          limit: 20,
          offset: 0,
          count: expect.any(Number),
        })
      );
    });

    it('GET /api/kyc/webhooks/audit filters by smeId and action', async () => {
      await kycService.persistKycRecord({ smeId: 'sme_target', status: 'pending' });
      await kycService.persistKycRecord({ smeId: 'sme_target', status: 'verified' });
      await kycService.persistKycRecord({ smeId: 'sme_other', status: 'verified' });

      const res = await request(app).get('/api/kyc/webhooks/audit?smeId=sme_target&action=UPDATE');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].resourceId).toBe('sme_target');
      expect(res.body.data[0].action).toBe('UPDATE');
    });

    it('GET /api/kyc/webhooks/audit enforces pagination limit bounds (1..100)', async () => {
      const resHigh = await request(app).get('/api/kyc/webhooks/audit?limit=500');
      expect(resHigh.status).toBe(400);

      const resLow = await request(app).get('/api/kyc/webhooks/audit?limit=0');
      expect(resLow.status).toBe(400);

      const resValid = await request(app).get('/api/kyc/webhooks/audit?limit=50');
      expect(resValid.status).toBe(200);
      expect(resValid.body.meta.limit).toBe(50);
    });

    it('GET /api/admin/kyc/webhooks/audit returns audit log entries via admin route', async () => {
      await kycService.persistKycRecord({ smeId: 'sme_admin_read', status: 'verified' });

      const res = await request(app).get('/api/admin/kyc/webhooks/audit');
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.some((l) => l.resourceId === 'sme_admin_read')).toBe(true);
    });

    it('GET /api/admin/kyc/webhooks/audit rejects invalid limit or negative offset', async () => {
      const resBadLimit = await request(app).get('/api/admin/kyc/webhooks/audit?limit=invalid');
      expect(resBadLimit.status).toBe(400);

      const resNegOffset = await request(app).get('/api/admin/kyc/webhooks/audit?offset=-5');
      expect(resNegOffset.status).toBe(400);
    });
  });
});
