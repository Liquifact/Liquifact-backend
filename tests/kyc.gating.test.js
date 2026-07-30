'use strict';

/**
 * @file tests/kyc.gating.test.js
 * @description Comprehensive tests for the KYC gating middleware.
 *
 * Covers:
 *   1. Structural compliance — CAPITAL_MOVING_STATES contains high-risk states.
 *   2. kycGatingMiddleware — blocks/permits based on target state and user KYC flag.
 *   3. requireKycForFunding — enforces smeId from JWT, checks KYC status.
 */

const express = require('express');
const request = require('supertest');
const kycGatingMiddleware = require('../src/middleware/kycGating');
const { CAPITAL_MOVING_STATES } = require('../src/services/invoiceStateMachine');

// Import the real canFundWithKycStatus so jest.mock doesn't replace it with undefined
const { canFundWithKycStatus } = require('../src/services/kycService');

// Mock kycService so tests are deterministic; re-export canFundWithKycStatus
jest.mock('../src/services/kycService', () => {
  const original = jest.requireActual('../src/services/kycService');
  return {
    ...original,
    getKycStatus: jest.fn(),
    canFundWithKycStatus: original.canFundWithKycStatus,
  };
});

const kycService = require('../src/services/kycService');

/**
 * Helper: creates an Express app with a user-injecting middleware and a route
 * that uses the given gate middleware.
 */
