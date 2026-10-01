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

  // ── regression: pre-existing contract ────────────────────────────────────

  it('uses default TTL of 30000ms when env var is not set', () => {
    delete process.env.ESCROW_CACHE_TTL_SECONDS;
    const { cacheConfig } = require('./cache');
    expect(cacheConfig.escrowTtl).toBe(30000);
    expect(cacheConfig.escrowMaxEntries).toBe(500);
  });

  it('parses ESCROW_CACHE_MAX_ENTRIES', () => {
    process.env.ESCROW_CACHE_MAX_ENTRIES = '25';
    const { cacheConfig } = require('./cache');
    expect(cacheConfig.escrowMaxEntries).toBe(25);
  });

  it('parses ESCROW_CACHE_TTL_SECONDS from env and converts to ms', () => {
    process.env.ESCROW_CACHE_TTL_SECONDS = '60';
    const { cacheConfig } = require('./cache');
    expect(cacheConfig.escrowTtl).toBe(60000);
  });

  it('falls back to default when env var is not a valid number', () => {
    process.env.ESCROW_CACHE_TTL_SECONDS = 'abc';
    const { cacheConfig } = require('./cache');
    expect(cacheConfig.escrowTtl).toBe(30000);
    expect(process.emitWarning).toHaveBeenCalledWith(
      'Invalid ESCROW_CACHE_TTL_SECONDS; using default 30',
      { code: 'CACHE_CONFIG_INVALID_VALUE' },
    );
  });

  const settings = [
    ['ESCROW_CACHE_TTL_SECONDS', 'escrowTtl', 30000, 1000],
    ['ESCROW_CACHE_MAX_ENTRIES', 'escrowMaxEntries', 500, 1],
    ['INVOICE_STATE_CACHE_TTL_SECONDS', 'invoiceStateTtl', 30000, 1000],
    ['INVOICE_STATE_CACHE_MAX_ENTRIES', 'invoiceStateMaxEntries', 500, 1],
    ['INDEXER_CACHE_TTL_SECONDS', 'indexerTtl', 10000, 1000],
    ['INDEXER_CACHE_MAX_ENTRIES', 'indexerMaxEntries', 200, 1],
  ];

  describe.each(settings)('%s invariants', (field, property, fallback, multiplier) => {
    it.each(['2', ' 002 ', 2])('accepts complete positive integers: %j', (value) => {
      const { parseCacheConfig } = require('./cache');
      expect(parseCacheConfig({ [field]: value })[property]).toBe(2 * multiplier);
    });

    it.each([
      '0',
      '-1',
      '1.5',
      '1e3',
      '0x10',
      '30seconds',
      '',
      ' ',
      'Infinity',
      '9007199254740992',
      null,
      false,
      ['2'],
      {},
      0,
      -1,
      1.5,
      NaN,
      Infinity,
    ])('rejects malformed or unsafe input as a whole: %j', (value) => {
      const { parseCacheConfig } = require('./cache');
      const onInvalid = jest.fn();
      const snapshot = parseCacheConfig({ [field]: value }, { onInvalid });
      expect(snapshot[property]).toBe(fallback);
      expect(onInvalid).toHaveBeenCalledWith(field, fallback / multiplier);
      for (const numeric of Object.values(snapshot)) {
        expect(Number.isSafeInteger(numeric) && numeric > 0).toBe(true);
      }
    });

    it('uses defaults for missing and inherited values without invoking getters', () => {
      const { parseCacheConfig } = require('./cache');
      const getter = jest.fn(() => '2');
      const env = Object.create({ [field]: '2' });
      expect(parseCacheConfig(env)[property]).toBe(fallback);
      Object.defineProperty(env, field, { get: getter });
      expect(parseCacheConfig(env)[property]).toBe(fallback);
      expect(getter).not.toHaveBeenCalled();
      expect(parseCacheConfig({ [field]: undefined })[property]).toBe(fallback);
    });

    it('accepts its upper bound and rejects the next value', () => {
      const { parseCacheConfig } = require('./cache');
      const max = multiplier === 1000 ? Math.floor(0x7fffffff / 1000) : Number.MAX_SAFE_INTEGER;
      expect(parseCacheConfig({ [field]: String(max) })[property]).toBe(max * multiplier);
      expect(parseCacheConfig({ [field]: String(max + 1) })[property]).toBe(fallback);
    });
  });

  it('does not coerce objects or alter the supplied environment', () => {
    const { parseCacheConfig } = require('./cache');
    const toString = jest.fn(() => '2');
    const env = Object.freeze({ ESCROW_CACHE_TTL_SECONDS: { toString } });
    expect(parseCacheConfig(env).escrowTtl).toBe(30000);
    expect(toString).not.toHaveBeenCalled();
    expect(env.ESCROW_CACHE_TTL_SECONDS.toString).toBe(toString);
  });

  it.each([null, false, 2, '2', []])('rejects an invalid environment map: %j', (env) => {
    const { parseCacheConfig } = require('./cache');
    expect(() => parseCacheConfig(env)).toThrow('Cache environment must be an object');
  });

  it('validates the diagnostics sink and preserves shared state if it throws', () => {
    const { parseCacheConfig, cacheConfig } = require('./cache');
    const before = { ...cacheConfig };
    expect(() => parseCacheConfig({}, { onInvalid: true })).toThrow(TypeError);
    expect(() =>
      parseCacheConfig(
        { INDEXER_CACHE_TTL_SECONDS: 'bad' },
        {
          onInvalid: () => {
            throw new Error('diagnostic unavailable');
          },
        },
      ),
    ).toThrow('diagnostic unavailable');
    expect(cacheConfig).toEqual(before);
    expect(parseCacheConfig({}).indexerTtl).toBe(10000);
  });

  it('keeps snapshots immutable and independent through repeated and interleaved calls', async () => {
    const { parseCacheConfig, cacheConfig } = require('./cache');
    const env = { ESCROW_CACHE_MAX_ENTRIES: '2' };
    const first = parseCacheConfig(env);
    expect(() => {
      first.escrowMaxEntries = 0;
    }).toThrow(TypeError);
    expect(() => {
      cacheConfig.indexerMaxEntries = 0;
    }).toThrow(TypeError);
    env.ESCROW_CACHE_MAX_ENTRIES = '3';
    const snapshots = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => parseCacheConfig(env))),
    );
    expect(first.escrowMaxEntries).toBe(2);
    for (const snapshot of snapshots) {
      expect(snapshot.escrowMaxEntries).toBe(3);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(snapshot).not.toBe(first);
    }
    expect(parseCacheConfig(env)).toEqual(snapshots[0]);
    expect(cacheConfig.indexerMaxEntries).toBe(200);
  });

  it('reports only allowlisted names and defaults, without exposing raw values', () => {
    const { parseCacheConfig } = require('./cache');
    const onInvalid = jest.fn();
    parseCacheConfig(
      { ESCROW_CACHE_TTL_SECONDS: 'token-private-value', PRIVATE_TOKEN: 'secret' },
      { onInvalid },
    );
    expect(onInvalid.mock.calls).toEqual([['ESCROW_CACHE_TTL_SECONDS', 30]]);
  });

  it('warns once at module load and keeps subsequent default parses silent', () => {
    process.env.INDEXER_CACHE_MAX_ENTRIES = 'bad-sensitive-value';
    const { cacheConfig, parseCacheConfig } = require('./cache');
    expect(cacheConfig.indexerMaxEntries).toBe(200);
    const calls = process.emitWarning.mock.calls.length;
    parseCacheConfig();
    parseCacheConfig();
    expect(process.emitWarning).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(process.emitWarning.mock.calls)).not.toContain('bad-sensitive-value');
  });

  // ─── Input Validation ───────────────────────────────────────────────────

  describe('input validation', () => {
    it('handles null env var values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = null;
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(30000);
    });

    it('handles undefined env var values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = undefined;
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(30000);
    });

    it('handles empty string env var values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = '';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(30000);
    });

    it('handles NaN values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = 'NaN';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(30000);
    });

    it('handles Infinity values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = 'Infinity';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(30000);
    });

    it('handles negative values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = '-10';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(1000); // Clamped to MIN_TTL_SECONDS
    });

    it('handles zero values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = '0';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(1000); // Clamped to MIN_TTL_SECONDS
    });

    it('handles floating point values (parses as int)', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = '45.7';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(45700); // parseInt truncates
    });

    it('handles scientific notation', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = '1e2';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(100000);
    });
  });

  // ─── Bounds Checking ─────────────────────────────────────────────────────

  describe('bounds checking', () => {
    it('clamps TTL to MIN_TTL_SECONDS when too low', () => {
      const { parseCacheConfig, MIN_TTL_SECONDS } = require('./cache');
      const config = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: '0' });
      expect(config.escrowTtl).toBe(MIN_TTL_SECONDS * 1000);
    });

    it('clamps TTL to MAX_TTL_SECONDS when too high', () => {
      const { parseCacheConfig, MAX_TTL_SECONDS } = require('./cache');
      const config = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: '99999' });
      expect(config.escrowTtl).toBe(MAX_TTL_SECONDS * 1000);
    });

    it('clamps maxEntries to MIN_MAX_ENTRIES when too low', () => {
      const { parseCacheConfig, MIN_MAX_ENTRIES } = require('./cache');
      const config = parseCacheConfig({ ESCROW_CACHE_MAX_ENTRIES: '0' });
      expect(config.escrowMaxEntries).toBe(MIN_MAX_ENTRIES);
    });

    it('clamps maxEntries to MAX_MAX_ENTRIES when too high', () => {
      const { parseCacheConfig, MAX_MAX_ENTRIES } = require('./cache');
      const config = parseCacheConfig({ ESCROW_CACHE_MAX_ENTRIES: '99999' });
      expect(config.escrowMaxEntries).toBe(MAX_MAX_ENTRIES);
    });

    it('accepts values at exact boundaries', () => {
      const { parseCacheConfig, MIN_TTL_SECONDS, MAX_TTL_SECONDS } = require('./cache');
      const config = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: String(MIN_TTL_SECONDS) });
      expect(config.escrowTtl).toBe(MIN_TTL_SECONDS * 1000);

      const config2 = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: String(MAX_TTL_SECONDS) });
      expect(config2.escrowTtl).toBe(MAX_TTL_SECONDS * 1000);
    });
  });

  // ─── Invoice State Cache Config ────────────────────────────────────────

  describe('invoice state cache config', () => {
    it('parses INVOICE_STATE_CACHE_TTL_SECONDS', () => {
      process.env.INVOICE_STATE_CACHE_TTL_SECONDS = '45';
      const { cacheConfig } = require('./cache');
      expect(cacheConfig.invoiceStateTtl).toBe(45000);
    });

    it('parses INVOICE_STATE_CACHE_MAX_ENTRIES', () => {
      process.env.INVOICE_STATE_CACHE_MAX_ENTRIES = '100';
      const { cacheConfig } = require('./cache');
      expect(cacheConfig.invoiceStateMaxEntries).toBe(100);
    });

    it('clamps invoice state TTL to bounds', () => {
      const { parseCacheConfig, MIN_TTL_SECONDS, MAX_TTL_SECONDS } = require('./cache');
      const config = parseCacheConfig({ INVOICE_STATE_CACHE_TTL_SECONDS: '0' });
      expect(config.invoiceStateTtl).toBe(MIN_TTL_SECONDS * 1000);

      const config2 = parseCacheConfig({ INVOICE_STATE_CACHE_TTL_SECONDS: '99999' });
      expect(config2.invoiceStateTtl).toBe(MAX_TTL_SECONDS * 1000);
    });
  });

  // ─── Indexer Cache Config ───────────────────────────────────────────────

  describe('indexer cache config', () => {
    it('parses INDEXER_CACHE_TTL_SECONDS', () => {
      process.env.INDEXER_CACHE_TTL_SECONDS = '15';
      const { cacheConfig } = require('./cache');
      expect(cacheConfig.indexerTtl).toBe(15000);
    });

    it('parses INDEXER_CACHE_MAX_ENTRIES', () => {
      process.env.INDEXER_CACHE_MAX_ENTRIES = '50';
      const { cacheConfig } = require('./cache');
      expect(cacheConfig.indexerMaxEntries).toBe(50);
    });

    it('clamps indexer TTL to bounds', () => {
      const { parseCacheConfig, MIN_TTL_SECONDS, MAX_TTL_SECONDS } = require('./cache');
      const config = parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: '0' });
      expect(config.indexerTtl).toBe(MIN_TTL_SECONDS * 1000);

      const config2 = parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: '99999' });
      expect(config2.indexerTtl).toBe(MAX_TTL_SECONDS * 1000);
    });
  });

  // ─── Boundary Cases ─────────────────────────────────────────────────────

  describe('boundary cases', () => {
    it('handles very large valid numbers', () => {
      const { parseCacheConfig, MAX_TTL_SECONDS } = require('./cache');
      const config = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: String(MAX_TTL_SECONDS) });
      expect(config.escrowTtl).toBe(MAX_TTL_SECONDS * 1000);
    });

    it('handles very small valid numbers', () => {
      const { parseCacheConfig, MIN_TTL_SECONDS } = require('./cache');
      const config = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: String(MIN_TTL_SECONDS) });
      expect(config.escrowTtl).toBe(MIN_TTL_SECONDS * 1000);
    });

    it('handles whitespace in values', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = '  60  ';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      expect(config.escrowTtl).toBe(60000);
    });

    it('handles hexadecimal strings (parses as 0)', () => {
      process.env.ESCROW_CACHE_TTL_SECONDS = '0x10';
      const { parseCacheConfig } = require('./cache');
      const config = parseCacheConfig();
      // parseInt with radix 10 will parse '0x10' as 0
      expect(config.escrowTtl).toBe(1000); // Falls back to MIN_TTL_SECONDS
    });
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
});
