'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/services/health', () => ({
  performHealthChecks: jest.fn(),
}));

jest.mock('../src/services/marketplaceService', () => ({
  getMarketplaceInvoices: jest.fn(),
  PUBLIC_INVESTABLE_INVOICE_STATUSES: ['open', 'funded'],
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

jest.mock('../src/middleware/apiKeyAuth', () => ({
  authenticateApiKey: jest.fn(() => jest.fn((req, res, next) => {
    const err = new Error('Invalid API key');
    err.status = 401;
    next(err);
  })),
  API_KEY_HEADER: 'x-api-key',
  timingSafeStringEqual: (a, b) => a === b,
}));

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
}));

jest.mock('../src/services/investorCommitment', () => ({
  persistCommitment: jest.fn(),
  getAllInvestorLocks: jest.fn(() => ({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } })),
  getInvestorLocksByAddress: jest.fn(() => ({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } })),
  getInvestorLock: jest.fn(() => null),
  validateAddress: jest.fn(() => ({ valid: true })),
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

jest.mock('../src/db/knex', () => {
  function createQuery(result) {
    const query = {
      where: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      select: jest.fn(() => query),
      insert: jest.fn(() => query),
      update: jest.fn(() => query),
      limit: jest.fn(() => query),
      offset: jest.fn(() => query),
      returning: jest.fn(() => Promise.resolve(result)),
      first: jest.fn(() => Promise.resolve(Array.isArray(result) ? result[0] || null : result)),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      catch: (reject) => Promise.resolve(result).catch(reject),
    };
    return query;
  }

  return jest.fn(() => createQuery([]));
});

const { performHealthChecks } = require('../src/services/health');
const marketplaceService = require('../src/services/marketplaceService');
const escrowVersions = require('../src/config/escrowVersions');
const { createApp } = require('../src/app');
const investorRoutes = require('../src/routes/investor');
const { getFeatureRouterMounts } = require('../src/utils/routeMountRegistry');
const app = require('../src/app');

const SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'user_1', id: 'user_1', tenantId: 'tenant_test', ...payload },
    SECRET
  );
}

function authHeader(payload = {}) {
  return `Bearer ${makeToken(payload)}`;
}

// ─── Describe: shared stacks ─────────────────────────────────────────────────

describe('authenticatedTenantStack', () => {
  const { authenticatedTenantStack } = require('../src/middleware/stacks');

  it('exports an array of two middleware functions', () => {
    expect(Array.isArray(authenticatedTenantStack)).toBe(true);
    expect(authenticatedTenantStack).toHaveLength(2);
    expect(typeof authenticatedTenantStack[0]).toBe('function');
    expect(typeof authenticatedTenantStack[1]).toBe('function');
  });

  it('first item is authenticateToken', () => {
    const { authenticateToken } = require('../src/middleware/auth');
    expect(authenticatedTenantStack[0]).toBe(authenticateToken);
  });

  it('second item is extractTenant', () => {
    const { extractTenant } = require('../src/middleware/tenant');
    expect(authenticatedTenantStack[1]).toBe(extractTenant);
  });
});

describe('adminStack', () => {
  const { adminStack } = require('../src/middleware/stacks');

  it('exports an array of two middleware functions', () => {
    expect(Array.isArray(adminStack)).toBe(true);
    expect(adminStack).toHaveLength(2);
    expect(typeof adminStack[0]).toBe('function');
    expect(typeof adminStack[1]).toBe('function');
  });

  it('second item is extractTenant (ordering: auth before tenant)', () => {
    const { extractTenant } = require('../src/middleware/tenant');
    expect(adminStack[1]).toBe(extractTenant);
  });
});

// ─── Describe: mounted routers ───────────────────────────────────────────────

describe('Mounted feature routers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    performHealthChecks.mockResolvedValue({
      healthy: true,
      checks: {
        database: { healthy: true },
        soroban: { healthy: true },
      },
    });
    marketplaceService.getMarketplaceInvoices.mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
    });
    escrowVersions.getOnChainSchemaVersion.mockResolvedValue(3);
    escrowVersions.compareVersions.mockReturnValue({
      status: 'current',
      knownVersion: '1.2.0',
    });
  });

  it('preserves existing health behavior', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.service).toBe('liquifact-api');
  });

  it('preserves existing ready behavior', async () => {
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
    expect(performHealthChecks).toHaveBeenCalledTimes(1);
  });

  it('preserves existing metrics auth behavior', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).not.toBe(404);
  });

  it('mounts invest routes under /api/invest', async () => {
    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
  });

  it('mounts marketplace routes under /api/marketplace', async () => {
    const res = await request(app)
      .get('/api/marketplace')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
    expect(marketplaceService.getMarketplaceInvoices).toHaveBeenCalledTimes(1);
  });

  it('mounts retention routes under /api/retention', async () => {
    const res = await request(app)
      .get('/api/retention/policies')
      .set('Authorization', authHeader())
      .set('x-tenant-id', 'tenant_test');

    expect(res.status).not.toBe(404);
  });

  it('mounts invoice state routes under /api/invoices', async () => {
    const res = await request(app).get('/api/invoices/inv-001/state');

    expect(res.status).not.toBe(404);
  });

  it('mounts admin escrow routes under /api/admin/escrow', async () => {
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
    expect(escrowVersions.getOnChainSchemaVersion).toHaveBeenCalledTimes(1);
  });

  it('mounts sme routes under /api/sme', async () => {
    const res = await request(app)
      .get('/api/sme/metrics')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(404);
  });

  it('mounts v1 routes under /v1', async () => {
    const res = await request(app).get('/v1/health');

    expect(res.status).not.toBe(404);
  });

  it('mounts investor routes under /api/investor exactly once', () => {
    createApp();
    const investorMounts = getFeatureRouterMounts().filter(
      (entry) => entry.basePath === '/api/investor'
    );

    expect(investorMounts).toHaveLength(1);
    expect(investorMounts[0].router).toBe(investorRoutes);
  });

  it('mounts investor list endpoint and rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/investor/locks');

    expect(res.status).toBe(401);
  });

  it('mounts investor list endpoint and requires tenant context', async () => {
    const tokenNoTenant = jwt.sign({ sub: 'user_1', id: 'user_1' }, SECRET);
    const res = await request(app)
      .get('/api/investor/locks')
      .set('Authorization', `Bearer ${tokenNoTenant}`);

    expect(res.status).toBe(400);
  });

  it('mounts investor detail endpoint and rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/investor/locks/inv-001');

    expect(res.status).toBe(401);
  });

  it('mounts investor detail endpoint and requires tenant context', async () => {
    const tokenNoTenant = jwt.sign({ sub: 'user_1', id: 'user_1' }, SECRET);
    const res = await request(app)
      .get('/api/investor/locks/inv-001?funderAddress=GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK')
      .set('Authorization', `Bearer ${tokenNoTenant}`);

    expect(res.status).toBe(400);
  });

  it('allows authenticated investor list requests', async () => {
    const res = await request(app)
      .get('/api/investor/locks')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('has no duplicate router-instance mounts at any base path', () => {
    createApp();
    const mounts = getFeatureRouterMounts();

    for (let i = 0; i < mounts.length; i += 1) {
      for (let j = i + 1; j < mounts.length; j += 1) {
        expect(
          mounts[i].basePath === mounts[j].basePath && mounts[i].router === mounts[j].router
        ).toBe(false);
      }
    }
  });
});

