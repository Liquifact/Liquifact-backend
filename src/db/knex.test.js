'use strict';

/**
 * @file src/db/knex.test.js
 *
 * Regression suite for the hardened Knex singleton (issue #1330).
 *
 * Covers:
 *  1. resolveConfig error paths (missing test block, missing DATABASE_URL)
 *  2. Singleton initialisation — exactly one knex() call regardless of
 *     concurrent require paths
 *  3. Pool error-handler attachment and post-destroy silence
 *  4. Idempotent destroyOnce() — concurrent and repeated calls
 *  5. getHealthInfo() — success, timeout, destroyed, uninitialised
 *  6. shutdownCoordinator integration — uses destroyOnce()
 *
 * IMPORTANT: The global test setup (tests/mocks/setup.js) applies a virtual
 * mock for '../../src/db/knex'. This file unmocks it at the top level so the
 * real implementation is exercised. Each group that needs a fresh module
 * instance calls jest.resetModules() then jest.doMock() before require.
 */

// Unmock the global virtual mock from tests/mocks/setup.js so the real
// src/db/knex.js is used throughout this test file.
jest.unmock('../../src/db/knex');

// ---------------------------------------------------------------------------
// Helper: build a minimal fake knex() return value with a tarn pool stub
// ---------------------------------------------------------------------------

/**
 * Build a fake knex instance that satisfies attachPoolErrorHandlers
 * and provides a controllable destroy() method.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withPool=true]
 * @param {'resolve'|'reject'|'hang'} [opts.destroyBehaviour='resolve']
 * @returns {{ instance: object, poolEvents: Map<string,Function[]> }}
 */
function makeFakeKnexInstance({ withPool = true, destroyBehaviour = 'resolve' } = {}) {
  const poolEvents = new Map();
  let _destroyCalled = 0;

  const pool = withPool
    ? {
        on(event, handler) {
          if (!poolEvents.has(event)) { poolEvents.set(event, []); }
          poolEvents.get(event).push(handler);
        },
      }
    : null;

  const destroy = jest.fn(async () => {
    _destroyCalled += 1;
    if (destroyBehaviour === 'reject') { throw new Error('destroy failed'); }
    if (destroyBehaviour === 'hang') { await new Promise(() => {}); }
  });

  const raw = jest.fn(async () => ({ rows: [{ 1: 1 }] }));

  const instance = {
    client: pool ? { pool } : {},
    destroy,
    raw,
    _destroyCalled: () => _destroyCalled,
    _poolEvents: poolEvents,
  };

  return { instance, poolEvents };
}

// ---------------------------------------------------------------------------
// Helper: load knex.js with a controlled knex factory
//
// Uses the FULL path ('../../src/db/knex') so that jest.doMock targets the
// same registry entry as the test file's require.
// ---------------------------------------------------------------------------

/**
 * Reset the module registry, mock the `knex` npm package with a factory that
 * returns `fakeInstance`, then require the real knex.js implementation.
 *
 * @param {object} fakeInstance - Object returned by the stubbed knex() factory.
 * @returns {object} The db export from src/db/knex.js.
 */
function loadKnexModule(fakeInstance) {
  jest.resetModules();
  // Make sure the real src/db/knex.js is used (not the global virtual mock).
  jest.unmock('../../src/db/knex');
  // Stub the `knex` npm package that src/db/knex.js requires internally.
  jest.doMock('knex', () => jest.fn(() => fakeInstance));
  return require('../../src/db/knex');
}

