'use strict';

/**
 * Route-level tests for GET /ready (readiness probe) and GET /health.
 *
 * Every RPC interaction goes through an injected fake client
 * (`src/stellar/rpc.js` -> `setRpcServer`), so no test touches the network.
 */

process.env.READY_CHECK_TIMEOUT_MS = '50';

const request = require('supertest');
const { Contract } = require('@stellar/stellar-sdk');
const app = require('../src/app');
const config = require('../src/config');
const { setRpcServer, resetRpcServer } = require('../src/stellar/rpc');
const { getReadiness, resetReadinessCache } = require('../src/services/readiness');

const PASSPHRASE = config.networkPassphrase;

/**
 * Builds a fake Soroban RPC client. Every method can be overridden per test.
 *
 * @param {object} [overrides] method overrides
 * @returns {object} the fake client
 */
function fakeRpcServer(overrides = {}) {
  const nowSeconds = () => String(Math.floor(Date.now() / 1000));
  return {
    getHealth: jest.fn(async () => ({
      status: 'healthy',
      latestLedger: 1000,
      latestLedgerCloseTime: nowSeconds(),
    })),
    getNetwork: jest.fn(async () => ({ passphrase: PASSPHRASE, protocolVersion: 29 })),
    getLatestLedger: jest.fn(async () => ({ id: 'ledger-hash', sequence: 1000, closeTime: nowSeconds() })),
    getLedgerEntries: jest.fn(async () => ({ entries: [{ key: {}, val: {} }], latestLedger: 1000 })),
    ...overrides,
  };
}

let server;

/** Installs a fresh fake client and clears the readiness cache. */
function install(overrides = {}) {
  server = fakeRpcServer(overrides);
  setRpcServer(server);
  resetReadinessCache();
  return server;
}

beforeEach(() => {
  install();
});

afterEach(() => {
  resetRpcServer();
  resetReadinessCache();
});

describe('GET /ready — healthy', () => {
  test('returns 200 with every check reported', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.rpc.ok).toBe(true);
    expect(typeof res.body.checks.rpc.latencyMs).toBe('number');
    expect(res.body.checks.network).toEqual({
      ok: true,
      expected: PASSPHRASE,
      actual: PASSPHRASE,
    });
    expect(res.body.checks.ledger.ok).toBe(true);
    expect(res.body.checks.ledger.sequence).toBe(1000);
    expect(res.body.checks.ledger.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.checks.ledger.ageSeconds).toBeLessThan(60);
    expect(res.body.checks.contract).toEqual({ ok: true });
  });

  test('checks the configured contract instance key', async () => {
    await request(app).get('/ready');
    expect(server.getLedgerEntries).toHaveBeenCalledTimes(1);
    const [ledgerKey] = server.getLedgerEntries.mock.calls[0];
    const contractData = ledgerKey.contractData();
    expect(contractData.key().switch().name).toBe('scvLedgerKeyContractInstance');
    expect(contractData.durability().name).toBe('persistent');
    expect(contractData.contract().toString()).toBe(
      new Contract(config.contractId).address().toScAddress().toString(),
    );
  });

  test('uses the injected RPC client instead of the network', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(server.getHealth).toHaveBeenCalled();
    expect(server.getNetwork).toHaveBeenCalled();
    expect(server.getLatestLedger).toHaveBeenCalled();
    expect(server.getLedgerEntries).toHaveBeenCalled();
  });
});

