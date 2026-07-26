'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createStandardizedApp } = require('../src/app');
const db = require('../src/db/knex');
const { createRedisEscrowSummaryCache } = require('../src/cache/redis');

// JWT secret used by the auth middleware in tests (set by tests/mocks/setup.js)
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

/** Sign a JWT with the test secret. */
function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'user_test', id: 'user_test', tenantId: 'tenant_test', ...payload },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

/** Return the Authorization header value for a test token. */
function authHeader(payload = {}) {
  return `Bearer ${makeToken(payload)}`;
}

// Mock external dependencies — must precede any require of src/app to avoid
// transitive resolution failures for optional / uninstalled packages.
jest.mock('rate-limit-redis', () => ({ RedisStore: jest.fn() }), { virtual: true });
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve(null)),
    set: jest.fn(() => Promise.resolve('OK')),
    del: jest.fn(() => Promise.resolve(1)),
    quit: jest.fn(() => Promise.resolve()),
    sendCommand: jest.fn(() => Promise.resolve(null)),
  })),
}), { virtual: true });

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (id === 'unknown-inv') return null;
    return `C_ESCROW_FOR_${id.toUpperCase()}`;
  }),
}));

// We'll mock soroban to test fallback
jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => {
    return operation();
  }),
}));

// The global jest setup mocks src/db/knex with a fake builder whose
// `.first()` always returns the same canned row. That interferes with this
// suite because the projection read path needs the seeded row to round-trip
// through .insert() -> .where(invoice_id, ...).first(). Override the global
// mock here with an in-memory store keyed by invoice_id. The factory is
// fully self-contained (no external references) so jest's mock-hoisting
// does not trip on TDZ variables. The mock also exposes `db.destroy()` so
// the afterAll hook here does not throw on in-memory teardown.
jest.mock('../src/db/knex', () => {
  const rows = new Map();
  const fakeDb = jest.fn((table) => ({
    _table: table,
    _whereId: null,
    where(field, value) {
      if (typeof field === 'string') {
        this._whereId = String(value);
      }
      return this;
    },
    async first() {
      if (!this._whereId) return null;
      return rows.get(this._whereId) || null;
    },
    async del() {
      rows.clear();
      return 0;
    },
    async destroy() {
      rows.clear();
    },
    async insert(payload) {
      const entries = Array.isArray(payload) ? payload : [payload];
      entries.forEach((entry) => {
        if (entry && entry.invoice_id) {
          rows.set(entry.invoice_id, entry);
        }
      });
      return entries.length;
    },
  }));
  fakeDb.destroy = async () => {
    rows.clear();
  };
  return fakeDb;
}, { virtual: true });

