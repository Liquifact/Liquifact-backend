'use strict';

jest.unmock('../src/metrics');

const { checkMetricsHealth } = require('../src/services/health');
const metrics = require('../src/metrics');

describe('checkMetricsHealth', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns healthy when the registry responds', async () => {
    const result = await checkMetricsHealth();
    expect(result.status).toBe('healthy');
    expect(typeof result.latency).toBe('number');
  });

  it('returns disabled when METRICS_ENABLED is false, without calling the registry', async () => {
    process.env.METRICS_ENABLED = 'false';
    const metricsSpy = jest.spyOn(metrics.registry, 'metrics');
    const result = await checkMetricsHealth();
    expect(result).toEqual({ status: 'disabled' });
    expect(metricsSpy).not.toHaveBeenCalled();
    delete process.env.METRICS_ENABLED;
  });

  it('returns unhealthy with SCRAPE_FAILED when the registry throws', async () => {
    jest.spyOn(metrics.registry, 'metrics').mockRejectedValue(new Error('boom'));
    const result = await checkMetricsHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.error.code).toBe('SCRAPE_FAILED');
  });

  it('returns unhealthy with TIMEOUT when the registry hangs past the guard', async () => {
    jest.spyOn(metrics.registry, 'metrics').mockReturnValue(new Promise(() => {}));
    const result = await checkMetricsHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.error.code).toBe('TIMEOUT');
  }, 3000);
});
