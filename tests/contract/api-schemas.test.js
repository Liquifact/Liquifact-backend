'use strict';

/**
 * @fileoverview OpenAPI contract tests.
 *
 * Enforces that representative responses from the marketplace and invest
 * routes match the schemas documented via `@swagger` JSDoc annotations.
 *
 * Coverage:
 *   - 200 GET  /api/marketplace          → MarketplaceListResponse envelope.
 *   - 201 POST /api/invest/fund-invoice  → FundInvoiceResponse envelope.
 *   - 400 POST /api/invest/fund-invoice  → RFC 7807 Problem (validation).
 *   - 401 GET  /api/marketplace          → RFC 7807 Problem (auth).
 *   - 403 POST /api/invest/fund-invoice  → RFC 7807 Problem (KYC gate).
 *
 * The harness mocks service-layer modules so the tests don't touch the
 * database or external KYC provider — the contract under test is the HTTP
 * envelope, not the underlying data.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

const { assertResponse, buildContractApp } = require('./helpers');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const validToken = jwt.sign({ sub: 'user_test', smeId: 'sme_test' }, JWT_SECRET);
const authHeader = `Bearer ${validToken}`;

describe('OpenAPI contract — API responses match documented schemas', () => {
  afterEach(() => {
    jest.resetModules();
  });

  describe('GET /api/marketplace', () => {
    it('200 — returns a MarketplaceListResponse envelope', async () => {
      const app = buildContractApp({
        marketplaceList: async () => ({
          data: [
            {
              id: 'inv_1',
              status: 'verified',
              yield_bps: 800,
              maturity_date: '2026-06-15',
              funded_ratio: 25,
              amount: 10000,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
        }),
      });

      const res = await request(app).get('/api/marketplace').set('Authorization', authHeader);

      assertResponse('get', '/api/marketplace', 200, res);
    });

    it('401 — returns an RFC 7807 problem when the bearer token is missing', async () => {
      const app = buildContractApp();

      const res = await request(app).get('/api/marketplace');

      assertResponse('get', '/api/marketplace', 401, res);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.status).toBe(401);
      expect(res.body.type).toMatch(/^https?:\/\//);
    });
  });

  describe('POST /api/invest/fund-invoice', () => {
    const validBody = {
      invoiceId: 'inv_7788',
      investmentAmount: 1250.5,
      smeId: 'sme_test',
    };

    it('201 — returns a FundInvoiceResponse envelope for a verified SME', async () => {
      const app = buildContractApp();

      const res = await request(app)
        .post('/api/invest/fund-invoice')
        .set('Authorization', authHeader)
        .send(validBody);

      assertResponse('post', '/api/invest/fund-invoice', 201, res);
      expect(res.body.data.invoiceId).toBe(validBody.invoiceId);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.meta.kycVerified).toBe(true);
    });

    it('400 — returns a problem when the request body is invalid', async () => {
      const app = buildContractApp();

      const res = await request(app)
        .post('/api/invest/fund-invoice')
        .set('Authorization', authHeader)
        .send({ smeId: 'sme_test' });

      assertResponse('post', '/api/invest/fund-invoice', 400, res);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.status).toBe(400);
    });

    it('403 — returns a problem when the SME is not KYC-verified', async () => {
      const app = buildContractApp({
        kycStatus: async () => ({
          status: 'pending',
          recordId: 'kyc_test',
          verifiedAt: null,
        }),
      });

      const res = await request(app)
        .post('/api/invest/fund-invoice')
        .set('Authorization', authHeader)
        .send(validBody);

      assertResponse('post', '/api/invest/fund-invoice', 403, res);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.status).toBe(403);
      expect(res.body.type).toMatch(/^https?:\/\//);
    });
  });

  describe('Contract enforcement', () => {
    it('fails when the response diverges from the documented schema', () => {
      // Sanity check: assertResponse must reject obviously malformed bodies.
      expect(() =>
        assertResponse('get', '/api/marketplace', 200, {
          status: 200,
          body: { not_an_envelope: true },
        }),
      ).toThrow(/does not match documented schema/);
    });

    it('fails when the actual status code differs from the expected', () => {
      expect(() =>
        assertResponse('get', '/api/marketplace', 200, { status: 500, body: {} }),
      ).toThrow(/Expected GET \/api\/marketplace -> 200/);
    });
  });
});
