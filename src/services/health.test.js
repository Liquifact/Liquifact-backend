/**
 * @file Tests for health check service.
 */

jest.mock('../metrics', () => ({
  escrowIndexerLastCursorAdvanceTimestampSeconds: { get: jest.fn(() => 0) },
  readinessGauge: { set: jest.fn() },
}));

jest.mock('../config', () => ({
  get: jest.fn(() => ({
    ESCROW_INDEXER_ENABLED: 'false',
    ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: 300,
  })),
}));

jest.mock('./kycService', () => ({
  getKycProviderConfig: jest.fn(() => ({ enabled: false })),
}));

jest.mock('./storage', () => ({
  probeS3Connectivity: jest.fn().mockResolvedValue({ status: 'in_memory' }),
}));

jest.mock('../jobs/reconcileEscrow', () => ({
  getReconciliationSummary: jest.fn(),
}));

const {
  checkSorobanHealth,
  checkDatabaseHealth,
  checkIndexerStaleness,
  checkKycHealth,
  checkReconciliationHealth,
  checkStorageHealth,
  inspectPoolHealth,
  performHealthChecks,
  performReadinessChecks,
  resolveSorobanHealthTimeoutMs
} = require('./health');

const cfg = require('../config');
const { escrowIndexerLastCursorAdvanceTimestampSeconds, readinessGauge } = require('../metrics');
const { getReconciliationSummary } = require('../jobs/reconcileEscrow');
const { getKycProviderConfig } = require('./kycService');
const db = require('../db/knex');
const storage = require('./storage');

