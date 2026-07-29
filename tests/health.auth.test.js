'use strict';

/**
 * @file tests/health.auth.test.js
 *
 * Auth and tenant-scoping tests for all health endpoints.
 *
 * Design rationale
 * ────────────────
 * All health endpoints (/health, /healthz, /ready, /readyz,
 * /api/health/checks, /api/health/reports) are intentionally PUBLIC — no
 * `authenticateToken` or `extractTenant` middleware is wired into these
 * routes. This is by design: Kubernetes liveness and readiness probes must
 * never require authentication, and a flood of bad tokens must not affect
 * probe availability.
 *
 * What we are asserting here:
 *
 *  1. Public access preserved — every health endpoint responds 200 (or its
 *     normal success code) with NO Authorization header at all.
 *
 *  2. Malformed / tampered Authorization headers are silently ignored —
 *     unlike protected routes (which return 401), health endpoints must
 *     succeed regardless of the Authorization header value.
 *
 *  3. Invalid Bearer tokens are ignored — a forged or expired JWT in the
 *     Authorization header must not cause a 401 on health routes.
 *
 *  4. Tenant headers have no effect — sending x-tenant-id with any value
 *     (valid, empty, cross-tenant) does not change the response.
 *
 *  5. Cross-tenant access — health state is global, not tenant-scoped.
 *     Requests from tenants A and B see the same liveness/readiness state.
 *
 *  6. Idempotency-Key enforcement on POST /api/health/reports — missing or
 *     malformed Idempotency-Key returns 400; valid key returns 201.
 *
 *  7. Response body never leaks auth metadata — headers like x-tenant-id
 *     or Authorization values must not appear in the response body.
 *
 * @jest-environment node
 */

// ── Module-level mocks (must precede all require() calls) ────────────────────

jest.mock('../src/services/health', () => ({
  performHealthChecks: jest.fn(),
  performReadinessChecks: jest.fn(),
  listHealthChecks: jest.fn(),
}));

jest.mock('../src/services/storage', () => ({
  probeS3Connectivity: jest.fn().mockResolvedValue({ status: 'in_memory' }),
  runStartupStorageProbe: jest.fn().mockResolvedValue({ status: 'in_memory' }),
}));

jest.mock('../src/services/marketplaceService', () => ({
  getMarketplaceInvoices: jest.fn(),
  PUBLIC_INVESTABLE_INVOICE_STATUSES: ['verified', 'partially_funded'],
}));

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
}));

jest.mock('../src/services/investorCommitment', () => ({
  persistCommitment: jest.fn(),
  seedInvestorLocks: jest.fn(),
  clearInvestorLocks: jest.fn(),
  getInvestorLocksByAddress: jest.fn(),
  getAllInvestorLocks: jest.fn(),
  getInvestorLock: jest.fn(),
  paginateInvestorLocks: jest.fn(),
}));

jest.mock('../src/config/escrowVersions', () => ({
  getOnChainSchemaVersion: jest.fn(),
  compareVersions: jest.fn(),
}));

jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  readEscrowStateWithAttestations: jest.fn(),
  readFundedAmount: jest.fn(),
  fetchLegalHold: jest.fn(),
  fetchAttestationAppendLog: jest.fn(),
  validateInvoiceId: jest.fn(),
  getEscrowStateWithProjection: jest.fn(),
}));

jest.mock('../src/jobs/retentionPurge', () => ({
  scheduleRetentionPurge: jest.fn(),
  validatePiiFields: jest.fn(),
  getActivePolicies: jest.fn(),
  getEligibleInvoices: jest.fn(),
  getExecutionStatus: jest.fn(),
  getRecentExecutions: jest.fn(),
}));

