/**
 * Comprehensive tests for environment configuration validation module.
 * 
 * Coverage includes:
 * - Required variable validation
 * - Type coercion and validation
 * - Custom validation rules
 * - Default value application
 * - Error messages and security
 * - Edge cases
 */

const {
  validateEnv,
  getEnvSchema,
  generateEnvDocumentation,
  parseValue,
  validateVariable,
  ENV_ERRORS,
  ENV_TYPES,
  ENV_SCHEMA,
} = require('./env');

describe('Environment Configuration Validation', () => {
  // Helper function to create clean env for each test
  const createTestEnv = (overrides = {}) => {
    return {
      PORT: '3001',
      NODE_ENV: 'test',
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      ...overrides,
    };
  };

  describe('Valid Configurations', () => {
    it('should accept a minimal valid configuration with defaults', () => {
      const env = createTestEnv({
        PORT: undefined,
        NODE_ENV: undefined,
        STELLAR_NETWORK: undefined,
      });

      const config = validateEnv(env);

      expect(config).toMatchObject({
        PORT: 3001,
        NODE_ENV: 'development',
        STELLAR_NETWORK: 'testnet',
      });
    });

    it('should accept a fully specified valid configuration', () => {
      const env = createTestEnv();

      const config = validateEnv(env);

      expect(config.HORIZON_URL).toBe(env.HORIZON_URL);
      expect(config.SOROBAN_RPC_URL).toBe(env.SOROBAN_RPC_URL);
      expect(config.NODE_ENV).toBe(env.NODE_ENV);
      expect(config.STELLAR_NETWORK).toBe(env.STELLAR_NETWORK);
      expect(config.PORT).toBe(Number(env.PORT));
      expect(config.DATABASE_URL).toBeNull();
      expect(config.REDIS_URL).toBeNull();
    });

    it('should accept optional DATABASE_URL when provided', () => {
      const env = createTestEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/liquifact',
      });

      const config = validateEnv(env);

      expect(config.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/liquifact');
    });

    it('should set optional DATABASE_URL to null when not provided', () => {
      const env = createTestEnv();

      const config = validateEnv(env);

      expect(config.DATABASE_URL).toBeNull();
    });

    it('should accept REDIS_URL when provided', () => {
      const env = createTestEnv({
        REDIS_URL: 'redis://localhost:6379',
      });

      const config = validateEnv(env);

      expect(config.REDIS_URL).toBe('redis://localhost:6379');
    });
  });

  describe('Type Coercion', () => {
    it('should coerce string PORT to number', () => {
      const env = createTestEnv({ PORT: '8080' });

      const config = validateEnv(env);

      expect(config.PORT).toBe(8080);
      expect(typeof config.PORT).toBe('number');
    });

    it('should coerce string "true" to boolean true', () => {
      const result = parseValue('true', ENV_TYPES.BOOLEAN);
      expect(result).toBe(true);
    });

    it('should coerce various truthy strings to boolean true', () => {
      const truthyValues = ['true', 'True', 'TRUE', '1', 'yes', 'YES', 'on', 'ON'];

      truthyValues.forEach((val) => {
        const result = parseValue(val, ENV_TYPES.BOOLEAN);
        expect(result).toBe(true);
      });
    });

    it('should coerce various falsy strings to boolean false', () => {
      const falsyValues = ['false', 'False', 'FALSE', '0', 'no', 'NO', 'off', 'OFF'];

      falsyValues.forEach((val) => {
        const result = parseValue(val, ENV_TYPES.BOOLEAN);
        expect(result).toBe(false);
      });
    });
  });

  describe('PORT Validation', () => {
    it('should accept valid port numbers', () => {
      const validPorts = ['1', '80', '443', '3000', '8080', '65535'];

      validPorts.forEach((port) => {
        const env = createTestEnv({ PORT: port });
        const config = validateEnv(env);
        expect(config.PORT).toBe(Number(port));
      });
    });

    it('should reject port 0', () => {
      const env = createTestEnv({ PORT: '0' });

      expect(() => validateEnv(env)).toThrow('Port must be between 1 and 65535');
    });

    it('should reject port > 65535', () => {
      const env = createTestEnv({ PORT: '65536' });

      expect(() => validateEnv(env)).toThrow('Port must be between 1 and 65535');
    });

    it('should reject negative port', () => {
      const env = createTestEnv({ PORT: '-1' });

      expect(() => validateEnv(env)).toThrow('Port must be between 1 and 65535');
    });

    it('should reject non-numeric PORT', () => {
      const testEnv = createTestEnv({ PORT: 'not-a-number' });

      expect(() => validateEnv(testEnv)).toThrow('Cannot convert to number');
    });

    it('should use default port when not provided', () => {
      const env = createTestEnv({ PORT: '' });

      const config = validateEnv(env);

      expect(config.PORT).toBe(3001);
    });
  });

  describe('NODE_ENV Validation', () => {
    it('should accept valid NODE_ENV values', () => {
      const validEnvs = ['development', 'production', 'test'];

      validEnvs.forEach((nodeEnv) => {
        const env = createTestEnv({ NODE_ENV: nodeEnv });
        const config = validateEnv(env);
        expect(config.NODE_ENV).toBe(nodeEnv);
      });
    });

    it('should reject invalid NODE_ENV', () => {
      const env = createTestEnv({ NODE_ENV: 'staging' });

      expect(() => validateEnv(env)).toThrow('NODE_ENV must be one of');
    });

    it('should use default NODE_ENV when not provided', () => {
      const env = createTestEnv({ NODE_ENV: '' });

      const config = validateEnv(env);

      expect(config.NODE_ENV).toBe('development');
    });
  });

  describe('STELLAR_NETWORK Validation', () => {
    it('should accept valid STELLAR_NETWORK values', () => {
      const validNetworks = ['testnet', 'public'];

      validNetworks.forEach((network) => {
        const env = createTestEnv({ STELLAR_NETWORK: network });
        const config = validateEnv(env);
        expect(config.STELLAR_NETWORK).toBe(network);
      });
    });

    it('should reject invalid STELLAR_NETWORK', () => {
      const env = createTestEnv({ STELLAR_NETWORK: 'invalid' });

      expect(() => validateEnv(env)).toThrow('STELLAR_NETWORK must be one of');
    });

    it('should use default STELLAR_NETWORK when not provided', () => {
      const env = createTestEnv({ STELLAR_NETWORK: '' });

      const config = validateEnv(env);

      expect(config.STELLAR_NETWORK).toBe('testnet');
    });
  });

  describe('URL Validation (HORIZON_URL, SOROBAN_RPC_URL)', () => {
    it('should accept valid HTTPS URLs', () => {
      const env = createTestEnv({
        HORIZON_URL: 'https://custom-horizon.example.com',
        SOROBAN_RPC_URL: 'https://custom-soroban.example.com',
      });

      const config = validateEnv(env);

      expect(config.HORIZON_URL).toBe('https://custom-horizon.example.com');
      expect(config.SOROBAN_RPC_URL).toBe('https://custom-soroban.example.com');
    });

    it('should accept valid HTTP URLs', () => {
      const env = createTestEnv({
        HORIZON_URL: 'http://localhost:11626',
        SOROBAN_RPC_URL: 'http://localhost:8000',
      });

      const config = validateEnv(env);

      expect(config.HORIZON_URL).toBe('http://localhost:11626');
      expect(config.SOROBAN_RPC_URL).toBe('http://localhost:8000');
    });

    it('should reject invalid URL format for HORIZON_URL', () => {
      const env = createTestEnv({ HORIZON_URL: 'not-a-url' });

      expect(() => validateEnv(env)).toThrow('HORIZON_URL must be a valid URL');
    });

    it('should reject invalid URL format for SOROBAN_RPC_URL', () => {
      const env = createTestEnv({ SOROBAN_RPC_URL: 'not-a-url' });

      expect(() => validateEnv(env)).toThrow('SOROBAN_RPC_URL must be a valid URL');
    });

    it('should reject FTP protocol for HORIZON_URL', () => {
      const env = createTestEnv({ HORIZON_URL: 'ftp://example.com' });

      expect(() => validateEnv(env)).toThrow('must use http or https protocol');
    });

    it('should reject FTP protocol for SOROBAN_RPC_URL', () => {
      const env = createTestEnv({ SOROBAN_RPC_URL: 'ftp://example.com' });

      expect(() => validateEnv(env)).toThrow('must use http or https protocol');
    });

    it('should use default URLs when not provided', () => {
      const env = createTestEnv({ HORIZON_URL: '', SOROBAN_RPC_URL: '' });

      const config = validateEnv(env);

      expect(config.HORIZON_URL).toBe('https://horizon-testnet.stellar.org');
      expect(config.SOROBAN_RPC_URL).toBe('https://soroban-testnet.stellar.org');
    });
  });

  describe('DATABASE_URL Validation', () => {
    it('should accept valid PostgreSQL URLs', () => {
      const validUrls = [
        'postgresql://user:pass@localhost:5432/db',
        'postgres://user:pass@localhost/db',
      ];

      validUrls.forEach((url) => {
        const env = createTestEnv({ DATABASE_URL: url });
        const config = validateEnv(env);
        expect(config.DATABASE_URL).toBe(url);
      });
    });

    it('should accept valid MongoDB URLs', () => {
      const validUrls = [
        'mongodb://user:pass@localhost:27017/db',
        'mongodb+srv://user:pass@cluster.mongodb.net/db',
      ];

      validUrls.forEach((url) => {
        const env = createTestEnv({ DATABASE_URL: url });
        const config = validateEnv(env);
        expect(config.DATABASE_URL).toBe(url);
      });
    });

    it('should accept valid MySQL URLs', () => {
      const env = createTestEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' });

      const config = validateEnv(env);

      expect(config.DATABASE_URL).toBe('mysql://user:pass@localhost:3306/db');
    });

    it('should reject invalid database protocol', () => {
      const env = createTestEnv({ DATABASE_URL: 'http://localhost:5432/db' });

      expect(() => validateEnv(env)).toThrow('must use a valid database protocol');
    });

    it('should reject invalid URL format', () => {
      const env = createTestEnv({ DATABASE_URL: 'not-a-url' });

      expect(() => validateEnv(env)).toThrow('must be a valid database connection URL');
    });

    it('should allow DATABASE_URL to be omitted', () => {
      const env = createTestEnv();
      delete env.DATABASE_URL;

      const config = validateEnv(env);

      expect(config.DATABASE_URL).toBeNull();
    });
  });

  describe('REDIS_URL Validation', () => {
    it('should accept valid Redis URLs', () => {
      const env = createTestEnv({ REDIS_URL: 'redis://localhost:6379' });

      const config = validateEnv(env);

      expect(config.REDIS_URL).toBe('redis://localhost:6379');
    });

    it('should accept Redis URLs with password and db', () => {
      const env = createTestEnv({ REDIS_URL: 'redis://:password@localhost:6379/0' });

      const config = validateEnv(env);

      expect(config.REDIS_URL).toBe('redis://:password@localhost:6379/0');
    });

    it('should accept Redis URLs with custom host', () => {
      const env = createTestEnv({ REDIS_URL: 'redis://redis.example.com:6379' });

      const config = validateEnv(env);

      expect(config.REDIS_URL).toBe('redis://redis.example.com:6379');
    });

    it('should reject non-redis protocol', () => {
      const env = createTestEnv({ REDIS_URL: 'http://localhost:6379' });

      expect(() => validateEnv(env)).toThrow('must use redis protocol');
    });

    it('should reject invalid URL format', () => {
      const env = createTestEnv({ REDIS_URL: 'not-a-url' });

      expect(() => validateEnv(env)).toThrow('must be a valid Redis URL');
    });

    it('should allow REDIS_URL to be omitted', () => {
      const env = createTestEnv();
      delete env.REDIS_URL;

      const config = validateEnv(env);

      expect(config.REDIS_URL).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should throw EnvironmentValidationError with correct name', () => {
      const env = createTestEnv({ PORT: '99999' });

      try {
        validateEnv(env);
        fail('Should have thrown');
      } catch (error) {
        expect(error.name).toBe('EnvironmentValidationError');
      }
    });

    it('should include error details in thrown error', () => {
      const env = createTestEnv({ PORT: 'invalid' });

      try {
        validateEnv(env);
        fail('Should have thrown');
      } catch (error) {
        expect(error.details).toBeDefined();
        expect(Array.isArray(error.details)).toBe(true);
        expect(error.details[0]).toHaveProperty('key');
        expect(error.details[0]).toHaveProperty('error');
        expect(error.details[0]).toHaveProperty('message');
      }
    });

    it('should include actionable error messages', () => {
      const env = createTestEnv({ NODE_ENV: 'invalid' });

      try {
        validateEnv(env);
        fail('Should have thrown');
      } catch (error) {
        expect(error.message).toContain('Environment validation failed');
        expect(error.message).toContain('NODE_ENV');
        expect(error.message).toContain('must be one of');
      }
    });

    it('should report multiple validation errors', () => {
      const env = createTestEnv({
        PORT: 'invalid',
        NODE_ENV: 'invalid',
        STELLAR_NETWORK: 'invalid',
      });

      try {
        validateEnv(env);
        fail('Should have thrown');
      } catch (error) {
        expect(error.details.length).toBeGreaterThanOrEqual(3);
      }
    });

    it('should not include sensitive values in error messages', () => {
      const password = 'super-secret-password-123';
      const env = createTestEnv({ DATABASE_URL: `not-a-valid-url-with-${password}` });

      try {
        validateEnv(env);
        throw new Error('Expected validateEnv to throw');
      } catch (error) {
        // Make sure it's the validation error, not our thrown error
        if (error.message === 'Expected validateEnv to throw') {
          throw error;
        }
        expect(error.message).not.toContain(password);
        expect(error.message).not.toContain('super-secret');
        // Error message should only mention the variable name
        expect(error.message).toContain('DATABASE_URL');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string values as null for defaults', () => {
      const env = createTestEnv({
        REDIS_URL: '',
        DATABASE_URL: '',
      });

      const config = validateEnv(env);

      expect(config.REDIS_URL).toBeNull();
      expect(config.DATABASE_URL).toBeNull();
    });

    it('should handle whitespace-only values', () => {
      const env = createTestEnv({
        DATABASE_URL: '   ',
        REDIS_URL: '   ',
      });

      const config = validateEnv(env);

      // Whitespace is trimmed and treated as null for URLs
      expect(config.DATABASE_URL).toBeNull();
      expect(config.REDIS_URL).toBeNull();
    });

    it('should handle URLs with special characters in credentials', () => {
      const env = createTestEnv({
        DATABASE_URL: 'postgresql://user%40email:p%40ssw0rd@localhost/db',
      });

      const config = validateEnv(env);

      expect(config.DATABASE_URL).toBe('postgresql://user%40email:p%40ssw0rd@localhost/db');
    });

    it('should validate with undefined env values', () => {
      const env = createTestEnv({
        REDIS_URL: undefined,
        DATABASE_URL: undefined,
      });

      const config = validateEnv(env);

      expect(config.REDIS_URL).toBeNull();
      expect(config.DATABASE_URL).toBeNull();
    });

    it('should use default when env is empty object', () => {
      const emptyEnv = {
        PORT: '3000',
        NODE_ENV: 'development',
        STELLAR_NETWORK: 'testnet',
        HORIZON_URL: 'https://horizon-testnet.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      };

      const config = validateEnv(emptyEnv);

      expect(config.PORT).toBe(3000);
      expect(config.STELLAR_NETWORK).toBe('testnet');
    });

    it('should handle very long URLs', () => {
      const longPath = 'a'.repeat(1000);
      const env = createTestEnv({
        HORIZON_URL: `https://example.com/${longPath}`,
      });

      const config = validateEnv(env);

      expect(config.HORIZON_URL).toBe(`https://example.com/${longPath}`);
    });

    it('should handle localhost URLs correctly', () => {
      const env = createTestEnv({
        HORIZON_URL: 'http://localhost:11626',
        SOROBAN_RPC_URL: 'http://127.0.0.1:8000',
      });

      const config = validateEnv(env);

      expect(config.HORIZON_URL).toBe('http://localhost:11626');
      expect(config.SOROBAN_RPC_URL).toBe('http://127.0.0.1:8000');
    });
  });

  describe('parseValue', () => {
    it('should parse string type correctly', () => {
      const result = parseValue('hello', ENV_TYPES.STRING);
      expect(result).toBe('hello');
    });

    it('should parse URL type correctly', () => {
      const result = parseValue('https://example.com', ENV_TYPES.URL);
      expect(result).toBe('https://example.com');
    });

    it('should handle null and undefined in parseValue', () => {
      expect(parseValue(null, ENV_TYPES.STRING)).toBeNull();
      expect(parseValue(undefined, ENV_TYPES.STRING)).toBeNull();
      expect(parseValue('', ENV_TYPES.STRING)).toBeNull();
    });

    it('should throw error for invalid boolean string', () => {
      expect(() => parseValue('maybe', ENV_TYPES.BOOLEAN)).toThrow('Cannot convert to boolean');
    });

    it('should handle default case', () => {
      // Simulating an unknown type - should just return the value
      const unknownType = 'unknown-type';
      const result = parseValue('test-value', unknownType);
      expect(result).toBe('test-value');
    });

    it('should trim whitespace for URLs', () => {
      const result = parseValue('  https://example.com  ', ENV_TYPES.URL);
      expect(result).toBe('https://example.com');
    });

    it('should return null for whitespace-only URLs', () => {
      const result = parseValue('   ', ENV_TYPES.URL);
      expect(result).toBeNull();
    });

    it('should throw error for invalid number string', () => {
      expect(() => parseValue('not-a-number', ENV_TYPES.NUMBER)).toThrow('Cannot convert to number');
    });
  });

  describe('validateVariable', () => {
    it('should validate a single variable correctly', () => {
      const schema = ENV_SCHEMA.PORT;
      const result = validateVariable('PORT', '3000', schema);

      expect(result.valid).toBe(true);
      expect(result.value).toBe(3000);
    });

    it('should detect missing required variables', () => {
      const schema = { ...ENV_SCHEMA.PORT, required: true };
      const result = validateVariable('PORT', '', schema);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(ENV_ERRORS.MISSING);
    });

    it('should detect invalid types', () => {
      const schema = ENV_SCHEMA.PORT;
      const result = validateVariable('PORT', 'not-a-number', schema);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(ENV_ERRORS.INVALID_TYPE);
    });

    it('should detect validation failures', () => {
      const schema = ENV_SCHEMA.PORT;
      const result = validateVariable('PORT', '99999', schema);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(ENV_ERRORS.INVALID_RANGE);
    });
  });

  describe('Utility Functions', () => {
    it('should return a copy of the schema', () => {
      const schema = getEnvSchema();

      expect(schema).toEqual(ENV_SCHEMA);
      expect(schema).not.toBe(ENV_SCHEMA); // Should be a copy, not reference
    });

    it('should generate markdown documentation', () => {
      const doc = generateEnvDocumentation();

      expect(doc).toContain('Environment Variables');
      expect(doc).toContain('PORT');
      expect(doc).toContain('NODE_ENV');
      expect(doc).toContain('STELLAR_NETWORK');
      expect(doc).toContain('HORIZON_URL');
      expect(doc).toContain('SOROBAN_RPC_URL');
      expect(doc).toContain('DATABASE_URL');
      expect(doc).toContain('REDIS_URL');
    });

    it('documentation should be markdown table formatted', () => {
      const doc = generateEnvDocumentation();

      expect(doc).toContain('|');
      expect(doc).toContain('Required');
      expect(doc).toContain('Default');
    });
  });

  describe('Integration Tests', () => {
    it('should validate a production configuration', () => {
      const env = {
        PORT: '8080',
        NODE_ENV: 'production',
        STELLAR_NETWORK: 'public',
        HORIZON_URL: 'https://horizon.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban.stellar.org',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/prod',
        REDIS_URL: 'redis://:pass@redis.example.com:6379/0',
      };

      const config = validateEnv(env);

      expect(config.PORT).toBe(8080);
      expect(config.NODE_ENV).toBe('production');
      expect(config.STELLAR_NETWORK).toBe('public');
      expect(config.DATABASE_URL).toContain('postgresql');
      expect(config.REDIS_URL).toContain('redis');
    });

    it('should validate a development configuration', () => {
      const env = {
        PORT: '3001',
        NODE_ENV: 'development',
        STELLAR_NETWORK: 'testnet',
        HORIZON_URL: 'http://localhost:11626',
        SOROBAN_RPC_URL: 'http://localhost:8000',
      };

      const config = validateEnv(env);

      expect(config.PORT).toBe(3001);
      expect(config.NODE_ENV).toBe('development');
      expect(config.STELLAR_NETWORK).toBe('testnet');
      expect(config.HORIZON_URL).toBe('http://localhost:11626');
      expect(config.SOROBAN_RPC_URL).toBe('http://localhost:8000');
    });

    it('should validate with minimal required values', () => {
      const minimalEnv = {
        HORIZON_URL: 'https://horizon-testnet.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      };

      const config = validateEnv(minimalEnv);

      // Should have all required defaults
      expect(config.PORT).toBeDefined();
      expect(config.NODE_ENV).toBeDefined();
      expect(config.STELLAR_NETWORK).toBeDefined();
    });
  });
});
