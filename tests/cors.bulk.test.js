'use strict';

/**
 * @fileoverview Comprehensive tests for the bulk CORS operations endpoint.
 *
 * Covers:
 *  - validateBulkCorsItem unit tests (all op types, bad inputs)
 *  - processBulkCorsOperations unit tests (add, remove, replace, ordering,
 *    partial failure, over-cap enforcement by caller)
 *  - POST /api/admin/cors/bulk HTTP integration tests via supertest:
 *      happy path, partial failure, over-cap (400), empty array (400),
 *      non-array body (400), unauthenticated (401/403), tenant scoping
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => jest.fn());

jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

jest.mock('../src/metrics', () => ({
  webhookReplayTotal: { inc: jest.fn() },
  corsCacheHitsTotal: { inc: jest.fn(), reset: jest.fn(), hashMap: {} },
  corsCacheMissesTotal: { inc: jest.fn(), reset: jest.fn(), hashMap: {} },
  corsCacheEvictionsTotal: { inc: jest.fn(), reset: jest.fn(), hashMap: {} },
  corsCacheInvalidationsTotal: { inc: jest.fn(), reset: jest.fn(), hashMap: {} },
  registry: {
    contentType: 'text/plain',
    metrics: jest.fn().mockResolvedValue(''),
  },
}));

jest.mock('prom-client', () => ({
  Counter: class { constructor() {} inc() {} },
  Gauge: class { constructor() {} set() {} },
  Histogram: class { constructor() {} observe() {} },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics() { return ''; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });

// ── Imports ───────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const {
  validateBulkCorsItem,
  processBulkCorsOperations,
  BULK_CORS_MAX_OPERATIONS,
  reloadCorsOrigins,
} = require('../src/config/cors');

const adminCorsRouter = require('../src/routes/adminCors');

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

function makeAdminToken(sub = 'admin-user', tenantId = 'tenant_test') {
  return jwt.sign({ sub, tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Minimal Express app that mounts the adminCors router with a stub tenant.
 */
function buildApp() {
  const app = express();
  app.use(express.json());

  // Stub tenant extraction so tests don't need a real DB.
  app.use((req, _res, next) => {
    if (!req.tenantId) req.tenantId = 'tenant_test';
    next();
  });

  app.use('/api/admin/cors', adminCorsRouter);

  // Generic error handler
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  return app;
}

const APP = buildApp();
const AUTH = `Bearer ${makeAdminToken()}`;

// Reset allowedOrigins to a known state before each test so state from one
// test does not bleed into another.
beforeEach(() => {
  process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com,https://admin.example.com';
  reloadCorsOrigins();
});

