'use strict';

/**
 * @fileoverview Route-level tests for POST /api/admin/reconciliation/settlement/dry-run
 *
 * Strategy: mount the real `reconciliation` router (real `adminStack` auth +
 * tenant middleware, real `runSettlementDryRun` job, real
 * `createTenantInvoiceFundingDbSource` adapter) on a minimal Express app, and
 * inject a fake Knex-shaped `dbClient` via `req._dbClient` so no real
 * database is needed. This exercises the full request path — auth, tenant
 * scoping, mode validation, DB adapter query shape, job classification, and
 * response envelope — as a genuine integration test, not a unit test with
 * the job mocked out.
 *
 * Covers:
 *  - Authentication: missing / malformed / valid JWT, valid / wrong / insufficient-scope API key
 *  - Tenant isolation: only the authenticated tenant's rows are ever queried
 *  - Explicit dry-run mode: malformed mode values (missing, wrong case, "apply") → 400 INVALID_MODE
 *  - No writes / no external calls: the fake db exposes no write methods; calling one would throw
 *  - Edge cases from the issue: no differences, many differences, repeated calls
 *  - DB failure path: structured 502, no leaked DB error detail
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const reconciliationRoutes = require('../src/routes/reconciliation');

const JWT_SECRET = process.env.JWT_SECRET;

function makeToken(overrides = {}) {
  return jwt.sign({ sub: 'admin-user', tenantId: 'tenant-a', ...overrides }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApiKeysEnv(entries) {
  return entries.map((e) => JSON.stringify(e)).join(';');
}

const ADMIN_KEY = 'lf_admin_key_settlement_01';
const READONLY_KEY = 'lf_readonly_key_settle_01';
const VALID_API_KEYS = buildApiKeysEnv([
  { key: ADMIN_KEY, clientId: 'svc-admin', scopes: ['admin'] },
  { key: READONLY_KEY, clientId: 'svc-readonly', scopes: ['invoices:read'] },
]);

/**
 * Builds a fake Knex instance backing `invoices` / `escrow_summaries` (via
 * left join, not a real join engine — the adapter only ever selects from
 * `invoices`) and `escrow_operations`. Rows are supplied per-tenant so tests
 * can assert cross-tenant isolation.
 */
function makeFakeDb({ invoicesByTenant = {}, fundingByTenant = {}, fail = null } = {}) {
  const queryLog = [];

  function invoicesBuilder() {
    const state = { tenantId: null, cursor: null, limit: 100 };
    const b = {
      leftJoin() { return b; },
      where(col, opOrVal, maybeVal) {
        if (col === 'invoices.tenant_id') { state.tenantId = opOrVal; }
        if (col === 'invoices.id') { state.cursor = maybeVal !== undefined ? maybeVal : opOrVal; }
        return b;
      },
      whereNull() { return b; },
      select() { return b; },
      orderBy() { return b; },
      limit(n) { state.limit = n; return b; },
      then(resolve, reject) {
        queryLog.push({ table: 'invoices', tenantId: state.tenantId });
        if (fail) { return Promise.reject(fail).then(resolve, reject); }
        const all = invoicesByTenant[state.tenantId] || [];
        const startIdx = state.cursor ? all.findIndex((r) => r.id === state.cursor) + 1 : 0;
        const page = all.slice(startIdx, startIdx + state.limit);
        return Promise.resolve(page).then(resolve, reject);
      },
    };
    return b;
  }

  function fundingBuilder() {
    const state = { tenantId: null, ids: [] };
    const b = {
      where(col, val) { if (col === 'escrow_operations.tenant_id') { state.tenantId = val; } return b; },
      whereIn(col, ids) { state.ids = ids; return b; },
      select() { return b; },
      then(resolve, reject) {
        queryLog.push({ table: 'escrow_operations', tenantId: state.tenantId });
        if (fail) { return Promise.reject(fail).then(resolve, reject); }
        const all = fundingByTenant[state.tenantId] || [];
        const filtered = all.filter((r) => state.ids.includes(r.invoiceId));
        return Promise.resolve(filtered).then(resolve, reject);
      },
    };
    return b;
  }

  const db = jest.fn((tableName) => {
    if (tableName === 'invoices') { return invoicesBuilder(); }
    if (tableName === 'escrow_operations') { return fundingBuilder(); }
    throw new Error(`unexpected table in fake db: ${tableName}`);
  });
  db.__queryLog = queryLog;
  return db;
}

