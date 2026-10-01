/**
 * @fileoverview Comprehensive unit tests for src/config/cors.js.
 *
 * Covers all acceptance criteria:
 *  - Deterministic behaviour for valid, invalid, duplicate, and boundary inputs
 *  - Failure recovery: reloadCorsOrigins / reloadCorsMaxAge hot-reload
 *  - Concurrency / retry-safe: repeated reloads produce consistent state
 *  - Observability: correct error flags (isCorsOriginRejected, status, code)
 *  - User-visible error behaviour: 403 + fixed message for blocked origins
 *  - Partial failures in bulk operations
 *  - Backward-compatibility: buildCorsOptions alias, non-strict parseAllowedOrigins
 *  - All named exports are present (compatibility contract)
 *
 * @jest-environment node
 */

'use strict';

describe('CORS configuration module', () => {
  let OLD_ENV;

  beforeAll(() => {
    OLD_ENV = { ...process.env };
  });

  beforeEach(() => {
    delete process.env.CORS_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_MAX_AGE;
    delete process.env.NODE_ENV;
    jest.resetModules();
  });

  afterAll(() => {
    process.env = { ...OLD_ENV };
    jest.resetModules();
  });

  // ─── Named exports contract ───────────────────────────────────────────────

  describe('named exports', () => {
    it('exports all required identifiers', () => {
      jest.isolateModules(() => {
        const cors = require('./cors');
        const required = [
          'CORS_REJECTION_MESSAGE',
          'CORS_REJECTION_CODE',
          'DEV_DEFAULT_ORIGINS',
          'DEFAULT_MAX_AGE',
          'MAX_MAX_AGE',
          'MAX_ORIGIN_LENGTH',
          'BULK_CORS_MAX_OPERATIONS',
          'getDevelopmentFallbackOrigins',
          'validateOriginEntry',
          'parseAllowedOrigins',
          'getAllowedOriginsFromEnv',
          'resolveAllowlist',
          'normalizeOrigin',
          'isAllowedOrigin',
          'createCorsRejectionError',
          'isCorsOriginRejectedError',
          'parseMaxAge',
          'getMaxAge',
          'reloadCorsOrigins',
          'reloadCorsMaxAge',
          'createCorsOptions',
          'buildCorsOptions',
          'processBulkCorsOperations',
        ];
        for (const name of required) {
          expect(cors).toHaveProperty(name);
        }
      });
    });

    it('buildCorsOptions is an alias for createCorsOptions', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, buildCorsOptions } = require('./cors');
        expect(typeof createCorsOptions).toBe('function');
        expect(typeof buildCorsOptions).toBe('function');
        // Both produce an object with an origin callback
        const opts1 = createCorsOptions({ NODE_ENV: 'production' });
        const opts2 = buildCorsOptions({ NODE_ENV: 'production' });
        expect(typeof opts1.origin).toBe('function');
        expect(typeof opts2.origin).toBe('function');
      });
    });
  });

  // ─── Constants ────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('CORS_REJECTION_MESSAGE is the fixed string', () => {
      jest.isolateModules(() => {
        const { CORS_REJECTION_MESSAGE } = require('./cors');
        expect(CORS_REJECTION_MESSAGE).toBe('CORS policy: origin is not allowed.');
      });
    });

    it('DEFAULT_MAX_AGE is 600', () => {
      jest.isolateModules(() => {
        const { DEFAULT_MAX_AGE } = require('./cors');
        expect(DEFAULT_MAX_AGE).toBe(600);
      });
    });

    it('MAX_MAX_AGE is 86400', () => {
      jest.isolateModules(() => {
        const { MAX_MAX_AGE } = require('./cors');
        expect(MAX_MAX_AGE).toBe(86400);
      });
    });

    it('BULK_CORS_MAX_OPERATIONS is a positive integer', () => {
      jest.isolateModules(() => {
        const { BULK_CORS_MAX_OPERATIONS } = require('./cors');
        expect(typeof BULK_CORS_MAX_OPERATIONS).toBe('number');
        expect(BULK_CORS_MAX_OPERATIONS).toBeGreaterThan(0);
      });
    });
  });

  // ─── validateOriginEntry ─────────────────────────────────────────────────

  describe('validateOriginEntry', () => {
    it('returns valid for a well-formed https origin', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        const result = validateOriginEntry('https://app.example.com');
        expect(result).toEqual({ valid: true, normalized: 'https://app.example.com', error: null });
      });
    });

    it('returns valid for http with port', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        const result = validateOriginEntry('http://localhost:3000');
        expect(result.valid).toBe(true);
        expect(result.normalized).toBe('http://localhost:3000');
      });
    });

    it('rejects non-string entries', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        expect(validateOriginEntry(42).valid).toBe(false);
        expect(validateOriginEntry(null).valid).toBe(false);
        expect(validateOriginEntry(undefined).valid).toBe(false);
        expect(validateOriginEntry({}).valid).toBe(false);
      });
    });

    it('rejects empty string', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        const result = validateOriginEntry('');
        expect(result.valid).toBe(false);
        expect(result.error).toBe('origin entry must be a non-empty string');
      });
    });

    it('rejects the literal "null"', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        const result = validateOriginEntry('null');
        expect(result.valid).toBe(false);
        expect(result.error).toBe('origin entry cannot be the literal string "null"');
      });
    });

    it('rejects a non-URL string', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        expect(validateOriginEntry('not-a-url').valid).toBe(false);
      });
    });

    it('rejects a string exceeding MAX_ORIGIN_LENGTH', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry, MAX_ORIGIN_LENGTH } = require('./cors');
        const longOrigin = 'https://a.com/' + 'x'.repeat(MAX_ORIGIN_LENGTH);
        const result = validateOriginEntry(longOrigin);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('exceeds maximum length');
      });
    });

    it('accepts an origin at exactly MAX_ORIGIN_LENGTH characters', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry, MAX_ORIGIN_LENGTH } = require('./cors');
        const padding = MAX_ORIGIN_LENGTH - 'https://a.'.length;
        const origin = 'https://a.' + 'x'.repeat(padding);
        const result = validateOriginEntry(origin);
        expect(result.valid).toBe(true);
      });
    });

    it('normalizes uppercase scheme and host to lowercase', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        const result = validateOriginEntry('HTTPS://APP.EXAMPLE.COM');
        expect(result.valid).toBe(true);
        expect(result.normalized).toBe('https://app.example.com');
      });
    });

    it('normalizes origin with trailing slash', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry } = require('./cors');
        const result = validateOriginEntry('https://app.example.com/');
        expect(result.valid).toBe(true);
        expect(result.normalized).toBe('https://app.example.com');
      });
    });
  });

  // ─── parseAllowedOrigins (non-strict) ────────────────────────────────────

  describe('parseAllowedOrigins (non-strict / default)', () => {
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
        expect(parseAllowedOrigins('https://app.example.com')).toEqual(['https://app.example.com']);
      });
    });

    it('parses comma-separated origins with trimming', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins(' https://a.com , , https://b.com ,')).toEqual([
          'https://a.com',
          'https://b.com',
        ]);
      });
    });

    it('de-duplicates repeated origins', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins('https://a.com,https://a.com')).toEqual(['https://a.com']);
      });
    });

    it('silently filters invalid entries', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins('https://a.com,not-a-url')).toEqual(['https://a.com']);
      });
    });

    it('returns an array (not an object)', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(Array.isArray(parseAllowedOrigins('https://a.com,https://b.com'))).toBe(true);
      });
    });
  });

  // ─── parseAllowedOrigins (strict mode) ───────────────────────────────────

  describe('parseAllowedOrigins (strict mode)', () => {
    it('returns valid:true for undefined', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(parseAllowedOrigins(undefined, { strict: true })).toEqual({
          origins: [], rejected: [], fieldErrors: [], valid: true,
        });
      });
    });

    it('parses a single valid origin', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins('https://app.example.com', { strict: true });
        expect(result.origins).toEqual(['https://app.example.com']);
        expect(result.valid).toBe(true);
      });
    });

    it('reports invalid entries in rejected / fieldErrors', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins('https://a.com,not-a-url', { strict: true });
        expect(result.origins).toEqual(['https://a.com']);
        expect(result.rejected).toEqual(['not-a-url']);
        expect(result.fieldErrors.length).toBe(1);
        expect(result.valid).toBe(false);
      });
    });

    it('rejects "null" literal', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins('https://a.com,null', { strict: true });
        expect(result.rejected).toEqual(['null']);
        expect(result.valid).toBe(false);
      });
    });

    it('reports all invalid entries when every entry is invalid', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins('not-a-url,null,also-bad', { strict: true });
        expect(result.origins).toEqual([]);
        expect(result.rejected.length).toBe(3);
        expect(result.valid).toBe(false);
      });
    });

    it('de-duplicates valid origins', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins('https://a.com,https://a.com', { strict: true });
        expect(result.origins).toEqual(['https://a.com']);
        expect(result.valid).toBe(true);
      });
    });
  });

  // ─── parseMaxAge ──────────────────────────────────────────────────────────

  describe('parseMaxAge (non-strict)', () => {
    it('defaults to 600 for undefined/null/empty', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge(undefined)).toBe(600);
        expect(parseMaxAge(null)).toBe(600);
        expect(parseMaxAge('')).toBe(600);
      });
    });

    it('returns the value for a valid positive integer string', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('1800')).toBe(1800);
      });
    });

    it('defaults to 600 for negative, zero, float, or non-numeric', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('-100')).toBe(600);
        expect(parseMaxAge('0')).toBe(600);
        expect(parseMaxAge('720.5')).toBe(600);
        expect(parseMaxAge('notanumber')).toBe(600);
      });
    });
  });

  describe('parseMaxAge (strict mode)', () => {
    it('returns valid structured result for a valid value', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('1800', { strict: true })).toEqual({ value: 1800, valid: true, error: null });
      });
    });

    it('defaults for undefined with valid:true', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        const result = parseMaxAge(undefined, { strict: true });
        expect(result.value).toBe(600);
        expect(result.valid).toBe(true);
      });
    });

    it('reports error for non-string type', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        const result = parseMaxAge(42, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.error).toBe('max-age must be a string');
      });
    });

    it('reports error for non-integer string', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('notanumber', { strict: true }).error).toBe('max-age must be an integer');
        expect(parseMaxAge('720.5', { strict: true }).error).toBe('max-age must be an integer');
      });
    });

    it('reports error for non-positive value', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge('0', { strict: true }).error).toBe('max-age must be a positive integer');
        expect(parseMaxAge('-1', { strict: true }).error).toBe('max-age must be a positive integer');
      });
    });

    it('rejects a value exceeding MAX_MAX_AGE', () => {
      jest.isolateModules(() => {
        const { parseMaxAge, MAX_MAX_AGE } = require('./cors');
        const result = parseMaxAge(String(MAX_MAX_AGE + 1), { strict: true });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('must not exceed');
      });
    });

    it('accepts the boundary value MAX_MAX_AGE', () => {
      jest.isolateModules(() => {
        const { parseMaxAge, MAX_MAX_AGE } = require('./cors');
        const result = parseMaxAge(String(MAX_MAX_AGE), { strict: true });
        expect(result.valid).toBe(true);
        expect(result.value).toBe(MAX_MAX_AGE);
      });
    });

    it('accepts boundary value 1', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        const result = parseMaxAge('1', { strict: true });
        expect(result.valid).toBe(true);
        expect(result.value).toBe(1);
      });
    });
  });

  // ─── getDevelopmentFallbackOrigins ───────────────────────────────────────

  describe('getDevelopmentFallbackOrigins', () => {
    it('returns a fresh copy of DEV_DEFAULT_ORIGINS on every call', () => {
      jest.isolateModules(() => {
        const { getDevelopmentFallbackOrigins, DEV_DEFAULT_ORIGINS } = require('./cors');
        const a = getDevelopmentFallbackOrigins();
        const b = getDevelopmentFallbackOrigins();
        expect(a).toEqual(DEV_DEFAULT_ORIGINS);
        expect(a).not.toBe(b); // distinct array references
      });
    });

    it('mutating the returned array does not affect subsequent calls', () => {
      jest.isolateModules(() => {
        const { getDevelopmentFallbackOrigins } = require('./cors');
        const a = getDevelopmentFallbackOrigins();
        a.push('https://injected.com');
        const b = getDevelopmentFallbackOrigins();
        expect(b).not.toContain('https://injected.com');
      });
    });
  });

  // ─── normalizeOrigin ─────────────────────────────────────────────────────

  describe('normalizeOrigin', () => {
    it('returns null for "null", undefined, empty string, non-parseable string', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('null')).toBeNull();
        expect(normalizeOrigin(undefined)).toBeNull();
        expect(normalizeOrigin('')).toBeNull();
        expect(normalizeOrigin('not-a-url')).toBeNull();
      });
    });

    it('lowercases scheme and host', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('HTTPS://APP.EXAMPLE.COM')).toBe('https://app.example.com');
      });
    });

    it('strips trailing slash', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('https://app.example.com/')).toBe('https://app.example.com');
      });
    });

    it('preserves non-default port', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
      });
    });
  });

  // ─── isAllowedOrigin ─────────────────────────────────────────────────────

  describe('isAllowedOrigin', () => {
    it('returns true for exact-match', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://app.example.com', ['https://app.example.com'])).toBe(true);
      });
    });

    it('returns false for "null"', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('null', ['https://app.example.com', 'null'])).toBe(false);
      });
    });

    it('matches trailing-slash variant', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://app.example.com/', ['https://app.example.com'])).toBe(true);
      });
    });

    it('matches uppercase variant', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('HTTPS://APP.EXAMPLE.COM', ['https://app.example.com'])).toBe(true);
      });
    });

    it('returns false for unlisted origin', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://evil.com', ['https://app.example.com'])).toBe(false);
      });
    });

    it('returns false for empty allowlist', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://app.example.com', [])).toBe(false);
      });
    });

    it('returns false for non-array allowlist', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('https://app.example.com', null)).toBe(false);
        expect(isAllowedOrigin('https://app.example.com', undefined)).toBe(false);
      });
    });
  });

  // ─── createCorsRejectionError ─────────────────────────────────────────────

  describe('createCorsRejectionError', () => {
    it('creates an error with the correct message, status, and flags', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError, CORS_REJECTION_MESSAGE, CORS_REJECTION_CODE } = require('./cors');
        const err = createCorsRejectionError('https://evil.com');
        expect(err.message).toBe(CORS_REJECTION_MESSAGE);
        expect(err.code).toBe(CORS_REJECTION_CODE);
        expect(err.status).toBe(403);
        expect(err.isCorsOriginRejected).toBe(true);
        expect(err.isCorsOriginRejectedError).toBe(true);
      });
    });

    it('does not expose the rejected origin in the message', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError } = require('./cors');
        const err = createCorsRejectionError('https://evil.com');
        expect(err.message).not.toContain('evil.com');
      });
    });
  });

  // ─── isCorsOriginRejectedError ────────────────────────────────────────────

  describe('isCorsOriginRejectedError', () => {
    it('returns true for a rejection error', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError, isCorsOriginRejectedError } = require('./cors');
        expect(isCorsOriginRejectedError(createCorsRejectionError())).toBe(true);
      });
    });

    it('returns false for plain Error, null, undefined', () => {
      jest.isolateModules(() => {
        const { isCorsOriginRejectedError } = require('./cors');
        expect(isCorsOriginRejectedError(new Error('other'))).toBe(false);
        expect(isCorsOriginRejectedError(null)).toBe(false);
        expect(isCorsOriginRejectedError(undefined)).toBe(false);
      });
    });
  });

  // ─── getAllowedOriginsFromEnv ─────────────────────────────────────────────

  describe('getAllowedOriginsFromEnv', () => {
    it('reads from CORS_ALLOWED_ORIGINS', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv } = require('./cors');
        const result = getAllowedOriginsFromEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://a.com,https://b.com' });
        expect(result).toEqual(['https://a.com', 'https://b.com']);
      });
    });

    it('prefers CORS_ALLOWED_ORIGINS over CORS_ORIGINS', () => {
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
        const result = getAllowedOriginsFromEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'https://from-origins.com' });
        expect(result).toEqual(['https://from-origins.com']);
      });
    });

    it('returns dev fallback in development when nothing is set', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv, getDevelopmentFallbackOrigins } = require('./cors');
        expect(getAllowedOriginsFromEnv({ NODE_ENV: 'development' })).toEqual(getDevelopmentFallbackOrigins());
      });
    });

    it('returns empty array in production when nothing is set', () => {
      jest.isolateModules(() => {
        const { getAllowedOriginsFromEnv } = require('./cors');
        expect(getAllowedOriginsFromEnv({ NODE_ENV: 'production' })).toEqual([]);
      });
    });
  });

  // ─── createCorsOptions — origin validation ────────────────────────────────

  describe('createCorsOptions — origin validation', () => {
    it('allows an explicitly listed origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('allows an origin from CORS_ALLOWED_ORIGINS', () => {
      jest.isolateModules(() => {
        process.env.CORS_ALLOWED_ORIGINS = 'http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('rejects a disallowed origin with the standard CORS error (403, fixed message)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, isCorsOriginRejectedError, CORS_REJECTION_MESSAGE } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('http://b.com', cb);
        const [err] = cb.mock.calls[0];
        expect(err.message).toBe(CORS_REJECTION_MESSAGE);
        expect(err.status).toBe(403);
        expect(isCorsOriginRejectedError(err)).toBe(true);
      });
    });

    it('passes through requests with no Origin header (undefined)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin(undefined, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('passes through requests with null Origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin(null, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('rejects the literal "null" string origin (sandboxed iframe)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('null', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('rejects empty-string origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('allows trailing-slash variant of an allowlisted origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('https://app.example.com/', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('allows uppercase variant of an allowlisted origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('HTTPS://APP.EXAMPLE.COM', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('rejects subdomain bypass attempt', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('https://app.example.com.evil.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('optionsSuccessStatus is 204', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        expect(createCorsOptions().optionsSuccessStatus).toBe(204);
      });
    });

    it('allows multiple origins from comma-separated list', () => {
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
  });

  // ─── Development fallback ─────────────────────────────────────────────────

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
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('https://evil.com', cb);
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
  });

  // ─── Production no-config denial ─────────────────────────────────────────

  describe('production no-config denial', () => {
    it('denies all origins in production when CORS_ORIGINS is not set', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions();
        for (const origin of ['http://localhost:3000', 'https://app.example.com']) {
          const cb = jest.fn();
          opts.origin(origin, cb);
          expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
        }
      });
    });
  });

  // ─── max-age ──────────────────────────────────────────────────────────────

  describe('maxAge', () => {
    it('defaults to 600 when CORS_MAX_AGE is not set', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, getMaxAge } = require('./cors');
        expect(createCorsOptions().maxAge).toBe(600);
        expect(getMaxAge()).toBe(600);
      });
    });

    it('reads a custom CORS_MAX_AGE from the environment', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '1800';
        const { createCorsOptions, getMaxAge } = require('./cors');
        expect(createCorsOptions().maxAge).toBe(1800);
        expect(getMaxAge()).toBe(1800);
      });
    });

    it('falls back to 600 for invalid CORS_MAX_AGE', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = 'notanumber';
        const { createCorsOptions, getMaxAge } = require('./cors');
        expect(createCorsOptions().maxAge).toBe(600);
        expect(getMaxAge()).toBe(600);
      });
    });

    it('falls back to 600 for negative CORS_MAX_AGE', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '-100';
        const { createCorsOptions } = require('./cors');
        expect(createCorsOptions().maxAge).toBe(600);
      });
    });
  });

  // ─── reloadCorsOrigins (failure recovery, Issue #1284) ───────────────────

  describe('reloadCorsOrigins — failure recovery', () => {
    it('picks up newly added origins after reload', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, reloadCorsOrigins, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions();

        const cb1 = jest.fn();
        opts.origin('http://b.com', cb1);
        expect(isCorsOriginRejectedError(cb1.mock.calls[0][0])).toBe(true);

        process.env.CORS_ORIGINS = 'http://a.com,http://b.com';
        reloadCorsOrigins();

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

        process.env.NODE_ENV = 'production';
        delete process.env.CORS_ORIGINS;
        delete process.env.CORS_ALLOWED_ORIGINS;
        reloadCorsOrigins();

        const cb2 = jest.fn();
        opts.origin('http://localhost:3000', cb2);
        expect(cb2.mock.calls[0][0]).toHaveProperty('isCorsOriginRejected', true);
      });
    });

    it('transitions from production denial to dev fallback after reload', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        const cb1 = jest.fn();
        opts.origin('http://localhost:3000', cb1);
        expect(cb1.mock.calls[0][0]).toHaveProperty('isCorsOriginRejected', true);

        process.env.NODE_ENV = 'development';
        reloadCorsOrigins();

        const cb2 = jest.fn();
        opts.origin('http://localhost:3000', cb2);
        expect(cb2).toHaveBeenCalledWith(null, true);
      });
    });

    it('is safe to call multiple times (idempotent under no change)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        reloadCorsOrigins();
        reloadCorsOrigins();
        reloadCorsOrigins();

        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('denies all origins after reload with empty CORS_ORIGINS in production', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com';
        process.env.NODE_ENV = 'production';
        const { createCorsOptions, reloadCorsOrigins, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions();

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

        process.env.CORS_ORIGINS = '';
        reloadCorsOrigins();

        const cb = jest.fn();
        opts.origin('http://localhost:3000', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ─── reloadCorsMaxAge ─────────────────────────────────────────────────────

  describe('reloadCorsMaxAge — failure recovery', () => {
    it('picks up a new max-age value after reload', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '600';
        const { reloadCorsMaxAge, getMaxAge } = require('./cors');
        expect(getMaxAge()).toBe(600);

        process.env.CORS_MAX_AGE = '3600';
        reloadCorsMaxAge();
        expect(getMaxAge()).toBe(3600);
      });
    });

    it('falls back to default when CORS_MAX_AGE is cleared after reload', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '1200';
        const { reloadCorsMaxAge, getMaxAge } = require('./cors');
        expect(getMaxAge()).toBe(1200);

        delete process.env.CORS_MAX_AGE;
        reloadCorsMaxAge();
        expect(getMaxAge()).toBe(600);
      });
    });

    it('falls back to default for invalid value after reload', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '1200';
        const { reloadCorsMaxAge, getMaxAge } = require('./cors');

        process.env.CORS_MAX_AGE = 'broken';
        reloadCorsMaxAge();
        expect(getMaxAge()).toBe(600);
      });
    });

    it('is safe to call multiple times', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '900';
        const { reloadCorsMaxAge, getMaxAge } = require('./cors');
        reloadCorsMaxAge();
        reloadCorsMaxAge();
        expect(getMaxAge()).toBe(900);
      });
    });
  });

  // ─── Explicit env object path (test isolation) ───────────────────────────

  describe('createCorsOptions with explicit env object', () => {
    it('allows an origin when a literal env object is passed', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'http://a.com' });
        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('rejects a disallowed origin when a literal env object is passed', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'http://a.com' });
        const cb = jest.fn();
        opts.origin('http://b.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('passes through when origin is undefined with a literal env object', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'http://a.com' });
        const cb = jest.fn();
        opts.origin(undefined, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('denies all origins when no CORS_ORIGINS set in production env object', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production' });
        const cb = jest.fn();
        opts.origin('http://a.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });

    it('allows trailing-slash + uppercase variant in explicit env path', () => {
      jest.isolateModules(() => {
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' });
        const cb = jest.fn();
        opts.origin('HTTPS://APP.EXAMPLE.COM/', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('rejects "null" origin in explicit env path', () => {
      jest.isolateModules(() => {
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' });
        const cb = jest.fn();
        opts.origin('null', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });
  });

  // ─── Whitespace and duplicate handling ───────────────────────────────────

  describe('whitespace and duplicate origin handling', () => {
    it('trims whitespace around origins in CORS_ORIGINS', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = '  http://a.com , http://b.com  ';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        const cba = jest.fn();
        opts.origin('http://a.com', cba);
        expect(cba).toHaveBeenCalledWith(null, true);
        const cbb = jest.fn();
        opts.origin('http://b.com', cbb);
        expect(cbb).toHaveBeenCalledWith(null, true);
      });
    });

    it('handles duplicate origins without error or duplication', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'http://a.com,http://a.com,http://a.com';
        const { createCorsOptions } = require('./cors');
        const cb = jest.fn();
        createCorsOptions().origin('http://a.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ─── processBulkCorsOperations ────────────────────────────────────────────

  describe('processBulkCorsOperations', () => {
    it('adds valid origins and returns a result summary', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { processBulkCorsOperations } = require('./cors');
        const result = processBulkCorsOperations([
          { action: 'add', origin: 'https://new-origin.com' },
        ]);
        expect(result.added).toBe(1);
        expect(result.removed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.currentAllowlist).toContain('https://new-origin.com');
      });
    });

    it('skips invalid origins and reports them in errors', () => {
      jest.isolateModules(() => {
        const { processBulkCorsOperations } = require('./cors');
        const result = processBulkCorsOperations([
          { action: 'add', origin: 'not-a-url' },
        ]);
        expect(result.added).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.errors.length).toBe(1);
      });
    });

    it('skips duplicate adds (idempotent)', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { processBulkCorsOperations } = require('./cors');
        // Add once successfully
        processBulkCorsOperations([{ action: 'add', origin: 'https://dup.com' }]);
        // Add again — should be skipped
        const result = processBulkCorsOperations([{ action: 'add', origin: 'https://dup.com' }]);
        expect(result.skipped).toBe(1);
        expect(result.added).toBe(0);
      });
    });

    it('removes an existing origin', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { processBulkCorsOperations } = require('./cors');
        processBulkCorsOperations([{ action: 'add', origin: 'https://remove-me.com' }]);
        const result = processBulkCorsOperations([{ action: 'remove', origin: 'https://remove-me.com' }]);
        expect(result.removed).toBe(1);
        expect(result.currentAllowlist).not.toContain('https://remove-me.com');
      });
    });

    it('skips remove for absent origins (idempotent)', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { processBulkCorsOperations } = require('./cors');
        const result = processBulkCorsOperations([{ action: 'remove', origin: 'https://not-there.com' }]);
        expect(result.skipped).toBe(1);
        expect(result.removed).toBe(0);
      });
    });

    it('partial failure: processes valid operations even when some fail', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { processBulkCorsOperations } = require('./cors');
        const result = processBulkCorsOperations([
          { action: 'add', origin: 'https://valid.com' },
          { action: 'add', origin: 'not-a-url' },
          { action: 'add', origin: 'https://also-valid.com' },
        ]);
        expect(result.added).toBe(2);
        expect(result.skipped).toBe(1);
        expect(result.currentAllowlist).toContain('https://valid.com');
        expect(result.currentAllowlist).toContain('https://also-valid.com');
      });
    });

    it('respects BULK_CORS_MAX_OPERATIONS limit', () => {
      jest.isolateModules(() => {
        const { processBulkCorsOperations, BULK_CORS_MAX_OPERATIONS } = require('./cors');
        const ops = Array.from({ length: BULK_CORS_MAX_OPERATIONS + 10 }, (_, i) => ({
          action: 'add',
          origin: `https://origin-${i}.com`,
        }));
        const result = processBulkCorsOperations(ops);
        expect(result.added).toBe(BULK_CORS_MAX_OPERATIONS);
        expect(result.currentAllowlist.length).toBeLessThanOrEqual(BULK_CORS_MAX_OPERATIONS + 10);
      });
    });

    it('returns safely for non-array input', () => {
      jest.isolateModules(() => {
        const { processBulkCorsOperations } = require('./cors');
        const result = processBulkCorsOperations('not-an-array');
        expect(result.added).toBe(0);
        expect(result.errors.length).toBeGreaterThan(0);
      });
    });

    it('allows added origins in subsequent createCorsOptions calls', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { processBulkCorsOperations, createCorsOptions } = require('./cors');
        processBulkCorsOperations([{ action: 'add', origin: 'https://dynamic.com' }]);
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('https://dynamic.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('removed origins are subsequently rejected', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        const { processBulkCorsOperations, createCorsOptions, reloadCorsOrigins, isCorsOriginRejectedError } = require('./cors');
        // Start with an explicit origin, add it, confirm it works, remove it, confirm denial.
        process.env.CORS_ORIGINS = 'https://soon-removed.com';
        reloadCorsOrigins();

        processBulkCorsOperations([{ action: 'remove', origin: 'https://soon-removed.com' }]);

        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('https://soon-removed.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });
  });

  // ─── Express middleware integration ───────────────────────────────────────

  describe('express CORS middleware integration', () => {
    function setupApp(corsOrigins) {
      const express = require('express');
      const cors = require('cors');
      const { createCorsOptions } = require('./cors');
      const app = express();
      app.use(cors(createCorsOptions({ NODE_ENV: 'production', CORS_ORIGINS: corsOrigins })));
      app.get('/test', (_req, res) => res.json({ ok: true }));
      app.use((err, _req, res, _next) => {
        if (err && err.isCorsOriginRejected) {
          return res.status(403).json({ error: { message: err.message } });
        }
        return res.status(500).json({ error: { message: err.message } });
      });
      return app;
    }

    it('allows exact allowlisted origin', async () => {
      jest.isolateModules(async () => {
        const request = require('supertest');
        const app = setupApp('https://app.example.com');
        const res = await request(app).get('/test').set('Origin', 'https://app.example.com');
        expect(res.statusCode).toBe(200);
      });
    });

    it('rejects literal "null" origin with 403', async () => {
      jest.isolateModules(async () => {
        const request = require('supertest');
        const app = setupApp('https://app.example.com');
        const res = await request(app).get('/test').set('Origin', 'null');
        expect(res.statusCode).toBe(403);
        expect(res.body.error.message).toBe('CORS policy: origin is not allowed.');
      });
    });

    it('rejects disallowed origin with 403', async () => {
      jest.isolateModules(async () => {
        const request = require('supertest');
        const app = setupApp('https://app.example.com');
        const res = await request(app).get('/test').set('Origin', 'https://evil.com');
        expect(res.statusCode).toBe(403);
      });
    });

    it('rejects subdomain bypass with 403', async () => {
      jest.isolateModules(async () => {
        const request = require('supertest');
        const app = setupApp('https://app.example.com');
        const res = await request(app).get('/test').set('Origin', 'https://app.example.com.evil.com');
        expect(res.statusCode).toBe(403);
      });
    });

    it('handles CORS_ORIGINS configured with uppercase characters', async () => {
      jest.isolateModules(async () => {
        const request = require('supertest');
        const app = setupApp('HTTPS://APP.EXAMPLE.COM/');
        const res = await request(app).get('/test').set('Origin', 'https://app.example.com');
        expect(res.statusCode).toBe(200);
      });
    });
  });
});