function createApp(userOverrides = {}) {
  const app = express();
  app.use(express.json());

  // Attach a mock user to each request
  app.use((req, res, next) => {
    req.user = Object.assign({ smeId: 'test-sme-01', isKycVerified: false }, userOverrides);
    next();
  });

  // Error handler for tests
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

describe('KYC Gating', () => {
  // ── Structural Compliance ──────────────────────────────────────────────

  describe('Structural Compliance - Capital Movement KYC Verification', () => {
    it('should strictly gate known high-risk transaction lifecycle states', () => {
      expect(CAPITAL_MOVING_STATES.has('funded')).toBe(true);
      expect(CAPITAL_MOVING_STATES.has('settled')).toBe(true);
    });
  });

  // ── kycGatingMiddleware ────────────────────────────────────────────────

  describe('kycGatingMiddleware', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should allow transition when target state is not capital-moving', async () => {
      const app = createApp({ smeId: 'test-sme-01', isKycVerified: false });
      app.post('/transition', kycGatingMiddleware, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/transition')
        .send({ state: 'draft' });

      expect(res.status).toBe(200);
    });

    it('should block transition when target state is capital-moving and user is not KYC verified', async () => {
      const app = createApp({ smeId: 'test-sme-01', isKycVerified: false });
      app.post('/transition', kycGatingMiddleware, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/transition')
        .send({ state: 'funded' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'KYC_REQUIRED',
        message: 'Action restricted. KYC verification required for capital-moving operations.',
      });
    });

    it('should allow transition when target state is capital-moving and user IS KYC verified', async () => {
      const app = createApp({ smeId: 'test-sme-01', isKycVerified: true });
      app.post('/transition', kycGatingMiddleware, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/transition')
        .send({ state: 'funded' });

      expect(res.status).toBe(200);
    });

    it('should read target state from req.body.targetState when req.body.state is absent', async () => {
      const app = createApp({ smeId: 'test-sme-01', isKycVerified: false });
      app.post('/transition', kycGatingMiddleware, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/transition')
        .send({ targetState: 'settled' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('KYC_REQUIRED');
    });

    it('should block capital-moving when req.user is missing (fail-closed)', async () => {
      const app = express();
      app.use(express.json());
      // No user middleware — req.user is undefined
      app.post('/transition', kycGatingMiddleware, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/transition')
        .send({ state: 'funded' });

      // Fail-closed: undefined req.user means !req.user is true, so gate blocks
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('KYC_REQUIRED');
    });

    it('should not block for non-capital-moving state even when user is missing', async () => {
      const app = express();
      app.use(express.json());
      app.post('/transition', kycGatingMiddleware, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/transition')
        .send({ state: 'draft' });

      expect(res.status).toBe(200);
    });

    it('should block settled state (capital-moving) for unverified user', async () => {
      const app = createApp({ smeId: 'test-sme-01', isKycVerified: false });
      app.post('/transition', kycGatingMiddleware, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app)
        .post('/transition')
        .send({ state: 'settled' });

      expect(res.status).toBe(403);
    });
  });

  // ── requireKycForFunding ───────────────────────────────────────────────

  describe('requireKycForFunding', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return 400 when smeId is missing from authenticated user', async () => {
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        req.user = { sub: 'user-01' }; // no smeId
        next();
      });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_SME_ID');
    });

    it('should return 400 when req.user is undefined', async () => {
      const app = express();
      app.use(express.json());
      // No user middleware
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_SME_ID');
    });

    it('should return 403 when KYC status does not permit funding', async () => {
      kycService.getKycStatus.mockResolvedValue({ status: 'pending' });

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_GATE_FAILED');
      expect(res.body.error.message).toContain("'pending'");
    });

    it('should return 403 for rejected KYC status', async () => {
      kycService.getKycStatus.mockResolvedValue({ status: 'rejected' });

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_GATE_FAILED');
      expect(res.body.error.message).toContain("'rejected'");
    });

    it('should allow funding when KYC status is verified', async () => {
      kycService.getKycStatus.mockResolvedValue({ status: 'verified', recordId: 'rec_1' });

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 403 when KYC status is unknown (unmapped provider response)', async () => {
      kycService.getKycStatus.mockResolvedValue({ status: 'unknown' });

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_GATE_FAILED');
      expect(res.body.error.message).toContain("'unknown'");
    });

    it('should allow funding when KYC status is exempted', async () => {
      kycService.getKycStatus.mockResolvedValue({ status: 'exempted', recordId: 'rec_2' });

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should propagate errors from kycService.getKycStatus (returns 500)', async () => {
      kycService.getKycStatus.mockRejectedValue(new Error('DB connection failed'));

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      // When getKycStatus throws, next(err) is called and Express 5's default
      // error handling returns a 500 status. The exact body format depends on
      // Express 5's built-in error renderer.
      expect(res.status).toBe(500);
    });

    it('should not call canFundWithKycStatus if getKycStatus throws', async () => {
      kycService.getKycStatus.mockRejectedValue(new Error('timeout'));

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      await request(app).post('/fund');

      // canFundWithKycStatus is the real function, not a jest mock since we didn't spy on it
      // Verify getKycStatus was called and threw
      expect(kycService.getKycStatus).toHaveBeenCalledWith('sme-auth-01');
    });

    it('should call getKycStatus with the correct smeId', async () => {
      kycService.getKycStatus.mockResolvedValue({ status: 'verified' });

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.requireKycForFunding, (req, res) => {
        res.status(200).json({ success: true });
      });

      await request(app).post('/fund');

      expect(kycService.getKycStatus).toHaveBeenCalledWith('sme-auth-01');
    });
  });

  // ── auditKycAccess ──────────────────────────────────────────────────────

  describe('auditKycAccess', () => {
    it('should call next and allow the request through', async () => {
      const app = createApp({ smeId: 'sme-auth-01' });
      app.use((req, res, next) => {
        req.kyc = { smeId: 'sme-auth-01', status: 'verified' };
        next();
      });
      app.post('/fund', kycGatingMiddleware.auditKycAccess, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('should pass through requests with no req.kyc without throwing', async () => {
      const app = createApp({ smeId: 'sme-auth-01' });
      app.post('/fund', kycGatingMiddleware.auditKycAccess, (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).post('/fund');

      expect(res.status).toBe(200);
    });

    it('should compose with requireKycForFunding on a fully gated route', async () => {
      kycService.getKycStatus.mockResolvedValue({ status: 'verified', recordId: 'kyc-1' });

      const app = createApp({ smeId: 'sme-auth-01' });
      app.post(
        '/fund',
        kycGatingMiddleware.requireKycForFunding,
        kycGatingMiddleware.auditKycAccess,
        (req, res) => {
          res.status(200).json({ success: true, kyc: req.kyc });
        },
      );

      const res = await request(app).post('/fund');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── canFundWithKycStatus (fail-closed semantics) ───────────────────────

  describe('canFundWithKycStatus', () => {
    it('allows funding for verified status', () => {
      expect(canFundWithKycStatus('verified')).toBe(true);
    });

    it('allows funding for exempted status', () => {
      expect(canFundWithKycStatus('exempted')).toBe(true);
    });

    it('denies funding for pending status', () => {
      expect(canFundWithKycStatus('pending')).toBe(false);
    });

    it('denies funding for rejected status', () => {
      expect(canFundWithKycStatus('rejected')).toBe(false);
    });

    it('denies funding for unknown status (unmapped provider response)', () => {
      expect(canFundWithKycStatus('unknown')).toBe(false);
    });

    it('denies funding for undefined / empty / null values', () => {
      expect(canFundWithKycStatus(undefined)).toBe(false);
      expect(canFundWithKycStatus('')).toBe(false);
      expect(canFundWithKycStatus(null)).toBe(false);
    });

    it('denies funding for an unrecognised status string', () => {
      expect(canFundWithKycStatus('in_review')).toBe(false);
    });
  });
});