// ---------------------------------------------------------------------------
// resolveConfig — unit tests (no knex factory involved)
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  let resolveConfig;

  beforeEach(() => {
    jest.resetModules();
    jest.unmock('../../src/db/knex');
    resolveConfig = require('../../src/db/resolveConfig');
  });

  it('returns the test config for NODE_ENV=test', () => {
    const config = resolveConfig('test');
    expect(config).toBeDefined();
    expect(config.client).toBe('better-sqlite3');
  });

  it('throws when NODE_ENV=test but the test block is absent', () => {
    jest.resetModules();
    jest.doMock('../../knexfile', () => ({ development: { client: 'sqlite3', connection: ':memory:' } }));
    const rc = require('../../src/db/resolveConfig');
    expect(() => rc('test')).toThrow('[db] No "test" config block found');
    jest.unmock('../../knexfile');
  });

  it('throws for production without DATABASE_URL', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => resolveConfig('production')).toThrow('DATABASE_URL must be set');
    } finally {
      if (saved !== undefined) { process.env.DATABASE_URL = saved; }
    }
  });

  it('throws for production when the production config block is absent', () => {
    process.env.DATABASE_URL = 'postgres://localhost/test_db';
    jest.resetModules();
    jest.doMock('../../knexfile', () => ({
      test: { client: 'better-sqlite3', connection: ':memory:' },
    }));
    const rc = require('../../src/db/resolveConfig');
    try {
      expect(() => rc('production')).toThrow('[db] No "production" config block');
    } finally {
      delete process.env.DATABASE_URL;
      jest.unmock('../../knexfile');
    }
  });

  it('throws for an unknown environment with no development fallback', () => {
    jest.resetModules();
    jest.doMock('../../knexfile', () => ({
      test: { client: 'better-sqlite3', connection: ':memory:' },
    }));
    const rc = require('../../src/db/resolveConfig');
    expect(() => rc('staging')).toThrow('No config block found');
    jest.unmock('../../knexfile');
  });

  it('falls back to the development block for an unrecognised env', () => {
    jest.resetModules();
    jest.doMock('../../knexfile', () => ({
      test: { client: 'better-sqlite3', connection: ':memory:' },
      development: { client: 'sqlite3', connection: ':memory:' },
    }));
    const rc = require('../../src/db/resolveConfig');
    const cfg = rc('staging');
    expect(cfg.client).toBe('sqlite3');
    jest.unmock('../../knexfile');
  });
});

// ---------------------------------------------------------------------------
// Singleton initialisation guard
// ---------------------------------------------------------------------------

describe('knex singleton', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('knex');
  });

  it('calls knex() exactly once during module load', () => {
    let callCount = 0;
    const { instance } = makeFakeKnexInstance();
    jest.resetModules();
    jest.unmock('../../src/db/knex');
    jest.doMock('knex', () => jest.fn(() => { callCount += 1; return instance; }));

    require('../../src/db/knex');
    expect(callCount).toBe(1);
  });

  it('re-requiring the module returns the same cached export', () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);
    const db2 = require('../../src/db/knex');
    expect(db2).toBe(db);
  });

  it('exposes destroyOnce as a function', () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);
    expect(typeof db.destroyOnce).toBe('function');
  });

  it('exposes getHealthInfo as a function', () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);
    expect(typeof db.getHealthInfo).toBe('function');
  });

  it('does not enumerate destroyOnce or getHealthInfo', () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);
    const keys = Object.keys(db);
    expect(keys).not.toContain('destroyOnce');
    expect(keys).not.toContain('getHealthInfo');
  });
});

// ---------------------------------------------------------------------------
// Pool error handler attachment
// ---------------------------------------------------------------------------

