'use strict';

/**
 * @fileoverview Contract tests for the GET /api/sme/metrics endpoint.
 *
 * These tests lock the JSON response shape so that accidental field renames,
 * type changes, additions, or removals are caught before they reach
 * production.
 *
 * Contract surfaces covered:
 *   1. Success shape (no pagination)  — exact fields, types, and null values
 *   2. Success shape (paginated)       — same + meta.invoices, total, limit,
 *                                        hasMore, nextCursor
 *   3. Error shapes:
 *       400 missing tenant             — { error, message }
 *       400 invalid cursor             — { error: { message } }
 *       401 unauthenticated            — standard 401
 *       403 cross-tenant               — { error, message }
 *   4. No extra fields beyond the documented schema
 *   5. Field types (integer counts, ISO timestamps, boolean, string|null)
 *   6. data.{open,funded,settled,defaulted} are always non-negative integers
 *   7. Backward compatibility: no-pagination mode must not include
 *      meta.invoices, meta.total, meta.hasMore, or meta.nextCursor
 */

// Use a real SQLite database so the full request cycle runs end-to-end.
jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/index');
const db = require('../src/db/knex');

const JWT_SECRET =
  process.env.JWT_SECRET ||
  'test-secret-at-least-32-characters-long-string-for-jest';

// ── Helpers ─────────────────────────────────────────────────────────────────

const USER_ID = 'contract_sme_user';
const TENANT_ID = 'contract_tenant';

/** Generates a signed JWT for the given userId / tenantId pair. */
function makeToken(userId = USER_ID, tenantId = TENANT_ID) {
  return jwt.sign({ id: userId, tenantId }, JWT_SECRET);
}

/**
 * ISO 8601 date-time regex (lenient — just checks format, not calendar
 * validity, because we only need to catch obviously wrong types).
 */
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ── Suite setup ──────────────────────────────────────────────────────────────

