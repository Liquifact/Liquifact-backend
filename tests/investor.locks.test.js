'use strict';

const makeMetricStub = () => {
  const fn = jest.fn();
  fn.inc = jest.fn();
  fn.set = jest.fn();
  fn.observe = jest.fn();
  fn.labels = jest.fn(() => fn);
  return fn;
};

jest.mock('../src/metrics', () => new Proxy({}, {
  get(target, prop) {
    if (!target[prop]) {
      target[prop] = makeMetricStub();
    }
    return target[prop];
  },
}));

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: (_req, _res, next) => next(),
}));

jest.mock('../src/middleware/requestId', () => (req, _res, next) => {
  req.id = 'test-request-id';
  next();
});

jest.mock('../src/middleware/correlationId', () => ({
  correlationIdMiddleware: (_req, _res, next) => next(),
}));

jest.mock('../src/routes/sme', () => {
  const express = require('express');
  return express.Router();
});

jest.mock('../src/routes/invest', () => {
  const express = require('express');
  return express.Router();
});

const request = require('supertest');
const { createApp, resetStore } = require('../src/index');
const jwt = require('jsonwebtoken');
const investorCommitmentService = require('../src/services/investorCommitment');
const db = require('../src/db/knex');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const ADDR1 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
const ADDR2 = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';
const tokenFor = (payload) => jwt.sign(payload, TEST_SECRET, { expiresIn: '1h' });
const validToken = tokenFor({ id: 'user_investor', role: 'investor', tenantId: 'test-tenant', funderAddress: ADDR1 });
const secondInvestorToken = tokenFor({ id: 'user_investor_2', role: 'investor', tenantId: 'test-tenant', funderAddress: ADDR2 });
const adminToken = tokenFor({ id: 'admin_user', role: 'admin', tenantId: 'test-tenant' });
const unboundInvestorToken = tokenFor({ id: 'user_unbound', role: 'investor', tenantId: 'test-tenant' });

