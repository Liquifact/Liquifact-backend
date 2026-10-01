/**
 * @fileoverview Compatibility contract tests for `src/dtos/cors.js`.
 *
 * These tests pin the module's frozen public surface and its documented
 * behaviour at the deserialization/serialization boundaries. They are the
 * executable half of the "Compatibility contract" section in the module
 * docstring: if any of them fail, a caller-visible contract has changed.
 *
 * Covered invariants:
 *  1. Exact sorted export list (`Object.keys(module.exports)`).
 *  2. Types of every export.
 *  3. Frozen error-code string values.
 *  4. `validateOriginDto` never throws and fails closed for empty/absent/
 *     malformed/non-allowlisted input, with the documented result shapes.
 *  5. `corsConfigDtoFromEnv` defaults for absent/malformed roots and the
 *     development fallback.
 *  6. `corsConfigDtoToOptions` / `corsConfigDtoToJson` / `corsConfigDtoFromJson`
 *     are total on null/undefined/array/primitive input and return the frozen
 *     output shapes with documented defaults.
 *  7. Output arrays are fresh and de-duplicated/normalized (no input mutation).
 *
 * @jest-environment node
 */

'use strict';

const EXPECTED_EXPORTS = [
  'CORS_CONFIG_DTO_INVALID_CODE',
  'CORS_NULL_ORIGIN_CODE',
  'CORS_ORIGIN_NOT_ALLOWED_CODE',
  'corsConfigDtoFromEnv',
  'corsConfigDtoFromJson',
  'corsConfigDtoToJson',
  'corsConfigDtoToOptions',
  'validateOriginDto',
];

const CONFIG_DTO_KEYS = ['allowedOrigins', 'isDevelopmentFallback', 'maxAge', 'optionsSuccessStatus'];
const OPTIONS_KEYS = ['maxAge', 'optionsSuccessStatus', 'origin'];
const REJECTION_KEYS = ['allowed', 'errorCode', 'reason'];

const REJECTION_MESSAGE = 'CORS policy: origin is not allowed.';

