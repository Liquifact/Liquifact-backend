/**
 * @fileoverview Unit tests for src/config/cors.js.
 *
 * Each test case uses jest.isolateModules so that the module-level mutable
 * state (allowedOrigins, maxAge) is freshly initialised from the environment
 * variables we set inside the isolated callback.  The cors module has no
 * external dependencies beyond process.env, so no mocking is needed.
 *
 * Every test that depends on environment variables sets them **before** the
 * `require('./cors')` call so the module-level state is correctly seeded.
 *
 * @jest-environment node
 */

'use strict';

describe('CORS configuration module', () => {
  /** Snapshot of the original environment before any test ran. */
  let OLD_ENV;

  beforeAll(() => {
    OLD_ENV = { ...process.env };
  });

  beforeEach(() => {
    // Wipe the env vars the cors module reads so each test starts clean.
    delete process.env.CORS_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_MAX_AGE;
    delete process.env.NODE_ENV;

    jest.resetModules();
  });

  afterAll(() => {
    // Restore the original environment so other test suites are unaffected.
    process.env = { ...OLD_ENV };
  });

  // ─── Pure helpers (no env override needed) ────────────────────────────────

  describe('parseAllowedOrigins', () => {
    it('returns [] for undefined', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins(undefined)).toEqual([]);
      });
    });

    it('returns [] for empty string', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins('')).toEqual([]);
      });
    });

    it('returns [] for whitespace-only string', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins('   ')).toEqual([]);
      });
    });

    it('parses a single origin', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins('https://app.example.com')).toEqual([
          'https://app.example.com',
        ]);
      });
    });

    it('parses comma-separated origins with trimming', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(
          parseAllowedOrigins(' https://a.com , , https://b.com ,')
        ).toEqual(['https://a.com', 'https://b.com']);
      });
    });

    it('de-duplicates repeated origins', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins('https://a.com,https://a.com')).toEqual([
          'https://a.com',
        ]);
      });
    });
  });

  describe('parseMaxAge', () => {
    it('returns 600 for undefined', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge(undefined)).toBe(600);
      });
    });

    it('returns 600 for null', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge(null)).toBe(600);
      });
    });

    it('returns 600 for empty string', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('')).toBe(600);
      });
    });

    it('returns the value for a valid positive integer string', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('1800')).toBe(1800);
      });
    });

    it('returns 600 for a negative value', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('-100')).toBe(600);
      });
    });

    it('returns 600 for zero', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('0')).toBe(600);
      });
    });

    it('returns 600 for a non-numeric string', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('notanumber')).toBe(600);
      });
    });

    it('returns 600 for a float string', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('720.5')).toBe(600);
      });
    });
  });

  describe('getDevelopmentFallbackOrigins', () => {
    it('returns the DEV_DEFAULT_ORIGINS array', () => {
      jest.isolateModules(() => {
        const { getDevelopmentFallbackOrigins, DEV_DEFAULT_ORIGINS } =
          require('./cors');
        expect(getDevelopmentFallbackOrigins()).toEqual(DEV_DEFAULT_ORIGINS);
      });
    });
  });

  describe('createCorsRejectionError', () => {
    it('creates an error with the standard message and status 403', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError, CORS_REJECTION_MESSAGE } =
          require('./cors');
        const err = createCorsRejectionError('https://evil.com');
        expect(err.message).toBe(CORS_REJECTION_MESSAGE);
        expect(err.status).toBe(403);
        expect(err.isCorsOriginRejected).toBe(true);
        expect(err.isCorsOriginRejectedError).toBe(true);
      });
    });
  });

  describe('isCorsOriginRejectedError', () => {
    it('returns true for a rejection error', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError, isCorsOriginRejectedError } =
          require('./cors');
        expect(isCorsOriginRejectedError(createCorsRejectionError())).toBe(
          true
        );
      });
    });

    it('returns false for a plain Error', () => {
      jest.isolateModules(() => {
        const { isCorsOriginRejectedError } = require('./cors');
        expect(isCorsOriginRejectedError(new Error('other'))).toBe(false);
      });
    });

    it('returns false for null', () => {
      jest.isolateModules(() => {
        const { isCorsOriginRejectedError } = require('./cors');
        expect(isCorsOriginRejectedError(null)).toBe(false);
      });
    });

    it('returns false for undefined', () => {
      jest.isolateModules(() => {
        const { isCorsOriginRejectedError } = require('./cors');
        expect(isCorsOriginRejectedError(undefined)).toBe(false);
      });
    });
  });

  describe('getAllowedOriginsFromEnv', () => {
    it('returns origins from CORS_ALLOWED_ORIGINS', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv } = require('./cors');
        const result = getAllowedOriginsFromEnv({
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: 'https://a.com,https://b.com',
        });
        expect(result).toEqual(['https://a.com', 'https://b.com']);
      });
    });

    it('prefers CORS_ALLOWED_ORIGINS over CORS_ORIGINS when both set', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv } = require('./cors');
        const result = getAllowedOriginsFromEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://from-cors-origins.com',
          CORS_ALLOWED_ORIGINS: 'https://from-allowed.com',
        });
        expect(result).toEqual(['https://from-allowed.com']);
      });
    });

    it('falls back to CORS_ORIGINS when CORS_ALLOWED_ORIGINS is absent', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv } = require('./cors');
        const result = getAllowedOriginsFromEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://from-origins.com',
        });
        expect(result).toEqual(['https://from-origins.com']);
      });
    });

    it('returns dev fallback in development when nothing is set', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv, getDevelopmentFallbackOrigins } =
          require('./cors');
        expect(
          getAllowedOriginsFromEnv({ NODE_ENV: 'development' })
        ).toEqual(getDevelopmentFallbackOrigins());
      });
    });

    it('returns empty array in production when nothing is set', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv } = require('./cors');
        expect(getAllowedOriginsFromEnv({ NODE_ENV: 'production' })).toEqual(
          []
        );
      });
    });
  });

  describe('resolveAllowlist', () => {
    it('delegates to getAllowedOriginsFromEnv', () => {
      jest.isolateModules(() => {
        const { resolveAllowlist } = require('./cors');
        const result = resolveAllowlist({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://x.com',
        });
        expect(result).toEqual(['https://x.com']);
      });
    });
  });

  // ─── Scenarios 1–4: core origin behaviour ────────────────────────────────

  describe('createCorsOptions – origin validation', () => {
    // Scenario 1: allowed origin
    it('allows an origin that is explicitly listed in CORS_ORIGINS', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    // Scenario 1 also covers CORS_ALLOWED_ORIGINS
    it('allows an origin listed in CORS_ALLOWED_ORIGINS', () => {
      jest.isolateModules(() => {
        process.env.CORS_ALLOWED_ORIGINS = 'http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    // Scenario 2: disallowed origin
    it('rejects a disallowed origin with the standard CORS error', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, isCorsOriginRejectedError, CORS_REJECTION_MESSAGE } =
          require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('http://b.com', cb);
        const [err] = cb.mock.calls[0];
        expect(err).toBeDefined();
        expect(err.message).toBe(CORS_REJECTION_MESSAGE);
        expect(err.status).toBe(403);
        expect(isCorsOriginRejectedError(err)).toBe(true);
      });
    });

    // Scenario 3: no Origin header
    it('passes through requests without an Origin header (undefined)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin(undefined, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ─── Scenario 4: development fallback ────────────────────────────────────

  describe('development fallback', () => {
    it('allows localhost origins when NODE_ENV=development and no CORS_ORIGINS is set', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'development';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('http://localhost:3000', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('allows all DEV_DEFAULT_ORIGINS entries', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'development';
        const { createCorsOptions, DEV_DEFAULT_ORIGINS } = require('./cors');
        const opts = createCorsOptions();
        for (const origin of DEV_DEFAULT_ORIGINS) {
          const cb = jest.fn();
          opts.origin(origin, cb);
          expect(cb).toHaveBeenCalledWith(null, true);
        }
      });
    });

    it('rejects non-localhost origins in development fallback mode', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'development';
        const { createCorsOptions, isCorsOriginRejectedError } =
          require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('https://evil.com', cb);
        const [err] = cb.mock.calls[0];
        expect(isCorsOriginRejectedError(err)).toBe(true);
      });
    });
  });

  // ─── Scenario 5: reloadCorsOrigins ───────────────────────────────────────

  describe('reloadCorsOrigins', () => {
    it('picks up newly added origins after reload', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, reloadCorsOrigins, isCorsOriginRejectedError } =
          require('./cors');
        const opts = createCorsOptions();

        // http://b.com should be rejected initially
        const cb1 = jest.fn();
        opts.origin('http://b.com', cb1);
        expect(cb1).toHaveBeenCalledWith(
          expect.objectContaining({ isCorsOriginRejected: true })
        );

        // Add http://b.com to the env and reload
        process.env.CORS_ORIGINS = 'http://a.com,http://b.com';
        reloadCorsOrigins();

        // Now http://b.com must be allowed
        const cb2 = jest.fn();
        opts.origin('http://b.com', cb2);
        expect(cb2).toHaveBeenCalledWith(null, true);

        // http://c.com must still be rejected
        const cb3 = jest.fn();
        opts.origin('http://c.com', cb3);
        expect(isCorsOriginRejectedError(cb3.mock.calls[0][0])).toBe(true);
      });
    });

    it('transitions from dev fallback to production denial after reload', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'development';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        const cb1 = jest.fn();
        opts.origin('http://localhost:3000', cb1);
        expect(cb1).toHaveBeenCalledWith(null, true);

        // Change to production with no origins and reload
        process.env.NODE_ENV = 'production';
        delete process.env.CORS_ORIGINS;
        delete process.env.CORS_ALLOWED_ORIGINS;
        reloadCorsOrigins();

        const cb2 = jest.fn();
        opts.origin('http://localhost:3000', cb2);
        expect(cb2.mock.calls[0][0]).toHaveProperty(
          'isCorsOriginRejected',
          true
        );
      });
    });

    it('transitions from production denial to dev fallback after reload', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        const cb1 = jest.fn();
        opts.origin('http://localhost:3000', cb1);
        expect(cb1.mock.calls[0][0]).toHaveProperty(
          'isCorsOriginRejected',
          true
        );

        // Switch to development and reload
        process.env.NODE_ENV = 'development';
        reloadCorsOrigins();

        const cb2 = jest.fn();
        opts.origin('http://localhost:3000', cb2);
        expect(cb2).toHaveBeenCalledWith(null, true);
      });
    });

    it('is safe to call multiple times', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        // Call reload without changing env – no error expected
        reloadCorsOrigins();
        reloadCorsOrigins();

        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ─── Scenario 6: production no-config denial ─────────────────────────────

  describe('production no-config denial', () => {
    it('denies all origins in production when CORS_ORIGINS is not set', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { createCorsOptions, isCorsOriginRejectedError } =
          require('./cors');
        const opts = createCorsOptions();
        const origins = [
          'http://localhost:3000',
          'https://app.example.com',
          'http://127.0.0.1:3000',
        ];
        for (const origin of origins) {
          const cb = jest.fn();
          opts.origin(origin, cb);
          expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
        }
      });
    });
  });

  // ─── Scenario 7: max-age ─────────────────────────────────────────────────

  describe('maxAge', () => {
    it('defaults to 600 when CORS_MAX_AGE is not set', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, getMaxAge } = require('./cors');
        const opts = createCorsOptions();
        expect(opts.maxAge).toBe(600);
        expect(getMaxAge()).toBe(600);
      });
    });

    it('reads a custom CORS_MAX_AGE from the environment at module load', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '1800';
        const { createCorsOptions, getMaxAge } = require('./cors');
        const opts = createCorsOptions();
        expect(opts.maxAge).toBe(1800);
        expect(getMaxAge()).toBe(1800);
      });
    });

    it('falls back to 600 when CORS_MAX_AGE is an invalid value', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = 'notanumber';
        const { createCorsOptions, getMaxAge } = require('./cors');
        const opts = createCorsOptions();
        expect(opts.maxAge).toBe(600);
        expect(getMaxAge()).toBe(600);
      });
    });

    it('falls back to 600 when CORS_MAX_AGE is negative', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '-100';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        expect(opts.maxAge).toBe(600);
      });
    });

    it('falls back to 600 when CORS_MAX_AGE is zero', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '0';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        expect(opts.maxAge).toBe(600);
      });
    });
  });

  // ─── Scenario 8: reload with empty string ────────────────────────────────

  describe('reload with empty CORS_ORIGINS', () => {
    it('denies all origins after reload with empty CORS_ORIGINS in production', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        process.env.NODE_ENV = 'production';
        const { createCorsOptions, reloadCorsOrigins, isCorsOriginRejectedError } =
          require('./cors');
        const opts = createCorsOptions();

        // Reload with empty CORS_ORIGINS
        process.env.CORS_ORIGINS = '';
        reloadCorsOrigins();

        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('falls back to dev origins after reload with empty CORS_ORIGINS in development', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://production-only.com';
        process.env.NODE_ENV = 'development';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        // Reload with empty CORS_ORIGINS – fallback must kick in
        process.env.CORS_ORIGINS = '';
        reloadCorsOrigins();

        const cb = jest.fn();
        opts.origin('http://localhost:3000', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ─── Scenario 9: comma-separated with spaces ─────────────────────────────

  describe('comma-separated origins with whitespace', () => {
    it('trims whitespace around origins in CORS_ORIGINS', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = '  http://a.com , http://b.com  ';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();

        const cb1 = jest.fn();
        opts.origin('http://a.com', cb1);
        expect(cb1).toHaveBeenCalledWith(null, true);

        const cb2 = jest.fn();
        opts.origin('http://b.com', cb2);
        expect(cb2).toHaveBeenCalledWith(null, true);

        const cb3 = jest.fn();
        opts.origin('http://c.com', cb3);
        expect(cb3.mock.calls[0][0]).toHaveProperty(
          'isCorsOriginRejected',
          true
        );
      });
    });
  });

  // ─── Scenario 10: duplicate origins ──────────────────────────────────────

  describe('duplicate origins', () => {
    it('handles duplicate origins without error', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com,http://a.com,http://a.com';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();

        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ─── Additional edge cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('rejects empty-string origin (treated as present but not in allowlist)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, isCorsOriginRejectedError } =
          require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('allows multiple origins from a comma-separated list', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com,http://b.com,http://c.com';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();

        for (const origin of ['http://a.com', 'http://b.com', 'http://c.com']) {
          const cb = jest.fn();
          opts.origin(origin, cb);
          expect(cb).toHaveBeenCalledWith(null, true);
        }
      });
    });

    it('optionsSuccessStatus is always 204', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        expect(opts.optionsSuccessStatus).toBe(204);
      });
    });

    it('cors module exports all expected named exports', () => {
      jest.isolateModules(() => {
        const cors = require('./cors');
        expect(cors).toHaveProperty('CORS_REJECTION_MESSAGE');
        expect(cors).toHaveProperty('DEV_DEFAULT_ORIGINS');
        expect(cors).toHaveProperty('createCorsOptions');
        expect(cors).toHaveProperty('createCorsRejectionError');
        expect(cors).toHaveProperty('getAllowedOriginsFromEnv');
        expect(cors).toHaveProperty('getDevelopmentFallbackOrigins');
        expect(cors).toHaveProperty('getMaxAge');
        expect(cors).toHaveProperty('isAllowedOrigin');
        expect(cors).toHaveProperty('isCorsOriginRejectedError');
        expect(cors).toHaveProperty('normalizeOrigin');
        expect(cors).toHaveProperty('parseAllowedOrigins');
        expect(cors).toHaveProperty('parseMaxAge');
        expect(cors).toHaveProperty('reloadCorsOrigins');
        expect(cors).toHaveProperty('resolveAllowlist');
      });
    });

    it('passes through when origin is undefined even with empty allowlist', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin(undefined, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('DEFAULT_MAX_AGE constant is 600', () => {
      jest.isolateModules(() => {
        const { parseMaxAge, getMaxAge } = require('./cors');
        expect(parseMaxAge(undefined)).toBe(600);
        expect(getMaxAge()).toBe(600);
      });
    });

    // ── Custom-env path (non-process.env argument to createCorsOptions) ──

    it('allows an origin when createCorsOptions receives a literal env object', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'http://a.com',
        });
        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('rejects a disallowed origin when createCorsOptions receives a literal env object', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, isCorsOriginRejectedError } =
          require('./cors');
        const opts = createCorsOptions({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'http://a.com',
        });
        const cb = jest.fn();
        opts.origin('http://b.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('passes through when origin is undefined with a literal env object', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'http://a.com',
        });
        const cb = jest.fn();
        opts.origin(undefined, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('denies all origins when literal env object has no CORS_ORIGINS in production', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, isCorsOriginRejectedError } =
          require('./cors');
        const opts = createCorsOptions({
          NODE_ENV: 'production',
        });
        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });
  });

  // ─── normalizeOrigin ─────────────────────────────────────────────────────

  describe('normalizeOrigin', () => {
    it('returns null for the literal string "null" (sandboxed iframe)', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('null')).toBeNull();
      });
    });

    it('returns null for undefined', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin(undefined)).toBeNull();
      });
    });

    it('returns null for empty string', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('')).toBeNull();
      });
    });

    it('returns null for a non-parseable string', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('not-a-url')).toBeNull();
      });
    });

    it('lowercases scheme and host', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('HTTPS://APP.EXAMPLE.COM')).toBe('https://app.example.com');
      });
    });

    it('strips a trailing slash', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('https://app.example.com/')).toBe('https://app.example.com');
      });
    });

    it('preserves a non-default port', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
      });
    });

    it('returns the same value for an already-normalized origin', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('https://app.example.com')).toBe('https://app.example.com');
      });
    });
  });

  // ─── isAllowedOrigin ──────────────────────────────────────────────────────

  describe('isAllowedOrigin', () => {
    it('returns true for an exact-match allowlisted origin', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://app.example.com', ['https://app.example.com'])).toBe(true);
      });
    });

    it('returns false for the literal "null" origin', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('null', ['https://app.example.com', 'null'])).toBe(false);
      });
    });

    it('matches a trailing-slash variant against a clean allowlist entry', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://app.example.com/', ['https://app.example.com'])).toBe(true);
      });
    });

    it('matches an upper-case variant against a lower-case allowlist entry', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('HTTPS://APP.EXAMPLE.COM', ['https://app.example.com'])).toBe(true);
      });
    });

    it('returns false for an origin not in the allowlist', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://evil.com', ['https://app.example.com'])).toBe(false);
      });
    });

    it('returns false for an empty allowlist', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://app.example.com', [])).toBe(false);
      });
    });
  });

  // ─── Origin bypass hardening (integration via createCorsOptions) ──────────

  describe('origin bypass hardening', () => {
    it('rejects the literal "null" origin (sandboxed iframe)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('null', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('allows a trailing-slash variant of an allowlisted origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('https://app.example.com/', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('allows an upper-case variant of an allowlisted origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('HTTPS://APP.EXAMPLE.COM', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('allows a combined upper-case + trailing-slash variant', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('HTTPS://APP.EXAMPLE.COM/', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('does not allow an unlisted origin (no credentialed reflection)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('https://attacker.example.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('rejects "null" even when the allowlist is the dev fallback', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'development';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('null', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('passes through requests with no Origin header (undefined) with hardening active', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin(undefined, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('hardens null-origin in the custom-env (test) path', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' });
        const cb = jest.fn();
        opts.origin('null', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('allows trailing-slash variant in the custom-env path', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' });
        const cb = jest.fn();
        opts.origin('https://app.example.com/', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ─── Express middleware integration (driving cors(createCorsOptions())) ──

  describe('express CORS middleware integration', () => {
    function setupApp(corsOrigins) {
      const express = require('express');
      const cors = require('cors');
      const { createCorsOptions } = require('./cors');

      const app = express();
      app.use(
        cors(
          createCorsOptions({
            NODE_ENV: 'production',
            CORS_ORIGINS: corsOrigins,
          })
        )
      );
      app.get('/test', (req, res) => res.json({ ok: true }));
      app.use((err, req, res, _next) => {
        if (err && err.isCorsOriginRejected) {
          return res.status(403).json({ error: { message: err.message } });
        }
        return res.status(500).json({ error: { message: err.message } });
      });
      return app;
    }

    it('allows exact allowlisted origin', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'https://app.example.com');
      expect(res.statusCode).toBe(200);
    });

    it('allows trailing-slash variant of allowlisted origin', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'https://app.example.com/');
      expect(res.statusCode).toBe(200);
    });

    it('allows upper-case host variant of allowlisted origin', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'HTTPS://APP.EXAMPLE.COM');
      expect(res.statusCode).toBe(200);
    });

    it('rejects literal "null" origin with 403', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'null');
      expect(res.statusCode).toBe(403);
      expect(res.body.error.message).toBe('CORS policy: origin is not allowed.');
    });

    it('rejects disallowed origin with 403', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'https://evil.com');
      expect(res.statusCode).toBe(403);
    });

    it('rejects trailing-slash variant of disallowed origin with 403', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'https://evil.com/');
      expect(res.statusCode).toBe(403);
    });

    it('rejects upper-case variant of disallowed origin with 403', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'HTTPS://EVIL.COM');
      expect(res.statusCode).toBe(403);
    });

    it('rejects subdomain bypass attempt with 403', async () => {
      const request = require('supertest');
      const app = setupApp('https://app.example.com');
      const res = await request(app).get('/test').set('Origin', 'https://app.example.com.evil.com');
      expect(res.statusCode).toBe(403);
    });

    it('handles CORS_ORIGINS configured with trailing slash or uppercase characters', async () => {
      const request = require('supertest');
      const app = setupApp('HTTPS://APP.EXAMPLE.COM/');
      const res = await request(app).get('/test').set('Origin', 'https://app.example.com');
      expect(res.statusCode).toBe(200);
    });
  });
});
