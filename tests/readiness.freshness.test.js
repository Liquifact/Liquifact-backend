'use strict';

const { performReadinessChecks } = require('../src/services/health');

describe('performReadinessChecks freshness and error shaping', () => {
  let healthModule;

  beforeEach(() => {
    jest.resetModules();
    healthModule = require('../src/services/health');
  });

  it('exposes structured error for unavailable dependency', async () => {
    jest.spyOn(healthModule, 'checkDatabaseHealth').mockResolvedValue({ status: 'unhealthy', error: 'DB down' });
    jest.spyOn(healthModule, 'checkSorobanHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkStorageHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkReconciliationHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkMetricsHealth').mockResolvedValue({ status: 'healthy' });

    const result = await performReadinessChecks();

    expect(result.healthy).toBe(false);
    expect(result.checks.database.error).toEqual({ code: 'DEPENDENCY_ERROR', hint: 'DB down' });
  });

  it('includes freshness.ageSeconds for reconciliation lastRun stale', async () => {
    const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(); // 48 hours ago
    jest.spyOn(healthModule, 'checkDatabaseHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkSorobanHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkStorageHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkReconciliationHealth').mockResolvedValue({ status: 'stale', lastRun: oldDate });
    jest.spyOn(healthModule, 'checkMetricsHealth').mockResolvedValue({ status: 'healthy' });

    const result = await performReadinessChecks();
    expect(result.checks.reconciliation.freshness.ageSeconds).toBeGreaterThan(60 * 60 * 24);
  });

  it('handles clock skew where lastAdvanceTimestamp is in the future (negative age)', async () => {
    const futureTs = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
    jest.spyOn(healthModule, 'checkDatabaseHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkSorobanHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkStorageHealth').mockResolvedValue({ status: 'healthy' });
    // reuse reconciliation slot to simulate indexer-like lastAdvanceTimestamp
    jest.spyOn(healthModule, 'checkReconciliationHealth').mockResolvedValue({ status: 'healthy', lastAdvanceTimestamp: futureTs });
    jest.spyOn(healthModule, 'checkMetricsHealth').mockResolvedValue({ status: 'healthy' });

    const result = await performReadinessChecks();
    expect(typeof result.checks.reconciliation.freshness.ageSeconds).toBe('number');
    expect(result.checks.reconciliation.freshness.ageSeconds).toBeLessThan(0);
  });

  it('falls back to latency as freshness proxy for slow probes', async () => {
    jest.spyOn(healthModule, 'checkDatabaseHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkSorobanHealth').mockResolvedValue({ status: 'degraded', latency: 2500 });
    jest.spyOn(healthModule, 'checkStorageHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkReconciliationHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkMetricsHealth').mockResolvedValue({ status: 'healthy' });

    const result = await performReadinessChecks();
    expect(result.checks.soroban.freshness.ageSeconds).toBeGreaterThanOrEqual(2);
  });

  it('treats explicitly disabled partial dependencies as OK', async () => {
    jest.spyOn(healthModule, 'checkDatabaseHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkSorobanHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkStorageHealth').mockResolvedValue({ status: 'disabled' });
    jest.spyOn(healthModule, 'checkReconciliationHealth').mockResolvedValue({ status: 'healthy' });
    jest.spyOn(healthModule, 'checkMetricsHealth').mockResolvedValue({ status: 'healthy' });

    const result = await performReadinessChecks();
    expect(result.healthy).toBe(true);
    expect(result.checks.storage.status).toBe('disabled');
  });
});
