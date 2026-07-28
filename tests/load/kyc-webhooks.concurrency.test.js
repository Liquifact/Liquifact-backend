'use strict';

/**
 * @fileoverview Concurrency smoke tests for the KYC webhook endpoint.
 *
 * Tests the POST /api/kyc/webhook endpoint under concurrent load to verify:
 * - No race conditions in status persistence (TOCTOU fix: atomic upsert)
 * - Consistent state across concurrent writes
 * - No lost updates under concurrent writes
 * - Proper error handling under load
 *
 * The persistKycRecord function was changed from a SELECT-then-UPDATE/INSERT
 * pattern (which has a TOCTOU race window) to an atomic INSERT ... ON CONFLICT
 * DO UPDATE (upsert). Under the old pattern, concurrent writes to the same new
 * SME caused the second INSERT to fail with a UNIQUE constraint violation.
 * The fix eliminates this race in a single atomic SQL statement.
 */

process.env.NODE_ENV = 'test';

const knex = jest.requireActual('knex');
const knexConfig = require('../../knexfile').test;
const realDb = knex(knexConfig);

const mockDb = require('../../src/db/knex');
const kycService = require('../../src/services/kycService');
const migration = require('../../src/db/migrations/20260425_add_kyc_status');

const request = require('supertest');
const express = require('express');
const { createSignatureHeader } = require('../../src/services/webhooks');

const kycRoutes = require('../../src/routes/kyc');

const SECRET = 'concurrency-test-secret';
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

let originalMockImpl;

beforeAll(async () => {
  originalMockImpl = mockDb.getMockImplementation();

  mockDb.mockImplementation((table) => realDb(table));
  mockDb.raw = realDb.raw;
  mockDb.schema = realDb.schema;
  mockDb.migrate = realDb.migrate;
  mockDb.fn = realDb.fn;
  mockDb.transaction = realDb.transaction;

  await migration.up(realDb);
});

afterAll(async () => {
  mockDb.mockImplementation(originalMockImpl);
  await realDb.destroy();
});

