'use strict';

const { validate: validateConfig } = require('../src/config');
const {
  resolveEscrowAddress,
  clearCache,
  getCacheStats,
  invalidateEscrowCache,
  invalidateEscrowCacheByEnvironment,
} = require('../src/config/escrowMap');

describe('escrow mapping cache', () => {
  const originalEnv = process.env;
  const validStellarAddress = `G${'A'.repeat(55)}`;
  const validStellarAddress2 = `G${'B'.repeat(55)}`;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'development';
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [
        {
          invoiceId: 'inv_dev_001',
          escrowAddress: validStellarAddress,
          environment: 'development',
          isActive: true,
        },
        {
          invoiceId: 'inv_dev_002',
          escrowAddress: validStellarAddress2,
          environment: 'development',
          isActive: true,
        },
      ],
      allowlistEnabled: true,
      cacheEnabled: true,
      cacheTtlSeconds: 300,
    });
    process.env.ESCROW_CACHE_MAX_ENTRIES = '1';
    clearCache();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('cold cache, hit, invalidation, and eviction are tracked', () => {
    const coldStats = getCacheStats();
    expect(coldStats.size).toBe(0);
    expect(coldStats.hits).toBe(0);
    expect(coldStats.misses).toBe(0);

    expect(resolveEscrowAddress('inv_dev_001')).toBe(validStellarAddress);
    expect(getCacheStats().misses).toBe(1);

    expect(resolveEscrowAddress('inv_dev_001')).toBe(validStellarAddress);
    expect(getCacheStats().hits).toBe(1);

    expect(invalidateEscrowCache('inv_dev_001')).toBe(true);
    expect(getCacheStats().size).toBe(0);

    expect(resolveEscrowAddress('inv_dev_001')).toBe(validStellarAddress);
    expect(resolveEscrowAddress('inv_dev_002')).toBe(validStellarAddress2);
    expect(getCacheStats().size).toBe(1);

    expect(invalidateEscrowCacheByEnvironment('development')).toBe(1);
    expect(getCacheStats().size).toBe(0);
  });
});