describe('GET /ready — failures', () => {
  test('reports an unhealthy RPC with 503 and RPC_ERROR', async () => {
    install({ getHealth: jest.fn(async () => ({ status: 'unhealthy' })) });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.rpc.ok).toBe(false);
    expect(res.body.checks.rpc.error).toBe('RPC_ERROR');
    expect(res.body.checks.network.ok).toBe(true);
  });

  test('reports a timed out check with 503 and TIMEOUT', async () => {
    install({ getHealth: jest.fn(() => new Promise(() => {})) });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.rpc.ok).toBe(false);
    expect(res.body.checks.rpc.error).toBe('TIMEOUT');
  });

  test('reports a passphrase mismatch with 503 and PASSPHRASE_MISMATCH', async () => {
    install({ getNetwork: jest.fn(async () => ({ passphrase: 'Public Global Stellar Network ; September 2015' })) });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.network.ok).toBe(false);
    expect(res.body.checks.network.error).toBe('PASSPHRASE_MISMATCH');
    expect(res.body.checks.network.expected).toBe(PASSPHRASE);
    expect(res.body.checks.network.actual).toBe('Public Global Stellar Network ; September 2015');
    expect(res.body.checks.rpc.ok).toBe(true);
  });

  test('reports a stale ledger with 503 and STALE_LEDGER', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    install({ getLatestLedger: jest.fn(async () => ({ id: 'stale', sequence: 999, closeTime: stale })) });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.ledger.ok).toBe(false);
    expect(res.body.checks.ledger.error).toBe('STALE_LEDGER');
    expect(res.body.checks.ledger.sequence).toBe(999);
    expect(res.body.checks.ledger.ageSeconds).toBeGreaterThanOrEqual(3600);
  });

  test('reports a missing contract with 503 and CONTRACT_NOT_FOUND', async () => {
    install({ getLedgerEntries: jest.fn(async () => ({ entries: [], latestLedger: 1000 })) });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.contract.ok).toBe(false);
    expect(res.body.checks.contract.error).toBe('CONTRACT_NOT_FOUND');
  });

  test('reports an unreachable RPC as RPC_ERROR, not as a missing contract', async () => {
    install({
      getLedgerEntries: jest.fn(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' });
      }),
    });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.contract.ok).toBe(false);
    expect(res.body.checks.contract.error).toBe('RPC_ERROR');
    // The RPC itself answered, so the health check is unaffected.
    expect(res.body.checks.rpc.ok).toBe(true);
  });

  test('never leaks raw upstream error messages', async () => {
    install({
      getHealth: jest.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:443 token=super-secret');
      }),
    });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.rpc.error).toBe('RPC_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });
});

describe('GET /ready — caching', () => {
  test('reuses the result within the cache window and re-probes afterwards', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      install();
      const first = await getReadiness();
      const second = await getReadiness();
      expect(first.status).toBe('ready');
      expect(second).toBe(first);
      expect(server.getHealth).toHaveBeenCalledTimes(1);
      expect(server.getNetwork).toHaveBeenCalledTimes(1);

      // The cache window (READY_CACHE_SECONDS, default 10) has passed.
      jest.setSystemTime(Date.now() + 11_000);
      const third = await getReadiness();
      expect(third.status).toBe('ready');
      expect(third).not.toBe(first);
      expect(server.getHealth).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('GET /health — liveness', () => {
  test('stays 200 and dependency-free', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(server.getHealth).not.toHaveBeenCalled();
    expect(server.getNetwork).not.toHaveBeenCalled();
    expect(server.getLatestLedger).not.toHaveBeenCalled();
    expect(server.getLedgerEntries).not.toHaveBeenCalled();
  });

  test('stays 200 while /ready reports a passphrase mismatch', async () => {
    install({ getNetwork: jest.fn(async () => ({ passphrase: 'Public Global Stellar Network ; September 2015' })) });
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('not_ready');

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
  });
});

describe('endpoint index and OpenAPI', () => {
  test('the index lists /ready', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    const paths = res.body.endpoints.map((e) => e.path);
    expect(paths).toContain('/ready');
  });

  test('the OpenAPI document describes /ready and the changed /health', async () => {
    const spec = (await request(app).get('/openapi.json')).body;

    expect(spec.paths['/ready']).toBeDefined();
    const ready = spec.paths['/ready'].get;
    expect(ready.responses['200']).toBeDefined();
    expect(ready.responses['503']).toBeDefined();
    expect(ready.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ReadinessResponse',
    );
    expect(ready.responses['503'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ReadinessResponse',
    );

    const readiness = spec.components.schemas.ReadinessResponse;
    expect(readiness.properties.status.enum).toEqual(['ready', 'not_ready']);
    expect(Object.keys(readiness.properties.checks.properties)).toEqual([
      'rpc',
      'network',
      'ledger',
      'contract',
    ]);
    expect(readiness.properties.checks.properties.network.properties.error.enum).toEqual([
      'TIMEOUT',
      'PASSPHRASE_MISMATCH',
      'STALE_LEDGER',
      'CONTRACT_NOT_FOUND',
      'RPC_ERROR',
    ]);

    const health = spec.paths['/health'].get;
    expect(health.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/HealthResponse',
    );
    expect(spec.components.schemas.HealthResponse.properties).toHaveProperty('uptimeSeconds');
  });
});