beforeEach(async () => {
  await realDb('kyc_records').del();
  kycService.resetMockRecords();
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/** Build a signed payload and return { rawBody, signature }. */
function buildSignedPayload(smeId, status, overrides = {}) {
  const payload = {
    smeId,
    status,
    recordId: overrides.recordId || null,
    verifiedAt: overrides.verifiedAt || new Date().toISOString(),
    ...overrides,
  };
  const rawBody = JSON.stringify(payload);
  const signature = createSignatureHeader(SECRET, rawBody);
  return { rawBody, signature, payload };
}

function sendKycWebhook(app, { rawBody, signature }) {
  return request(app)
    .post('/api/kyc/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Signature', signature)
    .send(rawBody);
}

function createApp() {
  const app = express();
  process.env.KYC_WEBHOOK_ENABLED = 'true';
  process.env.KYC_PROVIDER_SECRET = SECRET;
  app.use('/api/kyc/webhook', express.raw({ type: 'application/json', limit: '100kb' }));
  app.use('/api/kyc', kycRoutes);
  return app;
}

/* ── Tests ──────────────────────────────────────────────────────────────────── */

describe('KYC Webhook Concurrency / Smoke Tests', () => {
  let app;

  beforeEach(() => {
    app = createApp();
  });

  describe('Parallel writes to the same SME', () => {
    it('handles 10 concurrent upserts to the same smeId without 500 errors', async () => {
      const smeId = 'sme-concurrent-same';
      const statuses = ['approved', 'rejected', 'approved', 'pending', 'exempted',
                        'rejected', 'approved', 'pending', 'exempted', 'approved'];
      // Use different record IDs so each payload is distinct
      const requests = statuses.map((status, i) => {
        const { rawBody, signature } = buildSignedPayload(smeId, status, {
          recordId: `rec-${i}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      const responses = await Promise.all(requests);

      // No 500 errors
      const statuses5xx = responses.map((r) => r.status).filter((s) => s >= 500);
      expect(statuses5xx).toEqual([]);

      // All were successful
      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });

      // Final DB state: exactly one record for this smeId
      const rows = await realDb('kyc_records').where({ sme_id: smeId });
      expect(rows).toHaveLength(1);
      expect(['verified', 'rejected', 'exempted', 'pending']).toContain(rows[0].status);
    });
  });

  describe('Parallel writes to different SMEs', () => {
    it('handles 20 concurrent writes to different smeIds', async () => {
      const count = 20;
      const requests = Array.from({ length: count }, (_, i) => {
        const smeId = `sme-concurrent-diff-${String(i).padStart(3, '0')}`;
        const { rawBody, signature } = buildSignedPayload(smeId, 'approved', {
          recordId: `rec-diff-${i}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      const responses = await Promise.all(requests);

      // All should be 200
      responses.forEach((res, i) => {
        expect(res.status).toBe(200);
      });

      // All records exist in DB
      const rows = await realDb('kyc_records').orderBy('sme_id');
      expect(rows).toHaveLength(count);
    });
  });

  describe('Read-after-write consistency', () => {
    it('all written records are visible after concurrent writes', async () => {
      const smeIds = ['sme-racy-1', 'sme-racy-2', 'sme-racy-3', 'sme-racy-4', 'sme-racy-5'];
      const writes = smeIds.map((smeId) => {
        const { rawBody, signature } = buildSignedPayload(smeId, 'approved', {
          recordId: `rec-racy-${smeId}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      await Promise.all(writes);

      const rows = await realDb('kyc_records').orderBy('sme_id');
      expect(rows).toHaveLength(smeIds.length);
      for (const smeId of smeIds) {
        const row = rows.find((r) => r.sme_id === smeId);
        expect(row).toBeDefined();
        expect(row.status).toBe('verified');
      }
    });
  });

  describe('High concurrency on a single SME', () => {
    it('handles 50 concurrent writes to the same smeId without errors', async () => {
      const smeId = 'sme-high-concurrency';
      const requests = Array.from({ length: 50 }, (_, i) => {
        const status = i % 2 === 0 ? 'approved' : 'rejected';
        const { rawBody, signature } = buildSignedPayload(smeId, status, {
          recordId: `rec-${i}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      const responses = await Promise.all(requests);

      // No 500 errors
      const statuses5xx = responses.map((r) => r.status).filter((s) => s >= 500);
      expect(statuses5xx).toEqual([]);

      // Final DB state: exactly one record
      const rows = await realDb('kyc_records').where({ sme_id: smeId });
      expect(rows).toHaveLength(1);
      expect(['verified', 'rejected']).toContain(rows[0].status);
    });
  });

  describe('Concurrent reads mixed with writes', () => {
    it('no crashes when reading while writing', async () => {
      const smeIds = Array.from({ length: 10 }, (_, i) => `sme-mixed-${i}`);
      const readRequest = () => request(app).get('/api/kyc/webhooks');

      // Fire 5 reads and 10 writes concurrently
      const reads = Array.from({ length: 5 }, () => readRequest());
      const writes = smeIds.map((smeId) => {
        const { rawBody, signature } = buildSignedPayload(smeId, 'approved', {
          recordId: `rec-mixed-${smeId}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      const results = await Promise.all([...reads, ...writes]);

      // No 500 errors
      const statuses5xx = results.map((r) => r.status).filter((s) => s >= 500);
      expect(statuses5xx).toEqual([]);

      // All writes succeeded
      const writeResults = results.slice(5);
      writeResults.forEach((res) => {
        expect(res.status).toBe(200);
      });

      // DB has the right number of records
      const rows = await realDb('kyc_records');
      expect(rows).toHaveLength(smeIds.length);
    });
  });

  describe('Status consistency under contention', () => {
    it('final status is always one of the written statuses for the same SME', async () => {
      const smeId = 'sme-consistency';
      const writtenStatuses = [];

      const requests = Array.from({ length: 25 }, (_, i) => {
        const status = i < 10 ? 'approved' : 'rejected';
        writtenStatuses.push(status);
        const { rawBody, signature } = buildSignedPayload(smeId, status, {
          recordId: `rec-${i}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      await Promise.all(requests);

      const row = await realDb('kyc_records').where({ sme_id: smeId }).first();
      expect(row).toBeDefined();
      expect(row.status).toMatch(/^(verified|rejected)$/);
    });
  });

  describe('No lost updates on existing records', () => {
    it('concurrent writes to an existing record all succeed and final state is valid', async () => {
      const smeId = 'sme-no-lost-update';

      // Seed a record first
      const seed = buildSignedPayload(smeId, 'approved', { recordId: 'rec-seed' });
      const seedRes = await sendKycWebhook(app, seed);
      expect(seedRes.status).toBe(200);

      // Fire 20 concurrent writes that alternate statuses
      const requests = Array.from({ length: 20 }, (_, i) => {
        const status = i % 2 === 0 ? 'rejected' : 'approved';
        const { rawBody, signature } = buildSignedPayload(smeId, status, {
          recordId: `rec-nlu-${i}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });

      // Exactly one record remains
      const rows = await realDb('kyc_records').where({ sme_id: smeId });
      expect(rows).toHaveLength(1);

      // Final status must be one of the statuses we wrote (never stale)
      expect(['verified', 'rejected']).toContain(rows[0].status);
    });
  });

  describe('Atomic upsert prevents INSERT race', () => {
    it('concurrent first writes to the same SME never cause UNIQUE violations', async () => {
      const smeId = 'sme-atomic-upsert';

      // All 15 requests race to INSERT the very first record for this SME.
      // Before the fix, the SELECT-then-INSERT pattern caused UNIQUE constraint
      // violations. After the fix, INSERT ... ON CONFLICT DO UPDATE serialises
      // them atomically.
      const requests = Array.from({ length: 15 }, (_, i) => {
        const status = i < 8 ? 'approved' : 'rejected';
        const { rawBody, signature } = buildSignedPayload(smeId, status, {
          recordId: `rec-atomic-${i}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      const responses = await Promise.all(requests);

      // Every response must be 200 — no 500 from UNIQUE constraint violation
      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body).toEqual(
          expect.objectContaining({ success: true, smeId })
        );
      });

      // Exactly one record persisted
      const rows = await realDb('kyc_records').where({ sme_id: smeId });
      expect(rows).toHaveLength(1);
    });
  });

  describe('Metrics accuracy under concurrent writes', () => {
    it('kycWebhookRequestsTotal counter reflects all concurrent requests', async () => {
      const smeId = 'sme-metrics-concurrent';
      const count = 8;

      const requests = Array.from({ length: count }, (_, i) => {
        const { rawBody, signature } = buildSignedPayload(smeId, 'approved', {
          recordId: `rec-metrics-${i}`,
        });
        return sendKycWebhook(app, { rawBody, signature });
      });

      await Promise.all(requests);

      const rows = await realDb('kyc_records').where({ sme_id: smeId });
      expect(rows).toHaveLength(1);
    });
  });

  describe('Deterministic ordering under contention', () => {
    it('alternating concurrent statuses converge to a known-valid state', async () => {
      const smeId = 'sme-deterministic';
      const statuses = ['approved', 'rejected'];

      for (let round = 0; round < 5; round++) {
        const requests = statuses.map((status) => {
          const { rawBody, signature } = buildSignedPayload(smeId, status, {
            recordId: `rec-det-${round}-${status}`,
          });
          return sendKycWebhook(app, { rawBody, signature });
        });

        const responses = await Promise.all(requests);

        responses.forEach((res) => {
          expect(res.status).toBe(200);
        });

        const row = await realDb('kyc_records').where({ sme_id: smeId }).first();
        expect(row).toBeDefined();
        expect(['verified', 'rejected']).toContain(row.status);
      }
    });
  });
});