describe('pool error handlers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('knex');
  });

  it('registers createFail, acquireFail, and destroyFail on the pool', () => {
    const { instance } = makeFakeKnexInstance();
    loadKnexModule(instance);

    const events = instance._poolEvents;
    expect(events.has('createFail')).toBe(true);
    expect(events.has('acquireFail')).toBe(true);
    expect(events.has('destroyFail')).toBe(true);
  });

  it('does not throw when the client has no pool', () => {
    const { instance } = makeFakeKnexInstance({ withPool: false });
    expect(() => loadKnexModule(instance)).not.toThrow();
  });

  it('pool createFail handler logs an error', () => {
    const { instance } = makeFakeKnexInstance();
    loadKnexModule(instance);

    // Require logger AFTER loadKnexModule so we share the same registry.
    const logger = require('../../src/logger');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const handlers = instance._poolEvents.get('createFail') || [];
    handlers.forEach((h) => h('evt-1', new Error('create timeout')));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('[db] Pool: failed to create connection'),
    );
    errorSpy.mockRestore();
  });

  it('pool acquireFail handler logs an error', () => {
    const { instance } = makeFakeKnexInstance();
    loadKnexModule(instance);

    const logger = require('../../src/logger');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const handlers = instance._poolEvents.get('acquireFail') || [];
    handlers.forEach((h) => h('evt-2', new Error('acquire timeout')));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('[db] Pool: failed to acquire connection'),
    );
    errorSpy.mockRestore();
  });

  it('pool destroyFail handler logs a warning', () => {
    const { instance } = makeFakeKnexInstance();
    loadKnexModule(instance);

    const logger = require('../../src/logger');
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const handlers = instance._poolEvents.get('destroyFail') || [];
    handlers.forEach((h) => h('evt-3', new Error('destroy timeout')));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('[db] Pool: failed to destroy connection'),
    );
    warnSpy.mockRestore();
  });

  it('pool handlers are silent after destroyOnce has been called', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    const logger = require('../../src/logger');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await db.destroyOnce();

    // Simulate late pool events firing after teardown.
    (instance._poolEvents.get('createFail') || []).forEach((h) => h('late-1', new Error('late')));
    (instance._poolEvents.get('acquireFail') || []).forEach((h) => h('late-2', new Error('late')));
    (instance._poolEvents.get('destroyFail') || []).forEach((h) => h('late-3', new Error('late')));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// destroyOnce — idempotency and concurrency
// ---------------------------------------------------------------------------

describe('destroyOnce()', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('knex');
  });

  it('calls db.destroy() exactly once on the first call', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    await db.destroyOnce();
    expect(instance._destroyCalled()).toBe(1);
  });

  it('a second call does NOT invoke db.destroy() again', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    await db.destroyOnce();
    await db.destroyOnce();
    expect(instance._destroyCalled()).toBe(1);
  });

  it('returns a resolved Promise for every call', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    const results = await Promise.all([db.destroyOnce(), db.destroyOnce(), db.destroyOnce()]);
    expect(results).toEqual([undefined, undefined, undefined]);
    expect(instance._destroyCalled()).toBe(1);
  });

  it('10 concurrent callers coalesce onto a single destroy()', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    await Promise.all(Array.from({ length: 10 }, () => db.destroyOnce()));
    expect(instance._destroyCalled()).toBe(1);
  });

  it('propagates a rejection from db.destroy() to all concurrent callers', async () => {
    const { instance } = makeFakeKnexInstance({ destroyBehaviour: 'reject' });
    const db = loadKnexModule(instance);

    const p1 = db.destroyOnce();
    const p2 = db.destroyOnce();

    await expect(p1).rejects.toThrow('destroy failed');
    // p2 shares the same cached rejected Promise.
    await expect(p2).rejects.toThrow('destroy failed');
    // Underlying destroy was called only once.
    expect(instance._destroyCalled()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getHealthInfo()
// ---------------------------------------------------------------------------

describe('getHealthInfo()', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('knex');
    delete process.env.DB_HEALTH_TIMEOUT_MS;
  });

  it('returns status=healthy when SELECT 1 succeeds', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    const info = await db.getHealthInfo();

    expect(info.status).toBe('healthy');
    expect(typeof info.latencyMs).toBe('number');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    expect(info.lastHealthyAt).not.toBeNull();
    expect(info.error).toBeNull();
  });

  it('returns status=unhealthy when SELECT 1 rejects', async () => {
    const { instance } = makeFakeKnexInstance();
    instance.raw.mockRejectedValueOnce(new Error('connection refused'));
    const db = loadKnexModule(instance);

    const info = await db.getHealthInfo();

    expect(info.status).toBe('unhealthy');
    expect(info.error).toContain('connection refused');
    expect(typeof info.latencyMs).toBe('number');
  });

  it('returns status=destroyed after destroyOnce()', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    await db.destroyOnce();
    const info = await db.getHealthInfo();

    expect(info.status).toBe('destroyed');
    expect(info.error).toContain('destroyed');
  });

  it('redacts connection strings from unhealthy error messages', async () => {
    const { instance } = makeFakeKnexInstance();
    instance.raw.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED postgresql://user:secret@db.internal:5432/app'),
    );
    const db = loadKnexModule(instance);

    const info = await db.getHealthInfo();

    expect(info.status).toBe('unhealthy');
    expect(info.error).not.toContain('secret');
    expect(info.error).not.toContain('user:');
    expect(info.error).toContain('[redacted]');
  });

  it('records lastHealthyAt only after a successful check', async () => {
    const { instance } = makeFakeKnexInstance();

    // First raw() call fails.
    instance.raw.mockRejectedValueOnce(new Error('fail'));
    const db = loadKnexModule(instance);

    const failInfo = await db.getHealthInfo();
    expect(failInfo.lastHealthyAt).toBeNull();

    // Second raw() call succeeds (default mock resolves).
    const okInfo = await db.getHealthInfo();
    expect(okInfo.status).toBe('healthy');
    expect(okInfo.lastHealthyAt).not.toBeNull();
  });

  it('times out when SELECT 1 hangs and returns unhealthy', async () => {
    process.env.DB_HEALTH_TIMEOUT_MS = '50'; // keep the test fast

    const { instance } = makeFakeKnexInstance();
    instance.raw.mockImplementation(() => new Promise(() => {})); // never resolves

    const db = loadKnexModule(instance);
    const info = await db.getHealthInfo();

    expect(info.status).toBe('unhealthy');
    expect(info.error).toMatch(/timed out/i);
  }, 3_000 /* generous wall-clock budget */);

  it('does not expose credentials or pool config in the response', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    const info = await db.getHealthInfo();
    const serialised = JSON.stringify(info);

    expect(serialised).not.toMatch(/password|credential|token|secret|DATABASE_URL/i);
  });

  it('handles concurrent calls without error', async () => {
    const { instance } = makeFakeKnexInstance();
    const db = loadKnexModule(instance);

    const [a, b, c] = await Promise.all([
      db.getHealthInfo(),
      db.getHealthInfo(),
      db.getHealthInfo(),
    ]);

    for (const info of [a, b, c]) {
      expect(info.status).toBe('healthy');
    }
  });
});

