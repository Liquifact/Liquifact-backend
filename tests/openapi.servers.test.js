'use strict';

/**
 * @fileoverview Comprehensive tests for the OpenAPI server URL derivation logic
 * introduced in `src/openapi/openapiSpec.js`.
 *
 * Covers:
 *  - Dev/test fallback when PUBLIC_API_BASE_URL is absent
 *  - Explicit URL in development and test environments
 *  - Trailing-slash normalisation
 *  - Production: valid HTTPS URL accepted
 *  - Production: HTTP URL rejected (defense-in-depth guard)
 *  - Production: loopback hostnames rejected (localhost, 127.x.x.x, ::1)
 *  - Production: missing URL rejects with informative error
 *  - Production: malformed URL rejected
 *  - Config `get()` integration — prefers validated config over raw env
 *  - buildOpenApiSpec() injects servers correctly and respects the cache
 *  - buildOpenApiSpec() cache is invalidated by _resetCache()
 *  - The existing openapi.test.js assertions still pass (servers defined + array)
 */

const { buildServers, buildOpenApiSpec, _resetCache } = require('../src/openapi/openapiSpec');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `process.env.NODE_ENV` temporarily set to `env`.
 * Restores the original value — and deletes PUBLIC_API_BASE_URL — afterwards.
 *
 * @param {string} env - NODE_ENV value to use.
 * @param {string|undefined} baseUrl - Value for PUBLIC_API_BASE_URL, or
 *   undefined to leave it unset.
 * @param {Function} fn - Callback to execute in the patched environment.
 * @returns {*} Return value of fn().
 */
function withEnv(env, baseUrl, fn) {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBaseUrl = process.env.PUBLIC_API_BASE_URL;

  process.env.NODE_ENV = env;
  if (baseUrl !== undefined) {
    process.env.PUBLIC_API_BASE_URL = baseUrl;
  } else {
    delete process.env.PUBLIC_API_BASE_URL;
  }

  try {
    return fn();
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBaseUrl !== undefined) {
      process.env.PUBLIC_API_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.PUBLIC_API_BASE_URL;
    }
  }
}

// ---------------------------------------------------------------------------
// Mock the config `get()` call so we can control what buildServers sees
// without a full validate() cycle.  The real setup.js already called
// validate() with NODE_ENV=test and no PUBLIC_API_BASE_URL, so the cached
// config object has PUBLIC_API_BASE_URL=undefined.  We jest.mock the module
// here so each test can specify exactly what get() returns.
// ---------------------------------------------------------------------------

jest.mock('../src/config', () => {
  const original = jest.requireActual('../src/config');
  return {
    ...original,
    get: jest.fn(),
  };
});

const configModule = require('../src/config');

/**
 * Make `config.get()` return a config object with the given PUBLIC_API_BASE_URL.
 * Pass `null` to make get() throw (simulating "not yet validated").
 *
 * @param {string|undefined|null} publicApiBaseUrl
 */