// ─── Describe: unauthenticated requests ──────────────────────────────────────

describe('Unauthenticated requests are rejected', () => {
  it('rejects GET /api/marketplace with 401', async () => {
    const res = await request(app).get('/api/marketplace');
    expect(res.status).toBe(401);
  });

  it('rejects GET /api/invest/opportunities with 401', async () => {
    const res = await request(app).get('/api/invest/opportunities');
    expect(res.status).toBe(401);
  });

  it('rejects GET /api/admin/escrow/version with 401', async () => {
    const res = await request(app).get('/api/admin/escrow/version');
    expect(res.status).toBe(401);
  });

  it('rejects GET /api/admin/audit/invoices/inv-1 with 401', async () => {
    const res = await request(app).get('/api/admin/audit/invoices/inv-1');
    expect(res.status).toBe(401);
  });
});

// ─── Describe: missing tenant context ────────────────────────────────────────

describe('Missing tenant context is rejected', () => {
  it('returns 400 on /api/marketplace when JWT has no tenantId', async () => {
    const tokenNoTenant = jwt.sign({ sub: 'user_1', id: 'user_1' }, SECRET);
    const res = await request(app)
      .get('/api/marketplace')
      .set('Authorization', `Bearer ${tokenNoTenant}`);

    expect(res.status).toBe(400);
  });

  it('returns 400 on /api/invest/opportunities when JWT has no tenantId', async () => {
    const tokenNoTenant = jwt.sign({ sub: 'user_1', id: 'user_1' }, SECRET);
    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${tokenNoTenant}`);

    expect(res.status).toBe(400);
  });
});

// ─── Describe: admin-only route via JWT ──────────────────────────────────────

describe('Admin-only routes via JWT', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    escrowVersions.getOnChainSchemaVersion.mockResolvedValue(3);
    escrowVersions.compareVersions.mockReturnValue({ status: 'current', knownVersion: '1.2.0' });
  });

  it('allows GET /api/admin/escrow/version with valid JWT', async () => {
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('allows GET /api/admin/audit/invoices/:id with valid JWT', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('Authorization', authHeader());

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });
});

// ─── Describe: admin-only route via API key ───────────────────────────────────

describe('Admin-only routes via API key', () => {
  it('reaches auth check with x-api-key header on /api/admin/escrow/version', async () => {
    // Without a valid DB-backed key the response is 401, but it is NOT 404 —
    // confirming the adminStack is wired and the route is reachable.
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('x-api-key', 'any-key')
      .set('x-tenant-id', 'tenant_test');

    expect(res.status).not.toBe(404);
  });

  it('reaches auth check with x-api-key header on /api/admin/audit/invoices/:id', async () => {
    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-001')
      .set('x-api-key', 'any-key')
      .set('x-tenant-id', 'tenant_test');

    expect(res.status).not.toBe(404);
  });
});

// ─── Describe: ordering guarantee — tenant context never set before auth ─────

describe('Middleware ordering guarantee', () => {
  it('authenticatedTenantStack: auth (index 0) runs before tenant (index 1)', () => {
    const { authenticatedTenantStack } = require('../src/middleware/stacks');
    const { authenticateToken } = require('../src/middleware/auth');
    const { extractTenant } = require('../src/middleware/tenant');

    expect(authenticatedTenantStack.indexOf(authenticateToken)).toBe(0);
    expect(authenticatedTenantStack.indexOf(extractTenant)).toBe(1);
  });

  it('adminStack: auth (index 0) runs before tenant (index 1)', () => {
    const { adminStack } = require('../src/middleware/stacks');
    const { extractTenant } = require('../src/middleware/tenant');

    expect(adminStack.indexOf(extractTenant)).toBe(1);
    // The auth function at index 0 is the internal adminAuth combiner
    expect(typeof adminStack[0]).toBe('function');
  });
});
