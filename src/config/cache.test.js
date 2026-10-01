'use strict';

/**
 * @fileoverview Tests for deterministic, bounded cache-configuration recovery.
 *
 * The subject is `src/config/cache.js`. Cache knobs are performance knobs, so
 * a bad value must never stop the process from booting — but it must also never
 * hand a consumer an out-of-contract value, because an `undefined` TTL or entry
 * bound silently disables expiry *and* eviction and becomes a memory leak.
 *
 * Coverage is organised around the invariants documented in the module:
 * success, rejection (every bounded reason), boundary values, the safety floor,
 * determinism/idempotence, atomic publication across reloads, observability
 * (including "no raw value in the log"), and dependency failure of the logger.
 */

const mockLogger = { warn: jest.fn() };
jest.mock('../logger', () => mockLogger);

/** A getter-backed env source that throws when a specific variable is read. */
function throwingEnv(variable, error) {
  const env = {};
  Object.defineProperty(env, variable, {
    enumerable: true,
    get() {
      throw error;
    },
  });
  return env;
}

describe('cacheConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    mockLogger.warn.mockReset();
  });

  afterEach(() => {
    // Restore the module mock in case a test overrode it via `jest.doMock`.
    jest.doMock('../logger', () => mockLogger);
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  // ── success ──────────────────────────────────────────────────────────────

  it('exposes exactly the six documented keys and nothing else', () => {
    const { cacheConfig } = require('./cache');
    expect(Object.keys(cacheConfig).sort()).toEqual([
      'escrowMaxEntries',
      'escrowTtl',
      'indexerMaxEntries',
      'indexerTtl',
      'invoiceStateMaxEntries',
      'invoiceStateTtl',
    ]);
  });

  it('applies documented defaults when no variable is set', () => {
    const { parseCacheConfig } = require('./cache');
    expect(parseCacheConfig({})).toEqual({
      escrowTtl: 30000,
      escrowMaxEntries: 500,
      indexerTtl: 10000,
      indexerMaxEntries: 200,
      invoiceStateTtl: 30000,
      invoiceStateMaxEntries: 500,
    });
  });

  it('converts every configured TTL from seconds to milliseconds', () => {
    const { parseCacheConfig } = require('./cache');
    const config = parseCacheConfig({
      ESCROW_CACHE_TTL_SECONDS: '60',
      INDEXER_CACHE_TTL_SECONDS: '5',
      INVOICE_STATE_CACHE_TTL_SECONDS: '120',
    });

    expect(config.escrowTtl).toBe(60000);
    expect(config.indexerTtl).toBe(5000);
    expect(config.invoiceStateTtl).toBe(120000);
  });

  it('honours every configured entry bound', () => {
    const { parseCacheConfig } = require('./cache');
    const config = parseCacheConfig({
      ESCROW_CACHE_MAX_ENTRIES: '25',
      INDEXER_CACHE_MAX_ENTRIES: '100',
      INVOICE_STATE_CACHE_MAX_ENTRIES: '7',
    });

    expect(config.escrowMaxEntries).toBe(25);
    expect(config.indexerMaxEntries).toBe(100);
    expect(config.invoiceStateMaxEntries).toBe(7);
  });

  it('tolerates surrounding whitespace and an explicit plus sign', () => {
    const { parseCacheConfig } = require('./cache');
    const config = parseCacheConfig({
      INDEXER_CACHE_TTL_SECONDS: '  7  ',
      INDEXER_CACHE_MAX_ENTRIES: '+42',
    });

    expect(config.indexerTtl).toBe(7000);
    expect(config.indexerMaxEntries).toBe(42);
  });

  it('accepts numeric values from a plain-object env source', () => {
    const { parseCacheConfig } = require('./cache');
    const config = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: 15 });

    expect(config.escrowTtl).toBe(15000);
  });

  it('reads a null-prototype env source without throwing', () => {
    const { parseCacheConfig } = require('./cache');
    const env = Object.create(null);
    env.INDEXER_CACHE_MAX_ENTRIES = '11';

    expect(parseCacheConfig(env).indexerMaxEntries).toBe(11);
  });

  // ── rejection: one bounded reason per failure mode ───────────────────────

  it('reports not_a_string for a value that is neither string nor number', () => {
    const { parseCacheConfig, describeCacheConfigFallbacks, CACHE_CONFIG_FALLBACK_REASON } =
      require('./cache');
    const value = { nested: 'object' };

    const config = parseCacheConfig({ INDEXER_CACHE_MAX_ENTRIES: value });

    expect(config.indexerMaxEntries).toBe(200);
    expect(describeCacheConfigFallbacks({ INDEXER_CACHE_MAX_ENTRIES: value })).toEqual([
      expect.objectContaining({
        variable: 'INDEXER_CACHE_MAX_ENTRIES',
        reason: CACHE_CONFIG_FALLBACK_REASON.NOT_A_STRING,
      }),
    ]);
  });

  it.each([
    ['abc'],
    ['1.5'],
    ['1e3'],
    ['60s'],
    ['NaN'],
    ['Infinity'],
    ['0x10'],
    ['１２３'],
  ])('rejects the partially numeric or non-integer value %p', (raw) => {
    const { parseCacheConfig, describeCacheConfigFallbacks, CACHE_CONFIG_FALLBACK_REASON } =
      require('./cache');
    const env = { INDEXER_CACHE_TTL_SECONDS: raw };

    expect(parseCacheConfig(env).indexerTtl).toBe(10000);
    expect(describeCacheConfigFallbacks(env)[0].reason).toBe(
      CACHE_CONFIG_FALLBACK_REASON.NOT_AN_INTEGER,
    );
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['large negative', '-99999'],
  ])('reports not_positive for %s', (_label, raw) => {
    const { parseCacheConfig, describeCacheConfigFallbacks, CACHE_CONFIG_FALLBACK_REASON } =
      require('./cache');
    const env = { INDEXER_CACHE_MAX_ENTRIES: raw };

    expect(parseCacheConfig(env).indexerMaxEntries).toBe(200);
    expect(describeCacheConfigFallbacks(env)[0].reason).toBe(
      CACHE_CONFIG_FALLBACK_REASON.NOT_POSITIVE,
    );
  });

  it('reports not_finite for a non-finite number', () => {
    const { describeCacheConfigFallbacks, CACHE_CONFIG_FALLBACK_REASON } = require('./cache');

    expect(
      describeCacheConfigFallbacks({ ESCROW_CACHE_TTL_SECONDS: Number.POSITIVE_INFINITY })[0].reason,
    ).toBe(CACHE_CONFIG_FALLBACK_REASON.NOT_FINITE);
    expect(
      describeCacheConfigFallbacks({ ESCROW_CACHE_TTL_SECONDS: Number.NaN })[0].reason,
    ).toBe(CACHE_CONFIG_FALLBACK_REASON.NOT_FINITE);
  });

  it('reports out_of_range for a syntactically valid but excessive value', () => {
    const { parseCacheConfig, describeCacheConfigFallbacks, CACHE_CONFIG_LIMITS } = require('./cache');
    const env = { INDEXER_CACHE_MAX_ENTRIES: String(CACHE_CONFIG_LIMITS.maxEntries.max + 1) };

    expect(parseCacheConfig(env).indexerMaxEntries).toBe(200);
    expect(describeCacheConfigFallbacks(env)[0].reason).toBe('out_of_range');
  });

  it('rejects an integer that overflows the safe-integer range', () => {
    const { parseCacheConfig, describeCacheConfigFallbacks } = require('./cache');
    const env = { INDEXER_CACHE_MAX_ENTRIES: '9007199254740993' };

    expect(parseCacheConfig(env).indexerMaxEntries).toBe(200);
    expect(describeCacheConfigFallbacks(env)[0].reason).toBe('not_an_integer');
  });

  it.each([
    ['null', null],
    ['a string', 'INDEXER_CACHE_TTL_SECONDS=5'],
    ['a number', 5],
    ['a boolean', true],
    ['a symbol', Symbol('env')],
  ])('reports unreadable_env when the env source is %s', (_label, source) => {
    const { parseCacheConfig, describeCacheConfigFallbacks } = require('./cache');

    expect(parseCacheConfig(source)).toEqual({
      escrowTtl: 30000,
      escrowMaxEntries: 500,
      indexerTtl: 10000,
      indexerMaxEntries: 200,
      invoiceStateTtl: 30000,
      invoiceStateMaxEntries: 500,
    });
    expect(describeCacheConfigFallbacks(source)).toHaveLength(6);
    expect(describeCacheConfigFallbacks(source).every((f) => f.reason === 'unreadable_env')).toBe(true);
  });

  it('reads process.env when no source is supplied', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = '11';
    const { parseCacheConfig, describeCacheConfigFallbacks } = require('./cache');

    expect(parseCacheConfig().indexerTtl).toBe(11000);
    expect(parseCacheConfig(undefined).indexerTtl).toBe(11000);
    expect(describeCacheConfigFallbacks()).toEqual([]);
  });

  it('recovers from an env source whose getter throws', () => {
    const { parseCacheConfig, describeCacheConfigFallbacks } = require('./cache');
    const env = throwingEnv('INDEXER_CACHE_TTL_SECONDS', new Error('environment read failed'));

    expect(parseCacheConfig(env).indexerTtl).toBe(10000);

    const fallbacks = describeCacheConfigFallbacks(env);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].variable).toBe('INDEXER_CACHE_TTL_SECONDS');
    expect(fallbacks[0].reason).toBe('unreadable_env');
  });

  it('treats an absent or blank variable as a normal default, not a rejection', () => {
    const { parseCacheConfig, describeCacheConfigFallbacks } = require('./cache');

    expect(parseCacheConfig({}).escrowTtl).toBe(30000);
    expect(parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: '' }).escrowTtl).toBe(30000);
    expect(parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: '   ' }).escrowTtl).toBe(30000);
    expect(describeCacheConfigFallbacks({ ESCROW_CACHE_TTL_SECONDS: '' })).toEqual([]);
    expect(describeCacheConfigFallbacks({})).toEqual([]);
  });

  // ── boundary ─────────────────────────────────────────────────────────────

  it('accepts the exact lower and upper bounds of every field', () => {
    const { parseCacheConfig, CACHE_CONFIG_LIMITS } = require('./cache');

    const config = parseCacheConfig({
      ESCROW_CACHE_TTL_SECONDS: String(CACHE_CONFIG_LIMITS.ttlSeconds.min),
      ESCROW_CACHE_MAX_ENTRIES: String(CACHE_CONFIG_LIMITS.maxEntries.min),
      INDEXER_CACHE_TTL_SECONDS: String(CACHE_CONFIG_LIMITS.ttlSeconds.max),
      INDEXER_CACHE_MAX_ENTRIES: String(CACHE_CONFIG_LIMITS.maxEntries.max),
    });

    expect(config.escrowTtl).toBe(1000);
    expect(config.escrowMaxEntries).toBe(1);
    expect(config.indexerTtl).toBe(86400000);
    expect(config.indexerMaxEntries).toBe(100000);
  });

  it('rejects one step outside each bound', () => {
    const { parseCacheConfig, CACHE_CONFIG_LIMITS } = require('./cache');

    const config = parseCacheConfig({
      ESCROW_CACHE_TTL_SECONDS: String(CACHE_CONFIG_LIMITS.ttlSeconds.min - 1),
      INDEXER_CACHE_MAX_ENTRIES: String(CACHE_CONFIG_LIMITS.maxEntries.max + 1),
    });

    expect(config.escrowTtl).toBe(30000);
    expect(config.indexerMaxEntries).toBe(200);
  });

  it('caps a hostile bound rather than allowing unbounded memory growth', () => {
    const { parseCacheConfig, CACHE_CONFIG_LIMITS } = require('./cache');

    const config = parseCacheConfig({ INDEXER_CACHE_MAX_ENTRIES: '1000000000' });

    expect(config.indexerMaxEntries).toBe(200);
    expect(config.indexerMaxEntries).toBeLessThanOrEqual(CACHE_CONFIG_LIMITS.maxEntries.max);
  });

  // ── safety floor: recovery never yields an out-of-contract value ─────────

  it.each([
    ['missing env', undefined],
    ['null env', null],
    ['empty env', {}],
    ['garbage env', { ESCROW_CACHE_TTL_SECONDS: 'abc', INDEXER_CACHE_MAX_ENTRIES: 'NaN' }],
    ['hostile env', {
      ESCROW_CACHE_TTL_SECONDS: '-0',
      ESCROW_CACHE_MAX_ENTRIES: '1e999',
      INDEXER_CACHE_TTL_SECONDS: Number.NaN,
      INDEXER_CACHE_MAX_ENTRIES: Number.POSITIVE_INFINITY,
      INVOICE_STATE_CACHE_TTL_SECONDS: {},
      INVOICE_STATE_CACHE_MAX_ENTRIES: [],
    }],
    ['throwing env', throwingEnv('ESCROW_CACHE_TTL_SECONDS', new Error('boom'))],
  ])('never returns a non-positive, non-finite, or non-integer value for %s', (_label, env) => {
    const { parseCacheConfig } = require('./cache');
    const config = parseCacheConfig(env);

    for (const [key, value] of Object.entries(config)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
      expect(key).toMatch(/Ttl$|MaxEntries$/);
    }
  });

  it('never yields a TTL that a consumer could read as "never expires"', () => {
    const { parseCacheConfig } = require('./cache');
    const config = parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: 'oops' });

    // `services/indexerCache` evaluates `expiresAt <= now()`; a NaN or
    // undefined ttlMs would make that comparison permanently false.
    expect(config.indexerTtl + 0).toBe(10000);
    expect(Number.isNaN(config.indexerTtl + 0)).toBe(false);
  });

  // ── determinism ──────────────────────────────────────────────────────────

  it('is a pure function of its env argument', () => {
    const { parseCacheConfig } = require('./cache');
    const env = { INDEXER_CACHE_TTL_SECONDS: '3', ESCROW_CACHE_MAX_ENTRIES: '9' };

    expect(parseCacheConfig(env)).toEqual(parseCacheConfig(env));
    expect(parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: '3', ESCROW_CACHE_MAX_ENTRIES: '9' })).toEqual(
      parseCacheConfig(env),
    );
  });

  it('is idempotent across repeated calls', () => {
    const { parseCacheConfig } = require('./cache');
    const env = { INDEXER_CACHE_TTL_SECONDS: '3' };

    const first = parseCacheConfig(env);
    const second = parseCacheConfig(env);
    const third = parseCacheConfig(env);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // Fresh objects each call: a caller cannot poison another caller's result.
    expect(third).not.toBe(first);
  });

  it('reports fallbacks in a deterministic order', () => {
    const { describeCacheConfigFallbacks } = require('./cache');
    const env = {
      INVOICE_STATE_CACHE_MAX_ENTRIES: 'x',
      ESCROW_CACHE_TTL_SECONDS: 'y',
      INDEXER_CACHE_TTL_SECONDS: 'z',
    };

    const order = describeCacheConfigFallbacks(env).map((f) => f.variable);
    expect(order).toEqual([
      'ESCROW_CACHE_TTL_SECONDS',
      'INDEXER_CACHE_TTL_SECONDS',
      'INVOICE_STATE_CACHE_MAX_ENTRIES',
    ]);
    expect(describeCacheConfigFallbacks(env).map((f) => f.variable)).toEqual(order);
  });

  // ── observability ────────────────────────────────────────────────────────

  it('describes a rejection with the variable, range, and applied default', () => {
    const { describeCacheConfigFallbacks } = require('./cache');

    expect(describeCacheConfigFallbacks({ INDEXER_CACHE_TTL_SECONDS: 'abc' })).toEqual([
      {
        variable: 'INDEXER_CACHE_TTL_SECONDS',
        key: 'indexerTtl',
        reason: 'not_an_integer',
        envDefault: 10,
        min: 1,
        max: 86400,
        resolved: 10000,
      },
    ]);
  });

  it('never places the raw configured value in a fallback record', () => {
    const { describeCacheConfigFallbacks } = require('./cache');
    const secretish = 'not-a-number-super-secret-token';

    const serialised = JSON.stringify(describeCacheConfigFallbacks({
      ESCROW_CACHE_TTL_SECONDS: secretish,
    }));

    expect(serialised).not.toContain(secretish);
  });

  it('notifies an onFallback observer once per rejected value', () => {
    const { parseCacheConfig } = require('./cache');
    const onFallback = jest.fn();

    const config = parseCacheConfig(
      { ESCROW_CACHE_TTL_SECONDS: 'abc', INDEXER_CACHE_MAX_ENTRIES: '-5' },
      { onFallback },
    );

    expect(config.escrowTtl).toBe(30000);
    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback.mock.calls.map(([f]) => f.variable)).toEqual([
      'ESCROW_CACHE_TTL_SECONDS',
      'INDEXER_CACHE_MAX_ENTRIES',
    ]);
  });

  it('does not notify the observer when nothing was rejected', () => {
    const { parseCacheConfig } = require('./cache');
    const onFallback = jest.fn();

    parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: '60' }, { onFallback });

    expect(onFallback).not.toHaveBeenCalled();
  });

  it('still returns a safe config when the observer throws', () => {
    const { parseCacheConfig } = require('./cache');
    const onFallback = jest.fn(() => {
      throw new Error('observer exploded');
    });

    expect(() => parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: 'abc' }, { onFallback })).not.toThrow();
    expect(parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: 'abc' }, { onFallback }).indexerTtl).toBe(
      10000,
    );
    expect(onFallback).toHaveBeenCalled();
  });

  it('warns once per distinct variable and reason at load time', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = 'abc';
    const { getCacheConfigFallbacks } = require('./cache');

    expect(getCacheConfigFallbacks()).toHaveLength(1);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    const [payload, message] = mockLogger.warn.mock.calls[0];
    expect(payload).toEqual({
      event: 'cache_config.fallback',
      variable: 'INDEXER_CACHE_TTL_SECONDS',
      key: 'indexerTtl',
      reason: 'not_an_integer',
      envDefault: 10,
      minAccepted: 1,
      maxAccepted: 86400,
      appliedValue: 10000,
    });
    expect(message).toMatch(/applied the documented default/);
  });

  it('does not leak the raw value into the log payload', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = 'super-secret-not-a-number';
    require('./cache');

    const serialised = JSON.stringify(mockLogger.warn.mock.calls);
    expect(serialised).not.toContain('super-secret-not-a-number');
  });

  it('logs no fallback at all when the configuration is valid', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = '30';
    const { getCacheConfigFallbacks } = require('./cache');

    expect(getCacheConfigFallbacks()).toEqual([]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // ── dependency failure ───────────────────────────────────────────────────

  it('loads configuration even when the logger dependency throws', () => {
    jest.resetModules();
    jest.doMock('../logger', () => {
      throw new Error('logger dependency unavailable');
    });
    process.env.INDEXER_CACHE_TTL_SECONDS = 'abc';

    let cacheModule;
    expect(() => {
      cacheModule = require('./cache');
    }).not.toThrow();

    expect(cacheModule.parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: 'abc' }).indexerTtl).toBe(10000);
    expect(cacheModule.getCacheConfigFallbacks()).toHaveLength(1);
    expect(cacheModule.getCacheConfig().indexerTtl).toBe(10000);
  });

  it('loads configuration when the logger throws while writing', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = 'abc';
    mockLogger.warn.mockImplementation(() => {
      throw new Error('log sink unavailable');
    });

    let cacheModule;
    expect(() => {
      cacheModule = require('./cache');
    }).not.toThrow();

    expect(cacheModule.getCacheConfig().indexerTtl).toBe(10000);
    expect(cacheModule.getCacheConfigFallbacks()).toHaveLength(1);
  });

  it('loads configuration when the logger export has no warn method', () => {
    jest.resetModules();
    jest.doMock('../logger', () => ({}));

    let cacheModule;
    expect(() => {
      cacheModule = require('./cache');
    }).not.toThrow();

    expect(cacheModule.getCacheConfig().escrowTtl).toBe(30000);
  });

  // ── retry, reload, atomic publication ────────────────────────────────────

  it('starts from the defaults and reflects the live environment', () => {
    const { cacheConfig, getCacheConfig, reloadCacheConfig } = require('./cache');

    expect(getCacheConfig()).toBe(cacheConfig);

    process.env.INDEXER_CACHE_TTL_SECONDS = '4';
    const reloaded = reloadCacheConfig();

    expect(reloaded.indexerTtl).toBe(4000);
    expect(getCacheConfig().indexerTtl).toBe(4000);
    // The load-time binding is intentionally a snapshot.
    expect(cacheConfig.indexerTtl).toBe(10000);
  });

  it('converges on the corrected values when a retry follows a bad value', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = 'abc';
    const { getCacheConfig, getCacheConfigFallbacks, reloadCacheConfig } = require('./cache');

    expect(getCacheConfig().indexerTtl).toBe(10000);
    expect(getCacheConfigFallbacks()).toHaveLength(1);

    process.env.INDEXER_CACHE_TTL_SECONDS = '8';
    reloadCacheConfig();

    expect(getCacheConfig().indexerTtl).toBe(8000);
    expect(getCacheConfigFallbacks()).toEqual([]);
  });

  it('recovers when a retry is itself given an unusable env source', () => {
    const { getCacheConfig, reloadCacheConfig } = require('./cache');
    const before = getCacheConfig();

    const after = reloadCacheConfig(null);

    expect(after).toEqual(before);
    expect(after).not.toBe(before);
    expect(getCacheConfig()).toEqual(before);
  });

  it('does not log the same failure twice across retries', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = 'abc';
    const { reloadCacheConfig } = require('./cache');

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    reloadCacheConfig();
    reloadCacheConfig();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('reports a newly broken variable even if another was already reported', () => {
    process.env.INDEXER_CACHE_TTL_SECONDS = 'abc';
    const { reloadCacheConfig } = require('./cache');
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    process.env.INDEXER_CACHE_MAX_ENTRIES = '0';
    reloadCacheConfig();

    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn.mock.calls[1][0].variable).toBe('INDEXER_CACHE_MAX_ENTRIES');
  });

  it('never mutates a previously published configuration', () => {
    const { getCacheConfig, reloadCacheConfig } = require('./cache');

    const before = getCacheConfig();
    expect(Object.isFrozen(before)).toBe(true);
    const snapshot = { ...before };

    process.env.ESCROW_CACHE_TTL_SECONDS = '99';
    reloadCacheConfig();

    // The old reference a concurrent reader may still hold is unchanged and
    // still internally complete, so it can never be observed half-applied.
    expect(before).toEqual(snapshot);
    expect(getCacheConfig().escrowTtl).toBe(99000);
  });

  it('publishes only complete, frozen configurations under interleaved reloads', async () => {
    const { getCacheConfig, reloadCacheConfig } = require('./cache');

    const allDefault = { ...getCacheConfig() };
    const allMin = {
      escrowTtl: 1000,
      escrowMaxEntries: 1,
      indexerTtl: 1000,
      indexerMaxEntries: 1,
      invoiceStateTtl: 1000,
      invoiceStateMaxEntries: 1,
    };
    const minEnv = {
      ESCROW_CACHE_TTL_SECONDS: '1',
      ESCROW_CACHE_MAX_ENTRIES: '1',
      INDEXER_CACHE_TTL_SECONDS: '1',
      INDEXER_CACHE_MAX_ENTRIES: '1',
      INVOICE_STATE_CACHE_TTL_SECONDS: '1',
      INVOICE_STATE_CACHE_MAX_ENTRIES: '1',
    };

    // Alternate between two internally consistent generations. Every value a
    // reader can observe must belong wholly to one of them: never a mix of the
    // old and the new configuration.
    const observed = [];
    const reloads = [{}, minEnv, {}, minEnv].map((env) =>
      Promise.resolve().then(() => {
        reloadCacheConfig(env);
        observed.push({ ...getCacheConfig() });
      }),
    );

    await Promise.all(reloads);

    expect(observed.length).toBe(4);
    for (const config of observed) {
      expect([allDefault, allMin]).toContainEqual(config);
    }
  });

  // ── immutability ─────────────────────────────────────────────────────────

  it('returns a frozen configuration that callers cannot mutate', () => {
    const { parseCacheConfig } = require('./cache');
    const config = parseCacheConfig({});

    expect(Object.isFrozen(config)).toBe(true);

    // This file is strict mode, so a write to a frozen object throws rather
    // than silently failing: the invariant is enforced, not merely conventional.
    expect(() => {
      config.escrowTtl = 1;
    }).toThrow(TypeError);
    expect(() => {
      config.indexerMaxEntries = 1;
    }).toThrow(TypeError);

    expect(config.escrowTtl).toBe(30000);
    expect(config.indexerMaxEntries).toBe(200);
  });

  it('returns frozen fallback records that callers cannot mutate', () => {
    const { describeCacheConfigFallbacks } = require('./cache');
    const fallbacks = describeCacheConfigFallbacks({ INDEXER_CACHE_TTL_SECONDS: 'abc' });

    expect(Object.isFrozen(fallbacks)).toBe(true);
    expect(Object.isFrozen(fallbacks[0])).toBe(true);

    expect(() => {
      fallbacks[0].resolved = -1;
    }).toThrow(TypeError);
    expect(() => {
      fallbacks.push({});
    }).toThrow(TypeError);

    expect(fallbacks[0].resolved).toBe(10000);
    expect(fallbacks).toHaveLength(1);
  });

  // ── exported constants stay consistent with behaviour ────────────────────

  it('exports defaults and limits that match what parsing applies', () => {
    const { parseCacheConfig, DEFAULT_INDEXER_TTL_SECONDS, DEFAULT_INDEXER_MAX_ENTRIES } =
      require('./cache');
    const config = parseCacheConfig({});

    expect(DEFAULT_INDEXER_TTL_SECONDS * 1000).toBe(config.indexerTtl);
    expect(DEFAULT_INDEXER_MAX_ENTRIES).toBe(config.indexerMaxEntries);
  });

  it('keeps the legacy DEFAULT_ESCROW_MAX_ENTRIES export intact', () => {
    const { DEFAULT_ESCROW_MAX_ENTRIES, parseCacheConfig } = require('./cache');

    expect(DEFAULT_ESCROW_MAX_ENTRIES).toBe(500);
    expect(parseCacheConfig({}).escrowMaxEntries).toBe(DEFAULT_ESCROW_MAX_ENTRIES);
  });

  // ── compatibility contract: frozen public surface ────────────────────────

  describe('compatibility contract', () => {
    // Sorted `Object.keys(module.exports)`. Additive changes append here; any
    // removal or rename must come with a migration note in the module docs.
    const FROZEN_EXPORTS = [
      'CACHE_CONFIG_FALLBACK_REASON',
      'CACHE_CONFIG_FIELDS',
      'CACHE_CONFIG_LIMITS',
      'DEFAULT_ESCROW_MAX_ENTRIES',
      'DEFAULT_ESCROW_TTL_SECONDS',
      'DEFAULT_INDEXER_MAX_ENTRIES',
      'DEFAULT_INDEXER_TTL_SECONDS',
      'DEFAULT_INVOICE_STATE_MAX_ENTRIES',
      'DEFAULT_INVOICE_STATE_TTL_SECONDS',
      '_resetCacheConfigForTests',
      '_resetLoggerForTests',
      'cacheConfig',
      'describeCacheConfigFallbacks',
      'getCacheConfig',
      'getCacheConfigFallbacks',
      'parseCacheConfig',
      'reloadCacheConfig',
    ];

    const EXPECTED_DEFAULTS = {
      escrowTtl: 30000,
      escrowMaxEntries: 500,
      indexerTtl: 10000,
      indexerMaxEntries: 200,
      invoiceStateTtl: 30000,
      invoiceStateMaxEntries: 500,
    };

    const EXPECTED_TYPES = {
      CACHE_CONFIG_FALLBACK_REASON: 'object',
      CACHE_CONFIG_FIELDS: 'object',
      CACHE_CONFIG_LIMITS: 'object',
      DEFAULT_ESCROW_MAX_ENTRIES: 'number',
      DEFAULT_ESCROW_TTL_SECONDS: 'number',
      DEFAULT_INDEXER_MAX_ENTRIES: 'number',
      DEFAULT_INDEXER_TTL_SECONDS: 'number',
      DEFAULT_INVOICE_STATE_MAX_ENTRIES: 'number',
      DEFAULT_INVOICE_STATE_TTL_SECONDS: 'number',
      _resetCacheConfigForTests: 'function',
      _resetLoggerForTests: 'function',
      cacheConfig: 'object',
      describeCacheConfigFallbacks: 'function',
      getCacheConfig: 'function',
      getCacheConfigFallbacks: 'function',
      parseCacheConfig: 'function',
      reloadCacheConfig: 'function',
    };

    it('exposes exactly the documented set of exports, sorted', () => {
      expect(Object.keys(require('./cache')).sort()).toEqual(FROZEN_EXPORTS);
    });

    it('never removes, renames, or retypes an export across a reload', () => {
      const cacheModule = require('./cache');
      const before = Object.keys(cacheModule).sort();

      cacheModule.reloadCacheConfig({});

      const after = Object.keys(cacheModule).sort();
      expect(after).toEqual(before);
      expect(after).toEqual(FROZEN_EXPORTS);
    });

    it('exposes each documented export with its documented type', () => {
      const cacheModule = require('./cache');

      for (const name of FROZEN_EXPORTS) {
        expect(typeof cacheModule[name]).toBe(EXPECTED_TYPES[name]);
      }
    });

    it('keeps the documented shape of the machine-readable exports', () => {
      const { CACHE_CONFIG_FIELDS, CACHE_CONFIG_LIMITS, CACHE_CONFIG_FALLBACK_REASON } =
        require('./cache');

      expect(Object.isFrozen(CACHE_CONFIG_FIELDS)).toBe(true);
      expect(Array.isArray(CACHE_CONFIG_FIELDS)).toBe(true);
      for (const field of CACHE_CONFIG_FIELDS) {
        expect(Object.isFrozen(field)).toBe(true);
        expect(Object.keys(field).sort()).toEqual([
          'defaultValue',
          'key',
          'max',
          'min',
          'scale',
          'variable',
        ]);
      }

      expect(CACHE_CONFIG_LIMITS).toEqual({
        ttlSeconds: { min: 1, max: 86400 },
        maxEntries: { min: 1, max: 100000 },
      });
      expect(Object.isFrozen(CACHE_CONFIG_LIMITS)).toBe(true);
      expect(Object.isFrozen(CACHE_CONFIG_LIMITS.ttlSeconds)).toBe(true);
      expect(Object.isFrozen(CACHE_CONFIG_LIMITS.maxEntries)).toBe(true);

      expect(CACHE_CONFIG_FALLBACK_REASON).toEqual({
        UNREADABLE_ENV: 'unreadable_env',
        NOT_A_STRING: 'not_a_string',
        NOT_AN_INTEGER: 'not_an_integer',
        NOT_FINITE: 'not_finite',
        NOT_POSITIVE: 'not_positive',
        OUT_OF_RANGE: 'out_of_range',
      });
      expect(Object.isFrozen(CACHE_CONFIG_FALLBACK_REASON)).toBe(true);
    });

    it('supports the destructuring consumers rely on at import time', () => {
      const {
        cacheConfig,
        parseCacheConfig,
        describeCacheConfigFallbacks,
        getCacheConfig,
        getCacheConfigFallbacks,
        reloadCacheConfig,
      } = require('./cache');

      expect(typeof parseCacheConfig).toBe('function');
      expect(typeof describeCacheConfigFallbacks).toBe('function');
      expect(typeof getCacheConfig).toBe('function');
      expect(typeof getCacheConfigFallbacks).toBe('function');
      expect(typeof reloadCacheConfig).toBe('function');

      // `cacheConfig` is the load-time snapshot callers destructure; its shape
      // is part of the contract.
      expect(Object.keys(cacheConfig).sort()).toEqual([
        'escrowMaxEntries',
        'escrowTtl',
        'indexerMaxEntries',
        'indexerTtl',
        'invoiceStateMaxEntries',
        'invoiceStateTtl',
      ]);
      expect(parseCacheConfig({})).toEqual(EXPECTED_DEFAULTS);
      expect(getCacheConfig()).toEqual(EXPECTED_DEFAULTS);
      expect(getCacheConfigFallbacks()).toEqual([]);
    });

    it('yields the documented defaults for an empty or absent environment', () => {
      const { parseCacheConfig } = require('./cache');

      expect(parseCacheConfig({})).toEqual(EXPECTED_DEFAULTS);
      expect(parseCacheConfig(Object.create(null))).toEqual(EXPECTED_DEFAULTS);

      // An absent source falls back to `process.env`; with our variables
      // cleared that is still the documented default set.
      for (const key of Object.keys(process.env)) {
        if (/_CACHE_(TTL_SECONDS|MAX_ENTRIES)$/.test(key)) {
          delete process.env[key];
        }
      }
      expect(parseCacheConfig()).toEqual(EXPECTED_DEFAULTS);
    });

    it('does not throw on a malformed or unusable env source and keeps defaults', () => {
      const { parseCacheConfig } = require('./cache');

      for (const source of [null, 'not-an-env', 42, true, Symbol('env'), []]) {
        expect(() => parseCacheConfig(source)).not.toThrow();
        expect(parseCacheConfig(source)).toEqual(EXPECTED_DEFAULTS);
      }
    });

    it('never throws on load or repeated reload, whatever the environment', () => {
      const previous = process.env;
      try {
        process.env = {
          ...previous,
          ESCROW_CACHE_TTL_SECONDS: 'not-a-number',
          INDEXER_CACHE_MAX_ENTRIES: Number.POSITIVE_INFINITY,
          INVOICE_STATE_CACHE_TTL_SECONDS: {},
        };

        jest.isolateModules(() => {
          let cacheModule;
          expect(() => {
            cacheModule = require('./cache');
          }).not.toThrow();

          expect(() => {
            for (let i = 0; i < 5; i += 1) {
              cacheModule.reloadCacheConfig(process.env);
            }
          }).not.toThrow();

          expect(Object.keys(cacheModule).sort()).toEqual(FROZEN_EXPORTS);
          for (const value of Object.values(cacheModule.getCacheConfig())) {
            expect(Number.isSafeInteger(value) && value > 0).toBe(true);
          }
        });
      } finally {
        process.env = previous;
      }
    });
  });
});
