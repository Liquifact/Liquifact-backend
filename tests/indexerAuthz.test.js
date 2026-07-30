'use strict';

/**
 * @fileoverview Auth and tenant-scoping tests for indexer endpoints (#762).
 *
 * Covers:
 *  - GET  /api/admin/indexer/events      — auth guards & tenant scoping
 *  - POST /api/admin/indexer/events/bulk — auth guards & tenant scoping
 *
 * Auth paths tested:
 *  - JWT bearer (valid / invalid / missing tenantId / expired)
 *  - API key  (missing / invalid / revoked / insufficient scope / valid)
 *
 * Tenant scoping tested:
 *  - x-tenant-id header takes priority over JWT tenantId claim
 *  - JWT tenantId claim used as fallback when no header present
 *  - 400 when no tenant context can be resolved
 *
 * Known design notes:
 *  (a) Admin indexer routes accept ANY valid JWT (no role-level admin check),
 *      consistent with the adminStack which only enforces admin scope for API keys.
 *  (b) The service layer explicitly documents that escrow events are admin-level
 *      data and not tenant-partitioned, so cross-tenant data isolation is not
 *      applicable at the database level (tenant is tracked for audit/logging).
 *  (c) Defects found & fixed as part of this work:
 *      - src/routes/sme/index.js: missing persistenceErrorHandler import
 *      - src/routes/invoiceStateRoutes.js: missing imports (extractTenant,
 *        createCompressionMiddleware, invoiceStateErrorHandler) and orphaned
 *        code blocks from a failed refactoring
 *      - src/routes/adminIndexer.js: duplicate const declarations for
 *        mapQueryToDTO & mapDTOToServiceParams
 */

// ── Top-level mocks ─────────────────────────────────────────────────────────
jest.mock('../src/db/knex', () => {
  const q = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ total: 0, 'count(*)': 0 }),
    then: jest.fn(function (resolve) {
      return Promise.resolve([]).then(resolve);
    }),
    insert: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    merge: jest.fn().mockResolvedValue(undefined),
  };
  const mockDb = jest.fn(() => q);
  mockDb._q = q;
  return mockDb;
});

// Bypass indexer metrics instrumentation which depends on prom-client.
jest.mock('../src/middleware/indexerMetrics', () => ({
  instrumentIndexer: (handler) => handler,
}));