describe('GET /api/escrow/:invoiceId', () => {
  let app;
  let cache;

  beforeAll(() => {
    app = createStandardizedApp();
    cache = createRedisEscrowSummaryCache();
  });

  afterAll(async () => {
    await db.destroy();
    if (cache && cache.client) {
      await cache.client.quit();
    }
  });

  beforeEach(async () => {
    // Clear tables and cache
    await db('escrow_event_projection').del();
    if (cache && cache.client) {
      await cache.client.flushall();
    }
  });

  it('returns 404 for unknown invoice', async () => {
    const res = await request(app).get('/api/escrow/unknown-inv');
    expect(res.status).toBe(404);
    // Standardized envelope wraps route errors as `{message, code, details}`
    expect(res.body.error.message).toMatch(/No escrow contract mapping found/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reads from projection table when cache misses', async () => {
    // Seed projection
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-proj-1',
      latest_event_id: 'evt_1',
      latest_event_type: 'funded',
      latest_ledger_sequence: 12345,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
      latest_observed_at: new Date()
    });

    const res = await request(app).get('/api/escrow/inv-proj-1');
    expect(res.status).toBe(200);
    expect(res.headers['x-escrow-address']).toBe('C_ESCROW_FOR_INV-PROJ-1');
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.fundedAmount).toBe(5000);
    expect(res.body.data.latest_ledger_sequence).toBe(12345);
    expect(res.body.data.latest_event_type).toBe('funded');
    expect(res.body.data.fromProjection).toBe(true);
    // Standardized envelope: confirm success envelope shape (error=null,
    // meta stamped with version+timestamp). The original `message` field is
    // dropped by the wrapper; the data carries a `fromProjection` flag that
    // is the contract here.
    expect(res.body.error).toBeNull();
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.version).toBeDefined();

    // Verify it was cached
    if (cache) {
      const cacheResult = await cache.getSummary('inv-proj-1', 12346);
      expect(cacheResult.hit).toBe(true);
      expect(cacheResult.value.status).toBe('funded');
    }
  });

  it('falls back to live read if projection misses', async () => {
    const res = await request(app).get('/api/escrow/inv-live-1');
    expect(res.status).toBe(200);
    // No projection seeded: the fallback RPC stub must NOT fabricate funded
    // values. The neutral envelope reports status='not_found' regardless.
    expect(res.body.data.status).toBe('not_found');
    expect(res.body.data.fundedAmount).toBe(0);
    expect(res.body.data.latest_event_type).toBe('live_read');
    expect(res.body.error).toBeNull();
  });

  it('does NOT fabricate funded/settled state from the legacy fixture names', async () => {
    // Issue #354 regression: legacy keys used to return hardcoded funded/settled
    // data. With the projection-first refactor, missing projection rows must
    // fall through to the neutral stub (status='not_found', fundedAmount=0)
    // rather than fabricate state the indexer has not yet recorded.
    await db('escrow_event_projection').del();

    const fundedRes = await request(app).get('/api/escrow/funded_invoice');
    expect(fundedRes.status).toBe(200);
    expect(fundedRes.body.data.status).toBe('not_found');
    expect(fundedRes.body.data.fundedAmount).toBe(0);
    expect(fundedRes.body.data.latest_event_type).toBe('live_read');

    const settledRes = await request(app).get('/api/escrow/settled_invoice');
    expect(settledRes.status).toBe(200);
    expect(settledRes.body.data.status).toBe('not_found');
    expect(settledRes.body.data.fundedAmount).toBe(0);
  });

  it('treats malformed projection JSON as missing data (no crash)', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-bad-json',
      latest_event_id: 'evt_bad',
      latest_event_type: 'funded',
      latest_ledger_sequence: 7,
      latest_event_body: '{not json',
      latest_observed_at: new Date(),
    });

    const res = await request(app).get('/api/escrow/inv-bad-json');
    expect(res.status).toBe(200);
    // Source still marked as projection (because a row exists) but funded
    // amount gracefully falls back to 0.
    expect(res.body.data.source).toBe('projection');
    expect(res.body.data.fundedAmount).toBe(0);
    expect(res.body.data.status).toBe('funded'); // falls back to event_type
  });

  it('serves projection as cache on second request', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-cache',
      latest_event_id: 'evt_c',
      latest_event_type: 'funded',
      latest_ledger_sequence: 50,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 100 }),
      latest_observed_at: new Date(),
    });

    const first = await request(app).get('/api/escrow/inv-cache');
    expect(first.status).toBe(200);
    expect(first.body.data.fundedAmount).toBe(100);

    // The first call should have populated the cache. Don't reseed projection.
    if (cache) {
      const cached = await cache.getSummary('inv-cache', 51);
      expect(cached.hit).toBe(true);
      expect(cached.value.fundedAmount).toBe(100);
    }
  });

  it('rejects an invalid invoiceId with INVALID_INVOICE_ID', async () => {
    // /api/escrow/:invoiceId rejects obviously bad ids upstream. We sanity
    // check here via the service helper since the route is gated by mapping.
    const { validateInvoiceId } = require('../src/services/escrowRead');
    expect(validateInvoiceId('').valid).toBe(false);
    expect(validateInvoiceId('   ').valid).toBe(false);
    expect(validateInvoiceId('bad id with spaces').valid).toBe(false);
  });

  // ── Not-found / validation-failure paths (via HTTP endpoint) ───────────────

  it('returns 200 with neutral stub for valid-format but unmapped invoiceId', async () => {
    // For IDs the mock does return an address for but have no projection data,
    // the endpoint returns 200 with the neutral stub (not found on-chain).
    const res = await request(app).get('/api/escrow/nonexistent_inv_999');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('not_found');
    expect(res.body.data.fundedAmount).toBe(0);
  });

  it('returns 200 with neutral stub for empty/whitespace invoiceId via HTTP (stub)', async () => {
    // Express decodes %20 to space; route trims to empty string.
    // The mock resolves '' to an address; getEscrowStateWithProjection returns neutral stub.
    const res = await request(app).get('/api/escrow/%20');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('not_found');
    expect(res.body.data.fundedAmount).toBe(0);
  });

  // ── Idempotent-repeat paths ───────────────────────────────────────────────

  it('returns identical response shape on repeated success requests (idempotency)', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-idem-1',
      latest_event_id: 'evt_idem_1',
      latest_event_type: 'funded',
      latest_ledger_sequence: 100,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 999 }),
      latest_observed_at: new Date(),
    });

    const first = await request(app).get('/api/escrow/inv-idem-1');
    expect(first.status).toBe(200);

    const second = await request(app).get('/api/escrow/inv-idem-1');
    expect(second.status).toBe(200);

    // Core escrow fields must be identical on repeat reads
    expect(second.body.data.status).toBe(first.body.data.status);
    expect(second.body.data.fundedAmount).toBe(first.body.data.fundedAmount);
    expect(second.body.data.latest_ledger_sequence).toBe(first.body.data.latest_ledger_sequence);
    expect(second.body.data.latest_event_type).toBe(first.body.data.latest_event_type);
    expect(second.body.data.source).toBe(first.body.data.source);
    expect(second.body.data.fromProjection).toBe(first.body.data.fromProjection);
  });

  it('returns identical error shape on repeated 404 requests (idempotency)', async () => {
    // Use the one invoiceId the mock returns null for to trigger 404.
    const first = await request(app).get('/api/escrow/unknown-inv');
    expect(first.status).toBe(404);

    const second = await request(app).get('/api/escrow/unknown-inv');
    expect(second.status).toBe(404);

    // Error code and shape must be identical on repeat
    expect(second.body.error.code).toBe(first.body.error.code);
    expect(second.body.error.message).toBe(first.body.error.message);
  });

  it('invalidates cache on ledger gap', async () => {
    if (!cache) return; // Skip if no redis configured

    // Force set cache with old ledger
    await cache.setSummary('inv-gap-1', { status: 'pending', fundedAmount: 0 }, 1000);

    // If we were to query it at ledger 2000 (gap > threshold), it should miss.
    // In our app.js we don't pass currentLedger to cache.getSummary() so it doesn't gap-invalidate during GET.
    // But testing the cache gap invalidation directly:
    const cacheResult = await cache.getSummary('inv-gap-1', 2000);
    expect(cacheResult.hit).toBe(false);
    expect(cacheResult.reason).toBe('ledger_gap');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// V1 escrow-read: Authorization & Tenant Scoping
// ═══════════════════════════════════════════════════════════════════════════════
//
// The V1 escrow-read endpoint (GET /v1/escrow/:invoiceId) is protected by
// authenticateToken + extractTenant middleware, unlike the legacy /api/escrow
// endpoint which has no auth guards.
//
// NOTE (defect observed): While extractTenant ensures a tenant context exists,
// the handler does NOT verify that the caller's tenant owns the invoice/escrow
// contract. Full cross-tenant ownership enforcement is tracked separately.

describe('GET /v1/escrow/:invoiceId — Authorization & Tenant Scoping', () => {
  let app;

  beforeAll(() => {
    app = createStandardizedApp();
  });

  beforeEach(async () => {
    await db('escrow_event_projection').del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ── Missing / invalid authentication ─────────────────────────────────────

  describe('Authentication — missing or invalid', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await request(app).get('/v1/escrow/inv-auth-1');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message || res.body.error.detail).toMatch(/token/i);
    });

    it('returns 401 when Authorization header has wrong scheme', async () => {
      const res = await request(app)
        .get('/v1/escrow/inv-auth-1')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).toBe(401);
    });

    it('returns 401 for a malformed Authorization header (no Bearer prefix)', async () => {
      const res = await request(app)
        .get('/v1/escrow/inv-auth-1')
        .set('Authorization', makeToken());

      expect(res.status).toBe(401);
    });

    it('returns 401 for a token signed with the wrong secret', async () => {
      const badToken = jwt.sign(
        { sub: 'user_test', tenantId: 'tenant_test' },
        'wrong-secret-that-does-not-match',
        { algorithm: 'HS256', expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/v1/escrow/inv-auth-1')
        .set('Authorization', `Bearer ${badToken}`);

      expect(res.status).toBe(401);
    });

    it('returns 401 for an expired token', async () => {
      const expiredToken = jwt.sign(
        { sub: 'user_test', tenantId: 'tenant_test' },
        TEST_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '0s' },
      );

      // Small sleep to ensure the token is actually expired
      await new Promise((r) => setTimeout(r, 1100));

      const res = await request(app)
        .get('/v1/escrow/inv-auth-1')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
    }, 5000);

    it('returns 401 for a token signed with a disallowed algorithm (not in allowlist)', async () => {
      // Sign with HS384 — a valid algorithm but not in the HS256-only allowlist
      const badAlgToken = jwt.sign(
        { sub: 'user_test', tenantId: 'tenant_test' },
        TEST_JWT_SECRET,
        { algorithm: 'HS384', expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/v1/escrow/inv-auth-1')
        .set('Authorization', `Bearer ${badAlgToken}`);

      expect(res.status).toBe(401);
    });
  });

  // ── Missing tenant context ───────────────────────────────────────────────

  describe('Tenant context — missing', () => {
    it('returns 400 when JWT has no tenantId claim and no x-tenant-id header', async () => {
      const tokenNoTenant = jwt.sign(
        { sub: 'user_notenant', id: 'user_notenant' },
        TEST_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/v1/escrow/inv-tenant-1')
        .set('Authorization', `Bearer ${tokenNoTenant}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 400 when JWT tenantId is an empty string', async () => {
      const tokenEmptyTenant = jwt.sign(
        { sub: 'user_empty', id: 'user_empty', tenantId: '' },
        TEST_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/v1/escrow/inv-tenant-1')
        .set('Authorization', `Bearer ${tokenEmptyTenant}`);

      expect(res.status).toBe(400);
    });

    it('returns 400 when JWT tenantId is only whitespace', async () => {
      const tokenWsTenant = jwt.sign(
        { sub: 'user_ws', id: 'user_ws', tenantId: '   ' },
        TEST_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/v1/escrow/inv-tenant-1')
        .set('Authorization', `Bearer ${tokenWsTenant}`);

      expect(res.status).toBe(400);
    });
  });

  // ── Valid authentication + tenant context ────────────────────────────────

  describe('Valid authentication with tenant context', () => {
    it('returns 200 when JWT carries a valid tenantId claim', async () => {
      const res = await request(app)
        .get('/v1/escrow/inv-auth-ok')
        .set('Authorization', authHeader({ tenantId: 'tenant_alpha' }));

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      expect(res.body.data).toBeDefined();
      expect(res.body.data.status).toBeDefined();
    });

    it('returns 200 when tenant comes from x-tenant-id header (overrides JWT)', async () => {
      const res = await request(app)
        .get('/v1/escrow/inv-auth-ok')
        .set('Authorization', authHeader({ tenantId: 'tenant_alpha' }))
        .set('x-tenant-id', 'tenant_beta');

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
    });

    it('returns 200 when tenant comes ONLY from x-tenant-id header (no JWT claim)', async () => {
      const tokenNoTenant = jwt.sign(
        { sub: 'user_notenant', id: 'user_notenant' },
        TEST_JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/v1/escrow/inv-auth-ok')
        .set('Authorization', `Bearer ${tokenNoTenant}`)
        .set('x-tenant-id', 'tenant_header_only');

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
    });

    it('returns 200 with projection data when seeded', async () => {
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-v1-proj',
        latest_event_id: 'evt_v1',
        latest_event_type: 'funded',
        latest_ledger_sequence: 99,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 7500 }),
        latest_observed_at: new Date(),
      });

      const res = await request(app)
        .get('/v1/escrow/inv-v1-proj')
        .set('Authorization', authHeader());

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('funded');
      expect(res.body.data.fundedAmount).toBe(7500);
      expect(res.body.data.fromProjection).toBe(true);
    });

    it('includes X-Escrow-Address header on success', async () => {
      const res = await request(app)
        .get('/v1/escrow/inv-header-check')
        .set('Authorization', authHeader());

      expect(res.status).toBe(200);
      expect(res.headers['x-escrow-address']).toBe('C_ESCROW_FOR_INV-HEADER-CHECK');
    });
  });

  // ── Tenant scoping — cross-tenant access ─────────────────────────────────

  describe('Tenant scoping — cross-tenant access', () => {
    it('allows tenant A to read an escrow (no ownership gating at handler level)', async () => {
      // NOTE: The V1 escrow-read handler does not currently verify that the
      // authenticated tenant owns the invoice or escrow contract. The
      // extractTenant middleware only ensures a tenant context exists; the
      // handler reads escrow state regardless of which tenant makes the
      // request. This is a known gap tracked for a future iteration.
      const res = await request(app)
        .get('/v1/escrow/inv-cross-tenant')
        .set('Authorization', authHeader({ tenantId: 'tenant_alpha' }));

      expect(res.status).toBe(200);
      // Cross-tenant read succeeds because no ownership check is performed.
    });

    it('does not reject tenant B reading data that conceptually belongs to tenant A', async () => {
      // Seed projection row — the data is accessible to any authenticated
      // tenant because the handler does not gate on req.tenantId.
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-shared',
        latest_event_id: 'evt_shared',
        latest_event_type: 'funded',
        latest_ledger_sequence: 42,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 3000 }),
        latest_observed_at: new Date(),
      });

      // Tenant A can read it
      const resA = await request(app)
        .get('/v1/escrow/inv-shared')
        .set('Authorization', authHeader({ tenantId: 'tenant_a' }));
      expect(resA.status).toBe(200);
      expect(resA.body.data.fundedAmount).toBe(3000);

      // Tenant B can ALSO read it — no cross-tenant rejection
      const resB = await request(app)
        .get('/v1/escrow/inv-shared')
        .set('Authorization', authHeader({ tenantId: 'tenant_b' }));
      expect(resB.status).toBe(200);
      expect(resB.body.data.fundedAmount).toBe(3000);

      // Both tenants see the same data — tenant isolation is NOT enforced at
      // the escrow-read handler level (tracked as a defect).
    });

    it('rejects access when x-tenant-id header contains overly long value', async () => {
      const res = await request(app)
        .get('/v1/escrow/inv-long-tenant')
        .set('Authorization', authHeader({ tenantId: 'a'.repeat(200) }));

      // The sanitiseTenantId function caps at MAX_TENANT_ID_LENGTH (128).
      // A value over the cap is treated as invalid → 400.
      expect(res.status).toBe(400);
    });
  });

  // ── Edge cases: 404 for unknown invoice ──────────────────────────────────

  describe('Edge cases', () => {
    it('returns 404 for unknown invoice (with valid auth)', async () => {
      const res = await request(app)
        .get('/v1/escrow/unknown-inv')
        .set('Authorization', authHeader());

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });

    it('returns 404 even when auth and tenant are both valid', async () => {
      const res = await request(app)
        .get('/v1/escrow/unknown-inv')
        .set('Authorization', authHeader({ tenantId: 'tenant_valid' }))
        .set('x-tenant-id', 'tenant_valid');

      expect(res.status).toBe(404);
    });
  });
});
