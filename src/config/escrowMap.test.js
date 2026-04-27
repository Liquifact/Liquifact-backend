/**
 * @fileoverview Test suite for escrow address mapping configuration.
 * 
 * Tests invoice-to-escrow contract address resolution functionality including:
 * - Configuration parsing and validation
 * - Environment-specific mapping resolution
 * - Allowlist validation
 * - Caching behavior
 * - Error handling and edge cases
 * 
 * @module config/escrowMap.test
 */

'use strict';

const { validate: validateConfig } = require('./index');
const {
  resolveEscrowAddress,
  isInvoiceAllowlisted,
  getActiveMappings,
  validateMappingConfig,
  clearCache,
  getCacheStats,
  parseEscrowMappingConfig,
  EscrowMappingEntrySchema,
  EscrowMappingConfigSchema
} = require('./escrowMap');

describe('Escrow Address Mapping', () => {
  const originalEnv = process.env;
  const validStellarAddress = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM';
  const validStellarAddress2 = 'GZYXWVUTSRQPONMLKJIHGFEDCBAZYXWVUTSRQPONML';

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    delete process.env.ESCROW_ADDR_BY_INVOICE;
    clearCache();
    
    // Validate config to prevent errors in getCurrentEnvironment()
    try {
      validateConfig();
    } catch (error) {
      // Config validation might fail due to missing JWT_SECRET, but that's ok for tests
      // We'll fall back to NODE_ENV in getCurrentEnvironment()
    }
  });

  afterAll(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Configuration Parsing', () => {
    test('should return default config when ESCROW_ADDR_BY_INVOICE is not set', () => {
      const config = parseEscrowMappingConfig();
      
      expect(config).toEqual({
        mappings: [],
        defaultEnvironment: 'development',
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
    });

    test('should return default config when ESCROW_ADDR_BY_INVOICE is empty string', () => {
      process.env.ESCROW_ADDR_BY_INVOICE = '';
      const config = parseEscrowMappingConfig();
      
      expect(config.mappings).toEqual([]);
      expect(config.defaultEnvironment).toBe('development');
    });

    test('should parse valid JSON configuration', () => {
      const configJson = JSON.stringify({
        mappings: [{
          invoiceId: 'inv_123',
          escrowAddress: validStellarAddress,
          environment: 'development',
          isActive: true
        }],
        defaultEnvironment: 'development',
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = configJson;
      const config = parseEscrowMappingConfig();
      
      expect(config.mappings).toHaveLength(1);
      expect(config.mappings[0].invoiceId).toBe('inv_123');
      expect(config.mappings[0].escrowAddress).toBe(validStellarAddress);
    });

    test('should throw error for invalid JSON', () => {
      process.env.ESCROW_ADDR_BY_INVOICE = 'invalid-json';
      
      expect(() => parseEscrowMappingConfig()).toThrow(
        'Failed to parse ESCROW_ADDR_BY_INVOICE JSON'
      );
    });

    test('should throw error for invalid schema', () => {
      const invalidConfig = JSON.stringify({
        mappings: [{
          invoiceId: '', // Invalid: empty string
          escrowAddress: 'invalid-address', // Invalid: wrong format
          environment: 'invalid-env' // Invalid: not in enum
        }]
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = invalidConfig;
      
      expect(() => parseEscrowMappingConfig()).toThrow(
        'Invalid escrow mapping configuration'
      );
    });
  });

  describe('Address Resolution', () => {
    beforeEach(() => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'inv_dev_001',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          },
          {
            invoiceId: 'inv_prod_001',
            escrowAddress: validStellarAddress2,
            environment: 'production',
            isActive: true
          },
          {
            invoiceId: 'inv_inactive',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: false
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      process.env.NODE_ENV = 'development';
    });

    test('should resolve address for active mapping in current environment', () => {
      const address = resolveEscrowAddress('inv_dev_001');
      expect(address).toBe(validStellarAddress);
    });

    test('should resolve address for specific environment', () => {
      const address = resolveEscrowAddress('inv_prod_001', 'production');
      expect(address).toBe(validStellarAddress2);
    });

    test('should return null for inactive mapping', () => {
      const address = resolveEscrowAddress('inv_inactive');
      expect(address).toBeNull();
    });

    test('should return null for non-existent invoice', () => {
      const address = resolveEscrowAddress('non_existent');
      expect(address).toBeNull();
    });

    test('should return null for invoice in different environment', () => {
      const address = resolveEscrowAddress('inv_prod_001'); // Current env is development
      expect(address).toBeNull();
    });

    test('should throw error for invalid invoice ID', () => {
      expect(() => resolveEscrowAddress(null)).toThrow('Invoice ID is required');
      expect(() => resolveEscrowAddress(undefined)).toThrow('Invoice ID is required');
      expect(() => resolveEscrowAddress('')).toThrow('Invoice ID cannot be empty');
      expect(() => resolveEscrowAddress('   ')).toThrow('Invoice ID cannot be empty');
    });

    test('should cache resolved addresses', () => {
      // First call should cache
      const address1 = resolveEscrowAddress('inv_dev_001');
      expect(address1).toBe(validStellarAddress);

      // Check cache stats
      const stats = getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.entries[0].ageSeconds).toBeLessThan(1);

      // Second call should use cache
      const address2 = resolveEscrowAddress('inv_dev_001');
      expect(address2).toBe(validStellarAddress);
      expect(address2).toBe(address1);
    });
  });

  describe('Allowlist Validation', () => {
    beforeEach(() => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'allowed_inv',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      process.env.NODE_ENV = 'development';
    });

    test('should return true for allowlisted invoice', () => {
      const isAllowed = isInvoiceAllowlisted('allowed_inv');
      expect(isAllowed).toBe(true);
    });

    test('should return false for non-allowlisted invoice', () => {
      const isAllowed = isInvoiceAllowlisted('not_allowed');
      expect(isAllowed).toBe(false);
    });

    test('should return false for invalid invoice ID', () => {
      expect(isInvoiceAllowlisted(null)).toBe(false);
      expect(isInvoiceAllowlisted(undefined)).toBe(false);
      expect(isInvoiceAllowlisted('')).toBe(false);
    });

    test('should return true for all invoices when allowlist disabled', () => {
      const config = JSON.stringify({
        mappings: [],
        allowlistEnabled: false,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      
      expect(isInvoiceAllowlisted('any_invoice')).toBe(true);
      expect(isInvoiceAllowlisted('')).toBe(false); // Still validates format
    });
  });

  describe('Active Migrations Retrieval', () => {
    beforeEach(() => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'dev_active',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          },
          {
            invoiceId: 'dev_inactive',
            escrowAddress: validStellarAddress2,
            environment: 'development',
            isActive: false
          },
          {
            invoiceId: 'prod_active',
            escrowAddress: validStellarAddress,
            environment: 'production',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      process.env.NODE_ENV = 'development';
    });

    test('should return only active mappings for current environment', () => {
      const mappings = getActiveMappings();
      
      expect(mappings).toHaveLength(1);
      expect(mappings[0].invoiceId).toBe('dev_active');
      expect(mappings[0].escrowAddress).toBe(validStellarAddress);
    });

    test('should return active mappings for specified environment', () => {
      const mappings = getActiveMappings('production');
      
      expect(mappings).toHaveLength(1);
      expect(mappings[0].invoiceId).toBe('prod_active');
    });
  });

  describe('Cache Behavior', () => {
    beforeEach(() => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'cached_inv',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 1 // Short TTL for testing
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      process.env.NODE_ENV = 'development';
    });

    test('should cache and expire entries', (done) => {
      // First call - should cache
      const address1 = resolveEscrowAddress('cached_inv');
      expect(address1).toBe(validStellarAddress);

      // Check cache exists
      let stats = getCacheStats();
      expect(stats.size).toBe(1);

      // Wait for cache to expire
      setTimeout(() => {
        // Cache should be expired and cleared on next call
        const address2 = resolveEscrowAddress('cached_inv');
        expect(address2).toBe(validStellarAddress);

        // Stats should show cache was cleared and repopulated
        stats = getCacheStats();
        expect(stats.size).toBe(1);
        expect(stats.entries[0].ageSeconds).toBeLessThan(1);
        
        done();
      }, 1100); // Wait longer than TTL
    });

    test('should not cache when disabled', () => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'no_cache_inv',
            escrowAddress: validStellarAddress2,
            environment: 'development',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: false, // Cache disabled
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;

      resolveEscrowAddress('no_cache_inv');
      
      const stats = getCacheStats();
      expect(stats.size).toBe(0);
    });

    test('should clear cache manually', () => {
      resolveEscrowAddress('cached_inv');
      
      let stats = getCacheStats();
      expect(stats.size).toBe(1);

      clearCache();
      
      stats = getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('Configuration Validation', () => {
    test('should validate correct configuration', () => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'valid_inv',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      
      const validation = validateMappingConfig();
      
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(validation.mappingCount).toBe(1);
      expect(validation.activeMappings).toBe(1);
      expect(validation.environments).toContain('development');
    });

    test('should detect duplicate invoice IDs in same environment', () => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'duplicate_inv',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          },
          {
            invoiceId: 'duplicate_inv',
            escrowAddress: validStellarAddress2,
            environment: 'development',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      
      const validation = validateMappingConfig();
      
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain(
        'Duplicate invoice ID "duplicate_inv" in environment "development"'
      );
    });

    test('should detect invalid Stellar addresses', () => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'bad_address_inv',
            escrowAddress: 'invalid_address',
            environment: 'development',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      
      const validation = validateMappingConfig();
      
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain(
        'Invalid Stellar address format for invoice "bad_address_inv"'
      );
    });

    test('should warn about high ratio of inactive mappings', () => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'active_inv',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          },
          {
            invoiceId: 'inactive_inv_1',
            escrowAddress: validStellarAddress2,
            environment: 'development',
            isActive: false
          },
          {
            invoiceId: 'inactive_inv_2',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: false
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      
      const validation = validateMappingConfig();
      
      expect(validation.isValid).toBe(true);
      expect(validation.warnings).toContain(
        'High ratio of inactive mappings (2/3)'
      );
    });
  });

  describe('Schema Validation', () => {
    test('should validate correct mapping entry schema', () => {
      const validEntry = {
        invoiceId: 'inv_123',
        escrowAddress: validStellarAddress,
        environment: 'development',
        isActive: true
      };
      
      const result = EscrowMappingEntrySchema.safeParse(validEntry);
      expect(result.success).toBe(true);
    });

    test('should reject invalid mapping entry schema', () => {
      const invalidEntries = [
        { invoiceId: '', escrowAddress: validStellarAddress }, // Empty invoice ID
        { invoiceId: 'inv_123', escrowAddress: 'invalid' }, // Invalid address
        { invoiceId: 'inv_123', escrowAddress: validStellarAddress, environment: 'invalid' }, // Invalid environment
        { invoiceId: 'inv@123', escrowAddress: validStellarAddress } // Invalid characters in invoice ID
      ];
      
      invalidEntries.forEach(entry => {
        const result = EscrowMappingEntrySchema.safeParse(entry);
        expect(result.success).toBe(false);
      });
    });

    test('should validate correct config schema', () => {
      const validConfig = {
        mappings: [
          {
            invoiceId: 'inv_123',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          }
        ],
        defaultEnvironment: 'development',
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      };
      
      const result = EscrowMappingConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    test('should reject invalid config schema', () => {
      const invalidConfigs = [
        { mappings: 'not-array' }, // Invalid mappings type
        { mappings: [], cacheTtlSeconds: 1 }, // TTL too low
        { mappings: [], cacheTtlSeconds: 4000 }, // TTL too high
        { mappings: [], defaultEnvironment: 'invalid' }, // Invalid default environment
        { mappings: new Array(1001).fill({}) } // Too many mappings
      ];
      
      invalidConfigs.forEach(config => {
        const result = EscrowMappingConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Edge Cases', () => {
    test('should handle environment fallback gracefully', () => {
      const config = JSON.stringify({
        mappings: [
          {
            invoiceId: 'test_inv',
            escrowAddress: validStellarAddress,
            environment: 'development',
            isActive: true
          }
        ],
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      // Don't set NODE_ENV - should default to development
      
      const address = resolveEscrowAddress('test_inv');
      expect(address).toBe(validStellarAddress);
    });

    test('should handle maximum allowed mappings', () => {
      const mappings = Array.from({ length: 1000 }, (_, i) => ({
        invoiceId: `inv_${i}`,
        escrowAddress: validStellarAddress,
        environment: 'development',
        isActive: true
      }));
      
      const config = JSON.stringify({
        mappings,
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      
      const validation = validateMappingConfig();
      expect(validation.isValid).toBe(true);
      expect(validation.mappingCount).toBe(1000);
    });

    test('should reject mappings over maximum limit', () => {
      const mappings = Array.from({ length: 1001 }, (_, i) => ({
        invoiceId: `inv_${i}`,
        escrowAddress: validStellarAddress,
        environment: 'development',
        isActive: true
      }));
      
      const config = JSON.stringify({
        mappings,
        allowlistEnabled: true,
        cacheEnabled: true,
        cacheTtlSeconds: 300
      });
      
      process.env.ESCROW_ADDR_BY_INVOICE = config;
      
      expect(() => parseEscrowMappingConfig()).toThrow(
        'Invalid escrow mapping configuration'
      );
    });
  });
});
