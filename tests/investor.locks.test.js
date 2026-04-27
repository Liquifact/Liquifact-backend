'use strict';

const request = require('supertest');
const { createApp } = require('../src/index');
const jwt = require('jsonwebtoken');
const investorCommitmentService = require('../src/services/investorCommitment');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const validToken = jwt.sign({ id: 'user_investor', role: 'investor' }, TEST_SECRET, { expiresIn: '1h' });

describe('Investor Locks API', () => {
  let app;

  beforeAll(() => {
    investorCommitmentService.clearInvestorLocks();
    investorCommitmentService.seedInvestorLocks();
    app = createApp({ enableTestRoutes: true });
  });

  afterAll(() => {
    investorCommitmentService.clearInvestorLocks();
  });

  describe('GET /api/investor/locks', () => {
    it('should return 401 if no token is provided', async () => {
      const response = await request(app).get('/api/investor/locks');
      expect(response.status).toBe(401);
    });

    it('should return 200 with all locks when authenticated without filters', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.meta.stale).toBe(true);
    });

    it('should return stale=true in meta when DB mirror data exists', async () => {
      const response = await request(app)
        .get('/api/investor/locks')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.body.meta.stale).toBe(true);
    });

    it('should filter by funderAddress when provided', async () => {
      const funderAddress = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
      const response = await request(app)
        .get(`/api/investor/locks?funderAddress=${funderAddress}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0].funderAddress).toBe(funderAddress);
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
      const funderAddress = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
      const response = await request(app)
        .get('/api/investor/locks/nonexistent_invoice?funderAddress=' + funderAddress)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(404);
    });

    it('should return lock record when found', async () => {
      const funderAddress = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
      const response = await request(app)
        .get('/api/investor/locks/inv_7788?funderAddress=' + funderAddress)
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.funderAddress).toBe(funderAddress);
      expect(response.body.data.invoiceId).toBe('inv_7788');
      expect(response.body.data).toHaveProperty('claimNotBefore');
      expect(response.body.data).toHaveProperty('investorEffectiveYieldBps');
      expect(response.body.data).toHaveProperty('stale');
    });
  });
});

describe('Investor Commitment Service', () => {
  beforeEach(() => {
    investorCommitmentService.clearInvestorLocks();
  });

  describe('validateAddress', () => {
    it('should return valid for correct G... address', () => {
      const result = investorCommitmentService.validateAddress(
        'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK'
      );
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
    it('should create a new lock record', () => {
      const lock = investorCommitmentService.setInvestorLock({
        funderAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK',
        claimNotBefore: '2026-03-01T00:00:00Z',
        investorEffectiveYieldBps: 900,
        invoiceId: 'inv_test',
      });

      expect(lock.funderAddress).toBe('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK');
      expect(lock.claimNotBefore).toBe('2026-03-01T00:00:00Z');
      expect(lock.investorEffectiveYieldBps).toBe(900);
      expect(lock.invoiceId).toBe('inv_test');
      expect(lock.stale).toBe(true);
    });

    it('should update existing lock', () => {
      const funder = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';

      investorCommitmentService.setInvestorLock({
        funderAddress: funder,
        claimNotBefore: '2026-01-01T00:00:00Z',
        investorEffectiveYieldBps: 500,
        invoiceId: 'inv_upd',
      });

      const updated = investorCommitmentService.setInvestorLock({
        funderAddress: funder,
        claimNotBefore: '2026-02-01T00:00:00Z',
        investorEffectiveYieldBps: 600,
        invoiceId: 'inv_upd',
      });

      const locks = investorCommitmentService.getInvestorLocksByAddress(funder, { invoiceId: 'inv_upd' });
      expect(locks.length).toBe(1);
      expect(locks[0].investorEffectiveYieldBps).toBe(600);
    });
  });

  describe('getInvestorLock', () => {
    it('should retrieve lock by invoiceId and funderAddress', () => {
      investorCommitmentService.setInvestorLock({
        funderAddress: 'GDGQVOKHW4VEJRU2TETD8G6RWJ3TVM3VROMV7I3ESNITIBLL6QL6RAIL',
        claimNotBefore: '2026-04-01T00:00:00Z',
        investorEffectiveYieldBps: 750,
        invoiceId: 'inv_find',
      });

      const lock = investorCommitmentService.getInvestorLock(
        'inv_find',
        'GDGQVOKHW4VEJRU2TETD8G6RWJ3TVM3VROMV7I3ESNITIBLL6QL6RAIL'
      );

      expect(lock).toBeDefined();
      expect(lock.investorEffectiveYieldBps).toBe(750);
    });

    it('should return undefined for non-existent lock', () => {
      const lock = investorCommitmentService.getInvestorLock('inv_none', 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK');
      expect(lock).toBeUndefined();
    });
  });
});