describe('Investor Locks API', () => {
  let app;

  beforeAll(async () => {
    resetStore();
    await db.migrate.latest({ directory: './migrations' });
    await investorCommitmentService.clearInvestorLocks();
    await investorCommitmentService.seedInvestorLocks({ tenantId: 'test-tenant' });
    app = createApp({ enableTestRoutes: true });
  });

  afterAll(async () => {
    await investorCommitmentService.clearInvestorLocks();
    await db.destroy();
  });

  describe('GET /api/investor/locks', () => {
    it('should return 401 if no token is provided', async () => {
      const response = await request(app).get('/api/investor/locks');
      expect(response.status).toBe(401);
    });

    it('should scope omitted funderAddress to the authenticated investor', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data.every((lock) => lock.funderAddress === ADDR1)).toBe(true);
      expect(response.body.data.some((lock) => lock.funderAddress === ADDR2)).toBe(false);
      expect(response.body.meta.stale).toBe(false);
    });

    it('allows admin callers to list all tenant locks when funderAddress is omitted', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(6);
      expect(response.body.data.some((lock) => lock.funderAddress === ADDR1)).toBe(true);
      expect(response.body.data.some((lock) => lock.funderAddress === ADDR2)).toBe(true);
    });

    it('should include pagination meta fields', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.meta).toMatchObject({
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
        totalPages: expect.any(Number),
        hasMore: expect.any(Boolean),
        stale: expect.any(Boolean),
      });
    });

    it('should return stale=false in meta for fresh DB-backed reads', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.body.meta.stale).toBe(false);
    });

    it('should filter by funderAddress when provided', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data.every((l) => l.funderAddress === ADDR1)).toBe(true);
    });

    it('denies a non-admin caller that requests another funderAddress', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR2}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('not authorized');
    });

    it('allows an admin caller to request another funderAddress', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR2}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(1);
      expect(response.body.data.every((lock) => lock.funderAddress === ADDR2)).toBe(true);
    });

    it('denies non-admin callers that have no bound funderAddress', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${unboundInvestorToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('not bound');
    });

    it('should return 400 for invalid address format', async () => {
      const response = await request(app)
        .get('/api/investor/locks?funderAddress=invalid')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('invalid Stellar address');
    });

    it('should filter by invoiceId when provided', async () => {
      const response = await request(app)
        .get('/api/investor/locks?invoiceId=inv_7788')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.every((lock) => lock.invoiceId === 'inv_7788')).toBe(true);
    });

    // ── Pagination tests ──────────────────────────────────────────────────────

    it('should return the first page with limit=2', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=2&page=1')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.limit).toBe(2);
      expect(response.body.meta.hasMore).toBe(true);
    });

    it('should return second page with limit=2', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=2&page=2')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      expect(response.body.meta.page).toBe(2);
    });

    it('should return hasMore=false on last page', async () => {
      // 6 total locks seeded; last page at limit=4 is page 2 with 2 items
      const first = await request(app)
        .get('/api/investor/locks?limit=4&page=1')
        .set('Authorization', `Bearer ${validToken}`);
      const second = await request(app)
        .get('/api/investor/locks?limit=4&page=2')
        .set('Authorization', `Bearer ${validToken}`);

      expect(first.body.meta.hasMore).toBe(true);
      expect(second.body.meta.hasMore).toBe(false);
    });

    it('should return empty data array for a page beyond totalPages', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=100&page=99')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.hasMore).toBe(false);
    });

    it('should return 400 for limit=0', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=0')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('limit');
    });

    it('should return 400 for limit > 100', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=101')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('limit');
    });

    it('should return 400 for non-integer limit', async () => {
      const response = await request(app)
        .get('/api/investor/locks?limit=abc')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('limit');
    });

    it('should return 400 for page=0', async () => {
      const response = await request(app)
        .get('/api/investor/locks?page=0')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('page');
    });

    it('should paginate funderAddress-scoped results', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR1}&limit=2&page=1`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      // All returned locks must belong to ADDR1 — no cross-funder leakage
      expect(response.body.data.every((l) => l.funderAddress === ADDR1)).toBe(true);
      expect(response.body.meta.hasMore).toBe(true);
    });

    it('should not leak ADDR2 locks when filtering by ADDR1', async () => {
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      const hasAddr2 = response.body.data.some((l) => l.funderAddress === ADDR2);
      expect(hasAddr2).toBe(false);
    });

    it('should return all pages consistently (no overlaps, no gaps)', async () => {
      const pageSize = 2;
      const seen = new Set();
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await request(app)
          .get(`/api/investor/locks?limit=${pageSize}&page=${page}`)
          .set('Authorization', `Bearer ${validToken}`);

        expect(res.status).toBe(200);
        for (const lock of res.body.data) {
          const key = `${lock.invoiceId}:${lock.funderAddress}`;
          expect(seen.has(key)).toBe(false); // no duplicates
          seen.add(key);
        }
        hasMore = res.body.meta.hasMore;
        page++;
      }

      // The non-admin caller sees only the 5 seeded locks for their bound address.
      expect(seen.size).toBe(5);
      expect([...seen].every((key) => key.endsWith(`:${ADDR1}`))).toBe(true);
    });

    it('does not reuse cached list responses across different bound funders', async () => {
      resetStore();

      const first = await request(app)
        .get('/api/investor/locks?limit=100')
        .set('Authorization', `Bearer ${validToken}`);
      const second = await request(app)
        .get('/api/investor/locks?limit=100')
        .set('Authorization', `Bearer ${secondInvestorToken}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.data.every((lock) => lock.funderAddress === ADDR1)).toBe(true);
      expect(second.body.data.every((lock) => lock.funderAddress === ADDR2)).toBe(true);
      expect(second.body.data).toHaveLength(1);
    });
  });

  describe('GET /api/investor/locks/:invoiceId', () => {
    it('should return 400 if funderAddress query param is missing', async () => {
      const response = await request(app)
        .get('/api/investor/locks/inv_7788')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('funderAddress');
    });

    it('should return 400 for invalid funderAddress', async () => {
      const response = await request(app)
        .get('/api/investor/locks/inv_7788?funderAddress=bad')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('invalid Stellar address');
    });

    it('should return 404 if lock not found', async () => {
      const response = await request(app)
        .get(`/api/investor/locks/nonexistent_invoice?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(404);
    });

    it('should return lock record when found', async () => {
      const response = await request(app)
        .get(`/api/investor/locks/inv_7788?funderAddress=${ADDR1}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.funderAddress).toBe(ADDR1);
      expect(response.body.data.invoiceId).toBe('inv_7788');
      expect(response.body.data).toHaveProperty('claimNotBefore');
      expect(response.body.data).toHaveProperty('investorEffectiveYieldBps');
      expect(response.body.data).toHaveProperty('stale');
    });

    it('denies a single-lock lookup for another funderAddress', async () => {
      const response = await request(app)
        .get(`/api/investor/locks/inv_9900?funderAddress=${ADDR2}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('not authorized');
    });

    it('does not reuse cached single-lock responses across different bound funders', async () => {
      resetStore();

      const first = await request(app)
        .get(`/api/investor/locks/inv_9900?funderAddress=${ADDR2}`)
        .set('Authorization', `Bearer ${adminToken}`);
      const second = await request(app)
        .get(`/api/investor/locks/inv_9900?funderAddress=${ADDR2}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(first.status).toBe(200);
      expect(first.body.data.funderAddress).toBe(ADDR2);
      expect(second.status).toBe(403);
    });
  });
});