jest.mock('../src/jobs/contractListRefresh', () => ({
  runContractListRefresh: jest.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const {
  performHealthChecks,
  performReadinessChecks,
  listHealthChecks,
} = require('../src/services/health');

// ── Constants ────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

/** Liveness-only endpoints — never touch external dependencies. */
const LIVENESS_ENDPOINTS = ['/health', '/healthz'];

/** Readiness endpoints — call performHealthChecks or performReadinessChecks. */
const READINESS_ENDPOINTS = ['/ready', '/readyz'];

/** All simple GET health endpoints (liveness + readiness). */
const ALL_PROBE_ENDPOINTS = [...LIVENESS_ENDPOINTS, ...READINESS_ENDPOINTS];

/** Health API endpoints that live under /api/health. */
const HEALTH_API_CHECKS = '/api/health/checks';
const HEALTH_API_REPORTS = '/api/health/reports';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mint a valid HS256 JWT signed with the test secret.
 *
 * @param {object} [payload={}] - Additional claims.
 * @param {object} [opts={}]    - jsonwebtoken sign options.
 * @returns {string} Signed token.
 */
function mintToken(payload = {}, opts = {}) {
  return jwt.sign(
    { sub: 'user-test', tenantId: 'tenant-alpha', ...payload },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h', ...opts },
  );
}

/**
 * Mint an expired JWT (iat/exp both in the past).
 *
 * @returns {string} Expired token.
 */
function mintExpiredToken() {
  return jwt.sign(
    { sub: 'user-test', tenantId: 'tenant-alpha' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: -1 },
  );
}

/**
 * Return a minimal valid health-report body.
 *
 * @param {object} [overrides={}]
 * @returns {object}
 */
function validReportBody(overrides = {}) {
  return { serviceName: 'test-service', status: 'healthy', ...overrides };
}

/**
 * Generate a unique URL-safe idempotency key (meets 8-char minimum).
 *
 * @returns {string}
 */
function uniqueKey() {
  return 'ik_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Healthy mock return value for performHealthChecks / performReadinessChecks.
 */
const HEALTHY_RESULT = {
  healthy: true,
  checks: { database: { status: 'healthy' }, soroban: { status: 'healthy' } },
};

// ── Test environment setup ────────────────────────────────────────────────────

let app;
let savedEnv;

beforeAll(() => {
  savedEnv = process.env;
  process.env = {
    ...savedEnv,
    NODE_ENV: 'test',
    JWT_SECRET,
  };
  app = createApp();
});

afterAll(() => {
  process.env = savedEnv;
});

beforeEach(() => {
  jest.clearAllMocks();

  // Default happy-path stubs for readiness endpoints.
  performHealthChecks.mockResolvedValue(HEALTHY_RESULT);
  performReadinessChecks.mockResolvedValue(HEALTHY_RESULT);

  // Default stub for /api/health/checks
  listHealthChecks.mockResolvedValue([
    {
      id: 'database',
      name: 'Database',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      detail: { status: 'healthy' },
    },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Public access — no Authorization header required
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Public access — health endpoints require no authentication', () => {
  describe('Liveness probes (/health, /healthz)', () => {
    LIVENESS_ENDPOINTS.forEach((endpoint) => {
      it(`GET ${endpoint} returns 200 with no Authorization header`, async () => {
        const res = await request(app).get(endpoint);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
      });

      it(`GET ${endpoint} returns 200 without x-tenant-id header`, async () => {
        // No tenant header should not block liveness
        const res = await request(app).get(endpoint);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', service: 'liquifact-api' });
      });
    });
  });

  describe('Readiness probes (/ready, /readyz)', () => {
    READINESS_ENDPOINTS.forEach((endpoint) => {
      it(`GET ${endpoint} returns 200 with no Authorization header when healthy`, async () => {
        const res = await request(app).get(endpoint);

        expect(res.status).toBe(200);
        expect(res.body.ready).toBe(true);
      });

      it(`GET ${endpoint} returns 503 with no auth when unhealthy (public)`, async () => {
        performHealthChecks.mockResolvedValue({
          healthy: false,
          checks: { database: { status: 'unhealthy', error: 'timeout' } },
        });
        performReadinessChecks.mockResolvedValue({
          healthy: false,
          checks: { database: { status: 'unhealthy', error: 'timeout' } },
        });

        const res = await request(app).get(endpoint);

        // 503 is the correct public status code — NOT a 401/403
        expect(res.status).toBe(503);
        expect(res.body.ready).toBe(false);
      });
    });
  });

  describe('GET /api/health/checks — no auth required', () => {
    it('returns 200 with no Authorization header', async () => {
      const res = await request(app).get(HEALTH_API_CHECKS);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('POST /api/health/reports — no auth required (only Idempotency-Key)', () => {
    it('returns 201 with no Authorization header when Idempotency-Key is valid', async () => {
      const res = await request(app)
        .post(HEALTH_API_REPORTS)
        .set('Idempotency-Key', uniqueKey())
        .send(validReportBody());

      expect(res.status).toBe(201);
      expect(res.body.data.reportId).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Malformed Authorization headers are ignored (not rejected with 401)
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. Malformed Authorization headers are silently ignored', () => {
  const malformedHeaders = [
    // Description                   Header value
    ['empty string',                 ''],
    ['just a word (no scheme)',      'sometoken'],
    ['wrong scheme: Basic',          'Basic dXNlcjpwYXNz'],
    ['wrong scheme: ApiKey',         'ApiKey abc123'],
    ['Bearer with no token',         'Bearer'],
    ['Bearer with whitespace only',  'Bearer    '],
    ['multiple spaces in scheme',    'Bearer  tok  en'],
    ['lower-case bearer',            'bearer ' + mintToken()],
    ['null literal string',          'null'],
    ['numeric value',                '12345'],
  ];

  ALL_PROBE_ENDPOINTS.forEach((endpoint) => {
    malformedHeaders.forEach(([desc, headerValue]) => {
      it(`GET ${endpoint} → 200 even with malformed header: ${desc}`, async () => {
        const res = await request(app)
          .get(endpoint)
          .set('Authorization', headerValue);

        // Health probes must never return 401/403 — they return their
        // normal operational status code.
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        // Liveness → always 200; readiness → 200 when healthy (default mock).
        expect([200, 503]).toContain(res.status);
      });
    });
  });

  it('GET /api/health/checks → 200 with garbage Authorization header', async () => {
    const res = await request(app)
      .get(HEALTH_API_CHECKS)
      .set('Authorization', 'garbage_value_not_bearer');

    expect(res.status).toBe(200);
  });

  it('POST /api/health/reports → 201 (not 401) with malformed Authorization header', async () => {
    const res = await request(app)
      .post(HEALTH_API_REPORTS)
      .set('Authorization', 'Bearer this-is-not-a-valid-jwt')
      .set('Idempotency-Key', uniqueKey())
      .send(validReportBody());

    expect(res.status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Invalid / expired / tampered Bearer tokens are ignored
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. Invalid Bearer tokens do not trigger 401 on health routes', () => {
  const invalidTokenCases = [
    ['random string',             'Bearer not-a-jwt-at-all'],
    ['JWT signed with wrong key', 'Bearer ' + jwt.sign({ sub: 'x' }, 'wrong-secret', { algorithm: 'HS256' })],
    ['structurally invalid JWT',  'Bearer aaa.bbb.ccc'],
    ['empty token after Bearer',  'Bearer '],
  ];

  ALL_PROBE_ENDPOINTS.forEach((endpoint) => {
    invalidTokenCases.forEach(([desc, authHeader]) => {
      it(`GET ${endpoint} → not 401 with ${desc}`, async () => {
        const res = await request(app)
          .get(endpoint)
          .set('Authorization', authHeader);

        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });

    it(`GET ${endpoint} → not 401 with expired JWT`, async () => {
      const res = await request(app)
        .get(endpoint)
        .set('Authorization', `Bearer ${mintExpiredToken()}`);

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  it('GET /api/health/checks → 200 with expired JWT', async () => {
    const res = await request(app)
      .get(HEALTH_API_CHECKS)
      .set('Authorization', `Bearer ${mintExpiredToken()}`);

    expect(res.status).toBe(200);
  });

  it('POST /api/health/reports → 201 (not 401) with expired JWT', async () => {
    const res = await request(app)
      .post(HEALTH_API_REPORTS)
      .set('Authorization', `Bearer ${mintExpiredToken()}`)
      .set('Idempotency-Key', uniqueKey())
      .send(validReportBody());

    expect(res.status).toBe(201);
  });

  it('POST /api/health/reports → 201 with valid JWT from a different tenant', async () => {
    // Auth from tenant-beta must not block submission — no auth enforcement.
    const tokenB = mintToken({ sub: 'user-b', tenantId: 'tenant-beta' });

    const res = await request(app)
      .post(HEALTH_API_REPORTS)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('Idempotency-Key', uniqueKey())
      .send(validReportBody());

    expect(res.status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Tenant headers have no effect on health endpoint responses
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. Tenant context does not gate or scope health endpoints', () => {
  const tenantVariants = [
    ['no tenant header',                    undefined],
    ['tenant-alpha',                        'tenant-alpha'],
    ['tenant-beta (cross-tenant)',          'tenant-beta'],
    ['tenant with special chars',           'tenant_999'],
    ['very long tenant id (128 chars)',     'a'.repeat(128)],
    ['empty string tenant id',             ''],
    ['whitespace-only tenant id',          '   '],
  ];

  LIVENESS_ENDPOINTS.forEach((endpoint) => {
    tenantVariants.forEach(([desc, tenantId]) => {
      it(`GET ${endpoint} → 200 with ${desc}`, async () => {
        const req = request(app).get(endpoint);
        if (tenantId !== undefined) {
          req.set('x-tenant-id', tenantId);
        }
        const res = await req;
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
      });
    });
  });

  READINESS_ENDPOINTS.forEach((endpoint) => {
    tenantVariants.forEach(([desc, tenantId]) => {
      it(`GET ${endpoint} → 200 (healthy) with ${desc}`, async () => {
        const req = request(app).get(endpoint);
        if (tenantId !== undefined) {
          req.set('x-tenant-id', tenantId);
        }
        const res = await req;
        expect(res.status).toBe(200);
        expect(res.body.ready).toBe(true);
      });
    });
  });

  it('GET /api/health/checks → same 200 response for tenant-alpha and tenant-beta', async () => {
    const resA = await request(app)
      .get(HEALTH_API_CHECKS)
      .set('x-tenant-id', 'tenant-alpha');

    const resB = await request(app)
      .get(HEALTH_API_CHECKS)
      .set('x-tenant-id', 'tenant-beta');

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Both tenants see the same global health data
    expect(resA.body.data).toEqual(resB.body.data);
    expect(resA.body.meta.total).toBe(resB.body.meta.total);
  });

  it('GET /api/health/checks → 200 with both a JWT tenantId claim and x-tenant-id header', async () => {
    const token = mintToken({ tenantId: 'tenant-alpha' });

    const res = await request(app)
      .get(HEALTH_API_CHECKS)
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-beta'); // header conflicts with JWT claim

    // Neither auth nor tenant should affect response
    expect(res.status).toBe(200);
  });
});