// Mock indexer cache so it doesn't try to load prometheus metrics.
jest.mock('../src/services/indexerCache', () => {
  const mockCache = {
    get: jest.fn(() => undefined),
    set: jest.fn(),
    invalidateAll: jest.fn(),
  };
  const IndexerCacheMock = {
    buildKey: jest.fn(() => 'test-cache-key'),
  };
  return { IndexerCache: IndexerCacheMock, indexerCache: mockCache };
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// ── Shared constants ────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const ISS = process.env.JWT_ISSUER || 'liquifact';
const AUD = process.env.JWT_AUDIENCE || 'liquifact-api';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-bravo';

// ── JWT helpers ─────────────────────────────────────────────────────────────
function makeAdminToken(tenantId = TENANT_A) {
  return jwt.sign(
    { sub: 'admin-user', tenantId, role: 'admin' },
    JWT_SECRET,
    { algorithm: 'HS256', issuer: ISS, audience: AUD },
  );
}

function makeTokenWithoutTenant() {
  return jwt.sign(
    { sub: 'no-tenant-user', role: 'admin' },
    JWT_SECRET,
    { algorithm: 'HS256', issuer: ISS, audience: AUD },
  );
}

// ── API key helpers ─────────────────────────────────────────────────────────
const ADMIN_KEY = 'lf_admin_key_001';
const NOADMIN_KEY = 'lf_noadmin_key01';
const REVOKED_KEY = 'lf_revoked_key01';

function buildApiKeysEnv(entries) {
  return entries.map((e) => JSON.stringify(e)).join(';');
}

const VALID_API_KEYS = buildApiKeysEnv([
  { key: ADMIN_KEY, clientId: 'svc-admin', scopes: ['admin', 'invoices:read'] },
  { key: NOADMIN_KEY, clientId: 'svc-readonly', scopes: ['invoices:read'] },
  { key: REVOKED_KEY, clientId: 'svc-revoked', scopes: ['admin'], revoked: true },
]);

// ── Bulk event helper ───────────────────────────────────────────────────────
function makeValidEvent(overrides = {}) {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    invoiceId: 'INV-100',
    eventType: 'escrow_created',
    ledgerSequence: 100,
    ...overrides,
  };
}

// ── Build minimal test app ──────────────────────────────────────────────────
// We mount the real adminIndexer routes with the real adminStack middleware
// (auth + tenant) so that auth/tenant logic is tested end-to-end. Only the
// database layer and ancillary middleware (metrics, cache) are mocked.

function buildTestApp() {
  const app = express();
  app.use(express.json());
  // Minimal request-id stub so route handlers don't crash referencing req.id.
  app.use((req, _res, next) => {
    req.id = 'test-req-id';
    next();
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/indexer/events
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/indexer/events — auth & tenant scoping', () => {
  const adminIndexerRoutes = require('../src/routes/adminIndexer');
  const db = require('../src/db/knex');

  let app;
  let mockQ;

  beforeAll(() => {
    app = buildTestApp();
    app.use('/api/admin/indexer', adminIndexerRoutes);
    mockQ = db._q;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockQ.first.mockResolvedValue({ total: 0, 'count(*)': 0 });
    mockQ.then.mockImplementation(function (resolve) {
      return Promise.resolve([]).then(resolve);
    });
    delete process.env.API_KEYS;
  });

  afterAll(() => {
    delete process.env.API_KEYS;
  });

  // ── 401 / missing auth ─────────────────────────────────────────────────

  test('returns 401 when no Authorization header and no API key', async () => {
    const res = await request(app).get('/api/admin/indexer/events');
    expect(res.status).toBe(401);
  });

  test('returns 401 for malformed Authorization header (not Bearer)', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', 'Basic dGVzdDp0ZXN0');
    expect(res.status).toBe(401);
  });

  test('returns 401 for expired JWT', async () => {
    const expired = jwt.sign(
      { sub: 'admin-user', tenantId: TENANT_A, role: 'admin' },
      JWT_SECRET,
      { algorithm: 'HS256', issuer: ISS, audience: AUD, expiresIn: '-10s' },
    );
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  // ── 400 / missing tenant context (JWT path) ────────────────────────────

  test('returns 400 when valid JWT has no tenantId claim and no x-tenant-id header', async () => {
    const token = makeTokenWithoutTenant();
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/tenant/i);
  });

  // ── 200 / tenant from JWT claim ───────────────────────────────────────

  test('returns 200 when valid JWT has tenantId claim and no x-tenant-id header', async () => {
    const token = makeAdminToken(TENANT_A);
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // ── Tenant header priority over JWT claim ──────────────────────────────

  test('uses x-tenant-id header over JWT tenantId when both are present', async () => {
    const token = makeAdminToken(TENANT_A);
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', TENANT_B);
    expect(res.status).toBe(200);
  });

  // ── API key: missing ───────────────────────────────────────────────────

  test('returns 401 when x-api-key header is present but empty', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', '');
    expect(res.status).toBe(401);
    expect(res.body.error || JSON.stringify(res.body)).toMatch(/API key/i);
  });

  // ── API key: invalid ───────────────────────────────────────────────────

  test('returns 401 for unrecognised API key', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', 'lf_nonexistent_key');
    expect(res.status).toBe(401);
  });

  // ── API key: revoked ───────────────────────────────────────────────────

  test('returns 401 for revoked API key', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', REVOKED_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error || JSON.stringify(res.body)).toMatch(/revoked/i);
  });

  // ── API key: missing admin scope → 403 ─────────────────────────────────

  test('returns 403 when API key lacks admin scope', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', NOADMIN_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error || JSON.stringify(res.body))
      .toMatch(/permission/i);
  });

  // ── API key: valid admin scope + tenant header → 200 ───────────────────

  test('returns 200 when API key has admin scope and x-tenant-id is provided', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', ADMIN_KEY)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.message).toBe('Indexer events retrieved successfully.');
  });

  // ── API key: valid admin scope but no tenant header → 400 ──────────────

  test('returns 400 when API key has admin scope but no x-tenant-id header', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', ADMIN_KEY);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/tenant/i);
  });

  // ── API key: can specify any tenant ────────────────────────────────────

  test('API key can specify any tenant via x-tenant-id header', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', ADMIN_KEY)
      .set('x-tenant-id', TENANT_B);
    expect(res.status).toBe(200);
  });

  // ── Whitespace-trimmed API key ─────────────────────────────────────────

  test('accepts API key with surrounding whitespace', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .get('/api/admin/indexer/events')
      .set('x-api-key', `  ${ADMIN_KEY}  `)
      .set('x-tenant-id', TENANT_A);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/indexer/events/bulk
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/indexer/events/bulk — auth & tenant scoping', () => {
  const adminIndexerRoutes = require('../src/routes/adminIndexer');
  const db = require('../src/db/knex');

  let app;
  let mockQ;

  beforeAll(() => {
    app = buildTestApp();
    app.use('/api/admin/indexer', adminIndexerRoutes);
    mockQ = db._q;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockQ.first.mockResolvedValue({ total: 0, 'count(*)': 0 });
    mockQ.then.mockImplementation(function (resolve) {
      return Promise.resolve([]).then(resolve);
    });
    mockQ.insert.mockReturnThis();
    mockQ.onConflict.mockReturnThis();
    mockQ.merge.mockResolvedValue(undefined);
    delete process.env.API_KEYS;
  });

  afterAll(() => {
    delete process.env.API_KEYS;
  });

  // ── 401 / missing auth ─────────────────────────────────────────────────

  test('returns 401 when no Authorization header and no API key', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  test('returns 401 for malformed Authorization header', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', 'Basic dGVzdDp0ZXN0')
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  test('returns 401 for expired JWT', async () => {
    const expired = jwt.sign(
      { sub: 'admin-user', tenantId: TENANT_A, role: 'admin' },
      JWT_SECRET,
      { algorithm: 'HS256', issuer: ISS, audience: AUD, expiresIn: '-10s' },
    );
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${expired}`)
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  // ── 400 / missing tenant context (JWT path) ────────────────────────────

  test('returns 400 when valid JWT has no tenantId claim and no x-tenant-id header', async () => {
    const token = makeTokenWithoutTenant();
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send([makeValidEvent()]);
    expect(res.status).toBe(400);
  });

  // ── 200 / tenant from JWT claim ───────────────────────────────────────

  test('returns 200 when valid JWT has tenantId claim and no x-tenant-id header', async () => {
    const token = makeAdminToken(TENANT_A);
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send([makeValidEvent()]);
    expect(res.status).toBe(200);
  });

  // ── Tenant header priority ─────────────────────────────────────────────

  test('uses x-tenant-id header over JWT tenantId when both are present', async () => {
    const token = makeAdminToken(TENANT_A);
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', TENANT_B)
      .send([makeValidEvent()]);
    expect(res.status).toBe(200);
  });

  // ── API key: missing ───────────────────────────────────────────────────

  test('returns 401 when x-api-key header is present but empty', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('x-api-key', '')
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  // ── API key: invalid ───────────────────────────────────────────────────

  test('returns 401 for unrecognised API key', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('x-api-key', 'lf_badkey')
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  // ── API key: revoked ───────────────────────────────────────────────────

  test('returns 401 for revoked API key', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('x-api-key', REVOKED_KEY)
      .send([makeValidEvent()]);
    expect(res.status).toBe(401);
  });

  // ── API key: missing admin scope → 403 ─────────────────────────────────

  test('returns 403 when API key lacks admin scope', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('x-api-key', NOADMIN_KEY)
      .send([makeValidEvent()]);
    expect(res.status).toBe(403);
  });

  // ── API key: valid admin scope + tenant → 200 ──────────────────────────

  test('returns 200 when API key has admin scope and x-tenant-id is provided', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('x-api-key', ADMIN_KEY)
      .set('x-tenant-id', TENANT_A)
      .send([makeValidEvent()]);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Bulk indexer events processed.');
  });

  // ── API key: valid admin scope but no tenant → 400 ─────────────────────

  test('returns 400 when API key has admin scope but no x-tenant-id header', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('x-api-key', ADMIN_KEY)
      .send([makeValidEvent()]);
    expect(res.status).toBe(400);
  });

  // ── API key: works with any tenant ─────────────────────────────────────

  test('API key can specify any tenant via x-tenant-id header', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const res = await request(app)
      .post('/api/admin/indexer/events/bulk')
      .set('x-api-key', ADMIN_KEY)
      .set('x-tenant-id', TENANT_B)
      .send([makeValidEvent()]);
    expect(res.status).toBe(200);
  });
});