describe('Health Service', () => {
  let originalEnv;
  let fetchMock;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    db.client = undefined;
    if (db.raw && db.raw.mockReset) {
      db.raw.mockReset();
      db.raw.mockResolvedValue([{ ok: 1 }]);
    }
    cfg.get.mockReturnValue({
      ESCROW_INDEXER_ENABLED: 'false',
      ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: 300,
    });
    escrowIndexerLastCursorAdvanceTimestampSeconds.get.mockReturnValue(0);
    getKycProviderConfig.mockReturnValue({ enabled: false });
    getReconciliationSummary.mockResolvedValue(null);
    storage.probeS3Connectivity.mockResolvedValue({ status: 'in_memory' });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('checkSorobanHealth', () => {
    it('should resolve the configured timeout with default and safety bounds', () => {
      expect(resolveSorobanHealthTimeoutMs({})).toBe(5000);
      expect(resolveSorobanHealthTimeoutMs({ SOROBAN_HEALTH_TIMEOUT_MS: 'invalid' })).toBe(5000);
      expect(resolveSorobanHealthTimeoutMs({ SOROBAN_HEALTH_TIMEOUT_MS: '50' })).toBe(250);
      expect(resolveSorobanHealthTimeoutMs({ SOROBAN_HEALTH_TIMEOUT_MS: '750' })).toBe(750);
      expect(resolveSorobanHealthTimeoutMs({ SOROBAN_HEALTH_TIMEOUT_MS: '60000' })).toBe(10000);
    });

    it('should return unknown when SOROBAN_RPC_URL is not configured', async () => {
      delete process.env.SOROBAN_RPC_URL;

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unknown');
      expect(result.error).toBe('SOROBAN_RPC_URL not configured');
    });

    it('should return healthy when Soroban RPC responds successfully', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await checkSorobanHealth();

      expect(result.status).toBe('healthy');
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://soroban-testnet.stellar.org',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
    });

    it('should return unhealthy when Soroban RPC returns error status', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: false, status: 503 });

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('HTTP 503');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when Soroban RPC times out', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mockRejectedValue(abortError);

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('The operation was aborted');
    });

    it('should abort a hanging Soroban RPC call after the configured timeout', async () => {
      jest.useFakeTimers();
      try {
        process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
        process.env.SOROBAN_HEALTH_TIMEOUT_MS = '250';
        fetchMock.mockImplementation((url, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }));

        const resultPromise = checkSorobanHealth();
        expect(fetchMock).toHaveBeenCalledWith(
          'https://soroban-testnet.stellar.org',
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );

        jest.advanceTimersByTime(249);
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1);
        const result = await resultPromise;

        expect(result.status).toBe('unhealthy');
        expect(result.error).toBe('The operation was aborted');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should classify latency as degraded when latency exceeds warn but not fail', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      // Warn at -1ms so any real latency (>= 0ms) exceeds warn; fail at 500ms
      process.env.SOROBAN_LATENCY_WARN_MS = '-1';
      process.env.SOROBAN_LATENCY_FAIL_MS = '500';

      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await checkSorobanHealth();

      expect(result.status).toBe('degraded');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should classify latency as unhealthy when latency exceeds fail', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      process.env.SOROBAN_LATENCY_WARN_MS = '-2';
      process.env.SOROBAN_LATENCY_FAIL_MS = '-1';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when network error occurs', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockRejectedValue(new Error('Network failure'));

      const result = await checkSorobanHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Network failure');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkDatabaseHealth', () => {
    it('should return not_configured when DATABASE_URL is not set', async () => {
      delete process.env.DATABASE_URL;

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('not_configured');
    });

    it('should return healthy when DATABASE_URL is set and DB is reachable', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('healthy');
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(result.pool).toBeUndefined();
    });

    it('should return unhealthy when the DB query rejects', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      const db = require('../db/knex');
      db.raw.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Database unreachable');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy on acquisition timeout', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.DB_HEALTH_PROBE_TIMEOUT_MS = '10';
      const db = require('../db/knex');
      db.raw.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(resolve, 500))
      );

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Connection pool acquire timeout');
    });

    it('should return degraded when the DB pool is saturated', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      const db = require('../db/knex');
      db.client = {
        pool: {
          numUsed: () => 8,
          numFree: () => 1,
          numPendingAcquires: () => 0,
        },
        config: { pool: { max: 10 } },
      };

      const result = await checkDatabaseHealth();

      expect(result.status).toBe('degraded');
      expect(result.pool).toEqual({ used: 8, free: 1, pending: 0, max: 10 });
    });
  });

  describe('checkReconciliationHealth', () => {
    it('should return not_run when no reconciliation summary exists', async () => {
      getReconciliationSummary.mockResolvedValue(null);

      const result = await checkReconciliationHealth();

      expect(result.status).toBe('not_run');
      expect(result.error).toBe('Reconciliation has not been run yet');
    });

    it('should return stale when the last reconciliation is too old', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-29T12:00:00Z').getTime());
      getReconciliationSummary.mockResolvedValue({
        reconciledAt: '2026-06-28T10:00:00.000Z',
        mismatches: 0,
      });

      const result = await checkReconciliationHealth();

      expect(result.status).toBe('stale');
      expect(result.error).toBe('Reconciliation not run recently');
    });

    it('should return mismatches when reconciliation found discrepancies', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-29T12:00:00Z').getTime());
      getReconciliationSummary.mockResolvedValue({
        reconciledAt: '2026-06-29T11:00:00.000Z',
        mismatches: 2,
      });

      const result = await checkReconciliationHealth();

      expect(result.status).toBe('mismatches');
      expect(result.mismatches).toBe(2);
    });

    it('should return healthy when reconciliation is recent and clean', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-29T12:00:00Z').getTime());
      getReconciliationSummary.mockResolvedValue({
        reconciledAt: '2026-06-29T11:30:00.000Z',
        mismatches: 0,
      });

      const result = await checkReconciliationHealth();

      expect(result.status).toBe('healthy');
      expect(result.lastRun).toBe('2026-06-29T11:30:00.000Z');
    });

    it('should return error when reconciliation summary lookup throws', async () => {
      getReconciliationSummary.mockRejectedValue(new Error('summary failed'));

      const result = await checkReconciliationHealth();

      expect(result.status).toBe('error');
      expect(result.error).toBe('summary failed');
    });
  });

  describe('checkKycHealth', () => {
    it('should return disabled when the provider is not configured', async () => {
      getKycProviderConfig.mockReturnValue({ enabled: false });

      const result = await checkKycHealth();

      expect(result.status).toBe('disabled');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should return healthy when the provider responds below 500', async () => {
      getKycProviderConfig.mockReturnValue({
        enabled: true,
        baseUrl: 'https://kyc.example.com/health',
        apiKey: 'test-key',
      });
      fetchMock.mockResolvedValue({ ok: false, status: 401 });

      const result = await checkKycHealth();

      expect(result.status).toBe('healthy');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://kyc.example.com/health',
        expect.objectContaining({
          method: 'HEAD',
          headers: { Authorization: 'Bearer test-key' },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should return unhealthy when the provider returns a server error', async () => {
      getKycProviderConfig.mockReturnValue({
        enabled: true,
        baseUrl: 'https://kyc.example.com/health',
        apiKey: 'test-key',
      });
      fetchMock.mockResolvedValue({ ok: false, status: 503 });

      const result = await checkKycHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('HTTP 503');
    });

    it('should return unhealthy when the provider request throws', async () => {
      getKycProviderConfig.mockReturnValue({
        enabled: true,
        baseUrl: 'https://kyc.example.com/health',
        apiKey: 'test-key',
      });
      fetchMock.mockRejectedValue(new Error('KYC network failure'));

      const result = await checkKycHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('KYC network failure');
    });
  });

  describe('checkIndexerStaleness', () => {
    it('should return disabled when the escrow indexer is off', async () => {
      cfg.get.mockReturnValue({ ESCROW_INDEXER_ENABLED: 'false' });

      const result = await checkIndexerStaleness();

      expect(result.status).toBe('disabled');
    });

    it('should return healthy when the cursor has not been set yet', async () => {
      cfg.get.mockReturnValue({
        ESCROW_INDEXER_ENABLED: 'true',
        ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: 300,
      });
      escrowIndexerLastCursorAdvanceTimestampSeconds.get.mockReturnValue(undefined);

      const result = await checkIndexerStaleness();

      expect(result).toEqual({ status: 'healthy', lastAdvanceTimestamp: 0, threshold: 300 });
    });

    it('should return stale when the cursor is older than the threshold', async () => {
      cfg.get.mockReturnValue({
        ESCROW_INDEXER_ENABLED: 'true',
        ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: 300,
      });
      escrowIndexerLastCursorAdvanceTimestampSeconds.get.mockReturnValue(1000);
      jest.spyOn(Date, 'now').mockReturnValue(1401 * 1000);

      const result = await checkIndexerStaleness();

      expect(result.status).toBe('stale');
      expect(result.elapsedSeconds).toBe(401);
      expect(result.threshold).toBe(300);
    });

    it('should return healthy when the cursor is within the threshold', async () => {
      cfg.get.mockReturnValue({
        ESCROW_INDEXER_ENABLED: 'true',
        ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: 300,
      });
      escrowIndexerLastCursorAdvanceTimestampSeconds.get.mockReturnValue(1000);
      jest.spyOn(Date, 'now').mockReturnValue(1200 * 1000);

      const result = await checkIndexerStaleness();

      expect(result.status).toBe('healthy');
      expect(result.elapsedSeconds).toBe(200);
    });

    it('should return error when the indexer config lookup throws', async () => {
      cfg.get.mockImplementation(() => {
        throw new Error('config failed');
      });

      const result = await checkIndexerStaleness();

      expect(result.status).toBe('error');
      expect(result.error).toBe('config failed');
    });
  });

  describe('checkStorageHealth', () => {
    it('should return the storage service probe result', async () => {
      storage.probeS3Connectivity.mockResolvedValue({
        status: 'healthy',
        latency: 12,
      });

      const result = await checkStorageHealth();

      expect(result).toEqual({ status: 'healthy', latency: 12 });
    });
  });

  describe('inspectPoolHealth', () => {
    it('returns null when knex instance has no client', () => {
      expect(inspectPoolHealth(null)).toBeNull();
      expect(inspectPoolHealth({})).toBeNull();
    });

    it('returns null when pool is absent', () => {
      expect(inspectPoolHealth({ client: {} })).toBeNull();
    });

    it('returns pool counters from tarn methods', () => {
      const fakeKnex = {
        client: {
          pool: {
            numUsed: () => 3,
            numFree: () => 7,
            numPendingAcquires: () => 1,
          },
          config: { pool: { max: 10 } },
        },
      };
      expect(inspectPoolHealth(fakeKnex)).toEqual({ used: 3, free: 7, pending: 1, max: 10 });
    });

    it('defaults max to 10 when config is absent', () => {
      const fakeKnex = {
        client: {
          pool: {
            numUsed: () => 0,
            numFree: () => 0,
            numPendingAcquires: () => 0,
          },
        },
      };
      const metrics = inspectPoolHealth(fakeKnex);
      expect(metrics.max).toBe(10);
    });
  });

  describe('performHealthChecks', () => {
    it('should return healthy when Soroban is healthy', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await performHealthChecks();

      expect(result.healthy).toBe(true);
      expect(result.checks.soroban.status).toBe('healthy');
      expect(result.checks.database.status).toBe('not_configured');
    });

    it('should return healthy when Soroban is not configured', async () => {
      delete process.env.SOROBAN_RPC_URL;

      const result = await performHealthChecks();

      expect(result.healthy).toBe(true);
      expect(result.checks.soroban.status).toBe('unknown');
    });

    it('should return unhealthy when Soroban is down', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockRejectedValue(new Error('Connection refused'));

      const result = await performHealthChecks();

      expect(result.healthy).toBe(false);
      expect(result.checks.soroban.status).toBe('unhealthy');
      expect(result.checks.soroban.error).toBe('Connection refused');
    });

    it('should check all dependencies in parallel', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const start = Date.now();
      const result = await performHealthChecks();
      const duration = Date.now() - start;

      expect(result.checks.soroban).toBeDefined();
      expect(result.checks.database).toBeDefined();
      expect(duration).toBeLessThan(100);
    });
  });

  describe('performReadinessChecks', () => {
    it('should report ready and set gauge to 1 when critical checks are healthy', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      storage.probeS3Connectivity.mockResolvedValue({ status: 'in_memory' });

      const result = await performReadinessChecks();

      expect(result.healthy).toBe(true);
      expect(result.checks.database.status).toBe('healthy');
      expect(result.checks.soroban.status).toBe('healthy');
      expect(readinessGauge.set).toHaveBeenCalledWith(1);
    });

    it('should set gauge to 0.5 when a critical dependency is degraded but ready', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      process.env.SOROBAN_LATENCY_WARN_MS = '-1';
      process.env.SOROBAN_LATENCY_FAIL_MS = '500';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await performReadinessChecks();

      expect(result.healthy).toBe(true);
      expect(result.checks.soroban.status).toBe('degraded');
      expect(readinessGauge.set).toHaveBeenCalledWith(0.5);
    });

    it('should report not ready and set gauge to 0 when DB is not configured', async () => {
      delete process.env.DATABASE_URL;
      delete process.env.SOROBAN_RPC_URL;

      const result = await performReadinessChecks();

      expect(result.healthy).toBe(false);
      expect(result.checks.database.status).toBe('not_configured');
      expect(readinessGauge.set).toHaveBeenCalledWith(0);
    });

    it('should report not ready when storage is not configured', async () => {
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      delete process.env.SOROBAN_RPC_URL;
      storage.probeS3Connectivity.mockResolvedValue({ status: 'not_configured' });

      const result = await performReadinessChecks();

      expect(result.healthy).toBe(false);
      expect(result.checks.storage.status).toBe('not_configured');
      expect(readinessGauge.set).toHaveBeenCalledWith(0);
    });
  });
});
