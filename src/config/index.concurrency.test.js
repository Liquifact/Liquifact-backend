'use strict';

/**
 * @fileoverview Concurrency and repeated-execution regression tests for the
 * centralized config module (issue #1305).
 *
 * These tests pin the documented invariants of `src/config/index.js`:
 *  - validation parses an atomic point-in-time copy of `process.env`
 *  - published snapshots are immutable and never partially built
 *  - repeated validation of an unchanged env is a no-op (single publication)
 *  - a failed re-validation never clobbers the last known-good snapshot, and
 *    the staleness is observable
 *  - a re-entrant `validate()` cannot start a competing parse
 *  - concurrent readers always observe a complete, consistent snapshot
 */

const SECRET = '0123456789abcdef0123456789abcdef';

/** Env keys these tests touch, captured once so they can be restored exactly. */
const MANAGED_KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'PORT',
  'SOROBAN_BATCH_CONCURRENCY',
  'INVOICE_FILE_MAX_SIZE',
  'PUBLIC_API_BASE_URL',
  'KYC_PROVIDER_URL',
  'KYC_PROVIDER_API_KEY',
];

const baselineEnv = {};
for (const key of MANAGED_KEYS) {
  baselineEnv[key] = process.env[key];
}

/** Restores only the keys these tests mutate, leaving the rest of env intact. */
function restoreEnv() {
  for (const key of MANAGED_KEYS) {
    if (baselineEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baselineEnv[key];
    }
  }
}

/** Applies a valid baseline environment for the tests below. */
function applyValidEnv() {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = SECRET;
  delete process.env.PORT;
  delete process.env.SOROBAN_BATCH_CONCURRENCY;
  delete process.env.PUBLIC_API_BASE_URL;
  delete process.env.KYC_PROVIDER_URL;
  delete process.env.KYC_PROVIDER_API_KEY;
}

/**
 * Loads a fresh, unvalidated module instance so each test starts from a clean
 * snapshot state without leaking a publication into the next test.
 * @returns {typeof import('./index')} Isolated config module instance.
 */
function loadConfigModule() {
  let mod;
  jest.isolateModules(() => {
    mod = require('./index');
  });
  return mod;
}

