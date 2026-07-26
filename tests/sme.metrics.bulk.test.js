/**
 * Integration tests for the SME bulk metrics endpoint.
 *
 * Bypasses the global knex mock to run tests against an in-memory SQLite database.
 * Covers: happy path, validation, authorization, partial failure, and edge cases.
 */

'use strict';

jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/index');
const db = require('../src/db/knex');
const invoiceService = require('../src/services/invoiceService');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

describe('SME Bulk Metrics API', () => {
  const userId = 'test_sme_user';
  const tenantId = 'test_tenant';
  const token = jwt.sign({ id: userId, tenantId }, JWT_SECRET);

  beforeAll(async () => {
    await db.migrate.latest({ directory: './migrations' });
  });

  beforeEach(async () => {
    await db('invoices').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    test('POST /api/sme/metrics/bulk - returns correct counts for a single operation', async () => {
      await db('invoices').insert([
        { invoice_id: 'b1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'C1' },
        { invoice_id: 'b2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'C2' },
      ]);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [{ tenantId, userId }] });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0]).toEqual({
        tenantId,
        userId,
        status: 'success',
        data: { open: 1, funded: 1, settled: 0, defaulted: 0 },
        error: null,
      });
      expect(res.body.meta).toEqual({
        total: 1,
        succeeded: 1,
        failed: 0,
        timestamp: expect.any(String),
      });
    });

    test('POST /api/sme/metrics/bulk - returns per-item results for multiple operations', async () => {
      const otherUserId = 'other_sme_user';
      await db('invoices').insert([
        { invoice_id: 'm1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'C1' },
        { invoice_id: 'm2', sme_id: otherUserId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'C2' },
        { invoice_id: 'm3', sme_id: otherUserId, tenant_id: tenantId, status: 'settled', amount: 300, customer: 'C3' },
      ]);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({
          operations: [
            { tenantId, userId },
            { tenantId, userId: otherUserId },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0]).toEqual({
        tenantId,
        userId,
        status: 'success',
        data: { open: 1, funded: 0, settled: 0, defaulted: 0 },
        error: null,
      });
      expect(res.body.results[1]).toEqual({
        tenantId,
        userId: otherUserId,
        status: 'success',
        data: { open: 0, funded: 1, settled: 1, defaulted: 0 },
        error: null,
      });
      expect(res.body.meta.succeeded).toBe(2);
      expect(res.body.meta.failed).toBe(0);
    });

    test('POST /api/sme/metrics/bulk - returns zeros for users with no invoices', async () => {
      const newUserToken = jwt.sign({ id: 'empty_user_bulk', tenantId }, JWT_SECRET);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${newUserToken}`)
        .send({ operations: [{ tenantId, userId: 'empty_user_bulk' }] });

      expect(res.status).toBe(200);
      expect(res.body.results[0].status).toBe('success');
      expect(res.body.results[0].data).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
    });

    test('POST /api/sme/metrics/bulk - processes items at the cap (25)', async () => {
      const operations = Array.from({ length: 25 }, (_, i) => ({
        tenantId,
        userId: `user_${i}`,
      }));

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(25);
      expect(res.body.meta.total).toBe(25);
      expect(res.body.meta.succeeded).toBe(25);
      expect(res.body.meta.failed).toBe(0);
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('validation', () => {
    test('rejects empty operations array with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [] });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects over-cap array (>25 items) with 400', async () => {
      const operations = Array.from({ length: 26 }, (_, i) => ({
        tenantId,
        userId: `user_${i}`,
      }));

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects missing operations field with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects operation with missing tenantId with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [{ userId: 'u1' }] });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects operation with missing userId with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [{ tenantId: 't1' }] });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects operation with empty tenantId string with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [{ tenantId: '  ', userId: 'u1' }] });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects unknown top-level keys with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [{ tenantId, userId }], extra: 'field' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects unknown per-item keys with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [{ tenantId, userId, extra: true }] });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });

    test('rejects non-array operations with 400', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });
  });

  // ── Authorization ──────────────────────────────────────────────────────────

  describe('authorization', () => {
    test('rejects unauthorized requests with 401', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .send({ operations: [{ tenantId, userId }] });

      expect(res.status).toBe(401);
    });

    test('rejects cross-tenant item with per-item error', async () => {
      const crossTenantToken = jwt.sign({ id: userId, tenantId: 'caller_tenant' }, JWT_SECRET);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${crossTenantToken}`)
        .send({ operations: [{ tenantId: 'other_tenant', userId }] });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].status).toBe('error');
      expect(res.body.results[0].error).toBe('Cross-tenant access denied');
      expect(res.body.meta.failed).toBe(1);
    });

    test('rejects request with missing tenant context with 400', async () => {
      const tokenNoTenant = jwt.sign({ id: userId }, JWT_SECRET);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${tokenNoTenant}`)
        .send({ operations: [{ tenantId, userId }] });

      expect(res.status).toBe(400);
    });

    test('mixes valid and cross-tenant items — returns partial results', async () => {
      const otherUserId = 'other_bulk_user';
      await db('invoices').insert([
        { invoice_id: 'pv1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'C1' },
        { invoice_id: 'pv2', sme_id: otherUserId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'C2' },
      ]);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({
          operations: [
            { tenantId, userId },
            { tenantId: 'forbidden_tenant', userId: otherUserId },
            { tenantId, userId: otherUserId },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(3);
      expect(res.body.results[0].status).toBe('success');
      expect(res.body.results[1].status).toBe('error');
      expect(res.body.results[1].error).toBe('Cross-tenant access denied');
      expect(res.body.results[2].status).toBe('success');
      expect(res.body.meta.succeeded).toBe(2);
      expect(res.body.meta.failed).toBe(1);
    });
  });

  // ── Partial failure ────────────────────────────────────────────────────────

  describe('partial failure', () => {
    test('isolates service errors to the failing item', async () => {
      await db('invoices').insert([
        { invoice_id: 'pf1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'C1' },
      ]);

      const otherUserId = 'will_fail_user';
      const spy = jest
        .spyOn(invoiceService, 'getSmeInvoiceCounts')
        .mockImplementationOnce(async (tid, uid) => {
          if (uid === otherUserId) {
            throw new Error('Database connection lost');
          }
          return invoiceService.getSmeInvoiceCounts.__original ? invoiceService.getSmeInvoiceCounts.__original(tid, uid) : { open: 1, funded: 0, settled: 0, defaulted: 0 };
        });

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({
          operations: [
            { tenantId, userId },
            { tenantId, userId: otherUserId },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.results[0].status).toBe('success');
      expect(res.body.results[1].status).toBe('error');
      expect(res.body.results[1].error).toBe('Database connection lost');
      expect(res.body.meta.succeeded).toBe(1);
      expect(res.body.meta.failed).toBe(1);
      spy.mockRestore();
    });
  });

  // ── Duplicate items ────────────────────────────────────────────────────────

  describe('duplicate items', () => {
    test('processes duplicate items independently', async () => {
      await db('invoices').insert([
        { invoice_id: 'dup1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'C1' },
      ]);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({
          operations: [
            { tenantId, userId },
            { tenantId, userId },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0].status).toBe('success');
      expect(res.body.results[1].status).toBe('success');
      expect(res.body.results[0].data).toEqual(res.body.results[1].data);
    });
  });

  // ── Not-found / unmatched-route paths ─────────────────────────────────────

  describe('not-found paths', () => {
    test('returns 404 for GET on /api/sme/metrics/bulk', async () => {
      const res = await request(app)
        .get('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    test('returns 404 for unmatched sub-path under /api/sme/metrics/bulk', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk/extra')
        .set('Authorization', `Bearer ${token}`)
        .send({ operations: [{ tenantId, userId }] });

      expect(res.status).toBe(404);
    });
  });

  // ── Idempotent-repeat paths ────────────────────────────────────────────────

  describe('idempotent-repeat paths', () => {
    test('repeating the same bulk request returns identical results', async () => {
      await db('invoices').insert([
        { invoice_id: 'idp1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'C1' },
      ]);

      const payload = { operations: [{ tenantId, userId }] };

      const first = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send(payload);

      const second = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send(payload);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.results).toEqual(first.body.results);
    });

    test('repeating an unauthorized request deterministically returns 401', async () => {
      const payload = { operations: [{ tenantId, userId }] };

      const first = await request(app)
        .post('/api/sme/metrics/bulk')
        .send(payload);

      const second = await request(app)
        .post('/api/sme/metrics/bulk')
        .send(payload);

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
    });
  });

  // ── Tenant isolation per-item ──────────────────────────────────────────────

  describe('tenant isolation per-item', () => {
    test('each item is scoped to its tenant independently', async () => {
      const otherTenantId = 'other_bulk_tenant';
      await db('invoices').insert([
        { invoice_id: 'ti1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'C1' },
        { invoice_id: 'ti2', sme_id: userId, tenant_id: otherTenantId, status: 'funded', amount: 200, customer: 'C2' },
      ]);

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({
          operations: [
            { tenantId, userId },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.results[0].data.open).toBe(1);
    });

    test('item with different tenant than caller is rejected per-item', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send({
          operations: [
            { tenantId: 'forbidden_tenant', userId: 'someone_else' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.results[0].status).toBe('error');
      expect(res.body.results[0].error).toBe('Cross-tenant access denied');
    });
  });
});