function invoiceRow(overrides = {}) {
  return { id: 'inv-1', amount: '100.00', currency: 'USD', status: 'funded', fundedAmount: '100.00', ...overrides };
}

function buildApp(dbMock) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'test-req-id';
    if (dbMock) { req._dbClient = dbMock; }
    next();
  });
  app.use('/api/admin/reconciliation', reconciliationRoutes);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'internal' });
  });
  return app;
}

const ENDPOINT = '/api/admin/reconciliation/settlement/dry-run';

describe('POST /api/admin/reconciliation/settlement/dry-run — authentication', () => {
  afterEach(() => { delete process.env.API_KEYS; });

  it('returns 401 with no Authorization header and no API key', async () => {
    const app = buildApp(makeFakeDb());
    const res = await request(app).post(ENDPOINT).send({ mode: 'dry-run' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed Bearer token', async () => {
    const app = buildApp(makeFakeDb());
    const res = await request(app).post(ENDPOINT).set('Authorization', 'Bearer not.a.real.token').send({ mode: 'dry-run' });
    expect(res.status).toBe(401);
  });

  it('returns 200 for a valid admin JWT', async () => {
    const app = buildApp(makeFakeDb({ invoicesByTenant: { 'tenant-a': [] } }));
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({ mode: 'dry-run' });
    expect(res.status).toBe(200);
  });

  it('returns 200 for a valid admin-scoped API key', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const app = buildApp(makeFakeDb({ invoicesByTenant: { 'tenant-a': [] } }));
    const res = await request(app)
      .post(ENDPOINT)
      .set('x-api-key', ADMIN_KEY)
      .set('x-tenant-id', 'tenant-a')
      .send({ mode: 'dry-run' });
    expect(res.status).toBe(200);
  });

  it('returns 403 for an API key without the admin scope (insufficient permissions)', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const app = buildApp(makeFakeDb());
    const res = await request(app)
      .post(ENDPOINT)
      .set('x-api-key', READONLY_KEY)
      .set('x-tenant-id', 'tenant-a')
      .send({ mode: 'dry-run' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/reconciliation/settlement/dry-run — mode validation (preview vs. apply)', () => {
  it('rejects a missing mode with 400 INVALID_MODE before any query runs', async () => {
    const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': [invoiceRow()] } });
    const app = buildApp(db);
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MODE');
    expect(db.__queryLog).toHaveLength(0);
  });

  it.each(['apply', 'Dry-Run', 'DRY_RUN', 'dryrun', '', 123])(
    'rejects malformed mode value %p with 400 INVALID_MODE',
    async (mode) => {
      const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': [invoiceRow()] } });
      const app = buildApp(db);
      const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({ mode });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_MODE');
      expect(db.__queryLog).toHaveLength(0);
    },
  );

  it('an admin caller cannot reach any settlement application through mode: "apply" — proves no apply path exists regardless of privilege', async () => {
    process.env.API_KEYS = VALID_API_KEYS;
    const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': [invoiceRow()] } });
    const app = buildApp(db);
    const res = await request(app)
      .post(ENDPOINT)
      .set('x-api-key', ADMIN_KEY) // full admin privilege
      .set('x-tenant-id', 'tenant-a')
      .send({ mode: 'apply' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MODE');
    expect(db.__queryLog).toHaveLength(0);
    delete process.env.API_KEYS;
  });

  it('accepts mode: "dry-run" and returns 200', async () => {
    const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': [invoiceRow()] }, fundingByTenant: { 'tenant-a': [{ id: 'op-1', invoiceId: 'inv-1', amount: '100.00' }] } });
    const app = buildApp(db);
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({ mode: 'dry-run' });
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('dry-run');
  });
});

describe('POST /api/admin/reconciliation/settlement/dry-run — tenant isolation', () => {
  it('only queries the authenticated tenant, never another tenant\'s rows', async () => {
    const db = makeFakeDb({
      invoicesByTenant: {
        'tenant-a': [invoiceRow({ id: 'inv-a1' })],
        'tenant-b': [invoiceRow({ id: 'inv-b1', fundedAmount: '1.00' })], // would be a violation if leaked
      },
      fundingByTenant: {
        'tenant-a': [{ id: 'op-a1', invoiceId: 'inv-a1', amount: '100.00' }],
      },
    });
    const app = buildApp(db);
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken({ tenantId: 'tenant-a' })}`).send({ mode: 'dry-run' });

    expect(res.status).toBe(200);
    expect(res.body.data.scanned).toBe(1);
    expect(JSON.stringify(res.body)).not.toMatch(/inv-b1/);
    expect(db.__queryLog.every((q) => q.tenantId === 'tenant-a')).toBe(true);
  });
});

describe('POST /api/admin/reconciliation/settlement/dry-run — no writes, no external calls', () => {
  it('the injected db exposes no write methods the route could call', async () => {
    const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': [invoiceRow()] }, fundingByTenant: { 'tenant-a': [] } });
    // Sanity: this fake db object has no insert/update/delete at all — if the
    // route ever called one, it would throw "is not a function", which
    // would surface as a 500 in the assertions below, not a silent write.
    const app = buildApp(db);
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({ mode: 'dry-run' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/admin/reconciliation/settlement/dry-run — edge cases', () => {
  it('dry run with no differences: clean status, empty proposals', async () => {
    const db = makeFakeDb({
      invoicesByTenant: { 'tenant-a': [invoiceRow()] },
      fundingByTenant: { 'tenant-a': [{ id: 'op-1', invoiceId: 'inv-1', amount: '100.00' }] },
    });
    const app = buildApp(db);
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({ mode: 'dry-run' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'clean', proposedChangeCount: 0, manualReviewCount: 0, truncated: false });
  });

  it('dry run with many differences: proposals and manual-review items, bounded by maxProposals', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => invoiceRow({ id: `inv-${i}`, fundedAmount: '50.00' }));
    const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': rows }, fundingByTenant: { 'tenant-a': [] } });
    const app = buildApp(db);
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({ mode: 'dry-run', maxProposals: 5 });
    expect(res.status).toBe(200);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.proposedChangeCount + res.body.data.manualReviewCount).toBe(5);
  });

  it('dry run repeated: identical response body (minus timestamps) across calls', async () => {
    const rows = [invoiceRow({ id: 'inv-1', fundedAmount: '90.00' })];
    const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': rows }, fundingByTenant: { 'tenant-a': [] } });
    const app = buildApp(db);
    const token = makeToken();

    const first = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${token}`).send({ mode: 'dry-run', runId: 'fixed-run' });
    const second = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${token}`).send({ mode: 'dry-run', runId: 'fixed-run' });

    const strip = (body) => {
      const { startedAt, completedAt, ...rest } = body.data;
      return { ...body, data: rest, meta: { ...body.meta, timestamp: undefined } };
    };
    expect(strip(first.body)).toEqual(strip(second.body));
  });

  it('DB failure returns structured 502 with no leaked DB error detail', async () => {
    const db = makeFakeDb({ invoicesByTenant: { 'tenant-a': [invoiceRow()] }, fail: new Error('password authentication failed for user "liquifact_prod"') });
    const app = buildApp(db);
    const res = await request(app).post(ENDPOINT).set('Authorization', `Bearer ${makeToken()}`).send({ mode: 'dry-run' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/liquifact_prod|password authentication/);
  });
});
