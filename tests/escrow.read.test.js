'use strict';

// Mock external dependencies — this project's Jest config runs with
// `transform: {}` (no babel-jest), so `jest.mock()` calls are NOT hoisted
// above requires the way they would be under a babel transform. That means
// these calls MUST appear, in source order, before any `require(...)` of
// `../src/app` (or any other module that transitively requires them) —
// otherwise the real implementations get loaded and cached first, and the
// mocks below never take effect.
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

// Requires of `../src/app` (and anything that transitively pulls in the
// modules mocked above) must come after all `jest.mock(...)` calls — see
// the note at the top of this file.
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

  it('returns 400 for a whitespace-only invoiceId via HTTP (fails validation)', async () => {
    // Express decodes %20 to space; the route trims it to an empty string.
    // The invoice-id validation regex requires a non-empty string, so this
    // must be rejected with 400 rather than falling through to a 200 stub —
    // silently accepting an empty id would bypass the validation contract.
    const res = await request(app).get('/api/escrow/%20');
    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('BAD_REQUEST');
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

describe('ESCROW_READ_PROJECTION_ENABLED feature flag', () => {
  let app;
  let testCache;

  beforeAll(() => {
    app = createStandardizedApp();
    testCache = createRedisEscrowSummaryCache();
  });

  beforeEach(async () => {
    await db('escrow_event_projection').del();
    if (testCache && testCache.client) {
      await testCache.client.flushall();
    }
  });

  it('reads from projection when flag is enabled (default)', async () => {
    // Seed projection
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-flag-on-1',
      latest_event_id: 'evt_flag_1',
      latest_event_type: 'funded',
      latest_ledger_sequence: 55555,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 3000 }),
      latest_observed_at: new Date()
    });

    // Default: ESCROW_READ_PROJECTION_ENABLED is 'true' (no env override needed)
    const res = await request(app).get('/api/escrow/inv-flag-on-1');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.fundedAmount).toBe(3000);
    expect(res.body.data.fromProjection).toBe(true);
    expect(res.body.message).toMatch(/from event projection/);
  });

  it('skips projection and goes to live read when flag is disabled', async () => {
    // Temporarily set env to disable the feature
    const origEnv = process.env.ESCROW_READ_PROJECTION_ENABLED;
    process.env.ESCROW_READ_PROJECTION_ENABLED = 'false';

    // Re-import modules with fresh config. jest.resetModules() clears the
    // require cache, including the config module's internal validated-state,
    // so it must be re-validated before src/app.js (which reads getConfig())
    // is required again.
    jest.resetModules();
    require('../src/config').validate();

    // Seed projection data (should be ignored when flag is off)
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-flag-off-1',
      latest_event_id: 'evt_flag_off',
      latest_event_type: 'funded',
      latest_ledger_sequence: 66666,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
      latest_observed_at: new Date()
    });

    // Create fresh app with updated env
    const { createStandardizedApp: createAppFresh } = require('../src/app');
    const freshApp = createAppFresh();

    const res = await request(freshApp).get('/api/escrow/inv-flag-off-1');
    // Should fall through to live read, which returns not_found with 0 amount
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('not_found');
    expect(res.body.data.fundedAmount).toBe(0);
    expect(res.body.data.latest_event_type).toBe('live_read');
    // The projection fields should NOT be present
    expect(res.body.data.fromProjection).toBeUndefined();

    process.env.ESCROW_READ_PROJECTION_ENABLED = origEnv;
  });

  it('returns live read data when flag is off even with no projection data', async () => {
    const origEnv = process.env.ESCROW_READ_PROJECTION_ENABLED;
    process.env.ESCROW_READ_PROJECTION_ENABLED = 'false';
    jest.resetModules();
    require('../src/config').validate();

    const { createStandardizedApp: createAppFresh } = require('../src/app');
    const freshApp = createAppFresh();

    const res = await request(freshApp).get('/api/escrow/inv-flag-off-none');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('not_found');
    expect(res.body.data.latest_event_type).toBe('live_read');
    expect(res.body.data.fromProjection).toBeUndefined();

    process.env.ESCROW_READ_PROJECTION_ENABLED = origEnv;
  });
});

