/**
 * Integration tests for the SME metrics endpoint.
 *
 * Bypasses the global knex mock to run tests against an in-memory SQLite database.
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

describe('SME Metrics API', () => {
  const userId = 'test_sme_user';
  const tenantId = 'test_tenant';
  const token = jwt.sign({ id: userId, tenantId }, JWT_SECRET);

  beforeAll(async () => {
    // Run migration setup on SQLite
    await db.migrate.latest({ directory: './migrations' });
  });

  beforeEach(async () => {
    // Wipe invoices before each test
    await db('invoices').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  test('GET /api/sme/metrics - Returns correct counts for various statuses', async () => {
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer 1' },
      { invoice_id: '2', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'Customer 2' },
      { invoice_id: '3', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 300, customer: 'Customer 3' },
      { invoice_id: '4', sme_id: userId, tenant_id: tenantId, status: 'settled', amount: 400, customer: 'Customer 4' },
      { invoice_id: '5', sme_id: userId, tenant_id: tenantId, status: 'paid', amount: 500, customer: 'Customer 5' },
      { invoice_id: '6', sme_id: userId, tenant_id: tenantId, status: 'defaulted', amount: 600, customer: 'Customer 6' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      open: 2,      // pending_verification + verified
      funded: 1,    // funded
      settled: 2,   // settled + paid
      defaulted: 1  // defaulted
    });
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.timestamp).toBeDefined();
  });

  test('GET /api/sme/metrics - Returns zeros for a new user with no invoices', async () => {
    const newUserToken = jwt.sign({ id: 'new_user', tenantId }, JWT_SECRET);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${newUserToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      open: 0,
      funded: 0,
      settled: 0,
      defaulted: 0
    });
  });

  test('GET /api/sme/metrics - Ensures "withdrawn" and other unmapped statuses are not counted', async () => {
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'withdrawn', amount: 100, customer: 'Customer 1' },
      { invoice_id: '2', sme_id: userId, tenant_id: tenantId, status: 'unknown_status', amount: 100, customer: 'Customer 2' },
      { invoice_id: '3', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer 3' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1);
    const total = Object.values(res.body.data).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  test('GET /api/sme/metrics - Ignores soft-deleted invoices', async () => {
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer 1', deleted_at: new Date().toISOString() },
      { invoice_id: '2', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'Customer 2' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1); // Only active verified invoice counted
    const total = Object.values(res.body.data).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  test('GET /api/sme/metrics - Enforces tenant isolation (Tenant A cannot see Tenant B)', async () => {
    const otherTenantId = 'other_tenant';
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer A' },
      { invoice_id: '2', sme_id: userId, tenant_id: otherTenantId, status: 'verified', amount: 200, customer: 'Customer B' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1); // Only Tenant A's invoice is counted
  });

  test('GET /api/sme/metrics - Enforces owner isolation (User A cannot see User B)', async () => {
    const otherUserId = 'other_sme_user';
    await db('invoices').insert([
      { invoice_id: '1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'Customer A' },
      { invoice_id: '2', sme_id: otherUserId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'Customer B' }
    ]);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(1); // Only User A's invoice is counted
  });

  test('GET /api/sme/metrics - Rejects cross-tenant read attempt via x-tenant-id header (403)', async () => {
    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'some_other_tenant');

    expect(res.status).toBe(403);
  });

  test('GET /api/sme/metrics - Rejects unauthorized requests', async () => {
    const res = await request(app).get('/api/sme/metrics');
    expect(res.status).toBe(401);
  });

  test('GET /api/sme/metrics - Rejects request with missing tenant context (400)', async () => {
    const tokenNoTenant = jwt.sign({ id: userId }, JWT_SECRET);

    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', `Bearer ${tokenNoTenant}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing tenant context');
  });

  // ── Cursor pagination tests ───────────────────────────────────────────────

  describe('cursor pagination', () => {
    test('returns aggregated counts only when no cursor or limit is provided (backward compat)', async () => {
      await db('invoices').insert([
        { invoice_id: 'c1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'C1' },
        { invoice_id: 'c2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'C2' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ open: 1, funded: 1, settled: 0, defaulted: 0 });
      expect(res.body.meta.invoices).toBeUndefined();
      expect(res.body.meta.nextCursor).toBeUndefined();
      expect(res.body.meta.hasMore).toBeUndefined();
    });

    test('returns paginated invoices when limit is supplied', async () => {
      await db('invoices').insert([
        { invoice_id: 'p1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'P1' },
        { invoice_id: 'p2', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'P2' },
        { invoice_id: 'p3', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 300, customer: 'P3' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ open: 2, funded: 1, settled: 0, defaulted: 0 });
      expect(res.body.meta.invoices).toHaveLength(2);
      expect(res.body.meta.limit).toBe(2);
      expect(res.body.meta.total).toBe(3);
      expect(res.body.meta.hasMore).toBe(true);
      expect(res.body.meta.nextCursor).toBeTruthy();
      expect(res.body.meta.timestamp).toBeDefined();
    });

    test('returns empty invoices list for a user with no invoices', async () => {
      const newUserToken = jwt.sign({ id: 'empty_user', tenantId }, JWT_SECRET);

      const res = await request(app)
        .get('/api/sme/metrics?limit=5')
        .set('Authorization', `Bearer ${newUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
      expect(res.body.meta.invoices).toEqual([]);
      expect(res.body.meta.total).toBe(0);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    test('paginates across multiple pages correctly', async () => {
      await db('invoices').insert([
        { invoice_id: 'mp1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'MP1' },
        { invoice_id: 'mp2', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 200, customer: 'MP2' },
        { invoice_id: 'mp3', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 300, customer: 'MP3' },
        { invoice_id: 'mp4', sme_id: userId, tenant_id: tenantId, status: 'settled', amount: 400, customer: 'MP4' },
        { invoice_id: 'mp5', sme_id: userId, tenant_id: tenantId, status: 'paid', amount: 500, customer: 'MP5' },
      ]);

      const page1 = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${token}`);

      expect(page1.status).toBe(200);
      expect(page1.body.meta.invoices).toHaveLength(2);
      expect(page1.body.meta.total).toBe(5);
      expect(page1.body.meta.hasMore).toBe(true);
      expect(page1.body.meta.nextCursor).toBeTruthy();
      const page1Ids = page1.body.meta.invoices.map((i) => i.invoice_id);
      expect(page1Ids).toEqual(['mp5', 'mp4']);

      const page2 = await request(app)
        .get(`/api/sme/metrics?limit=2&cursor=${page1.body.meta.nextCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(page2.status).toBe(200);
      expect(page2.body.meta.invoices).toHaveLength(2);
      expect(page2.body.meta.total).toBe(5);
      expect(page2.body.meta.hasMore).toBe(true);
      expect(page2.body.meta.nextCursor).toBeTruthy();
      const page2Ids = page2.body.meta.invoices.map((i) => i.invoice_id);
      expect(page2Ids).toEqual(['mp3', 'mp2']);

      const page3 = await request(app)
        .get(`/api/sme/metrics?limit=2&cursor=${page2.body.meta.nextCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(page3.status).toBe(200);
      expect(page3.body.meta.invoices).toHaveLength(1);
      expect(page3.body.meta.total).toBe(5);
      expect(page3.body.meta.hasMore).toBe(false);
      expect(page3.body.meta.nextCursor).toBeNull();
      const page3Ids = page3.body.meta.invoices.map((i) => i.invoice_id);
      expect(page3Ids).toEqual(['mp1']);
    });

    test('single page when items fit within limit', async () => {
      await db('invoices').insert([
        { invoice_id: 'sp1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'SP1' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics?limit=10')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.invoices).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    test('accepts limit at the maximum of 100', async () => {
      const invoices = Array.from({ length: 50 }, (_, i) => ({
        invoice_id: `clamp_${i}`,
        sme_id: userId,
        tenant_id: tenantId,
        status: i % 2 === 0 ? 'verified' : 'funded',
        amount: (i + 1) * 10,
        customer: `Clamp${i}`,
      }));
      await db('invoices').insert(invoices);

      const res = await request(app)
        .get('/api/sme/metrics?limit=100')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(100);
      expect(res.body.meta.invoices).toHaveLength(50);
      expect(res.body.meta.hasMore).toBe(false);
    });

    test('rejects limit above the maximum instead of clamping it', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=999')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    test('rejects malformed cursor with 400', async () => {
      await db('invoices').insert([
        { invoice_id: 'mc1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'MC1' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics?limit=5&cursor=invalid-cursor-string')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    test('pagination respects tenant isolation', async () => {
      const otherTenantId = 'other_tenant_pag';
      await db('invoices').insert([
        { invoice_id: 'ti1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'TI1' },
        { invoice_id: 'ti2', sme_id: userId, tenant_id: otherTenantId, status: 'funded', amount: 200, customer: 'TI2' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics?limit=10')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.invoices).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.meta.invoices[0].invoice_id).toBe('ti1');
    });

    test('pagination respects owner isolation', async () => {
      const otherUserId = 'other_user_pag';
      const otherToken = jwt.sign({ id: otherUserId, tenantId }, JWT_SECRET);
      await db('invoices').insert([
        { invoice_id: 'oi1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'OI1' },
        { invoice_id: 'oi2', sme_id: otherUserId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'OI2' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics?limit=10')
        .set('Authorization', `Bearer ${otherToken}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.invoices).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.meta.invoices[0].invoice_id).toBe('oi2');
    });

    test('pagination excludes soft-deleted invoices', async () => {
      await db('invoices').insert([
        { invoice_id: 'sd1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'SD1', deleted_at: new Date().toISOString() },
        { invoice_id: 'sd2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'SD2' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics?limit=10')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.invoices).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.meta.invoices[0].invoice_id).toBe('sd2');
    });

    test('includes counts in data alongside paginated invoices', async () => {
      await db('invoices').insert([
        { invoice_id: 'ic1', sme_id: userId, tenant_id: tenantId, status: 'pending_verification', amount: 100, customer: 'IC1' },
        { invoice_id: 'ic2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'IC2' },
        { invoice_id: 'ic3', sme_id: userId, tenant_id: tenantId, status: 'settled', amount: 300, customer: 'IC3' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ open: 1, funded: 1, settled: 1, defaulted: 0 });
      expect(res.body.meta.invoices).toHaveLength(2);
    });

    test('rejects a cursor with a tampered signature with 400', async () => {
      await db('invoices').insert([
        { invoice_id: 'ts1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'TS1' },
        { invoice_id: 'ts2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'TS2' },
      ]);

      const page1 = await request(app)
        .get('/api/sme/metrics?limit=1')
        .set('Authorization', `Bearer ${token}`);

      const validCursor = page1.body.meta.nextCursor;
      const dotIdx = validCursor.lastIndexOf('.');
      const sig = validCursor.slice(dotIdx + 1);
      const flippedChar = sig[0] === '0' ? '1' : '0';
      const tamperedCursor = `${validCursor.slice(0, dotIdx + 1)}${flippedChar}${sig.slice(1)}`;

      const res = await request(app)
        .get(`/api/sme/metrics?limit=1&cursor=${tamperedCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Invalid cursor signature');
    });
  });

  // ── Not-found / unmatched-route paths ───────────────────────────────────

  describe('not-found paths', () => {
    test('returns 404 for an unmatched sub-path under /api/sme/metrics', async () => {
      const res = await request(app)
        .get('/api/sme/metrics/does-not-exist')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Not found');
    });

    test('returns aggregated zeros (not a 404) for a valid tenant/user pair with no invoices', async () => {
      const newUserToken = jwt.sign({ id: 'nobody_home', tenantId }, JWT_SECRET);

      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${newUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
    });
  });

  // ── Unexpected (non-CursorError) failures propagate to the error handler ──

  describe('unexpected error propagation', () => {
    test('a non-CursorError from the pagination lookup is forwarded to next(err) as a 500', async () => {
      const spy = jest
        .spyOn(invoiceService, 'getSmeInvoiceList')
        .mockRejectedValueOnce(new Error('unexpected db failure'));

      const res = await request(app)
        .get('/api/sme/metrics?limit=5')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      spy.mockRestore();
    });
  });

  // ── Validation-failure: invalid (non-throwing) limit values ────────────

  describe('validation-failure — invalid limit values are rejected, not repaired', () => {
    beforeEach(async () => {
      await db('invoices').insert([
        { invoice_id: 'lv1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'LV1' },
      ]);
    });

    // These previously returned 200 by silently substituting a default or
    // clamped page size, which hid the bad input from the caller. Malformed and
    // out-of-range values now fail closed with a structured 400.
    test('non-numeric limit is rejected rather than falling back to a default', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=not-a-number')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    test('zero limit is rejected as below the minimum', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=0')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    test('negative limit is rejected rather than clamped up to 1', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=-5')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  // ── Idempotent-repeat paths ──────────────────────────────────────────────

  describe('idempotent-repeat paths', () => {
    test('repeating the aggregated-counts request returns identical data', async () => {
      await db('invoices').insert([
        { invoice_id: 'ir1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'IR1' },
        { invoice_id: 'ir2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'IR2' },
      ]);

      const first = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${token}`);
      const second = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${token}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data).toEqual(first.body.data);
    });

    test('repeating a paginated request with the same cursor returns the same page', async () => {
      await db('invoices').insert([
        { invoice_id: 'irp1', sme_id: userId, tenant_id: tenantId, status: 'verified', amount: 100, customer: 'IRP1' },
        { invoice_id: 'irp2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 200, customer: 'IRP2' },
        { invoice_id: 'irp3', sme_id: userId, tenant_id: tenantId, status: 'settled', amount: 300, customer: 'IRP3' },
      ]);

      const page1 = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${token}`);
      const cursor = page1.body.meta.nextCursor;

      const repeatA = await request(app)
        .get(`/api/sme/metrics?limit=2&cursor=${cursor}`)
        .set('Authorization', `Bearer ${token}`);
      const repeatB = await request(app)
        .get(`/api/sme/metrics?limit=2&cursor=${cursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(repeatA.status).toBe(200);
      expect(repeatB.status).toBe(200);
      expect(repeatB.body.meta.invoices).toEqual(repeatA.body.meta.invoices);
      expect(repeatB.body.meta.nextCursor).toEqual(repeatA.body.meta.nextCursor);
      expect(repeatB.body.meta.hasMore).toEqual(repeatA.body.meta.hasMore);
    });

    test('repeating an unauthorized request deterministically returns 401 each time', async () => {
      const first = await request(app).get('/api/sme/metrics');
      const second = await request(app).get('/api/sme/metrics');

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
    });
  });
});
