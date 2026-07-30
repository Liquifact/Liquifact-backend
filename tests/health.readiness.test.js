'use strict';

const request = require('supertest');

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: { fromSecret: jest.fn(), random: jest.fn() },
}), { virtual: true });

jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn(),
}), { virtual: true });

jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  readEscrowStateWithAttestations: jest.fn(),
  readFundedAmount: jest.fn(),
  fetchLegalHold: jest.fn(),
  fetchAttestationAppendLog: jest.fn(),
  validateInvoiceId: jest.fn(),
  getEscrowStateWithProjection: jest.fn(),
}));

const mockStorageProbe = jest.fn();
jest.mock('../src/services/storage', () => {
  const actual = jest.requireActual('../src/services/storage');
  return {
    ...actual,
    probeS3Connectivity: (...args) => mockStorageProbe(...args),
    runStartupStorageProbe: () => Promise.resolve({ status: 'in_memory' }),
  };
});

jest.mock('../src/services/marketplaceService', () => ({
  getMarketplaceInvoices: jest.fn(),
  PUBLIC_INVESTABLE_INVOICE_STATUSES: ['open', 'funded'],
}));

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
}));

jest.mock('../src/services/investorCommitment', () => ({
  persistCommitment: jest.fn(),
}));

jest.mock('../src/config/escrowVersions', () => ({
  getOnChainSchemaVersion: jest.fn(),
  compareVersions: jest.fn(),
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

const { createApp } = require('../src/app');
const db = require('../src/db/knex');
const { registry, readinessGauge } = require('../src/metrics');

describe('Readiness probe (/readyz)', () => {
  let app;
  let originalEnv;

  beforeAll(() => {
    originalEnv = process.env;
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'supersecret32characterlongstringforzod',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
      SOROBAN_RPC_URL: 'http://localhost:8000',
      NODE_ENV: 'test',
    };
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    process.env.SOROBAN_RPC_URL = 'http://localhost:8000';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/test';
    registry.registerMetric(readinessGauge);
    mockStorageProbe.mockResolvedValue({ status: 'in_memory' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    registry.clear();
  });

  describe('GET /healthz (liveness)', () => {
    it('should return 200 with status ok without touching external dependencies', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('liquifact-api');
      expect(res.body).not.toHaveProperty('checks');
      expect(res.body).not.toHaveProperty('database');
      expect(res.body).not.toHaveProperty('soroban');
    });
  });

  describe('GET /readyz (readiness)', () => {
    it('should return 200 when DB and Soroban RPC are healthy', async () => {
      db.raw.mockResolvedValue([{ '1': 1 }]);
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        })
      );

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.checks.database.status).toBe('healthy');
      expect(res.body.checks.soroban.status).toBe('healthy');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(1);
    });

    it('should return 503 when DB is unreachable', async () => {
      db.raw.mockRejectedValue(new Error('Connection refused'));
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        })
      );

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('unhealthy');
      expect(res.body.checks.database.error).toBe('Database unreachable');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    it('should return 503 when Soroban RPC is unreachable', async () => {
      db.raw.mockResolvedValue([{ '1': 1 }]);
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('healthy');
      expect(res.body.checks.soroban.status).toBe('unhealthy');
      expect(res.body.checks.soroban.error).toBe('Network error');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    it('should return 503 when both DB and Soroban are down', async () => {
      db.raw.mockRejectedValue(new Error('Connection refused'));
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('unhealthy');
      expect(res.body.checks.soroban.status).toBe('unhealthy');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    it('should return 200 when DB is healthy and Soroban is not configured', async () => {
      process.env.SOROBAN_RPC_URL = '';
      db.raw.mockResolvedValue([{ '1': 1 }]);

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.checks.database.status).toBe('healthy');
      expect(res.body.checks.soroban.status).toBe('unknown');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(1);
    });

    it('should report database as not_configured when DATABASE_URL is missing', async () => {
      delete process.env.DATABASE_URL;
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        })
      );

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('not_configured');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    describe('S3 storage readiness (issue #452)', () => {
      afterEach(() => {
        mockStorageProbe.mockReset();
      });

      it('returns 503 when S3 storage probe is unhealthy', async () => {
        mockStorageProbe.mockResolvedValue({
          status: 'unhealthy',
          latency: 12,
          error: { code: 'NoSuchBucket', hint: 'configured bucket not found' },
        });
        db.raw.mockResolvedValue([{ '1': 1 }]);
        global.fetch = jest.fn(() =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: 'ok' }) })
        );

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.ready).toBe(false);
        expect(res.body.checks.storage.status).toBe('unhealthy');
        expect(res.body.checks.storage.error).toEqual({
          code: 'NoSuchBucket',
          hint: 'configured bucket not found',
        });
        // The error string MUST NOT leak endpoint or credential material.
        const logString = JSON.stringify(res.body);
        expect(logString).not.toMatch(/AKIA[A-Z0-9]+/);
        expect(logString).not.toContain('AWS_SECRET');
        expect(logString).not.toContain('AWS_ACCESS_KEY');

        const metric = await readinessGauge.get();
        expect(metric.values[0].value).toBe(0);
      });

      it('returns 503 when S3 storage is not_configured', async () => {
        mockStorageProbe.mockResolvedValue({
          status: 'not_configured',
          bucketConfigured: false,
          credentialsConfigured: false,
        });
        db.raw.mockResolvedValue([{ '1': 1 }]);
        global.fetch = jest.fn(() =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: 'ok' }) })
        );

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.ready).toBe(false);
        expect(res.body.checks.storage.status).toBe('not_configured');

        const metric = await readinessGauge.get();
        expect(metric.values[0].value).toBe(0);
      });

      it('returns 200 when S3 storage probe is explicitly disabled', async () => {
        mockStorageProbe.mockResolvedValue({
          status: 'disabled',
          bucketConfigured: true,
          credentialsConfigured: true,
        });
        db.raw.mockResolvedValue([{ '1': 1 }]);
        global.fetch = jest.fn(() =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: 'ok' }) })
        );

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.ready).toBe(true);
        expect(res.body.checks.storage.status).toBe('disabled');

        const metric = await readinessGauge.get();
        expect(metric.values[0].value).toBe(1);
      });

      it('returns 200 when S3 storage probe is in_memory (test mode)', async () => {
        mockStorageProbe.mockResolvedValue({
          status: 'in_memory',
          bucketConfigured: false,
          credentialsConfigured: false,
        });
        db.raw.mockResolvedValue([{ '1': 1 }]);
        global.fetch = jest.fn(() =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: 'ok' }) })
        );

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.ready).toBe(true);
        expect(res.body.checks.storage.status).toBe('in_memory');

        const metric = await readinessGauge.get();
        expect(metric.values[0].value).toBe(1);
      });

      it('returns 200 when S3 storage probe is healthy', async () => {
        mockStorageProbe.mockResolvedValue({
          status: 'healthy',
          latency: 8,
          bucketConfigured: true,
          credentialsConfigured: true,
        });
        db.raw.mockResolvedValue([{ '1': 1 }]);
        global.fetch = jest.fn(() =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: 'ok' }) })
        );

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.ready).toBe(true);
        expect(res.body.checks.storage.status).toBe('healthy');
      });
    });

    it('should not leak database connection strings or hostnames in error responses', async () => {
      process.env.SOROBAN_RPC_URL = 'http://localhost:8000';
      db.raw.mockRejectedValue(new Error('Connection refused'));
      global.fetch = jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED localhost:8000')));

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      const body = JSON.stringify(res.body);

      expect(body).not.toMatch(/postgres:\/\//);
      expect(body).not.toMatch(/user:pass/);
      expect(body).not.toMatch(/DATABASE_URL/i);
      expect(res.body.checks.database.status).toBe('unhealthy');
      expect(res.body.checks.database.error).toBe('Database unreachable');
    });

    it('should report database as not_configured when DATABASE_URL is missing', async () => {
      delete process.env.DATABASE_URL;
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        })
      );

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('not_configured');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    describe('Pool saturation health checks', () => {
      let savedClient;

      function mockPool({ used, free, pending, max }) {
        db.client = {
          pool: {
            numUsed: jest.fn().mockReturnValue(used),
            numFree: jest.fn().mockReturnValue(free),
            numPendingAcquires: jest.fn().mockReturnValue(pending),
          },
          config: { pool: { max } },
        };
      }

      beforeEach(() => {
        savedClient = db.client;
        global.fetch = jest.fn(() =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: 'ok' }) })
        );
      });

      afterEach(() => {
        db.client = savedClient;
        delete process.env.DB_POOL_SATURATION_RATIO;
        delete process.env.DB_HEALTH_PROBE_TIMEOUT_MS;
      });

      it('returns healthy when pool is within normal bounds', async () => {
        mockPool({ used: 2, free: 8, pending: 0, max: 10 });
        db.raw.mockResolvedValue([{ '1': 1 }]);

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.checks.database.status).toBe('healthy');
        expect(res.body.checks.database.pool).toEqual({ used: 2, free: 8, pending: 0, max: 10 });
      });

      it('returns degraded and still ready when pending acquisitions exist', async () => {
        mockPool({ used: 10, free: 0, pending: 3, max: 10 });
        db.raw.mockResolvedValue([{ '1': 1 }]);

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.ready).toBe(true);
        expect(res.body.checks.database.status).toBe('degraded');
        expect(res.body.checks.database.pool.pending).toBe(3);

        const metric = await readinessGauge.get();
        expect(metric.values[0].value).toBe(0.5);
      });

      it('returns degraded when used connections meet or exceed the saturation ratio', async () => {
        mockPool({ used: 8, free: 2, pending: 0, max: 10 });
        db.raw.mockResolvedValue([{ '1': 1 }]);

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.ready).toBe(true);
        expect(res.body.checks.database.status).toBe('degraded');
      });

      it('returns healthy when used connections are below the saturation ratio', async () => {
        mockPool({ used: 7, free: 3, pending: 0, max: 10 });
        db.raw.mockResolvedValue([{ '1': 1 }]);

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.checks.database.status).toBe('healthy');
      });

      it('respects a custom DB_POOL_SATURATION_RATIO', async () => {
        process.env.DB_POOL_SATURATION_RATIO = '0.5';
        mockPool({ used: 6, free: 4, pending: 0, max: 10 });
        db.raw.mockResolvedValue([{ '1': 1 }]);

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.checks.database.status).toBe('degraded');
      });

      it('returns unhealthy on pool acquisition timeout', async () => {
        process.env.DB_HEALTH_PROBE_TIMEOUT_MS = '10';
        db.raw.mockImplementation(
          () => new Promise(resolve => setTimeout(resolve, 500))
        );

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.ready).toBe(false);
        expect(res.body.checks.database.status).toBe('unhealthy');
        expect(res.body.checks.database.error).toBe('Connection pool acquire timeout');

        const metric = await readinessGauge.get();
        expect(metric.values[0].value).toBe(0);
      });

      it('does not expose credentials or host info alongside pool metrics', async () => {
        mockPool({ used: 10, free: 0, pending: 5, max: 10 });
        db.raw.mockResolvedValue([{ '1': 1 }]);

        const res = await request(app).get('/readyz');
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/postgres:\/\//);
        expect(body).not.toMatch(/user:pass/);
        expect(body).not.toMatch(/DATABASE_URL/i);
        expect(res.body.checks.database.pool).toEqual({ used: 10, free: 0, pending: 5, max: 10 });
      });

      it('returns healthy with no pool field when pool internals are inaccessible', async () => {
        db.client = undefined;
        db.raw.mockResolvedValue([{ '1': 1 }]);

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body.checks.database.status).toBe('healthy');
        expect(res.body.checks.database.pool).toBeUndefined();
      });
    });
  });
});
