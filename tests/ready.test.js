'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const rpcClient = require('../src/stellar/rpc');
const { createReadiness } = require('../src/ready');

const nowSec = () => Math.floor(Date.now() / 1000);

function mockServer(overrides = {}) {
  return {
    getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    getNetwork: jest.fn().mockResolvedValue({ passphrase: config.networkPassphrase }),
    getLatestLedger: jest.fn().mockImplementation(async () => ({ sequence: 123, closeTime: String(nowSec() - 3) })),
    getContractData: jest.fn().mockResolvedValue({ key: 'k' }),
    ...overrides,
  };
}

function makeReady(server, settings = {}) {
  return createReadiness({ getServer: () => server, settings: { cacheSeconds: 0, ...settings } });
}

describe('readiness checks (mocked RPC)', () => {
  test('healthy', async () => {
    const server = mockServer();
    const { statusCode, body } = await makeReady(server).check();
    expect(statusCode).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks.rpc.ok).toBe(true);
    expect(typeof body.checks.rpc.latencyMs).toBe('number');
    expect(body.checks.network).toEqual({
      ok: true,
      expected: config.networkPassphrase,
      actual: config.networkPassphrase,
    });
    expect(body.checks.ledger).toMatchObject({ ok: true, sequence: 123 });
    expect(body.checks.ledger.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body.checks.contract).toEqual({ ok: true });
    expect(server.getContractData).toHaveBeenCalledTimes(1);
  });

  test('unhealthy rpc', async () => {
    const server = mockServer({ getHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }) });
    const { statusCode, body } = await makeReady(server).check();
    expect(statusCode).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.checks.rpc).toMatchObject({ ok: false, error: 'RPC_ERROR' });
    expect(body.checks.network.ok).toBe(true);
  });

  test('rpc error does not leak upstream message', async () => {
    const server = mockServer({ getHealth: jest.fn().mockRejectedValue(new Error('secret upstream detail')) });
    const { statusCode, body } = await makeReady(server).check();
    expect(statusCode).toBe(503);
    expect(body.checks.rpc).toEqual({ ok: false, error: 'RPC_ERROR' });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  test('timeout', async () => {
    jest.useFakeTimers();
    try {
      const server = mockServer({ getHealth: jest.fn(() => new Promise(() => {})) });
      const pending = makeReady(server, { checkTimeoutMs: 2000 }).check();
      await jest.advanceTimersByTimeAsync(2000);
      const { statusCode, body } = await pending;
      expect(statusCode).toBe(503);
      expect(body.checks.rpc).toEqual({ ok: false, error: 'TIMEOUT' });
      expect(body.checks.contract.ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('passphrase mismatch', async () => {
    const server = mockServer({
      getNetwork: jest.fn().mockResolvedValue({ passphrase: 'Public Global Stellar Network ; September 2015' }),
    });
    const { statusCode, body } = await makeReady(server).check();
    expect(statusCode).toBe(503);
    expect(body.checks.network).toEqual({
      ok: false,
      expected: config.networkPassphrase,
      actual: 'Public Global Stellar Network ; September 2015',
      error: 'PASSPHRASE_MISMATCH',
    });
  });

  test('stale ledger', async () => {
    const server = mockServer({
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 9, closeTime: String(nowSec() - 600) }),
    });
    const { statusCode, body } = await makeReady(server, { maxLedgerAgeSeconds: 60 }).check();
    expect(statusCode).toBe(503);
    expect(body.checks.ledger).toMatchObject({ ok: false, sequence: 9, error: 'STALE_LEDGER' });
    expect(body.checks.ledger.ageSeconds).toBeGreaterThanOrEqual(600);
  });

  test('missing contract', async () => {
    const server = mockServer({ getContractData: jest.fn().mockRejectedValue(new Error('Contract data not found')) });
    const { statusCode, body } = await makeReady(server).check();
    expect(statusCode).toBe(503);
    expect(body.checks.contract).toEqual({ ok: false, error: 'CONTRACT_NOT_FOUND' });
  });
});

describe('readiness cache', () => {
  test('two calls within the window invoke the RPC once', async () => {
    jest.useFakeTimers();
    try {
      const server = mockServer();
      const ready = makeReady(server, { cacheSeconds: 10 });
      await ready.check();
      await jest.advanceTimersByTimeAsync(5000);
      await ready.check();
      expect(server.getHealth).toHaveBeenCalledTimes(1);
      expect(server.getNetwork).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(6000);
      await ready.check();
      expect(server.getHealth).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('GET /ready and /health over HTTP (injected RPC client)', () => {
  afterEach(() => {
    rpcClient.setServer(null);
    app.locals.readiness.reset();
  });

  test('200 when ready', async () => {
    rpcClient.setServer(mockServer());
    app.locals.readiness.reset();
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  test('passphrase mismatch -> /ready 503 while /health stays 200', async () => {
    rpcClient.setServer(
      mockServer({ getNetwork: jest.fn().mockResolvedValue({ passphrase: 'Public Global Stellar Network ; September 2015' }) }),
    );
    app.locals.readiness.reset();
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('not_ready');
    expect(ready.body.checks.network.error).toBe('PASSPHRASE_MISMATCH');
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(typeof health.body.uptimeSeconds).toBe('number');
  });

  test('/ready is in the index and OpenAPI', async () => {
    const index = await request(app).get('/');
    expect(index.body.endpoints.map((e) => e.path)).toContain('/ready');
    const spec = (await request(app).get('/openapi.json')).body;
    expect(Object.keys(spec.paths)).toContain('/ready');
    expect(Object.keys(spec.paths['/ready'].get.responses)).toEqual(expect.arrayContaining(['200', '503']));
    expect(Object.keys(spec.components.schemas)).toEqual(expect.arrayContaining(['Health', 'Readiness']));
    expect(spec.components.schemas.Health.properties.uptimeSeconds).toBeDefined();
  });
});
