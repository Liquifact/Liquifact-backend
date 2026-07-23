/**
 * Tests for centralized config module.
 */

const { validate, get, getInvoiceFileMaxSize, logRedactedSummary, ConfigSchema } = require('./index');

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
    expect(config.JWT_ISSUER).toBe('liquifact-platform');
    expect(config.JWT_AUDIENCE).toBe('liquifact-client');
    expect(config.JWT_ALGORITHMS).toBe('HS256');
    expect(config.INVOICE_FILE_MAX_SIZE).toBe('5mb');
  });

  test('overrides defaults', () => {
    process.env.PORT = '8080';
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'prod-secret-32-chars-minimum-required';
    process.env.JWT_ISSUER = 'custom-issuer';
    process.env.JWT_AUDIENCE = 'custom-audience';
    process.env.JWT_ALGORITHMS = 'HS256,HS384';

    const config = validate();
    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('production');
    expect(config.JWT_ISSUER).toBe('custom-issuer');
    expect(config.JWT_AUDIENCE).toBe('custom-audience');
    expect(config.JWT_ALGORITHMS).toBe('HS256,HS384');
  });

  test('validates and exposes a custom invoice file size through the typed accessor', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.INVOICE_FILE_MAX_SIZE = '10mb';

    validate();

    expect(getInvoiceFileMaxSize()).toBe('10mb');
  });

  test('resolves the invoice file size before boot validation', () => {
    jest.isolateModules(() => {
      process.env.INVOICE_FILE_MAX_SIZE = '2mb';
      const { getInvoiceFileMaxSize: resolveInvoiceFileMaxSize } = require('./index');

      expect(resolveInvoiceFileMaxSize()).toBe('2mb');
    });
  });

  test('rejects an empty invoice file size at boot validation', () => {
    process.env.INVOICE_FILE_MAX_SIZE = '';

    expect(() => validate()).toThrow(/INVOICE_FILE_MAX_SIZE/);
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
});