describe('Investor Commitment Service', () => {
  beforeEach(async () => {
    await investorCommitmentService.clearInvestorLocks();
  });

  describe('validateAddress', () => {
    it('should return valid for correct G... address', () => {
      const result = investorCommitmentService.validateAddress(ADDR1);
      expect(result.valid).toBe(true);
    });

    it('should return valid for correct C... address', () => {
      const result = investorCommitmentService.validateAddress(
        'CDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK'
      );
      expect(result.valid).toBe(true);
    });

    it('should return invalid for empty string', () => {
      const result = investorCommitmentService.validateAddress('');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for wrong prefix', () => {
      const result = investorCommitmentService.validateAddress('XDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for wrong length', () => {
      const result = investorCommitmentService.validateAddress('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL');
      expect(result.valid).toBe(false);
    });
  });

  describe('setInvestorLock', () => {
    it('should create a new lock record', async () => {
      const lock = await investorCommitmentService.setInvestorLock({
        funderAddress: ADDR1,
        claimNotBefore: '2026-03-01T00:00:00Z',
        investorEffectiveYieldBps: 900,
        invoiceId: 'inv_test',
      });

      expect(lock.funderAddress).toBe(ADDR1);
      expect(lock.claimNotBefore).toBe('2026-03-01T00:00:00.000Z');
      expect(lock.investorEffectiveYieldBps).toBe(900);
      expect(lock.invoiceId).toBe('inv_test');
      expect(lock.stale).toBe(false);
    });

    it('should update existing lock', async () => {
      await investorCommitmentService.setInvestorLock({
        funderAddress: ADDR1,
        claimNotBefore: '2026-01-01T00:00:00Z',
        investorEffectiveYieldBps: 500,
        invoiceId: 'inv_upd',
      });

      await investorCommitmentService.setInvestorLock({
        funderAddress: ADDR1,
        claimNotBefore: '2026-02-01T00:00:00Z',
        investorEffectiveYieldBps: 600,
        invoiceId: 'inv_upd',
      });

      const result = await investorCommitmentService.getInvestorLocksByAddress(ADDR1, { invoiceId: 'inv_upd' });
      expect(result.data.length).toBe(1);
      expect(result.data[0].investorEffectiveYieldBps).toBe(600);
    });
  });

  describe('getInvestorLock', () => {
    it('should retrieve lock by invoiceId and funderAddress', async () => {
      await investorCommitmentService.setInvestorLock({
        funderAddress: ADDR2,
        claimNotBefore: '2026-04-01T00:00:00Z',
        investorEffectiveYieldBps: 750,
        invoiceId: 'inv_find',
      });

      const lock = await investorCommitmentService.getInvestorLock('inv_find', ADDR2);
      expect(lock).toBeDefined();
      expect(lock.investorEffectiveYieldBps).toBe(750);
    });

    it('should return undefined for non-existent lock', async () => {
      const lock = await investorCommitmentService.getInvestorLock('inv_none', ADDR1);
      expect(lock).toBeUndefined();
    });
  });

  describe('getAllInvestorLocks pagination', () => {
    beforeEach(async () => {
      // Seed 5 locks for ADDR1
      for (let i = 1; i <= 5; i++) {
        await investorCommitmentService.setInvestorLock({
          funderAddress: ADDR1,
          claimNotBefore: `2026-0${i}-01T00:00:00Z`,
          investorEffectiveYieldBps: 500 + i * 10,
          invoiceId: `inv_p${i}`,
        });
      }
    });

    it('should return first page', async () => {
      const result = await investorCommitmentService.getAllInvestorLocks({ limit: 2, page: 1 });
      expect(result.data.length).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.total).toBe(5);
      expect(result.meta.hasMore).toBe(true);
      expect(result.meta.totalPages).toBe(3);
    });

    it('should return last page (partial)', async () => {
      const result = await investorCommitmentService.getAllInvestorLocks({ limit: 2, page: 3 });
      expect(result.data.length).toBe(1);
      expect(result.meta.hasMore).toBe(false);
    });

    it('should return empty data for out-of-range page', async () => {
      const result = await investorCommitmentService.getAllInvestorLocks({ limit: 10, page: 99 });
      expect(result.data).toEqual([]);
      expect(result.meta.hasMore).toBe(false);
    });

    it('should filter by invoiceId', async () => {
      const result = await investorCommitmentService.getAllInvestorLocks({ invoiceId: 'inv_p3' });
      expect(result.data.length).toBe(1);
      expect(result.data[0].invoiceId).toBe('inv_p3');
    });

    it('should clamp limit to 1..100', async () => {
      const low = await investorCommitmentService.getAllInvestorLocks({ limit: 0 });
      expect(low.meta.limit).toBe(1);

      const high = await investorCommitmentService.getAllInvestorLocks({ limit: 999 });
      expect(high.meta.limit).toBe(100);
    });
  });

  describe('getInvestorLocksByAddress pagination', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 4; i++) {
        await investorCommitmentService.setInvestorLock({
          funderAddress: ADDR1,
          claimNotBefore: `2026-0${i}-01T00:00:00Z`,
          investorEffectiveYieldBps: 500 + i * 10,
          invoiceId: `inv_a${i}`,
        });
      }
      // ADDR2 lock — must never appear in ADDR1 results
      await investorCommitmentService.setInvestorLock({
        funderAddress: ADDR2,
        claimNotBefore: '2026-06-01T00:00:00Z',
        investorEffectiveYieldBps: 700,
        invoiceId: 'inv_b1',
      });
    });

    it('should only return locks for the specified funder', async () => {
      const result = await investorCommitmentService.getInvestorLocksByAddress(ADDR1);
      expect(result.data.every((l) => l.funderAddress === ADDR1)).toBe(true);
      expect(result.meta.total).toBe(4);
    });

    it('should paginate correctly for funderAddress scope', async () => {
      const p1 = await investorCommitmentService.getInvestorLocksByAddress(ADDR1, { limit: 2, page: 1 });
      const p2 = await investorCommitmentService.getInvestorLocksByAddress(ADDR1, { limit: 2, page: 2 });

      expect(p1.data.length).toBe(2);
      expect(p1.meta.hasMore).toBe(true);
      expect(p2.data.length).toBe(2);
      expect(p2.meta.hasMore).toBe(false);
    });

    it('should not include ADDR2 locks when querying ADDR1', async () => {
      const result = await investorCommitmentService.getInvestorLocksByAddress(ADDR1);
      expect(result.data.some((l) => l.funderAddress === ADDR2)).toBe(false);
    });
  });

  describe('tenant persistence', () => {
    it('stores the same invoice/funder independently per tenant', async () => {
      await investorCommitmentService.setInvestorLock({
        tenantId: 'tenant-a',
        funderAddress: ADDR1,
        claimNotBefore: '2026-07-01T00:00:00Z',
        investorEffectiveYieldBps: 710,
        invoiceId: 'inv_shared',
      });
      await investorCommitmentService.setInvestorLock({
        tenantId: 'tenant-b',
        funderAddress: ADDR1,
        claimNotBefore: '2026-08-01T00:00:00Z',
        investorEffectiveYieldBps: 820,
        invoiceId: 'inv_shared',
      });

      const tenantA = await investorCommitmentService.getInvestorLock('inv_shared', ADDR1, { tenantId: 'tenant-a' });
      const tenantB = await investorCommitmentService.getInvestorLock('inv_shared', ADDR1, { tenantId: 'tenant-b' });
      const rows = await db('investor_locks')
        .where({ invoice_id: 'inv_shared', funder_address: ADDR1 })
        .orderBy('tenant_id', 'asc');

      expect(tenantA.investorEffectiveYieldBps).toBe(710);
      expect(tenantB.investorEffectiveYieldBps).toBe(820);
      expect(rows).toHaveLength(2);
    });
  });
});
