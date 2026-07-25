/**
 * @fileoverview Unit tests for src/services/configService.js.
 *
 * Verifies the runtime config application logic extracted from
 * src/routes/adminConfig.js (issue #879):
 *  - cors section: origins-only, maxAge-only, both, and neither
 *  - unknown sections remain a no-op
 *  - reloadCorsOrigins / reloadCorsMaxAge are invoked exactly when expected
 *
 * `../config/cors` is mocked so we can assert on reload calls without
 * depending on its real env-parsing behaviour (that's covered by
 * src/config/cors.test.js).
 *
 * @jest-environment node
 */

'use strict';

jest.mock('../config/cors', () => ({
  reloadCorsOrigins: jest.fn(),
  reloadCorsMaxAge: jest.fn(),
}));

const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
const { applyConfigSection } = require('./configService');

describe('configService.applyConfigSection', () => {
  /** Snapshot of the original environment before any test ran. */
  let OLD_ENV;

  beforeAll(() => {
    OLD_ENV = { ...process.env };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_MAX_AGE;
  });

  afterAll(() => {
    process.env = { ...OLD_ENV };
  });

  describe('cors section — origins update', () => {
    it('sets CORS_ALLOWED_ORIGINS from a joined origins array', () => {
      applyConfigSection('cors', { origins: ['https://a.example.com', 'https://b.example.com'] });

      expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://a.example.com,https://b.example.com');
    });

    it('calls reloadCorsOrigins exactly once with no arguments', () => {
      applyConfigSection('cors', { origins: ['https://a.example.com'] });

      expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
      expect(reloadCorsOrigins).toHaveBeenCalledWith();
    });

    it('does not call reloadCorsMaxAge when only origins are provided', () => {
      applyConfigSection('cors', { origins: ['https://a.example.com'] });

      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });

    it('does not touch CORS_MAX_AGE when only origins are provided', () => {
      applyConfigSection('cors', { origins: ['https://a.example.com'] });

      expect(process.env.CORS_MAX_AGE).toBeUndefined();
    });
  });

  describe('cors section — maxAge update', () => {
    it('sets CORS_MAX_AGE as a string from a numeric maxAge', () => {
      applyConfigSection('cors', { maxAge: 3600 });

      expect(process.env.CORS_MAX_AGE).toBe('3600');
    });

    it('calls reloadCorsMaxAge exactly once with no arguments', () => {
      applyConfigSection('cors', { maxAge: 3600 });

      expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
      expect(reloadCorsMaxAge).toHaveBeenCalledWith();
    });

    it('does not call reloadCorsOrigins when only maxAge is provided', () => {
      applyConfigSection('cors', { maxAge: 3600 });

      expect(reloadCorsOrigins).not.toHaveBeenCalled();
    });

    it('does not touch CORS_ALLOWED_ORIGINS when only maxAge is provided', () => {
      applyConfigSection('cors', { maxAge: 3600 });

      expect(process.env.CORS_ALLOWED_ORIGINS).toBeUndefined();
    });

    it('treats maxAge of 0 as provided (uses !== undefined, not truthiness)', () => {
      applyConfigSection('cors', { maxAge: 0 });

      expect(process.env.CORS_MAX_AGE).toBe('0');
      expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
    });
  });

  describe('cors section — both values provided', () => {
    it('sets both env vars and calls both reload functions once each', () => {
      applyConfigSection('cors', {
        origins: ['https://app.example.com', 'https://admin.example.com'],
        maxAge: 1800,
      });

      expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://app.example.com,https://admin.example.com');
      expect(process.env.CORS_MAX_AGE).toBe('1800');
      expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
      expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
    });
  });

  describe('cors section — missing values', () => {
    it('leaves env vars untouched and calls no reload functions for an empty config object', () => {
      applyConfigSection('cors', {});

      expect(process.env.CORS_ALLOWED_ORIGINS).toBeUndefined();
      expect(process.env.CORS_MAX_AGE).toBeUndefined();
      expect(reloadCorsOrigins).not.toHaveBeenCalled();
      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });

    it('treats an empty origins array as provided (arrays are truthy), matching prior route behavior', () => {
      applyConfigSection('cors', { origins: [] });

      expect(process.env.CORS_ALLOWED_ORIGINS).toBe('');
      expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
    });
  });

  describe('unknown sections', () => {
    it.each(['webhook', 'reconciliation', 'kyc', 'retention', 'fraudThresholds'])(
      'is a no-op for the "%s" section (no env mutation, no reload calls)',
      (section) => {
        applyConfigSection(section, { anything: 'goes-here', origins: ['https://should-not-apply.com'] });

        expect(process.env.CORS_ALLOWED_ORIGINS).toBeUndefined();
        expect(process.env.CORS_MAX_AGE).toBeUndefined();
        expect(reloadCorsOrigins).not.toHaveBeenCalled();
        expect(reloadCorsMaxAge).not.toHaveBeenCalled();
      },
    );

    it('is a no-op for a completely unrecognized section name', () => {
      expect(() => applyConfigSection('doesNotExist', { origins: ['https://x.com'], maxAge: 60 })).not.toThrow();

      expect(process.env.CORS_ALLOWED_ORIGINS).toBeUndefined();
      expect(process.env.CORS_MAX_AGE).toBeUndefined();
      expect(reloadCorsOrigins).not.toHaveBeenCalled();
      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });
  });
});
