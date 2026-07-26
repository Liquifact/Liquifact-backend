/**
 * Tests for centralized config module.
 */

const {
  validate,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  ConfigSchema,
} = require('./index');

describe('Config Validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear module cache and reset config
    delete require.cache[require.resolve('./index')];
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('validates minimal config with defaults', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'this-is-a-32-char-secret-for-testing-only-do-not-use-in-prod';

    const config = validate();
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3001);
    expect(config.JWT_SECRET).toBe(process.env.JWT_SECRET);
    // JWT_ISSUER/JWT_AUDIENCE are optional with no default — enforcement in
    // src/middleware/auth.js is conditional on these being explicitly set.
    expect(config.JWT_ISSUER).toBeUndefined();
    expect(config.JWT_AUDIENCE).toBeUndefined();
    expect(config.JWT_ALGORITHMS).toBe('HS256');
  });

  test('overrides defaults', () => {
    process.env.PORT = '8080';
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'prod-secret-32-chars-minimum-required';
    process.env.JWT_ISSUER = 'custom-issuer';
    process.env.JWT_AUDIENCE = 'custom-audience';
    process.env.JWT_ALGORITHMS = 'HS256,HS384';
    // Required in production by the PUBLIC_API_BASE_URL superRefine rule.
    process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';

    const config = validate();
    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('production');
    expect(config.JWT_ISSUER).toBe('custom-issuer');
    expect(config.JWT_AUDIENCE).toBe('custom-audience');
    expect(config.JWT_ALGORITHMS).toBe('HS256,HS384');
  });

  test('rejects short JWT_SECRET', () => {
    process.env.JWT_SECRET = 'too-short';
    expect(() => validate()).toThrow(/string/i);
  });

  test('rejects invalid PORT', () => {
    process.env.PORT = 'invalid';
    expect(() => validate()).toThrow(/number/i);
  });

  test('rejects invalid NODE_ENV', () => {
    process.env.NODE_ENV = 'invalid';
    expect(() => validate()).toThrow(/invalid/i);
  });

  test('logRedactedSummary output does not contain secrets', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    process.env.JWT_SECRET = 'short';
    process.env.KYC_PROVIDER_API_KEY = 'some-secret-key-1234';

    let caughtError;
    try {
      validate();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    logRedactedSummary(caughtError);

    const loggedOutput = consoleSpy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(loggedOutput).toContain('JWT_SECRET');
    expect(loggedOutput).not.toContain('some-secret-key-1234');
    expect(loggedOutput).not.toContain('short');

    consoleSpy.mockRestore();
  });

  test('boot validation gate exits on invalid config', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'short-secret';
      
      const { startServer } = require('../index');
      startServer();
      
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  test('boot validation gate does not exit on valid config', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    jest.isolateModules(() => {
      const app = require('../app');
      const listenSpy = jest.spyOn(app, 'listen').mockImplementation(() => ({}));

      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
      // Required in production by the PUBLIC_API_BASE_URL superRefine rule.
      process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';

      const { startServer } = require('../index');
      startServer();

      expect(exitSpy).not.toHaveBeenCalled();
      listenSpy.mockRestore();
    });

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  test('rejects half-set KYC configuration in non-test env', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    delete process.env.KYC_PROVIDER_API_KEY;
    expect(() => validate()).toThrow(/KYC_PROVIDER_API_KEY/i);

    delete process.env.KYC_PROVIDER_URL;
    process.env.KYC_PROVIDER_API_KEY = 'some-key';
    expect(() => validate()).toThrow(/KYC_PROVIDER_URL/i);
  });

  test('rejects missing PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    delete process.env.PUBLIC_API_BASE_URL;

    expect(() => validate()).toThrow(/PUBLIC_API_BASE_URL must be set in production/i);
  });

  test('rejects non-HTTPS PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PUBLIC_API_BASE_URL = 'http://api.example.com';

    expect(() => validate()).toThrow(/must use HTTPS/i);
  });

  test('rejects loopback PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PUBLIC_API_BASE_URL = 'https://localhost:3001';

    expect(() => validate()).toThrow(/must not be a loopback address/i);
  });

  test('accepts a valid HTTPS non-loopback PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PUBLIC_API_BASE_URL = 'https://api.liquifact.com';

    const config = validate();
    expect(config.PUBLIC_API_BASE_URL).toBe('https://api.liquifact.com');
  });

  test('allows half-set KYC configuration in test env', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    delete process.env.KYC_PROVIDER_API_KEY;
    
    const config = validate();
    expect(config.KYC_PROVIDER_URL).toBe('https://kyc.example.com');
    expect(config.KYC_PROVIDER_API_KEY).toBeUndefined();
  });

  test('get() throws if not validated', () => {
    jest.isolateModules(() => {
      const { get: getFresh } = require('./index');
      expect(() => getFresh()).toThrow(/validated/i);
    });
  });

  test('schema type safety', () => {
    const result = ConfigSchema.parse({
      NODE_ENV: 'test',
      PORT: 3001,
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(result).toMatchObject({ NODE_ENV: 'test', PORT: 3001 });
  });

  test('exports securityHeaders config object', () => {
    const { securityHeaders } = require('./index');
    expect(securityHeaders).toBeDefined();
    expect(securityHeaders.contentSecurityPolicy).toBeDefined();
    expect(securityHeaders.docsContentSecurityPolicy).toBeDefined();
  });

  test('logRedactedSummary handles non-ZodError or empty error gracefully', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    logRedactedSummary(new Error('Some generic error'));
    expect(consoleSpy).toHaveBeenCalledWith('Some generic error');
    
    consoleSpy.mockClear();
    logRedactedSummary(null);
    expect(consoleSpy).toHaveBeenCalledWith('Unknown configuration error');
    
    consoleSpy.mockRestore();
  });

  test('get() returns config when validated', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    
    validate();
    const config = get();
    expect(config).toBeDefined();
    expect(config.NODE_ENV).toBe('test');
  });

  test('typed accessors return validated and coerced values', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PORT = '4321';
    process.env.INVOICE_FILE_MAX_SIZE = '2mb';
    validate();
    expect(getValue('PORT')).toBe(4321);
    expect(getInvoiceFileMaxSize()).toBe('2mb');
  });

  test('typed accessor preserves a missing optional value', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    delete process.env.PUBLIC_API_BASE_URL;
    validate();
    expect(getValue('PUBLIC_API_BASE_URL')).toBeUndefined();
  });

  test('upload limit accessor uses the validated default before boot validation', () => {
    jest.isolateModules(() => {
      delete process.env.INVOICE_FILE_MAX_SIZE;
      const { getInvoiceFileMaxSize: getFreshLimit } = require('./index');
      expect(getFreshLimit()).toBe('5mb');
    });
  });

  test('rejects an invalid route value during boot validation', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.INVOICE_FILE_MAX_SIZE = 'unbounded';
    expect(() => validate()).toThrow(/INVOICE_FILE_MAX_SIZE/i);
  });

  test('upload limit accessor rejects invalid values before full validation', () => {
    jest.isolateModules(() => {
      process.env.INVOICE_FILE_MAX_SIZE = '-1mb';
      const { getInvoiceFileMaxSize: getFreshLimit } = require('./index');
      expect(() => getFreshLimit()).toThrow(/INVOICE_FILE_MAX_SIZE/i);
    });
  });

  test('INVOICE_STATE_ENABLED defaults to true', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    delete process.env.INVOICE_STATE_ENABLED;
    const config = validate();
    expect(config.INVOICE_STATE_ENABLED).toBe('true');
  });

  test('INVOICE_STATE_ENABLED accepts false', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.INVOICE_STATE_ENABLED = 'false';
    const config = validate();
    expect(config.INVOICE_STATE_ENABLED).toBe('false');
  });

  test('INVOICE_STATE_ENABLED rejects invalid values', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.INVOICE_STATE_ENABLED = 'yes';
    expect(() => validate()).toThrow(/INVOICE_STATE_ENABLED/i);
  });

  test('empty optional strings are accepted (JWT_ISSUER, JWT_AUDIENCE, CORS_ALLOWED_ORIGINS)', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.JWT_ISSUER = '';
    process.env.JWT_AUDIENCE = '';
    process.env.CORS_ALLOWED_ORIGINS = '';

    const config = validate();
    expect(config.JWT_ISSUER).toBe('');
    expect(config.JWT_AUDIENCE).toBe('');
    expect(config.CORS_ALLOWED_ORIGINS).toBe('');
  });

  test('whitespace-only JWT_SECRET passes min-length check', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = ' '.repeat(32);

    const config = validate();
    expect(config.JWT_SECRET).toBe(' '.repeat(32));
  });

  test('PORT boundary values 1 and 65535 are accepted', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PORT = '1';
    expect(validate().PORT).toBe(1);

    process.env.PORT = '65535';
    expect(validate().PORT).toBe(65535);
  });

  test('empty string for enum fields is rejected', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.CURSOR_TTL_ENABLED = '';
    expect(() => validate()).toThrow(/Invalid option/i);
  });

  test('getInvoiceFileMaxSize falls back to default when unset before validation', () => {
    jest.isolateModules(() => {
      delete process.env.INVOICE_FILE_MAX_SIZE;
      const { getInvoiceFileMaxSize: getFreshLimit } = require('./index');
      expect(getFreshLimit()).toBe('5mb');
    });
  });
});

