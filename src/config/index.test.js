

/**
 * Tests for centralized config module — #1306 Preserve compatibility contracts.
 *
 * Covers:
 *  - All original public exports exist with correct signatures (compatibility)
 *  - CONFIG_VERSION is exported and is a semver string
 *  - FEATURE_FLAG_KEYS is exported and frozen
 *  - getFeatureFlag() returns boolean true/false for all flag keys
 *  - getFeatureFlag() throws TypeError for unknown keys
 *  - Existing callers using getValue() for feature flags still work
 *  - All original regression tests preserved
 */

const mod = require('./index');

const {
  validate,
  validateSafe,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  getFeatureFlag,
  FEATURE_FLAG_KEYS,
  CONFIG_VERSION,
  ConfigSchema,
  InvoiceFileMaxSizeSchema,
  securityHeaders,
} = mod;

// ─── Helpers ───────────────────────────────────────────────────────────────────

const VALID_JWT = 'valid-secret-at-least-32-chars-long-here';

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('Config — compatibility contracts (#1306)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── Export surface ─────────────────────────────────────────────────────────

  test('#1306 validate is exported as a function', () => {
    expect(typeof mod.validate).toBe('function');
  });

  test('#1306 get is exported as a function', () => {
    expect(typeof mod.get).toBe('function');
  });

  test('#1306 getValue is exported as a function', () => {
    expect(typeof mod.getValue).toBe('function');
  });

  test('#1306 getInvoiceFileMaxSize is exported as a function', () => {
    expect(typeof mod.getInvoiceFileMaxSize).toBe('function');
  });

  test('#1306 logRedactedSummary is exported as a function', () => {
    expect(typeof mod.logRedactedSummary).toBe('function');
  });

  test('#1306 ConfigSchema is exported', () => {
    expect(mod.ConfigSchema).toBeDefined();
    expect(typeof mod.ConfigSchema.parse).toBe('function');
  });

  test('#1306 InvoiceFileMaxSizeSchema is exported', () => {
    expect(mod.InvoiceFileMaxSizeSchema).toBeDefined();
    expect(typeof mod.InvoiceFileMaxSizeSchema.parse).toBe('function');
  });

  test('#1306 securityHeaders is exported as a plain object', () => {
    expect(typeof mod.securityHeaders).toBe('object');
    expect(mod.securityHeaders).not.toBeNull();
    expect(mod.securityHeaders.contentSecurityPolicy).toBeDefined();
    expect(mod.securityHeaders.hsts).toBeDefined();
    expect(mod.securityHeaders.referrerPolicy).toBeDefined();
  });

  // ── New additive exports (#1306) ──────────────────────────────────────────

  test('#1306 CONFIG_VERSION is exported as a string', () => {
    expect(typeof CONFIG_VERSION).toBe('string');
    // Must be a valid semver-like string: X.Y.Z
    expect(CONFIG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('#1306 FEATURE_FLAG_KEYS is exported as a frozen array', () => {
    expect(Array.isArray(FEATURE_FLAG_KEYS)).toBe(true);
    expect(Object.isFrozen(FEATURE_FLAG_KEYS)).toBe(true);
    expect(FEATURE_FLAG_KEYS.length).toBeGreaterThan(0);
  });

  test('#1306 FEATURE_FLAG_KEYS contains all expected flag keys', () => {
    const expected = [
      'ESCROW_INDEXER_ENABLED',
      'ESCROW_READ_PROJECTION_ENABLED',
      'INVOICE_STATE_ENABLED',
      'CONFIG_RUNTIME_ENABLED',
      'KYC_WEBHOOK_ENABLED',
      'CURSOR_TTL_ENABLED',
      'METRICS_ENABLED',
    ];
    expected.forEach(key => {
      expect(FEATURE_FLAG_KEYS).toContain(key);
    });
  });

  test('#1306 getFeatureFlag is exported as a function', () => {
    expect(typeof getFeatureFlag).toBe('function');
  });

  // ── getFeatureFlag() — success paths ──────────────────────────────────────

  test('#1306 getFeatureFlag returns true when flag is "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.ESCROW_READ_PROJECTION_ENABLED = 'true';
      const { validate: v, getFeatureFlag: gff } = require('./index');
      v();
      expect(gff('ESCROW_READ_PROJECTION_ENABLED')).toBe(true);
    });
  });

  test('#1306 getFeatureFlag returns false when flag is "false"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.ESCROW_READ_PROJECTION_ENABLED = 'false';
      const { validate: v, getFeatureFlag: gff } = require('./index');
      v();
      expect(gff('ESCROW_READ_PROJECTION_ENABLED')).toBe(false);
    });
  });

  test('#1306 getFeatureFlag returns native boolean (not string)', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.METRICS_ENABLED = 'true';
      const { validate: v, getFeatureFlag: gff } = require('./index');
      v();
      const result = gff('METRICS_ENABLED');
      expect(typeof result).toBe('boolean');
      expect(result).toBe(true);
    });
  });

  test('#1306 getFeatureFlag works for all keys in FEATURE_FLAG_KEYS', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, getFeatureFlag: gff, FEATURE_FLAG_KEYS: fk } = require('./index');
      v();
      fk.forEach(key => {
        const val = gff(key);
        expect(typeof val).toBe('boolean');
      });
    });
  });

  test('#1306 getFeatureFlag returns false for flags that default to "false"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, getFeatureFlag: gff } = require('./index');
      v();
      expect(gff('ESCROW_INDEXER_ENABLED')).toBe(false);
      expect(gff('KYC_WEBHOOK_ENABLED')).toBe(false);
      expect(gff('CURSOR_TTL_ENABLED')).toBe(false);
    });
  });

  test('#1306 getFeatureFlag returns true for flags that default to "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, getFeatureFlag: gff } = require('./index');
      v();
      expect(gff('ESCROW_READ_PROJECTION_ENABLED')).toBe(true);
      expect(gff('INVOICE_STATE_ENABLED')).toBe(true);
      expect(gff('CONFIG_RUNTIME_ENABLED')).toBe(true);
      expect(gff('METRICS_ENABLED')).toBe(true);
    });
  });

  // ── getFeatureFlag() — error paths ────────────────────────────────────────

  test('#1306 getFeatureFlag throws TypeError for an unknown key', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, getFeatureFlag: gff } = require('./index');
      v();
      expect(() => gff('NOT_A_FLAG')).toThrow(TypeError);
    });
  });

  test('#1306 getFeatureFlag TypeError message names the invalid key', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, getFeatureFlag: gff } = require('./index');
      v();
      expect(() => gff('BAD_KEY')).toThrow(/BAD_KEY/);
    });
  });

  test('#1306 getFeatureFlag throws before validate() is called', () => {
    jest.isolateModules(() => {
      const { getFeatureFlag: gff } = require('./index');
      expect(() => gff('METRICS_ENABLED')).toThrow(/Config not validated/i);
    });
  });

  // ── Backwards compatibility: getValue() still works for flags ─────────────

  test('#1306 existing callers using getValue() for feature flags still work', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.ESCROW_READ_PROJECTION_ENABLED = 'false';
      const { validate: v, getValue: gv } = require('./index');
      v();
      // Pattern used by existing callers before getFeatureFlag() was added.
      const enabled = getValue('ESCROW_READ_PROJECTION_ENABLED') === 'true';
      expect(enabled).toBe(false);
    });
  });

  test('#1306 getValue() and getFeatureFlag() agree on flag values', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.METRICS_ENABLED = 'false';
      const { validate: v, getValue: gv, getFeatureFlag: gff } = require('./index');
      v();
      const viaGetValue = gv('METRICS_ENABLED') === 'true';
      const viaGetFeatureFlag = gff('METRICS_ENABLED');
      expect(viaGetValue).toBe(viaGetFeatureFlag);
    });
  });

  // ── securityHeaders contract ───────────────────────────────────────────────

  test('#1306 securityHeaders.contentSecurityPolicy.directives.defaultSrc is ["\'self\'"]', () => {
    expect(securityHeaders.contentSecurityPolicy.directives.defaultSrc).toEqual(["'self'"]);
  });

  test('#1306 securityHeaders.hsts has correct maxAge', () => {
    expect(securityHeaders.hsts.maxAge).toBe(31536000);
    expect(securityHeaders.hsts.includeSubDomains).toBe(true);
    expect(securityHeaders.hsts.preload).toBe(true);
  });

  test('#1306 securityHeaders.docsContentSecurityPolicy allows unsafe-inline for scripts', () => {
    expect(securityHeaders.docsContentSecurityPolicy.directives.scriptSrc)
      .toContain("'unsafe-inline'");
  });

  // ── InvoiceFileMaxSizeSchema contract ─────────────────────────────────────

  test('#1306 InvoiceFileMaxSizeSchema.parse returns default "5mb" for undefined', () => {
    expect(InvoiceFileMaxSizeSchema.parse(undefined)).toBe('5mb');
  });

  test('#1306 InvoiceFileMaxSizeSchema accepts valid size strings', () => {
    expect(InvoiceFileMaxSizeSchema.parse('512kb')).toBe('512kb');
    expect(InvoiceFileMaxSizeSchema.parse('1mb')).toBe('1mb');
    expect(InvoiceFileMaxSizeSchema.parse('2gb')).toBe('2gb');
  });

  test('#1306 InvoiceFileMaxSizeSchema rejects invalid strings', () => {
    expect(() => InvoiceFileMaxSizeSchema.parse('not-a-size')).toThrow();
    expect(() => InvoiceFileMaxSizeSchema.parse('5')).toThrow();
  });

  // ── Original regression tests ─────────────────────────────────────────────

  test('validates minimal config with defaults', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      const cfg = v();
      expect(cfg.NODE_ENV).toBe('development');
      expect(cfg.PORT).toBe(3001);
    });
  });

  test('overrides defaults', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PORT = '8080';
      process.env.JWT_ISSUER = 'custom-issuer';
      process.env.JWT_AUDIENCE = 'custom-audience';
      process.env.JWT_ALGORITHMS = 'HS256,HS384';
      process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';
      const { validate: v } = require('./index');
      const cfg = v();
      expect(cfg.PORT).toBe(8080);
      expect(cfg.JWT_ISSUER).toBe('custom-issuer');
    });
  });

  test('rejects short JWT_SECRET', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'too-short';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow();
    });
  });

  test('rejects invalid NODE_ENV', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.NODE_ENV = 'invalid';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow();
    });
  });

  test('get() throws if not validated', () => {
    jest.isolateModules(() => {
      const { get: g } = require('./index');
      expect(() => g()).toThrow(/Config not validated/i);
    });
  });

  test('logRedactedSummary does not expose secret values', () => {
    jest.isolateModules(() => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.JWT_SECRET = 'short';
      process.env.KYC_PROVIDER_API_KEY = 'some-secret-key-1234';
      const { validate: v, logRedactedSummary: lrs } = require('./index');
      let err;
      try { v(); } catch (e) { err = e; }
      lrs(err);
      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('JWT_SECRET');
      expect(output).not.toContain('some-secret-key-1234');
      consoleSpy.mockRestore();
    });
  });

  test('rejects half-set KYC in non-test env', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';
      process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
      delete process.env.KYC_PROVIDER_API_KEY;
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/KYC_PROVIDER_API_KEY/i);
    });
  });

  test('rejects missing PUBLIC_API_BASE_URL in production', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      delete process.env.PUBLIC_API_BASE_URL;
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/PUBLIC_API_BASE_URL must be set in production/i);
    });
  });

  test('rejects non-HTTPS PUBLIC_API_BASE_URL in production', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PUBLIC_API_BASE_URL = 'http://api.example.com';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/must use HTTPS/i);
    });
  });

  test('rejects loopback PUBLIC_API_BASE_URL in production', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PUBLIC_API_BASE_URL = 'https://localhost:3001';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/must not be a loopback address/i);
    });
  });

  test('accepts a valid HTTPS non-loopback PUBLIC_API_BASE_URL in production', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PUBLIC_API_BASE_URL = 'https://api.liquifact.com';
      const { validate: v } = require('./index');
      expect(v().PUBLIC_API_BASE_URL).toBe('https://api.liquifact.com');
    });
  });

  test('schema direct parse', () => {
    const result = ConfigSchema.parse({
      NODE_ENV: 'test',
      PORT: 3001,
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(result).toMatchObject({ NODE_ENV: 'test', PORT: 3001 });
  });

  test('getInvoiceFileMaxSize falls back to env before validation', () => {
    jest.isolateModules(() => {
      process.env.INVOICE_FILE_MAX_SIZE = '512kb';
      const { getInvoiceFileMaxSize: gifs } = require('./index');
      expect(gifs()).toBe('512kb');
    });
  });

  test('ESCROW_READ_PROJECTION_ENABLED defaults to "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().ESCROW_READ_PROJECTION_ENABLED).toBe('true');
    });
  });

  test('ESCROW_INDEXER_ENABLED defaults to "false"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().ESCROW_INDEXER_ENABLED).toBe('false');
    });
  });

  test('CONFIG_RUNTIME_ENABLED defaults to "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().CONFIG_RUNTIME_ENABLED).toBe('true');
    });
  });

  test('INVOICE_STATE_ENABLED defaults to "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().INVOICE_STATE_ENABLED).toBe('true');
    });
  });
});