function mockConfigGet(publicApiBaseUrl) {
  if (publicApiBaseUrl === null) {
    configModule.get.mockImplementation(() => {
      throw new Error('Config not validated');
    });
  } else {
    configModule.get.mockReturnValue({ PUBLIC_API_BASE_URL: publicApiBaseUrl });
  }
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('buildServers()', () => {
  // Always reset the spec cache and restore the mock before each test so tests
  // are fully isolated.
  beforeEach(() => {
    _resetCache();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Development environment
  // -------------------------------------------------------------------------
  describe('development environment', () => {
    it('returns the localhost fallback when PUBLIC_API_BASE_URL is absent', () => {
      mockConfigGet(undefined);
      const servers = withEnv('development', undefined, () => buildServers());

      expect(servers).toHaveLength(1);
      expect(servers[0].url).toBe('http://localhost:3001');
      expect(servers[0].description).toBe('Local development');
    });

    it('uses PUBLIC_API_BASE_URL from validated config when present', () => {
      mockConfigGet('http://localhost:4000');
      const servers = withEnv('development', undefined, () => buildServers());

      expect(servers).toHaveLength(1);
      expect(servers[0].url).toBe('http://localhost:4000');
      expect(servers[0].description).toBe('API server');
    });

    it('falls back to process.env when config.get() throws', () => {
      mockConfigGet(null); // simulates pre-validation
      const servers = withEnv('development', 'http://localhost:8080', () => buildServers());

      expect(servers).toHaveLength(1);
      expect(servers[0].url).toBe('http://localhost:8080');
    });

    it('strips a trailing slash from the base URL', () => {
      mockConfigGet('http://localhost:4000/');
      const servers = withEnv('development', undefined, () => buildServers());

      expect(servers[0].url).toBe('http://localhost:4000');
    });

    it('strips multiple trailing slashes', () => {
      mockConfigGet('http://localhost:4000///');
      const servers = withEnv('development', undefined, () => buildServers());

      expect(servers[0].url).toBe('http://localhost:4000');
    });

    it('accepts an HTTP loopback URL in development without throwing', () => {
      mockConfigGet('http://127.0.0.1:3001');
      expect(() => withEnv('development', undefined, () => buildServers())).not.toThrow();
    });

    it('accepts an HTTP URL in development (no HTTPS requirement)', () => {
      mockConfigGet('http://dev.internal.example.com');
      expect(() => withEnv('development', undefined, () => buildServers())).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Test environment
  // -------------------------------------------------------------------------
  describe('test environment', () => {
    it('returns the localhost fallback when PUBLIC_API_BASE_URL is absent', () => {
      mockConfigGet(undefined);
      const servers = withEnv('test', undefined, () => buildServers());

      expect(servers).toHaveLength(1);
      expect(servers[0].url).toBe('http://localhost:3001');
    });

    it('uses PUBLIC_API_BASE_URL when set in test env', () => {
      mockConfigGet('https://api.test.example.com');
      const servers = withEnv('test', undefined, () => buildServers());

      expect(servers[0].url).toBe('https://api.test.example.com');
      expect(servers[0].description).toBe('Test server');
    });

    it('falls back to process.env when config.get() throws in test env', () => {
      mockConfigGet(null);
      const servers = withEnv('test', 'https://api.ci.example.com', () => buildServers());

      expect(servers[0].url).toBe('https://api.ci.example.com');
    });
  });

  // -------------------------------------------------------------------------
  // Production environment — valid URLs
  // -------------------------------------------------------------------------
  describe('production environment — valid HTTPS URLs', () => {
    it('accepts a plain HTTPS URL', () => {
      mockConfigGet('https://api.liquifact.com');
      const servers = withEnv('production', undefined, () => buildServers());

      expect(servers).toHaveLength(1);
      expect(servers[0].url).toBe('https://api.liquifact.com');
      expect(servers[0].description).toBe('Production API');
    });

    it('accepts an HTTPS URL with a path prefix', () => {
      mockConfigGet('https://api.liquifact.com/v1');
      const servers = withEnv('production', undefined, () => buildServers());

      expect(servers[0].url).toBe('https://api.liquifact.com/v1');
    });

    it('strips trailing slash from production HTTPS URL', () => {
      mockConfigGet('https://api.liquifact.com/');
      const servers = withEnv('production', undefined, () => buildServers());

      expect(servers[0].url).toBe('https://api.liquifact.com');
    });

    it('accepts an HTTPS URL with a non-standard port', () => {
      mockConfigGet('https://api.internal.liquifact.com:8443');
      const servers = withEnv('production', undefined, () => buildServers());

      expect(servers[0].url).toBe('https://api.internal.liquifact.com:8443');
    });

    it('prefers config.get() over process.env in production', () => {
      mockConfigGet('https://api.primary.liquifact.com');
      // Env has a different value — config should win
      const servers = withEnv('production', 'https://api.env.liquifact.com', () => buildServers());

      expect(servers[0].url).toBe('https://api.primary.liquifact.com');
    });

    it('falls back to process.env when config.get() throws in production', () => {
      mockConfigGet(null);
      const servers = withEnv('production', 'https://api.liquifact.com', () => buildServers());

      expect(servers[0].url).toBe('https://api.liquifact.com');
    });
  });

  // -------------------------------------------------------------------------
  // Production environment — rejected cases
  // -------------------------------------------------------------------------
  describe('production environment — rejected configurations', () => {
    it('throws when PUBLIC_API_BASE_URL is absent in production', () => {
      mockConfigGet(undefined);
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow(
        /PUBLIC_API_BASE_URL is required in production/,
      );
    });

    it('throws when PUBLIC_API_BASE_URL is an empty string in production', () => {
      mockConfigGet(null); // config.get() throws; empty env string treated as unset
      expect(() => withEnv('production', '', () => buildServers())).toThrow(
        /PUBLIC_API_BASE_URL is required in production/,
      );
    });

    it('throws when PUBLIC_API_BASE_URL uses HTTP (not HTTPS) in production', () => {
      mockConfigGet('http://api.liquifact.com');
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow(
        /must use HTTPS in production/,
      );
    });

    it('throws when HTTP URL comes from process.env in production', () => {
      mockConfigGet(null);
      expect(() => withEnv('production', 'http://api.liquifact.com', () => buildServers())).toThrow(
        /must use HTTPS in production/,
      );
    });

    it('throws for localhost in production', () => {
      mockConfigGet('https://localhost:3001');
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow(
        /must not be a loopback address in production/,
      );
    });

    it('throws for 127.0.0.1 in production', () => {
      mockConfigGet('https://127.0.0.1:3001');
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow(
        /must not be a loopback address in production/,
      );
    });

    it('throws for 127.1.2.3 in production', () => {
      mockConfigGet('https://127.1.2.3');
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow(
        /must not be a loopback address in production/,
      );
    });

    it('throws for ::1 (IPv6 loopback) in production', () => {
      mockConfigGet('https://[::1]:3001');
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow(
        /must not be a loopback address in production/,
      );
    });

    it('throws for a malformed URL in production', () => {
      mockConfigGet('not-a-valid-url');
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow(
        /PUBLIC_API_BASE_URL is not a valid URL in production/,
      );
    });

    it('throws for a URL with no protocol in production', () => {
      mockConfigGet('api.liquifact.com');
      expect(() => withEnv('production', undefined, () => buildServers())).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Return shape invariants
  // -------------------------------------------------------------------------
  describe('return shape', () => {
    it('always returns a non-empty array', () => {
      mockConfigGet(undefined);
      const servers = withEnv('development', undefined, () => buildServers());
      expect(Array.isArray(servers)).toBe(true);
      expect(servers.length).toBeGreaterThan(0);
    });

    it('every entry has a non-empty url string', () => {
      mockConfigGet('https://api.liquifact.com');
      const servers = withEnv('production', undefined, () => buildServers());
      for (const entry of servers) {
        expect(typeof entry.url).toBe('string');
        expect(entry.url.length).toBeGreaterThan(0);
      }
    });

    it('every entry has a non-empty description string', () => {
      mockConfigGet(undefined);
      const servers = withEnv('development', undefined, () => buildServers());
      for (const entry of servers) {
        expect(typeof entry.description).toBe('string');
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// buildOpenApiSpec() integration
// ---------------------------------------------------------------------------

describe('buildOpenApiSpec() server injection', () => {
  beforeEach(() => {
    _resetCache();
    jest.clearAllMocks();
  });

  it('injects the dev fallback into the built spec when PUBLIC_API_BASE_URL is absent', () => {
    mockConfigGet(undefined);
    const spec = withEnv('development', undefined, () => buildOpenApiSpec());

    expect(spec.servers).toBeDefined();
    expect(Array.isArray(spec.servers)).toBe(true);
    expect(spec.servers).toHaveLength(1);
    expect(spec.servers[0].url).toBe('http://localhost:3001');
  });

  it('injects the configured URL into the built spec', () => {
    mockConfigGet('https://api.liquifact.com');
    const spec = withEnv('production', undefined, () => buildOpenApiSpec());

    expect(spec.servers[0].url).toBe('https://api.liquifact.com');
    expect(spec.servers[0].description).toBe('Production API');
  });

  it('does not mutate baseDefinition.servers when building the spec', () => {
    const { baseDefinition } = require('../src/openapi/openapiSpec');
    const originalServers = baseDefinition.servers;

    mockConfigGet('https://api.liquifact.com');
    withEnv('production', undefined, () => buildOpenApiSpec());

    // baseDefinition.servers must remain the original empty array
    expect(baseDefinition.servers).toBe(originalServers);
    expect(baseDefinition.servers).toEqual([]);
  });

  it('returns a cached result on subsequent calls', () => {
    mockConfigGet(undefined);
    const spec1 = withEnv('development', undefined, () => buildOpenApiSpec());
    const spec2 = withEnv('development', undefined, () => buildOpenApiSpec());

    expect(spec1).toBe(spec2); // same reference — cache hit
  });

  it('_resetCache() forces a fresh build on the next call', () => {
    mockConfigGet(undefined);
    const spec1 = withEnv('development', undefined, () => buildOpenApiSpec());

    _resetCache();

    mockConfigGet('http://localhost:4000');
    const spec2 = withEnv('development', undefined, () => buildOpenApiSpec());

    // Different URLs → definitely a fresh build
    expect(spec2.servers[0].url).toBe('http://localhost:4000');
    expect(spec1.servers[0].url).toBe('http://localhost:3001');
    expect(spec1).not.toBe(spec2);
  });

  it('propagates a production error thrown by buildServers()', () => {
    mockConfigGet(undefined); // no URL configured
    expect(() => withEnv('production', undefined, () => buildOpenApiSpec())).toThrow(
      /PUBLIC_API_BASE_URL is required in production/,
    );
  });

  it('the spec still passes the standard OpenAPI envelope assertions', () => {
    mockConfigGet(undefined);
    const spec = withEnv('development', undefined, () => buildOpenApiSpec());

    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toBe('LiquiFact API');
    expect(spec.info.version).toBe('1.0.0');
    expect(spec.servers).toBeDefined();
    expect(Array.isArray(spec.servers)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config schema integration (Zod validation)
// ---------------------------------------------------------------------------

describe('ConfigSchema PUBLIC_API_BASE_URL validation', () => {
  // Use the real ConfigSchema (not the mocked get()) so we test Zod validation.
  const { ConfigSchema } = require('../src/config');

  const baseEnv = {
    NODE_ENV: 'development',
    JWT_SECRET: 'test-secret-at-least-32-characters-long',
  };

  it('is optional in development', () => {
    const result = ConfigSchema.safeParse({ ...baseEnv });
    expect(result.success).toBe(true);
    expect(result.data.PUBLIC_API_BASE_URL).toBeUndefined();
  });

  it('accepts a valid HTTP URL in development', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      PUBLIC_API_BASE_URL: 'http://localhost:3001',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid HTTPS URL in development', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      PUBLIC_API_BASE_URL: 'https://api.liquifact.com',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL string', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      PUBLIC_API_BASE_URL: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('is optional in test environment (superRefine skipped)', () => {
    const result = ConfigSchema.safeParse({ ...baseEnv, NODE_ENV: 'test' });
    expect(result.success).toBe(true);
  });

  it('fails in production when PUBLIC_API_BASE_URL is absent', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      // No PUBLIC_API_BASE_URL
    });
    expect(result.success).toBe(false);
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('PUBLIC_API_BASE_URL');
  });

  it('fails in production when PUBLIC_API_BASE_URL uses HTTP', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      PUBLIC_API_BASE_URL: 'http://api.liquifact.com',
    });
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/HTTPS/);
  });

  it('fails in production when PUBLIC_API_BASE_URL is localhost', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      PUBLIC_API_BASE_URL: 'https://localhost:3001',
    });
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/loopback/);
  });

  it('fails in production when PUBLIC_API_BASE_URL is 127.0.0.1', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      PUBLIC_API_BASE_URL: 'https://127.0.0.1:3001',
    });
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/loopback/);
  });

  it('fails in production when PUBLIC_API_BASE_URL is ::1', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      PUBLIC_API_BASE_URL: 'https://[::1]',
    });
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/loopback/);
  });

  it('succeeds in production with a valid HTTPS non-loopback URL', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      PUBLIC_API_BASE_URL: 'https://api.liquifact.com',
    });
    expect(result.success).toBe(true);
    expect(result.data.PUBLIC_API_BASE_URL).toBe('https://api.liquifact.com');
  });

  it('provides a human-readable error message when absent in production', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
    });
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/PUBLIC_API_BASE_URL/);
    expect(msg).toMatch(/production/);
  });

  it('provides a human-readable error message for HTTP in production', () => {
    const result = ConfigSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      PUBLIC_API_BASE_URL: 'http://api.liquifact.com',
    });
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/PUBLIC_API_BASE_URL/);
    expect(msg).toMatch(/HTTPS/);
  });
});
