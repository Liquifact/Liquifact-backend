describe('cacheConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses default TTL of 30000ms when env var is not set', () => {
    delete process.env.ESCROW_CACHE_TTL_SECONDS;
    const { cacheConfig } = require('./cache');
    expect(cacheConfig.escrowTtl).toBe(30000);
  });

  it('parses ESCROW_CACHE_TTL_SECONDS from env and converts to ms', () => {
    process.env.ESCROW_CACHE_TTL_SECONDS = '60';
    const { cacheConfig } = require('./cache');
    expect(cacheConfig.escrowTtl).toBe(60000);
  });

  it('falls back to default when env var is not a valid number', () => {
    process.env.ESCROW_CACHE_TTL_SECONDS = 'abc';
    const { cacheConfig } = require('./cache');
    expect(cacheConfig.escrowTtl).toBe(30000);
  });
});