// ---------------------------------------------------------------------------
// shutdownCoordinator integration
// ---------------------------------------------------------------------------

describe('shutdownCoordinator — uses destroyOnce', () => {
  /**
   * Load shutdownCoordinator with a controlled db mock injected.
   * Uses doMock so the mock is applied before require.
   *
   * @param {object} mockDb - Controlled db replacement.
   * @returns {object} shutdownCoordinator module.
   */
  function loadShutdown(mockDb) {
    jest.resetModules();
    jest.doMock('../../src/db/knex', () => mockDb);
    return require('../../src/utils/shutdownCoordinator');
  }

  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../src/db/knex');
  });

  it('calls db.destroyOnce() exactly once during shutdown', async () => {
    let destroyOnceCalled = 0;
    let _promise = null;
    const mockDb = {
      destroyOnce: jest.fn(() => {
        if (_promise) { return _promise; }
        destroyOnceCalled += 1;
        _promise = Promise.resolve();
        return _promise;
      }),
    };

    const shutdown = loadShutdown(mockDb);
    shutdown.register({ server: { close: jest.fn((cb) => cb()), closeIdleConnections: jest.fn() } });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    await shutdown.executeShutdown('SIGTERM');

    expect(mockDb.destroyOnce).toHaveBeenCalledTimes(1);
    expect(destroyOnceCalled).toBe(1);

    shutdown._resetState();
    exitSpy.mockRestore();
  });

  it('concurrent SIGTERM + SIGINT only triggers destroyOnce once', async () => {
    let destroyOnceCalled = 0;
    let _promise = null;
    const mockDb = {
      destroyOnce: jest.fn(() => {
        if (_promise) { return _promise; }
        destroyOnceCalled += 1;
        _promise = Promise.resolve();
        return _promise;
      }),
    };

    const shutdown = loadShutdown(mockDb);
    shutdown.register({ server: { close: jest.fn((cb) => cb()), closeIdleConnections: jest.fn() } });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    await Promise.all([
      shutdown.executeShutdown('SIGTERM'),
      shutdown.executeShutdown('SIGINT'),
    ]);

    // shutdownCoordinator's own isShuttingDown guard means Phase 4 runs once.
    expect(destroyOnceCalled).toBe(1);

    shutdown._resetState();
    exitSpy.mockRestore();
  });

  it('falls back to db.destroy() when destroyOnce is absent (legacy compat)', async () => {
    let destroyCalled = 0;
    const legacyDb = {
      destroy: jest.fn(async () => { destroyCalled += 1; }),
    };

    const shutdown = loadShutdown(legacyDb);
    shutdown.register({ server: { close: jest.fn((cb) => cb()), closeIdleConnections: jest.fn() } });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    await shutdown.executeShutdown('SIGTERM');

    expect(destroyCalled).toBe(1);

    shutdown._resetState();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Module-level init failure propagation
// ---------------------------------------------------------------------------

describe('module-level init failure', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('knex');
    jest.unmock('../../src/db/resolveConfig');
  });

  it('propagates resolveConfig throw out of require()', () => {
    jest.resetModules();
    jest.unmock('../../src/db/knex');
    jest.doMock('../../src/db/resolveConfig', () => () => {
      throw new Error('boom — no config');
    });
    expect(() => require('../../src/db/knex')).toThrow('boom — no config');
  });

  it('propagates knex() factory throw out of require()', () => {
    jest.resetModules();
    jest.unmock('../../src/db/knex');
    jest.doMock('knex', () => () => {
      throw new Error('knex factory error');
    });
    expect(() => require('../../src/db/knex')).toThrow('knex factory error');
  });
});