describe('GET /api/sme/metrics — response contract', () => {
  beforeAll(async () => {
    await db.migrate.latest({ directory: './migrations' });
  });

  beforeEach(async () => {
    await db('invoices').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ── 1. Success shape (no pagination) ────────────────────────────────────

  describe('success shape — no pagination', () => {
    it('top-level keys are exactly: data, meta, error, timestamp', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta', 'timestamp']);
    });

    it('data keys are exactly: open, funded, settled, defaulted', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(
        ['defaulted', 'funded', 'open', 'settled']
      );
    });

    it('meta keys in no-pagination mode are exactly: timestamp, version', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.meta).sort()).toEqual(['timestamp', 'version']);
    });

    it('error field is null in the success response', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
    });

    it('top-level timestamp is an ISO 8601 date-time string', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.timestamp).toBe('string');
      expect(res.body.timestamp).toMatch(ISO8601_RE);
    });

    it('meta.timestamp is an ISO 8601 date-time string', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.meta.timestamp).toBe('string');
      expect(res.body.meta.timestamp).toMatch(ISO8601_RE);
    });

    it('meta.version is a non-empty string', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.meta.version).toBe('string');
      expect(res.body.meta.version.length).toBeGreaterThan(0);
    });

    it('data counts are all non-negative integers', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      for (const key of ['open', 'funded', 'settled', 'defaulted']) {
        const value = res.body.data[key];
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    });

    it('no-pagination mode does NOT include meta.invoices', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.meta).not.toHaveProperty('invoices');
    });

    it('no-pagination mode does NOT include meta.total', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.meta).not.toHaveProperty('total');
    });

    it('no-pagination mode does NOT include meta.hasMore', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.meta).not.toHaveProperty('hasMore');
    });

    it('no-pagination mode does NOT include meta.nextCursor', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.meta).not.toHaveProperty('nextCursor');
    });

    it('counts reflect real invoice data', async () => {
      await db('invoices').insert([
        { invoice_id: 'c1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'pending_verification', amount: 100, customer: 'A' },
        { invoice_id: 'c2', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'funded', amount: 200, customer: 'B' },
        { invoice_id: 'c3', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'settled', amount: 300, customer: 'C' },
        { invoice_id: 'c4', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'defaulted', amount: 400, customer: 'D' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.open).toBe(1);
      expect(res.body.data.funded).toBe(1);
      expect(res.body.data.settled).toBe(1);
      expect(res.body.data.defaulted).toBe(1);
    });
  });

  // ── 2. Success shape (paginated) ─────────────────────────────────────────

  describe('success shape — paginated (limit supplied)', () => {
    beforeEach(async () => {
      await db('invoices').insert([
        { invoice_id: 'p1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'pending_verification', amount: 100, customer: 'P1' },
        { invoice_id: 'p2', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'funded', amount: 200, customer: 'P2' },
        { invoice_id: 'p3', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'settled', amount: 300, customer: 'P3' },
      ]);
    });

    it('top-level keys are exactly: data, meta, error, timestamp', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta', 'timestamp']);
    });

    it('meta keys in paginated mode are exactly: invoices, total, limit, hasMore, nextCursor, timestamp, version', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.meta).sort()).toEqual(
        ['hasMore', 'invoices', 'limit', 'nextCursor', 'timestamp', 'total', 'version']
      );
    });

    it('meta.invoices is an array', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.meta.invoices)).toBe(true);
    });

    it('meta.invoices length is bounded by limit', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.invoices.length).toBeLessThanOrEqual(2);
    });

    it('meta.total is a non-negative integer', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Number.isInteger(res.body.meta.total)).toBe(true);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(0);
    });

    it('meta.limit is a positive integer matching the requested limit', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Number.isInteger(res.body.meta.limit)).toBe(true);
      expect(res.body.meta.limit).toBe(2);
    });

    it('meta.hasMore is a boolean', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.meta.hasMore).toBe('boolean');
    });

    it('meta.nextCursor is a string when hasMore is true', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      if (res.body.meta.hasMore) {
        expect(typeof res.body.meta.nextCursor).toBe('string');
        expect(res.body.meta.nextCursor.length).toBeGreaterThan(0);
      }
    });

    it('meta.nextCursor is null when hasMore is false', async () => {
      // Fetch all 3 items at once — hasMore must be false
      const res = await request(app)
        .get('/api/sme/metrics?limit=100')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    it('meta.timestamp is an ISO 8601 date-time string', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.timestamp).toMatch(ISO8601_RE);
    });

    it('meta.version is a non-empty string', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.meta.version).toBe('string');
      expect(res.body.meta.version.length).toBeGreaterThan(0);
    });

    it('error field is null in paginated success response', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
    });

    it('data counts are non-negative integers in paginated response', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      for (const key of ['open', 'funded', 'settled', 'defaulted']) {
        expect(Number.isInteger(res.body.data[key])).toBe(true);
        expect(res.body.data[key]).toBeGreaterThanOrEqual(0);
      }
    });

    it('data counts match totals regardless of limit applied', async () => {
      // Aggregated counts must cover ALL matching invoices, not just the page
      const res = await request(app)
        .get('/api/sme/metrics?limit=1')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      // 3 invoices total: 1 open + 1 funded + 1 settled
      const { open, funded, settled, defaulted } = res.body.data;
      expect(open + funded + settled + defaulted).toBe(3);
    });

    it('cursor from first page yields second page correctly', async () => {
      const page1 = await request(app)
        .get('/api/sme/metrics?limit=2')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(page1.status).toBe(200);
      expect(page1.body.meta.hasMore).toBe(true);

      const cursor = page1.body.meta.nextCursor;
      const page2 = await request(app)
        .get(`/api/sme/metrics?limit=2&cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(page2.status).toBe(200);
      // Top-level contract must hold on subsequent pages too
      expect(Object.keys(page2.body).sort()).toEqual(['data', 'error', 'meta', 'timestamp']);
      expect(page2.body.meta.invoices.length).toBeGreaterThanOrEqual(1);
      expect(page2.body.meta.hasMore).toBe(false);
      expect(page2.body.meta.nextCursor).toBeNull();
    });
  });

  // ── 3a. Error shape — 401 Unauthorized ───────────────────────────────────

  describe('error shape — 401 unauthenticated', () => {
    it('returns 401 when no Authorization header is supplied', async () => {
      const res = await request(app).get('/api/sme/metrics');
      expect(res.status).toBe(401);
    });

    it('returns 401 with an error field in the body', async () => {
      const res = await request(app).get('/api/sme/metrics');
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('does not expose internal detail in the 401 body', async () => {
      const res = await request(app).get('/api/sme/metrics');
      expect(res.status).toBe(401);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toMatch(/stack/i);
      expect(bodyStr).not.toMatch(/JWT_SECRET/i);
    });
  });

  // ── 3b. Error shape — 400 missing tenant context ─────────────────────────

  describe('error shape — 400 missing tenant context', () => {
    it('returns 400 when JWT has no tenantId claim', async () => {
      const tokenNoTenant = jwt.sign({ id: USER_ID }, JWT_SECRET);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${tokenNoTenant}`);

      expect(res.status).toBe(400);
    });

    it('400 body has exactly two keys: error and message', async () => {
      const tokenNoTenant = jwt.sign({ id: USER_ID }, JWT_SECRET);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${tokenNoTenant}`);

      expect(res.status).toBe(400);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'message']);
    });

    it('400 error field is the string "Bad Request"', async () => {
      const tokenNoTenant = jwt.sign({ id: USER_ID }, JWT_SECRET);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${tokenNoTenant}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Bad Request');
    });

    it('400 message field contains "Missing tenant context"', async () => {
      const tokenNoTenant = jwt.sign({ id: USER_ID }, JWT_SECRET);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${tokenNoTenant}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Missing tenant context');
    });

    it('400 body does not contain "data" or "meta" fields', async () => {
      const tokenNoTenant = jwt.sign({ id: USER_ID }, JWT_SECRET);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${tokenNoTenant}`);

      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty('data');
      expect(res.body).not.toHaveProperty('meta');
    });
  });

  // ── 3c. Error shape — 400 invalid cursor ─────────────────────────────────

  describe('error shape — 400 invalid cursor', () => {
    it('returns 400 for a malformed cursor value', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?cursor=!!!invalid-cursor-value!!!')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(400);
    });

    it('400 cursor error body has an "error" key that is an object', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?cursor=!!!invalid-cursor-value!!!')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(typeof res.body.error).toBe('object');
      expect(res.body.error).not.toBeNull();
    });

    it('400 cursor error.error has a "message" string', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?cursor=!!!invalid-cursor-value!!!')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(400);
      expect(typeof res.body.error.message).toBe('string');
      expect(res.body.error.message.length).toBeGreaterThan(0);
    });

    it('400 cursor error body does not include "data" or "meta" fields', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?cursor=!!!invalid-cursor-value!!!')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty('data');
      expect(res.body).not.toHaveProperty('meta');
    });

    it('400 cursor error body does not contain a stack trace', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?cursor=!!!invalid-cursor-value!!!')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/at Object\./);
    });
  });

  // ── 3d. Error shape — 403 cross-tenant ────────────────────────────────────

  describe('error shape — 403 cross-tenant access denied', () => {
    it('returns 403 when x-tenant-id header does not match JWT tenantId', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', 'completely_different_tenant');

      expect(res.status).toBe(403);
    });

    it('403 body has exactly two keys: error and message', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', 'completely_different_tenant');

      expect(res.status).toBe(403);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'message']);
    });

    it('403 error field is the string "Forbidden"', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', 'completely_different_tenant');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    it('403 message field is a non-empty string', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', 'completely_different_tenant');

      expect(res.status).toBe(403);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
    });

    it('403 body does not include "data" or "meta" fields', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', 'completely_different_tenant');

      expect(res.status).toBe(403);
      expect(res.body).not.toHaveProperty('data');
      expect(res.body).not.toHaveProperty('meta');
    });

    it('403 body does not leak internal paths or stack traces', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', 'completely_different_tenant');

      expect(res.status).toBe(403);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toMatch(/stack/i);
      expect(bodyStr).not.toMatch(/at Object\./);
    });
  });

  // ── 4. No extra / missing fields ─────────────────────────────────────────

  describe('no extra or missing fields', () => {
    it('success (no pagination) has no undocumented top-level fields', async () => {
      const ALLOWED_TOP = new Set(['data', 'meta', 'error', 'timestamp']);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      for (const key of Object.keys(res.body)) {
        expect(ALLOWED_TOP.has(key)).toBe(true);
      }
    });

    it('success (no pagination) data has no undocumented keys', async () => {
      const ALLOWED_DATA = new Set(['open', 'funded', 'settled', 'defaulted']);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      for (const key of Object.keys(res.body.data)) {
        expect(ALLOWED_DATA.has(key)).toBe(true);
      }
    });

    it('success (no pagination) meta has no undocumented keys', async () => {
      const ALLOWED_META = new Set(['timestamp', 'version']);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      for (const key of Object.keys(res.body.meta)) {
        expect(ALLOWED_META.has(key)).toBe(true);
      }
    });

    it('success (paginated) meta has no undocumented keys', async () => {
      await db('invoices').insert([
        { invoice_id: 'extra1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'verified', amount: 100, customer: 'X1' },
      ]);
      const ALLOWED_META = new Set(['invoices', 'total', 'limit', 'hasMore', 'nextCursor', 'timestamp', 'version']);
      const res = await request(app)
        .get('/api/sme/metrics?limit=1')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      for (const key of Object.keys(res.body.meta)) {
        expect(ALLOWED_META.has(key)).toBe(true);
      }
    });

    it('400 missing-tenant body has no undocumented keys', async () => {
      const tokenNoTenant = jwt.sign({ id: USER_ID }, JWT_SECRET);
      const ALLOWED = new Set(['error', 'message']);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${tokenNoTenant}`);

      expect(res.status).toBe(400);
      for (const key of Object.keys(res.body)) {
        expect(ALLOWED.has(key)).toBe(true);
      }
    });

    it('403 cross-tenant body has no undocumented keys', async () => {
      const ALLOWED = new Set(['error', 'message']);
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', 'different_tenant_xyz');

      expect(res.status).toBe(403);
      for (const key of Object.keys(res.body)) {
        expect(ALLOWED.has(key)).toBe(true);
      }
    });
  });

  // ── 5. Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns zero counts (not undefined) when user has no invoices', async () => {
      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken('brand_new_user', TENANT_ID)}`);

      expect(res.status).toBe(200);
      expect(res.body.data.open).toBe(0);
      expect(res.body.data.funded).toBe(0);
      expect(res.body.data.settled).toBe(0);
      expect(res.body.data.defaulted).toBe(0);
    });

    it('returns empty invoices array (not undefined) in paginated mode when user has no invoices', async () => {
      const res = await request(app)
        .get('/api/sme/metrics?limit=5')
        .set('Authorization', `Bearer ${makeToken('brand_new_user', TENANT_ID)}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.meta.invoices)).toBe(true);
      expect(res.body.meta.invoices).toHaveLength(0);
    });

    it('soft-deleted invoices do not appear in counts', async () => {
      await db('invoices').insert([
        { invoice_id: 'del1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'pending_verification', amount: 100, customer: 'Del', deleted_at: new Date().toISOString() },
        { invoice_id: 'del2', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'verified', amount: 200, customer: 'Active' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      // Only the active verified invoice should count
      const total = Object.values(res.body.data).reduce((a, b) => a + b, 0);
      expect(total).toBe(1);
      expect(res.body.data.open).toBe(1);
    });

    it('withdrawn / unmapped statuses are NOT counted in any bucket', async () => {
      await db('invoices').insert([
        { invoice_id: 'w1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'withdrawn', amount: 100, customer: 'W' },
        { invoice_id: 'w2', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'unknown_status_xyz', amount: 100, customer: 'U' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      const total = Object.values(res.body.data).reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
    });

    it('tenant isolation: counts only include invoices for the authenticated tenant', async () => {
      const OTHER_TENANT = 'other_contract_tenant';
      await db('invoices').insert([
        { invoice_id: 'ti1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'funded', amount: 100, customer: 'Mine' },
        { invoice_id: 'ti2', sme_id: USER_ID, tenant_id: OTHER_TENANT, status: 'funded', amount: 200, customer: 'NotMine' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      // Only the invoice in TENANT_ID should be counted
      expect(res.body.data.funded).toBe(1);
    });

    it('owner isolation: counts only include invoices belonging to the authenticated user', async () => {
      const OTHER_USER = 'other_contract_user';
      await db('invoices').insert([
        { invoice_id: 'oi1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'settled', amount: 100, customer: 'Me' },
        { invoice_id: 'oi2', sme_id: OTHER_USER, tenant_id: TENANT_ID, status: 'settled', amount: 200, customer: 'NotMe' },
      ]);

      const res = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.settled).toBe(1);
    });

    it('response shape is stable across multiple calls with the same data', async () => {
      await db('invoices').insert([
        { invoice_id: 'stab1', sme_id: USER_ID, tenant_id: TENANT_ID, status: 'verified', amount: 100, customer: 'S1' },
      ]);

      const first = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);
      const second = await request(app)
        .get('/api/sme/metrics')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(Object.keys(first.body).sort()).toEqual(Object.keys(second.body).sort());
      expect(Object.keys(first.body.data).sort()).toEqual(Object.keys(second.body.data).sort());
      expect(Object.keys(first.body.meta).sort()).toEqual(Object.keys(second.body.meta).sort());
      expect(first.body.data).toEqual(second.body.data);
    });
  });
});
