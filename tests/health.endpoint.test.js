'use strict';

const request = require('supertest');

jest.mock('../src/services/health', () => ({
  performHealthChecks: jest.fn(),
  performReadinessChecks: jest.fn(),
}));

const { createApp } = require('../src/app');
const { performHealthChecks, performReadinessChecks } = require('../src/services/health');

describe('Health endpoint coverage', () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    app = createApp();
  });

  beforeEach(() => {
    performHealthChecks.mockReset();
    performReadinessChecks.mockReset();

    performHealthChecks.mockResolvedValue({
      healthy: true,
      checks: {
        database: { status: 'healthy' },
        soroban: { status: 'healthy' },
      },
    });

    performReadinessChecks.mockResolvedValue({
      healthy: true,
      checks: {
        database: { status: 'healthy' },
        soroban: { status: 'healthy' },
      },
    });
  });

  it('GET /health returns 200 with liveness payload', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'liquifact-api',
      version: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('GET /healthz returns 200 with the same liveness payload', async () => {
    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'liquifact-api',
      version: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('GET /ready returns 200 when health checks are healthy', async () => {
    const res = await request(app).get('/ready');

    expect(performHealthChecks).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ready: true,
      service: 'liquifact-api',
      checks: {
        database: { status: 'healthy' },
        soroban: { status: 'healthy' },
      },
    });
  });

  it('GET /ready returns 503 when health checks are unhealthy', async () => {
    performHealthChecks.mockResolvedValueOnce({
      healthy: false,
      checks: {
        database: { status: 'unhealthy', error: 'Database unreachable' },
        soroban: { status: 'healthy' },
      },
    });

    const res = await request(app).get('/ready');

    expect(performHealthChecks).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ready: false,
      service: 'liquifact-api',
      checks: {
        database: { status: 'unhealthy', error: 'Database unreachable' },
        soroban: { status: 'healthy' },
      },
    });
  });

  it('GET /readyz returns 200 when readiness checks are healthy', async () => {
    const res = await request(app).get('/readyz');

    expect(performReadinessChecks).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ready: true,
      service: 'liquifact-api',
      checks: {
        database: { status: 'healthy' },
        soroban: { status: 'healthy' },
      },
    });
  });

  it('GET /readyz returns 503 when readiness checks are unhealthy', async () => {
    performReadinessChecks.mockResolvedValueOnce({
      healthy: false,
      checks: {
        database: { status: 'unhealthy', error: 'Database unreachable' },
        soroban: { status: 'healthy' },
      },
    });

    const res = await request(app).get('/readyz');

    expect(performReadinessChecks).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ready: false,
      service: 'liquifact-api',
      checks: {
        database: { status: 'unhealthy', error: 'Database unreachable' },
        soroban: { status: 'healthy' },
      },
    });
  });
});