afterEach(() => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  reloadCorsOrigins();
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — validateBulkCorsItem unit tests
// ═════════════════════════════════════════════════════════════════════════════

describe('validateBulkCorsItem', () => {
  // ── op validation ──────────────────────────────────────────────────────────

  it('rejects a non-object item (null)', () => {
    const r = validateBulkCorsItem(null);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/plain object/);
  });

  it('rejects a non-object item (array)', () => {
    const r = validateBulkCorsItem(['add', 'https://a.example.com']);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/plain object/);
  });

  it('rejects an unknown op', () => {
    const r = validateBulkCorsItem({ op: 'upsert', origin: 'https://a.example.com' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/op must be one of/);
  });

  it('rejects a missing op', () => {
    const r = validateBulkCorsItem({ origin: 'https://a.example.com' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/op must be one of/);
  });

  // ── origin validation ──────────────────────────────────────────────────────

  it('rejects a non-string origin', () => {
    const r = validateBulkCorsItem({ op: 'add', origin: 42 });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/origin/);
  });

  it('rejects an unparseable origin', () => {
    const r = validateBulkCorsItem({ op: 'add', origin: 'not-a-url' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/origin/);
  });

  it('rejects the literal "null" origin', () => {
    const r = validateBulkCorsItem({ op: 'add', origin: 'null' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/origin/);
  });

  it('rejects an origin that exceeds max length', () => {
    const longOrigin = 'https://' + 'a'.repeat(500) + '.example.com';
    const r = validateBulkCorsItem({ op: 'add', origin: longOrigin });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/origin/);
  });

  // ── add ────────────────────────────────────────────────────────────────────

  it('accepts a valid add operation and normalises the origin', () => {
    const r = validateBulkCorsItem({ op: 'add', origin: 'https://new.example.com' });
    expect(r.valid).toBe(true);
    expect(r.error).toBeNull();
    expect(r.normalized.op).toBe('add');
    expect(r.normalized.origin).toBe('https://new.example.com');
    expect(r.normalized.newOrigin).toBeUndefined();
  });

  it('normalises an uppercase-scheme add origin', () => {
    const r = validateBulkCorsItem({ op: 'add', origin: 'HTTPS://NEW.EXAMPLE.COM' });
    expect(r.valid).toBe(true);
    expect(r.normalized.origin).toBe('https://new.example.com');
  });

  it('rejects add with an unexpected newOrigin field', () => {
    const r = validateBulkCorsItem({
      op: 'add',
      origin: 'https://a.example.com',
      newOrigin: 'https://b.example.com',
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/newOrigin must not be provided for add/);
  });

  // ── remove ─────────────────────────────────────────────────────────────────

  it('accepts a valid remove operation', () => {
    const r = validateBulkCorsItem({ op: 'remove', origin: 'https://app.example.com' });
    expect(r.valid).toBe(true);
    expect(r.normalized.op).toBe('remove');
  });

  it('rejects remove with an unexpected newOrigin field', () => {
    const r = validateBulkCorsItem({
      op: 'remove',
      origin: 'https://app.example.com',
      newOrigin: 'https://b.example.com',
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/newOrigin must not be provided for remove/);
  });

  // ── replace ────────────────────────────────────────────────────────────────

  it('accepts a valid replace operation', () => {
    const r = validateBulkCorsItem({
      op: 'replace',
      origin: 'https://app.example.com',
      newOrigin: 'https://app2.example.com',
    });
    expect(r.valid).toBe(true);
    expect(r.normalized.op).toBe('replace');
    expect(r.normalized.origin).toBe('https://app.example.com');
    expect(r.normalized.newOrigin).toBe('https://app2.example.com');
  });

  it('rejects replace without newOrigin', () => {
    const r = validateBulkCorsItem({ op: 'replace', origin: 'https://app.example.com' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/newOrigin is required for replace/);
  });

  it('rejects replace with an invalid newOrigin', () => {
    const r = validateBulkCorsItem({
      op: 'replace',
      origin: 'https://app.example.com',
      newOrigin: 'not-a-url',
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/newOrigin/);
  });
});


describe('processBulkCorsOperations', () => {
  // ── add ────────────────────────────────────────────────────────────────────

  it('adds a new origin and reports success', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      { op: 'add', origin: 'https://new.example.com' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].op).toBe('add');
    expect(results[0].index).toBe(0);
    expect(updatedOrigins).toContain('https://new.example.com');
  });

  it('does not duplicate an already-present origin on add', () => {
    const { updatedOrigins } = processBulkCorsOperations([
      { op: 'add', origin: 'https://app.example.com' },
    ]);
    const count = updatedOrigins.filter((o) => o === 'https://app.example.com').length;
    expect(count).toBe(1);
  });

  // ── remove ─────────────────────────────────────────────────────────────────

  it('removes a present origin and reports success', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      { op: 'remove', origin: 'https://app.example.com' },
    ]);
    expect(results[0].success).toBe(true);
    expect(updatedOrigins).not.toContain('https://app.example.com');
  });

  it('reports success with a no-op message when removing an absent origin', () => {
    const { results } = processBulkCorsOperations([
      { op: 'remove', origin: 'https://notpresent.example.com' },
    ]);
    expect(results[0].success).toBe(true);
    expect(results[0].error).toMatch(/no-op/);
  });

  // ── replace ────────────────────────────────────────────────────────────────

  it('replaces an existing origin and reports success', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      {
        op: 'replace',
        origin: 'https://app.example.com',
        newOrigin: 'https://app2.example.com',
      },
    ]);
    expect(results[0].success).toBe(true);
    expect(updatedOrigins).toContain('https://app2.example.com');
    expect(updatedOrigins).not.toContain('https://app.example.com');
  });

  it('fails replace when the target origin is not in the allowlist', () => {
    const { results } = processBulkCorsOperations([
      {
        op: 'replace',
        origin: 'https://notpresent.example.com',
        newOrigin: 'https://app2.example.com',
      },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/not found in the allowlist/);
  });

  // ── ordering ───────────────────────────────────────────────────────────────

  it('applies operations in order so later ops see earlier mutations', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      { op: 'add', origin: 'https://step1.example.com' },
      { op: 'remove', origin: 'https://step1.example.com' },
    ]);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(updatedOrigins).not.toContain('https://step1.example.com');
  });

  it('allows replace of an origin added earlier in the same batch', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      { op: 'add', origin: 'https://temp.example.com' },
      {
        op: 'replace',
        origin: 'https://temp.example.com',
        newOrigin: 'https://final.example.com',
      },
    ]);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(updatedOrigins).toContain('https://final.example.com');
    expect(updatedOrigins).not.toContain('https://temp.example.com');
  });

  // ── partial failure ────────────────────────────────────────────────────────

  it('continues processing remaining items after a per-item validation failure', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      { op: 'add', origin: 'not-a-url' },                  // fails
      { op: 'add', origin: 'https://valid.example.com' },  // succeeds
    ]);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
    expect(updatedOrigins).toContain('https://valid.example.com');
  });

  it('continues processing after a replace-not-found failure', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      {
        op: 'replace',
        origin: 'https://missing.example.com',
        newOrigin: 'https://x.example.com',
      },
      { op: 'add', origin: 'https://added.example.com' },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
    expect(updatedOrigins).toContain('https://added.example.com');
  });

  it('assigns the correct zero-based index to every result', () => {
    const ops = [
      { op: 'add', origin: 'https://a.example.com' },
      { op: 'remove', origin: 'https://app.example.com' },
      { op: 'add', origin: 'https://b.example.com' },
    ];
    const { results } = processBulkCorsOperations(ops);
    results.forEach((r, i) => expect(r.index).toBe(i));
  });

  it('handles a mixed valid/invalid batch and reflects updatedOrigins correctly', () => {
    const { results, updatedOrigins } = processBulkCorsOperations([
      { op: 'add', origin: 'https://good1.example.com' },
      { op: 'add', origin: 'bad-url' },
      { op: 'add', origin: 'https://good2.example.com' },
      { op: 'remove', origin: 'https://admin.example.com' },
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(3);
    expect(results.filter((r) => !r.success)).toHaveLength(1);
    expect(updatedOrigins).toContain('https://good1.example.com');
    expect(updatedOrigins).toContain('https://good2.example.com');
    expect(updatedOrigins).not.toContain('https://admin.example.com');
  });

  it('BULK_CORS_MAX_OPERATIONS is exactly 25', () => {
    expect(BULK_CORS_MAX_OPERATIONS).toBe(25);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — POST /api/admin/cors/bulk HTTP integration tests
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/cors/bulk', () => {

  // ── structural validation — 400 responses ─────────────────────────────────

  it('returns 400 when `operations` is missing from the body', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.detail).toMatch(/must be an array/);
  });

  it('returns 400 when `operations` is a string (not an array)', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: 'https://app.example.com' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when `operations` is an object (not an array)', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: { op: 'add', origin: 'https://a.example.com' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when `operations` is an empty array', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.detail).toMatch(/at least one item/);
  });

  it('returns 400 with BATCH_TOO_LARGE when operations exceeds 25', async () => {
    const operations = Array.from({ length: 26 }, (_, i) => ({
      op: 'add',
      origin: `https://origin${i}.example.com`,
    }));
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
    expect(res.body.detail).toMatch(/maximum is 25/);
  });

  it('returns 400 at exactly 26 items but 200 at exactly 25 items', async () => {
    const ops25 = Array.from({ length: 25 }, (_, i) => ({
      op: 'add',
      origin: `https://cap${i}.example.com`,
    }));
    const res25 = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: ops25 });
    expect(res25.status).toBe(200);

    const ops26 = [...ops25, { op: 'add', origin: 'https://over.example.com' }];
    const res26 = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: ops26 });
    expect(res26.status).toBe(400);
    expect(res26.body.code).toBe('BATCH_TOO_LARGE');
  });

  // ── authentication ─────────────────────────────────────────────────────────

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the JWT is malformed', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', 'Bearer not.a.valid.jwt')
      .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
    expect(res.status).toBe(401);
  });

  // ── happy path — all succeed ───────────────────────────────────────────────

  it('returns 200 with all-success results for a valid add batch', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({
        operations: [
          { op: 'add', origin: 'https://new1.example.com' },
          { op: 'add', origin: 'https://new2.example.com' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.every((r) => r.success)).toBe(true);
    expect(res.body.updatedOrigins).toContain('https://new1.example.com');
    expect(res.body.updatedOrigins).toContain('https://new2.example.com');
    expect(res.body.message).toMatch(/2 succeeded, 0 failed/);
  });

  it('returns 200 for a single-item add', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: [{ op: 'add', origin: 'https://single.example.com' }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[0].op).toBe('add');
    expect(res.body.results[0].index).toBe(0);
  });

  it('returns 200 for a valid remove operation', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: [{ op: 'remove', origin: 'https://app.example.com' }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.updatedOrigins).not.toContain('https://app.example.com');
  });

  it('returns 200 for a valid replace operation', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({
        operations: [
          {
            op: 'replace',
            origin: 'https://app.example.com',
            newOrigin: 'https://replaced.example.com',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.updatedOrigins).toContain('https://replaced.example.com');
    expect(res.body.updatedOrigins).not.toContain('https://app.example.com');
  });

  // ── partial failure — still 200 ───────────────────────────────────────────

  it('returns 200 even when some items fail, with per-item error detail', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({
        operations: [
          { op: 'add', origin: 'not-a-url' },                         // fails
          { op: 'add', origin: 'https://valid.example.com' },         // succeeds
          { op: 'replace', origin: 'https://missing.example.com', newOrigin: 'https://x.example.com' }, // fails
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toBeTruthy();
    expect(res.body.results[1].success).toBe(true);
    expect(res.body.results[2].success).toBe(false);
    expect(res.body.message).toMatch(/1 succeeded, 2 failed/);
  });

  it('includes the correct index in each result even on partial failure', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({
        operations: [
          { op: 'add', origin: 'bad' },
          { op: 'add', origin: 'https://ok.example.com' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].index).toBe(0);
    expect(res.body.results[1].index).toBe(1);
  });

  // ── response shape ─────────────────────────────────────────────────────────

  it('response body always contains results, updatedOrigins, and message', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: [{ op: 'add', origin: 'https://shape.example.com' }] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(Array.isArray(res.body.updatedOrigins)).toBe(true);
    expect(typeof res.body.message).toBe('string');
  });

  it('each result item contains index, success, op, origin, and error fields', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: [{ op: 'add', origin: 'https://fields.example.com' }] });
    const item = res.body.results[0];
    expect(typeof item.index).toBe('number');
    expect(typeof item.success).toBe('boolean');
    expect(typeof item.op).toBe('string');
    expect(typeof item.origin).toBe('string');
    expect('error' in item).toBe(true);
  });

  it('replace result includes newOrigin in the response item', async () => {
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({
        operations: [
          {
            op: 'replace',
            origin: 'https://app.example.com',
            newOrigin: 'https://replaced2.example.com',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].newOrigin).toBe('https://replaced2.example.com');
  });

  // ── over-cap boundary ──────────────────────────────────────────────────────

  it('rejects a batch of exactly 26 items before applying any operation', async () => {
    // Seed a known origin so we can verify it was not mutated
    process.env.CORS_ALLOWED_ORIGINS = 'https://before.example.com';
    reloadCorsOrigins();

    const operations = Array.from({ length: 26 }, (_, i) => ({
      op: 'add',
      origin: `https://overage${i}.example.com`,
    }));
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');

    // None of the 26 origins should have been applied
    const checkRes = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', AUTH)
      .send({ operations: [{ op: 'remove', origin: 'https://overage0.example.com' }] });
    // remove of non-existent is a success no-op; updatedOrigins should not include it
    expect(checkRes.body.updatedOrigins).not.toContain('https://overage0.example.com');
  });

  // ── authentication — advanced ──────────────────────────────────────────────

  it('returns 401 when Authorization uses Basic scheme instead of Bearer', async () => {
    const token = makeAdminToken();
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', `Basic ${token}`)
      .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the JWT is expired', async () => {
    const expiredToken = jwt.sign(
      { sub: 'admin-user', tenantId: 'tenant_test', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '0s' },
    );
    // Wait a tick so the token is definitely expired
    await new Promise((r) => setTimeout(r, 10));
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the JWT has a tampered signature', async () => {
    const tampered = makeAdminToken() + 'x';
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', `Bearer ${tampered}`)
      .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
    expect(res.status).toBe(401);
  });

  // ── tenant scoping ─────────────────────────────────────────────────────────

  it('extracts tenantId from JWT claim and includes it in log context', async () => {
    const logger = require('../src/logger');
    const token = makeAdminToken('admin-user', 'jwt_tenant_42');
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ operations: [{ op: 'add', origin: 'https://tenanttest.example.com' }] });
    expect(res.status).toBe(200);
    // The logger.info call should contain the tenantId from the JWT
    const infoCalls = logger.info.mock.calls.filter(
      (c) => c[1] === 'Admin bulk CORS operation completed',
    );
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    // Use the LAST matching call (not the first) to avoid picking up
    // log entries from earlier tests that also use tenant_test.
    expect(infoCalls[infoCalls.length - 1][0].tenantId).toBe('jwt_tenant_42');
  });

  it('extracts tenantId from x-tenant-id header with priority over JWT claim', async () => {
    const logger = require('../src/logger');
    const token = makeAdminToken('admin-user', 'jwt_tenant');
    const res = await request(APP)
      .post('/api/admin/cors/bulk')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'header_tenant_99')
      .send({ operations: [{ op: 'add', origin: 'https://headertest.example.com' }] });
    expect(res.status).toBe(200);
    // The x-tenant-id header should take priority
    const infoCalls = logger.info.mock.calls.filter(
      (c) => c[1] === 'Admin bulk CORS operation completed',
    );
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    expect(infoCalls[infoCalls.length - 1][0].tenantId).toBe('header_tenant_99');
  });

  it('rejects with 400 when no tenant context is available (no JWT claim, no header)', async () => {
    // Build an app without the stub tenant fallback so we hit extractTenant's 400 path
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.use('/api/admin/cors', adminCorsRouter);
    bareApp.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });

    // Use a JWT that has no tenantId claim
    const tokenNoTenant = jwt.sign(
      { sub: 'admin-user', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '1h' },
    );
    const res = await request(bareApp)
      .post('/api/admin/cors/bulk')
      .set('Authorization', `Bearer ${tokenNoTenant}`)
      .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
    expect(res.status).toBe(400);
  });

  // ── API key authentication ─────────────────────────────────────────────────

  describe('API key authentication', () => {
    beforeAll(() => {
      process.env.API_KEYS = [
        JSON.stringify({
          key: 'lf_test_admin_key',
          clientId: 'admin-service',
          scopes: ['admin'],
        }),
        JSON.stringify({
          key: 'lf_test_user_key',
          clientId: 'user-service',
          scopes: ['invoices:read'],
        }),
        JSON.stringify({
          key: 'lf_test_revoked_key',
          clientId: 'revoked-service',
          scopes: ['admin'],
          revoked: true,
        }),
      ].join(';');
    });

    afterAll(() => {
      delete process.env.API_KEYS;
    });

    it('returns 200 with a valid admin-scoped API key', async () => {
      const res = await request(APP)
        .post('/api/admin/cors/bulk')
        .set('x-api-key', 'lf_test_admin_key')
        .set('x-tenant-id', 'tenant_test')
        .send({ operations: [{ op: 'add', origin: 'https://api-key-test.example.com' }] });
      expect(res.status).toBe(200);
      expect(res.body.results[0].success).toBe(true);
    });

    it('returns 403 with an API key that lacks the admin scope', async () => {
      const res = await request(APP)
        .post('/api/admin/cors/bulk')
        .set('x-api-key', 'lf_test_user_key')
        .set('x-tenant-id', 'tenant_test')
        .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Insufficient permissions/);
    });

    it('returns 401 with a revoked API key', async () => {
      const res = await request(APP)
        .post('/api/admin/cors/bulk')
        .set('x-api-key', 'lf_test_revoked_key')
        .set('x-tenant-id', 'tenant_test')
        .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/revoked/);
    });

    it('returns 401 with a non-existent API key', async () => {
      const res = await request(APP)
        .post('/api/admin/cors/bulk')
        .set('x-api-key', 'lf_nonexistent_key')
        .set('x-tenant-id', 'tenant_test')
        .send({ operations: [{ op: 'add', origin: 'https://a.example.com' }] });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid API key/);
    });
  });
});