// ── Unit-level coverage: projection-read edge cases (issue: replace escrowRead
// stub values with projection reads) ───────────────────────────────────────
//
// These exercise `getEscrowStateWithProjection` / `readEscrowState` directly
// (no HTTP layer) so cache-hit and metadata-miss behaviour can be asserted
// deterministically, without depending on the Redis mock's always-miss
// `get()` stub used elsewhere in this file.
describe('escrowRead projection-read edge cases (unit-level)', () => {
  // Reuse the already-mocked `../src/db/knex` singleton (see top of file) so
  // seeded rows are visible to escrowRead.js's own `require('../db/knex')`.
  const escrowRead = require('../src/services/escrowRead');
  const { escrowReadCache } = require('../src/services/escrowReadCache');

  afterEach(async () => {
    await db('escrow_event_projection').del();
    escrowReadCache.invalidate('inv-cache-hit-unit');
  });

  it('serves a cache hit from the in-process cache without re-reading the projection table', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-cache-hit-unit',
      latest_event_id: 'evt_cache_hit',
      latest_event_type: 'funded',
      latest_ledger_sequence: 900,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 4200 }),
      latest_observed_at: new Date(),
    });

    const first = await escrowRead.getEscrowStateWithProjection('inv-cache-hit-unit');
    expect(first.fundedAmount).toBe(4200);
    expect(first.source).toBe('projection');

    // Remove the projection row entirely — if the second call were to hit the
    // DB again it would fall through to the neutral not-found stub instead
    // of the cached value, so a matching result here proves the cache path
    // was used rather than a fresh projection read.
    await db('escrow_event_projection').del();

    const second = await escrowRead.getEscrowStateWithProjection('inv-cache-hit-unit');
    expect(second).toBe(first);
    expect(second.fundedAmount).toBe(4200);
  });

  it('keeps the read best-effort when token-metadata enrichment fails (warn-and-continue)', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-metadata-miss',
      latest_event_id: 'evt_meta_miss',
      latest_event_type: 'funded',
      latest_ledger_sequence: 10,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 750 }),
      latest_observed_at: new Date(),
    });

    const failingTokenMetaAdapter = jest.fn().mockRejectedValue(new Error('token metadata RPC unavailable'));

    const state = await escrowRead.readEscrowState('inv-metadata-miss', {
      fundingAsset: 'SOME_ASSET_CODE',
      tokenMetaAdapter: failingTokenMetaAdapter,
    });

    // The read itself must succeed and still carry the real projection data —
    // a metadata-fetch failure must never fail (or fabricate) the whole read.
    expect(failingTokenMetaAdapter).toHaveBeenCalledWith('SOME_ASSET_CODE');
    expect(state.status).toBe('funded');
    expect(state.fundedAmount).toBe(750);
    expect(state.funding_token).toBeNull();
  });

  it('never uses projection/cached decimals to scale fundedAmount (decimals are display-only)', async () => {
    // A malicious or stale projection row could carry a `decimals` field in
    // its event body (e.g. copied from token metadata). Even if present, it
    // must never be used to rescale the on-chain fundedAmount figure.
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-decimals-guard',
      latest_event_id: 'evt_decimals',
      latest_event_type: 'funded',
      latest_ledger_sequence: 5,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 1000, decimals: 18 }),
      latest_observed_at: new Date(),
    });

    const state = await escrowRead.getEscrowStateWithProjection('inv-decimals-guard');

    // fundedAmount must equal the raw projected value, unscaled by `decimals`
    // (e.g. NOT 1000 / 10**18 or 1000 * 10**18).
    expect(state.fundedAmount).toBe(1000);
    // The projection-derived base state never surfaces a `decimals` field —
    // only src/services/tokenMeta.js's live metadata lookup may carry one,
    // and that value is documented as display-only.
    expect(state.decimals).toBeUndefined();
  });

  it('readFundedAmount reads the projected amount directly', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-funded-amount-only',
      latest_event_id: 'evt_amt',
      latest_event_type: 'funded',
      latest_ledger_sequence: 3,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 250 }),
      latest_observed_at: new Date(),
    });

    const amount = await escrowRead.readFundedAmount('inv-funded-amount-only');
    expect(amount).toBe(250);
  });

  it('readFundedAmount returns 0 (never fabricates) when no projection exists', async () => {
    const amount = await escrowRead.readFundedAmount('inv-no-projection-amount');
    expect(amount).toBe(0);
  });

  it('readFundedAmount rejects an invalid invoiceId', async () => {
    await expect(escrowRead.readFundedAmount('bad id')).rejects.toThrow(/invalid characters/);
  });

  it('falls back to the RPC stub (never fabricates funded state) when the projection read throws', async () => {
    const throwingDbClient = jest.fn(() => ({
      where() {
        return this;
      },
      first() {
        return Promise.reject(new Error('connection reset'));
      },
    }));

    const state = await escrowRead.readEscrowState('inv-db-error', {
      dbClient: throwingDbClient,
    });

    expect(throwingDbClient).toHaveBeenCalledWith('escrow_event_projection');
    expect(state.status).toBe('not_found');
    expect(state.fundedAmount).toBe(0);
    expect(state.source).toBe('rpc_stub');
  });

  it('getEscrowStateWithProjection skips the projection/cache path entirely when the flag is disabled', async () => {
    // `isProjectionEnabled()` reads the validated config singleton, which is
    // built once from `process.env` at `validate()` time — so the flag must
    // be flipped, and both `escrowRead` and `../db/knex` re-required fresh
    // (sharing the same new in-memory mock), before the env change takes
    // effect. This mirrors the HTTP-level flag tests above.
    const origEnv = process.env.ESCROW_READ_PROJECTION_ENABLED;
    process.env.ESCROW_READ_PROJECTION_ENABLED = 'false';
    jest.resetModules();
    require('../src/config').validate();

    const freshDb = require('../src/db/knex');
    const freshEscrowRead = require('../src/services/escrowRead');

    try {
      await freshDb('escrow_event_projection').insert({
        invoice_id: 'inv-flag-off-unit',
        latest_event_id: 'evt_flag_off_unit',
        latest_event_type: 'funded',
        latest_ledger_sequence: 1,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 8000 }),
        latest_observed_at: new Date(),
      });

      const state = await freshEscrowRead.getEscrowStateWithProjection('inv-flag-off-unit');
      // Seeded projection data must be ignored while the flag is off — the
      // live-read neutral stub must not fabricate the seeded funded amount.
      expect(state.status).toBe('not_found');
      expect(state.fundedAmount).toBe(0);
      expect(state.latest_event_type).toBe('live_read');
    } finally {
      process.env.ESCROW_READ_PROJECTION_ENABLED = origEnv;
    }
  });

  it('invalidateEscrowReadCache clears a previously cached response', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-invalidate-unit',
      latest_event_id: 'evt_invalidate',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 42 }),
      latest_observed_at: new Date(),
    });

    const first = await escrowRead.getEscrowStateWithProjection('inv-invalidate-unit');
    expect(first.fundedAmount).toBe(42);

    const wasInvalidated = await escrowRead.invalidateEscrowReadCache('inv-invalidate-unit');
    expect(wasInvalidated).toBe(true);

    // Remove the row, then confirm a fresh read no longer sees the stale
    // cached value (proves invalidation actually cleared the local cache).
    await db('escrow_event_projection').del();
    const second = await escrowRead.getEscrowStateWithProjection('inv-invalidate-unit');
    expect(second.status).toBe('not_found');
    expect(second.fundedAmount).toBe(0);
  });

  it('invalidateEscrowReadCache is a no-op for a non-string invoiceId', async () => {
    const result = await escrowRead.invalidateEscrowReadCache(undefined);
    expect(result).toBe(false);
  });

  it('readEscrowState rejects an invalid invoiceId directly (not only via the HTTP layer)', async () => {
    await expect(escrowRead.readEscrowState('bad id')).rejects.toMatchObject({
      code: 'INVALID_INVOICE_ID',
      status: 400,
    });
  });

  it('legal-hold status fails closed (unknown, not not_held) when the on-chain call errors', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-legalhold-error',
      latest_event_id: 'evt_lh',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 10 }),
      latest_observed_at: new Date(),
    });

    const throwingLegalHoldAdapter = jest.fn().mockRejectedValue(new Error('RPC timeout'));

    const state = await escrowRead.readEscrowState('inv-legalhold-error', {
      legalHoldAdapter: throwingLegalHoldAdapter,
    });

    // Issue #424: an unreadable legal-hold status must never collapse to
    // `not_held` — it must surface as `unknown` and gate closed (legal_hold
    // = true) so a compliance flag can never be silently bypassed.
    expect(state.legalHoldStatus).toBe('unknown');
    expect(state.legal_hold).toBe(true);
    expect(state.legalHoldReason).toBe('rpc_error');
  });

  it('excludes a soft-deleted projection row from a default read (falls through to the neutral stub)', async () => {
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-soft-deleted',
      latest_event_id: 'evt_soft_deleted',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 999 }),
      latest_observed_at: new Date(),
      deleted_at: new Date(),
    });

    const state = await escrowRead.readEscrowState('inv-soft-deleted');

    expect(state.status).toBe('not_found');
    expect(state.fundedAmount).toBe(0);
    expect(state.source).toBe('rpc_stub');
  });

  it('treats a projection row with no meaningful event data as absent', async () => {
    // A row that exists (e.g. an early cursor bookmark) but carries no
    // status, fundedAmount, ledgerCloseTime, or maturity fields must not be
    // surfaced as a real projection — it falls through to the neutral stub.
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-empty-projection',
      latest_event_id: null,
      latest_event_type: null,
      latest_ledger_sequence: null,
      latest_event_body: JSON.stringify({}),
      latest_observed_at: new Date(),
    });

    const state = await escrowRead.readEscrowState('inv-empty-projection');

    expect(state.status).toBe('not_found');
    expect(state.fundedAmount).toBe(0);
    expect(state.source).toBe('rpc_stub');
  });

  it('isProjectionEnabled defaults to enabled when config has not been validated yet', () => {
    const configModule = require('../src/config');
    const originalGet = configModule.get;
    configModule.get = () => {
      throw new Error('Config not validated. Call validate() first.');
    };
    try {
      expect(escrowRead.isProjectionEnabled()).toBe(true);
    } finally {
      configModule.get = originalGet;
    }
  });
});