describe('src/dtos/cors compatibility contract', () => {
  let cors;
  let savedEnv;

  beforeAll(() => {
    savedEnv = { ...process.env };
  });

  beforeEach(() => {
    delete process.env.CORS_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_MAX_AGE;
    delete process.env.NODE_ENV;
    jest.resetModules();
    cors = require('./cors');
  });

  afterAll(() => {
    process.env = { ...savedEnv };
  });

  // ── CONTRACT 1 & 2: frozen export list and types ──────────────────────────
  describe('frozen public surface', () => {
    it('exports exactly the documented, sorted names', () => {
      expect(Object.keys(cors).sort()).toEqual(EXPECTED_EXPORTS);
    });

    it('gives every export its documented JavaScript type', () => {
      for (const name of EXPECTED_EXPORTS) {
        if (name[0] === 'C') {
          expect(typeof cors[name]).toBe('string');
        } else {
          expect(typeof cors[name]).toBe('function');
        }
      }
    });

    it('freezes the exported error-code string values', () => {
      expect(cors.CORS_ORIGIN_NOT_ALLOWED_CODE).toBe('CORS_ORIGIN_NOT_ALLOWED');
      expect(cors.CORS_NULL_ORIGIN_CODE).toBe('CORS_NULL_ORIGIN');
      expect(cors.CORS_CONFIG_DTO_INVALID_CODE).toBe('CORS_CONFIG_DTO_INVALID');
    });
  });

  // ── CONTRACT 3: validateOriginDto ─────────────────────────────────────────
  describe('validateOriginDto', () => {
    it('allows a request with no Origin header', () => {
      expect(cors.validateOriginDto(undefined, ['https://a.com'])).toEqual({ allowed: true });
      expect(cors.validateOriginDto(undefined, [])).toEqual({ allowed: true });
    });

    it('allows an origin on the allowlist (normalised comparison)', () => {
      expect(cors.validateOriginDto('https://a.com', ['https://a.com'])).toEqual({ allowed: true });
      expect(cors.validateOriginDto('HTTPS://A.COM', ['https://a.com'])).toEqual({ allowed: true });
      expect(cors.validateOriginDto('https://a.com/', ['https://a.com'])).toEqual({ allowed: true });
    });

    it('fails closed for non-string and empty origins with the invalid-origin code', () => {
      for (const origin of [null, 42, true, {}, [], '', () => {}]) {
        expect(cors.validateOriginDto(origin, ['https://a.com'])).toEqual({
          allowed: false,
          reason: REJECTION_MESSAGE,
          errorCode: 'CORS_INVALID_ORIGIN',
        });
      }
    });

    it('rejects the literal "null" origin with the exported null-origin code', () => {
      const result = cors.validateOriginDto('null', ['null', 'https://a.com']);
      expect(result).toEqual({
        allowed: false,
        reason: REJECTION_MESSAGE,
        errorCode: cors.CORS_NULL_ORIGIN_CODE,
      });
    });

    it('rejects when the allowlist is empty or not an array', () => {
      for (const allowlist of [[], undefined, null, 'https://a.com']) {
        expect(cors.validateOriginDto('https://a.com', allowlist)).toEqual({
          allowed: false,
          reason: REJECTION_MESSAGE,
          errorCode: 'CORS_EMPTY_ALLOWLIST',
        });
      }
    });

    it('rejects a disallowed origin with the exported not-allowed code', () => {
      expect(cors.validateOriginDto('https://evil.com', ['https://a.com'])).toEqual({
        allowed: false,
        reason: REJECTION_MESSAGE,
        errorCode: cors.CORS_ORIGIN_NOT_ALLOWED_CODE,
      });
    });

    it('never throws for arbitrary input', () => {
      const inputs = [undefined, null, 0, '', 'null', 'https://a.com', {}, [], Symbol('x')];
      const allowlists = [undefined, null, [], ['https://a.com'], 'nope'];
      for (const origin of inputs) {
        for (const allowlist of allowlists) {
          expect(() => cors.validateOriginDto(origin, allowlist)).not.toThrow();
        }
      }
    });

    it('returns the frozen result shapes', () => {
      expect(Object.keys(cors.validateOriginDto('https://a.com', ['https://a.com'])).sort()).toEqual(['allowed']);
      expect(
        Object.keys(cors.validateOriginDto('https://evil.com', ['https://a.com'])).sort()
      ).toEqual(REJECTION_KEYS);
    });
  });

  // ── CONTRACT 4: corsConfigDtoFromEnv ──────────────────────────────────────
  describe('corsConfigDtoFromEnv', () => {
    it('returns documented defaults for absent configuration', () => {
      const dto = cors.corsConfigDtoFromEnv({});
      expect(dto).toEqual({
        allowedOrigins: [],
        maxAge: 600,
        optionsSuccessStatus: 204,
        isDevelopmentFallback: false,
      });
      expect(Object.keys(dto).sort()).toEqual(CONFIG_DTO_KEYS);
    });

    it('never throws for malformed/primitive env roots', () => {
      for (const env of [null, undefined, 42, 'env', true, []]) {
        expect(() => cors.corsConfigDtoFromEnv(env)).not.toThrow();
        const dto = cors.corsConfigDtoFromEnv(env);
        expect(Object.keys(dto).sort()).toEqual(CONFIG_DTO_KEYS);
        expect(Array.isArray(dto.allowedOrigins)).toBe(true);
      }
    });

    it('falls back to the development allowlist only in development', () => {
      const dev = cors.corsConfigDtoFromEnv({ NODE_ENV: 'development' });
      expect(dev.allowedOrigins.length).toBeGreaterThan(0);
      expect(dev.isDevelopmentFallback).toBe(true);

      const prod = cors.corsConfigDtoFromEnv({ NODE_ENV: 'production' });
      expect(prod.allowedOrigins).toEqual([]);
      expect(prod.isDevelopmentFallback).toBe(false);
    });

    it('normalises, de-duplicates and defaults malformed string fields', () => {
      const dto = cors.corsConfigDtoFromEnv({
        CORS_ORIGINS: 'https://a.com,https://a.com/,HTTPS://A.COM, not-a-url ',
        CORS_MAX_AGE: 'not-a-number',
      });
      expect(dto.allowedOrigins).toEqual(['https://a.com']);
      expect(dto.maxAge).toBe(600);
      expect(dto.optionsSuccessStatus).toBe(204);
    });

    it('returns a fresh allowlist array on every call', () => {
      const first = cors.corsConfigDtoFromEnv({ CORS_ORIGINS: 'https://a.com' });
      first.allowedOrigins.push('https://evil.com');
      const second = cors.corsConfigDtoFromEnv({ CORS_ORIGINS: 'https://a.com' });
      expect(second.allowedOrigins).toEqual(['https://a.com']);
    });
  });

  // ── CONTRACT 5: corsConfigDtoToOptions ────────────────────────────────────
  describe('corsConfigDtoToOptions', () => {
    it('returns the frozen options shape with defaults for malformed DTOs', () => {
      for (const dto of [null, undefined, 42, 'dto', [], {}, { maxAge: -1, optionsSuccessStatus: 999 }]) {
        let options;
        expect(() => { options = cors.corsConfigDtoToOptions(dto); }).not.toThrow();
        expect(Object.keys(options).sort()).toEqual(OPTIONS_KEYS);
        expect(typeof options.origin).toBe('function');
        expect(options.maxAge).toBe(600);
        expect(options.optionsSuccessStatus).toBe(204);
      }
    });

    it('accepts documented values and preserves the preflight status', () => {
      const options = cors.corsConfigDtoToOptions({
        allowedOrigins: ['https://a.com'],
        maxAge: 1800,
        optionsSuccessStatus: 200,
      });
      expect(options.maxAge).toBe(1800);
      expect(options.optionsSuccessStatus).toBe(200);
    });

    it('drives the origin callback to allow non-browser and allowlisted origins', () => {
      const options = cors.corsConfigDtoToOptions({ allowedOrigins: ['https://a.com'] });
      const cb = jest.fn();
      options.origin(undefined, cb);
      expect(cb).toHaveBeenCalledWith(null, true);

      const cb2 = jest.fn();
      options.origin('https://a.com', cb2);
      expect(cb2).toHaveBeenCalledWith(null, true);
    });

    it('drives the origin callback to reject with a coded error', () => {
      const options = cors.corsConfigDtoToOptions({ allowedOrigins: ['https://a.com'] });
      const cb = jest.fn();
      options.origin('https://evil.com', cb);
      const err = cb.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(403);
      expect(err.isCorsOriginRejected).toBe(true);
      expect(err.errorCode).toBe(cors.CORS_ORIGIN_NOT_ALLOWED_CODE);
    });
  });

  // ── CONTRACT 6: JSON serialization boundaries ─────────────────────────────
  describe('corsConfigDtoToJson / corsConfigDtoFromJson', () => {
    it('normalises malformed input to the frozen DTO shape', () => {
      for (const value of [null, undefined, 42, 'json', [], {}, { allowedOrigins: 'nope' }]) {
        const json = cors.corsConfigDtoToJson(value);
        const restored = cors.corsConfigDtoFromJson(value);
        expect(Object.keys(json).sort()).toEqual(CONFIG_DTO_KEYS);
        expect(Object.keys(restored).sort()).toEqual(CONFIG_DTO_KEYS);
        expect(json).toEqual({
          allowedOrigins: [],
          maxAge: 600,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        });
      }
    });

    it('round-trips a DTO without mutating the source', () => {
      const source = {
        allowedOrigins: ['https://a.com', 'https://b.com'],
        maxAge: 3600,
        optionsSuccessStatus: 204,
        isDevelopmentFallback: false,
      };
      const restored = cors.corsConfigDtoFromJson(cors.corsConfigDtoToJson(source));
      expect(restored).toEqual(source);
      expect(restored.allowedOrigins).not.toBe(source.allowedOrigins);

      restored.allowedOrigins.push('https://evil.com');
      expect(source.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
    });
  });
});