describe('config module concurrency hardening', () => {
  const spies = [];

  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
    while (spies.length) {
      spies.pop().mockRestore();
    }
  });

  describe('atomic validation input', () => {
    test('validates a point-in-time copy of process.env, not the live object', () => {
      const config = loadConfigModule();
      applyValidEnv();
      process.env.PORT = '4101';

      const seenInputs = [];
      const original = config.ConfigSchema.safeParse;
      const spy = jest
        .spyOn(config.ConfigSchema, 'safeParse')
        .mockImplementation((input) => {
          seenInputs.push(input);
          // Simulate the admin runtime-config surface mutating env while
          // validation is running. An implementation that parses live
          // `process.env` would observe the torn value here.
          process.env.PORT = '5999';
          return original.call(config.ConfigSchema, input);
        });
      spies.push(spy);

      const published = config.validate();

      expect(seenInputs).toHaveLength(1);
      expect(seenInputs[0]).not.toBe(process.env);
      expect(seenInputs[0].PORT).toBe('4101');
      expect(published.PORT).toBe(4101);
      // The mutation above is only visible to a *later* validation.
      expect(config.get().PORT).toBe(4101);
      expect(config.validate().PORT).toBe(5999);
    });
  });

  describe('immutable publication', () => {
    test('published snapshots are deeply frozen and shared by identity', () => {
      const config = loadConfigModule();
      applyValidEnv();

      const published = config.validate();

      expect(Object.isFrozen(published)).toBe(true);
      expect(config.get()).toBe(published);
      // Mutating a frozen snapshot in strict mode throws and cannot leak into
      // other consumers.
      expect(() => { published.PORT = 9999; }).toThrow(TypeError);
      expect(config.get().PORT).toBe(3001);
    });

    test('get() rejects reads before validation with a coded error', () => {
      const config = loadConfigModule();

      expect(() => config.get()).toThrow(/validated/i);
      try {
        config.get();
      } catch (err) {
        expect(err.code).toBe('CONFIG_NOT_VALIDATED');
      }
    });
  });

  describe('duplicate work and idempotent repeats', () => {
    test('repeat validation of an unchanged env publishes exactly once', () => {
      const config = loadConfigModule();
      applyValidEnv();

      const first = config.validate();
      const second = config.validate();
      const third = config.validate();

      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(config.getValidationState()).toEqual({
        state: 'valid',
        validated: true,
        stale: false,
        generation: 1,
        hasError: false,
      });
    });

    test('a changed env advances the generation and yields a new snapshot', () => {
      const config = loadConfigModule();
      applyValidEnv();

      const first = config.validate();
      process.env.PORT = '4200';

      const second = config.validate();

      expect(second).not.toBe(first);
      expect(second.PORT).toBe(4200);
      expect(config.get()).toBe(second);
      expect(config.getValidationState().generation).toBe(2);
    });

    test('retrying a failed validation against the same env fails deterministically', () => {
      const config = loadConfigModule();
      applyValidEnv();
      process.env.JWT_SECRET = 'too-short';

      let firstError;
      let secondError;
      try { config.validate(); } catch (err) { firstError = err; }
      try { config.validate(); } catch (err) { secondError = err; }

      expect(firstError).toBeDefined();
      expect(secondError).toBeDefined();
      expect(secondError.issues).toEqual(firstError.issues);
      expect(config.getValidationState().state).toBe('invalid');
      expect(config.getValidationState().validated).toBe(false);
      expect(config.getValidationState().generation).toBe(0);
    });
  });

  describe('failure isolation', () => {
    test('a failed re-validation keeps the last known-good snapshot and flags it stale', () => {
      const config = loadConfigModule();
      applyValidEnv();

      const good = config.validate();
      expect(good.JWT_SECRET).toBe(SECRET);

      process.env.JWT_SECRET = 'too-short';
      expect(() => config.validate()).toThrow();

      // Last known-good config keeps serving; it is never partially replaced.
      expect(config.get()).toBe(good);
      expect(config.get().JWT_SECRET).toBe(SECRET);

      const state = config.getValidationState();
      expect(state.state).toBe('invalid');
      expect(state.validated).toBe(false);
      expect(state.stale).toBe(true);
      expect(state.generation).toBe(1);
      expect(state.hasError).toBe(true);
      expect(config.getValidationError()).toBeDefined();
    });

    test('recovering with a valid env republishes and clears the stale flag', () => {
      const config = loadConfigModule();
      applyValidEnv();
      const good = config.validate();

      process.env.JWT_SECRET = 'too-short';
      expect(() => config.validate()).toThrow();

      process.env.JWT_SECRET = SECRET;
      process.env.PORT = '4300';
      const recovered = config.validate();

      expect(recovered).not.toBe(good);
      expect(recovered.PORT).toBe(4300);
      expect(config.getValidationState()).toEqual({
        state: 'valid',
        validated: true,
        stale: false,
        generation: 2,
        hasError: false,
      });
      expect(config.getValidationError()).toBeNull();
    });
  });

  describe('single-flight re-entrancy guard', () => {
    test('a re-entrant validate() returns the published snapshot without re-parsing', () => {
      const config = loadConfigModule();
      applyValidEnv();
      const published = config.validate();

      process.env.PORT = '4400';

      let nestedResult;
      let parseCalls = 0;
      const original = config.ConfigSchema.safeParse;
      const spy = jest
        .spyOn(config.ConfigSchema, 'safeParse')
        .mockImplementation((input) => {
          parseCalls += 1;
          if (nestedResult === undefined) {
            nestedResult = config.validate();
          }
          return original.call(config.ConfigSchema, input);
        });
      spies.push(spy);

      const next = config.validate();

      expect(parseCalls).toBe(1);
      expect(nestedResult).toBe(published);
      expect(next).not.toBe(published);
      expect(next.PORT).toBe(4400);
      expect(config.getValidationState().generation).toBe(2);
    });

    test('a re-entrant validate() fails fast when nothing is published yet', () => {
      const config = loadConfigModule();
      applyValidEnv();

      let nestedError;
      const original = config.ConfigSchema.safeParse;
      const spy = jest
        .spyOn(config.ConfigSchema, 'safeParse')
        .mockImplementation((input) => {
          if (!nestedError) {
            try {
              config.validate();
            } catch (err) {
              nestedError = err;
            }
          }
          return original.call(config.ConfigSchema, input);
        });
      spies.push(spy);

      // The outer attempt still publishes: the nested failure is contained.
      const published = config.validate();

      expect(nestedError).toBeDefined();
      expect(nestedError.code).toBe('CONFIG_VALIDATION_IN_PROGRESS');
      expect(published.PORT).toBe(3001);
      expect(config.getValidationState().state).toBe('valid');
    });
  });

  describe('concurrent readers', () => {
    test('racing readers never observe a torn snapshot across re-validations', async () => {
      const config = loadConfigModule();
      applyValidEnv();

      const generations = [
        { PORT: '4501', SOROBAN_BATCH_CONCURRENCY: '1' },
        { PORT: '4502', SOROBAN_BATCH_CONCURRENCY: '2' },
        { PORT: '4503', SOROBAN_BATCH_CONCURRENCY: '3' },
      ];
      const validPairs = new Set(
        generations.map((gen) => `${gen.PORT}:${gen.SOROBAN_BATCH_CONCURRENCY}`)
      );

      const observations = [];

      for (const gen of generations) {
        process.env.PORT = gen.PORT;
        process.env.SOROBAN_BATCH_CONCURRENCY = gen.SOROBAN_BATCH_CONCURRENCY;
        config.validate();

        // 25 readers scheduled concurrently against the just-published snapshot.
        const readers = Array.from({ length: 25 }, () =>
          Promise.resolve().then(() => {
            const snap = config.get();
            observations.push(`${snap.PORT}:${snap.SOROBAN_BATCH_CONCURRENCY}`);
            return Object.isFrozen(snap);
          })
        );
        const frozenFlags = await Promise.all(readers);
        expect(frozenFlags.every(Boolean)).toBe(true);
      }

      expect(observations).toHaveLength(generations.length * 25);
      for (const pair of observations) {
        // Every observed pair must come from a single, complete generation:
        // a torn snapshot would surface a mixed pair such as 4501:3.
        expect(validPairs.has(pair)).toBe(true);
      }
      expect(config.getValidationState().state).toBe('valid');
    });

    test('interleaved readers and validations always agree per generation', async () => {
      const config = loadConfigModule();
      applyValidEnv();

      for (let i = 0; i < 20; i += 1) {
        process.env.PORT = String(4600 + i);
        const published = config.validate();
        expect(config.getValidationState().generation).toBe(i + 1);

        // Let queued readers run before the next publication so different
        // generations are actually observed.
        const observed = await Promise.resolve().then(() => {
          const snap = config.get();
          return {
            port: snap.PORT,
            nodeEnv: snap.NODE_ENV,
            generation: config.getValidationState().generation,
          };
        });

        // The read must match the generation published at this step — no
        // earlier or partially applied config leaks through.
        expect(observed.port).toBe(published.PORT);
        expect(observed.nodeEnv).toBe('test');
        expect(observed.generation).toBe(i + 1);
      }

      expect(config.getValidationState().generation).toBe(20);
    });
  });

  describe('invoice file size boundary', () => {
    test('is deterministic before and after validation', () => {
      const config = loadConfigModule();
      applyValidEnv();
      delete process.env.INVOICE_FILE_MAX_SIZE;

      // Before validation: same schema, applied to an atomic env copy.
      expect(config.getInvoiceFileMaxSize()).toBe('5mb');

      const published = config.validate();

      expect(config.getInvoiceFileMaxSize()).toBe('5mb');
      expect(config.getInvoiceFileMaxSize()).toBe(published.INVOICE_FILE_MAX_SIZE);
    });

    test('honours a configured limit consistently on both sides of validation', () => {
      const config = loadConfigModule();
      applyValidEnv();
      process.env.INVOICE_FILE_MAX_SIZE = '2mb';

      expect(config.getInvoiceFileMaxSize()).toBe('2mb');
      config.validate();
      expect(config.getInvoiceFileMaxSize()).toBe('2mb');
    });
  });
});
