'use strict';

/**
 * Escrow read caching tests for GET /api/investor/locks (issue #519).
 */

jest.mock('../src/metrics', () => new Proxy({}, {
  get(target, prop) {
    if (!target[prop]) {
      const fn = jest.fn();
      fn.inc = jest.fn();
      fn.set = jest.fn();
      fn.observe = jest.fn();
      fn.labels = jest.fn(() => fn);
      target[prop] = fn;
    }
    return target[prop];
  },
}));

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: (_req, _res, next) => next(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp, resetStore } = require('../src/index');
const investorCommitmentService = require('../src/services/investorCommitment');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const ADDR1 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
const ADDR2 = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';
const tokenFor = (payload) => jwt.sign(payload, TEST_SECRET, { expiresIn: '1h' });
const validToken = tokenFor({ id: 'user_investor', role: 'investor', tenantId: 'test-tenant', funderAddress: ADDR1 });
const secondInvestorToken = tokenFor({ id: 'user_investor_2', role: 'investor', tenantId: 'test-tenant', funderAddress: ADDR2 });

describe('investor locks escrow read cache (issue #519)', () => {
  let app;

  beforeAll(() => {
    resetStore();
    investorCommitmentService.clearInvestorLocks();
    investorCommitmentService.seedInvestorLocks();
    app = createApp({ enableTestRoutes: true });
  });

  afterAll(() => {
    investorCommitmentService.clearInvestorLocks();
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

  it('does not reuse cached single-lock responses across different bound funders', async () => {
    resetStore();

    const first = await request(app)
      .get(`/api/investor/locks/inv_7788?funderAddress=${ADDR1}`)
      .set('Authorization', `Bearer ${validToken}`);
    const second = await request(app)
      .get(`/api/investor/locks/inv_9900?funderAddress=${ADDR2}`)
      .set('Authorization', `Bearer ${secondInvestorToken}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data.funderAddress).toBe(ADDR1);
    expect(second.body.data.funderAddress).toBe(ADDR2);
  });
});
