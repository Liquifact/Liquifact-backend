'use strict';

/**
 * @file src/db/resolveConfig.test.js
 *
 * Focused state-invariant suite for `src/db/resolveConfig.js` (issue #1338).
 *
 * These tests pin the invariants documented in the module header:
 *  1. public export shape (`module.exports = resolveConfig`);
 *  2. `normaliseEnvironment` boundary cases;
 *  3. deterministic resolution for valid environments;
 *  4. safe defaults (and no throws) for missing/empty/malformed input;
 *  5. purity — no mutation of `process.env` or the shared knexfile blocks.
 *
 * The suite deliberately uses the REAL `knexfile.js` so the
 * missing/empty/malformed assertions exercise a development fallback.
 * Isolation guards (test/production never fall back) additionally use
 * `jest.isolateModules` + `jest.doMock` for a synthetic knexfile.
 */

const resolveConfig = require('./resolveConfig');

// ---------------------------------------------------------------------------
// Invariant 1: public export shape
// ---------------------------------------------------------------------------
describe('resolveConfig — public export shape', () => {
  it('exports the bare function (module.exports = resolveConfig)', () => {
    expect(typeof resolveConfig).toBe('function');
  });

  it('attaches normaliseEnvironment as a static property', () => {
    expect(typeof resolveConfig.normaliseEnvironment).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: environment normalisation edge cases
// ---------------------------------------------------------------------------
describe('normaliseEnvironment — edge cases', () => {
  const normalise = resolveConfig.normaliseEnvironment;

  it.each([
    ['test', 'test'],
    ['TEST', 'test'],
    ['  Test  ', 'test'],
    ['production', 'production'],
    ['PRODUCTION ', 'production'],
    ['\tStaging\n', 'staging'],
    ['', ''],
    ['   ', ''],
  ])('trims and lowercases %p to %p', (input, expected) => {
    expect(normalise(input)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['zero', 0],
    ['a boolean', true],
    ['an object', {}],
    ['an array', []],
    ['a function', () => {}],
  ])('maps %s to the empty string (no TypeError)', (_label, input) => {
    expect(normalise(input)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Invariant 3: deterministic resolution for valid environments
// ---------------------------------------------------------------------------
describe('resolveConfig — deterministic resolution for valid env', () => {
  it('returns the isolated test block for "test"', () => {
    expect(resolveConfig('test').client).toBe('better-sqlite3');
  });

  it('returns the development block for "development"', () => {
    expect(resolveConfig('development').client).toBe('sqlite3');
  });

  it('is idempotent: identical input yields the identical reference', () => {
    expect(resolveConfig('test')).toBe(resolveConfig('test'));
    expect(resolveConfig('development')).toBe(resolveConfig('development'));
  });

  it('normalises case and whitespace before lookup', () => {
    expect(resolveConfig('  TEST  ')).toBe(resolveConfig('test'));
    expect(resolveConfig('Development')).toBe(resolveConfig('development'));
  });

  it('falls back to development for a recognised-but-absent env', () => {
    expect(resolveConfig('staging')).toBe(resolveConfig('development'));
  });

  it('is order-independent (no state leakage between calls)', () => {
    const first = resolveConfig('test');
    resolveConfig('staging');
    resolveConfig('development');
    expect(resolveConfig('test')).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: safe defaults for missing/empty/malformed env (never throws)
// ---------------------------------------------------------------------------
describe('resolveConfig — safe defaults for missing/empty/malformed env', () => {
  const development = resolveConfig('development');

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a number', 42],
    ['a boolean', true],
    ['an object', {}],
    ['an array', []],
  ])('returns the development fallback for %s without throwing', (_label, input) => {
    let result;
    expect(() => {
      result = resolveConfig(input);
    }).not.toThrow();
    expect(result).toBe(development);
  });

  it('returns the development fallback when called with no argument', () => {
    expect(() => resolveConfig()).not.toThrow();
    expect(resolveConfig()).toBe(development);
  });
});

// ---------------------------------------------------------------------------
// Invariant 5: purity — no mutation of process.env or shared config blocks
// ---------------------------------------------------------------------------
describe('resolveConfig — purity and non-mutation', () => {
  it('returns deep-equal output for identical valid input', () => {
    expect(resolveConfig('test')).toEqual(resolveConfig('test'));
    expect(resolveConfig('development')).toEqual(resolveConfig('development'));
  });

  it('does not mutate process.env', () => {
    const before = { ...process.env };

    resolveConfig('test');
    resolveConfig('development');
    resolveConfig('staging');
    resolveConfig(undefined);

    expect(process.env).toEqual(before);
  });

  it('does not mutate the shared knexfile config blocks', () => {
    const config = resolveConfig('development');
    const snapshot = JSON.stringify(config);

    resolveConfig('development');
    resolveConfig('staging');
    resolveConfig(undefined);

    expect(JSON.stringify(config)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Isolation guards: throw only when a safe block genuinely cannot be resolved
// ---------------------------------------------------------------------------
describe('resolveConfig — isolation invariants', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../knexfile');
  });

  it('throws instead of falling back when the test block is absent', () => {
    jest.isolateModules(() => {
      jest.doMock('../../knexfile', () => ({
        development: { client: 'sqlite3', connection: { filename: './db.sqlite3' } },
      }));
      const rc = require('../../src/db/resolveConfig');
      expect(() => rc('test')).toThrow(/No "test" config block/);
    });
  });

  it('throws when an unknown env has no development fallback', () => {
    jest.isolateModules(() => {
      jest.doMock('../../knexfile', () => ({
        test: { client: 'better-sqlite3', connection: { filename: ':memory:' } },
      }));
      const rc = require('../../src/db/resolveConfig');
      expect(() => rc('staging')).toThrow(/No config block found for NODE_ENV="staging"/);
    });
  });

  it('requires DATABASE_URL in production (never falls back to SQLite)', () => {
    jest.isolateModules(() => {
      const saved = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      jest.doMock('../../knexfile', () => ({
        production: { client: 'pg', connection: 'postgres://localhost/prod' },
      }));
      try {
        const rc = require('../../src/db/resolveConfig');
        expect(() => rc('production')).toThrow(/DATABASE_URL must be set/);
      } finally {
        if (saved !== undefined) {
          process.env.DATABASE_URL = saved;
        }
      }
    });
  });

  it('only ever throws Error instances with actionable messages', () => {
    jest.isolateModules(() => {
      jest.doMock('../../knexfile', () => ({
        development: { client: 'sqlite3', connection: { filename: './db.sqlite3' } },
      }));
      const rc = require('../../src/db/resolveConfig');

      let caught;
      try {
        rc('test');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/test/);
    });
  });
});
