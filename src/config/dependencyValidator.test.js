const { validateDependencies, DependencyConfigSchema } = require('./dependencyValidator');
const { logRedactedSummary } = require('./index');

describe('Boot-time Dependency Validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('passes with valid production dependencies', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_ESCROW_CACHE_ENABLED = 'true';
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.ESCROW_SIGNING_MODE = 'custodial';
    process.env.ESCROW_PLATFORM_SECRET = 'secret123';

    expect(() => validateDependencies()).not.toThrow();
  });

  test('edge case: missing required variable', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = ''; // Missing in production

    expect(() => validateDependencies()).toThrow(/DATABASE_URL is required in production/);
  });

  test('edge case: missing credentials in database URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://localhost:5432/db'; // No user/pass

    expect(() => validateDependencies()).toThrow(/DATABASE_URL must include credentials in production/);
  });

  test('edge case: invalid URL', () => {
    process.env.NODE_ENV = 'development';
    process.env.REDIS_URL = 'http://localhost:6379'; // Invalid protocol for Redis

    expect(() => validateDependencies()).toThrow(/REDIS_URL must use redis: or rediss: protocol/);
  });

  test('edge case: conflicting flags', () => {
    process.env.NODE_ENV = 'development';
    process.env.STORAGE_IN_MEMORY = 'true';
    process.env.AWS_ACCESS_KEY_ID = 'should-conflict';

    expect(() => validateDependencies()).toThrow(/STORAGE_IN_MEMORY cannot be true when AWS credentials are provided/);
  });

  test('edge case: optional dependency absent', () => {
    process.env.NODE_ENV = 'development';
    process.env.REDIS_ESCROW_CACHE_ENABLED = 'true';
    delete process.env.REDIS_URL;

    expect(() => validateDependencies()).toThrow(/REDIS_URL is required when REDIS_ESCROW_CACHE_ENABLED is true/);
  });

  test('edge case: optional dependency absent (custodial mode)', () => {
    process.env.NODE_ENV = 'development';
    process.env.ESCROW_SIGNING_MODE = 'custodial';
    delete process.env.ESCROW_PLATFORM_SECRET;

    expect(() => validateDependencies()).toThrow(/ESCROW_PLATFORM_SECRET is required when ESCROW_SIGNING_MODE is custodial/);
  });

  test('edge case: secret-like value in error output', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    // Provide a valid URL that triggers a different validation error, but ensure
    // the password doesn't get logged if it throws a schema error.
    process.env.DATABASE_URL = 'postgres://user:supersecretpassword@localhost:5432/db';
    process.env.REDIS_ESCROW_CACHE_ENABLED = 'true';
    delete process.env.REDIS_URL; // Triggers an error

    let caughtError;
    try {
      validateDependencies();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    
    // We use the existing logRedactedSummary to print
    logRedactedSummary(caughtError);
    
    const loggedOutput = consoleSpy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(loggedOutput).toContain('REDIS_URL');
    expect(loggedOutput).not.toContain('supersecretpassword');

    consoleSpy.mockRestore();
  });
});
