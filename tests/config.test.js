'use strict';

const { loadConfig, ConfigError } = require('../src/config');

describe('loadConfig', () => {
  const baseValidContract = 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';

  test('default (empty env) config matches existing defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3001);
    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(config.contractId).toBe(baseValidContract);
    expect(config.explorerUrl).toBe(
      `https://stellar.expert/explorer/testnet/contract/${baseValidContract}`,
    );
    expect(config.frontendUrl).toBe('https://liquifact-frontend.vercel.app');
    expect(config.corsOrigins).toEqual(['*']);
    expect(config.version).toBeDefined();
  });

  test('mainnet preset derives explorerUrl containing /public/ and uses public passphrase', () => {
    const config = loadConfig({
      STELLAR_NETWORK: 'mainnet',
      SOROBAN_RPC_URL: 'https://rpc.example',
    });
    expect(config.network).toBe('mainnet');
    expect(config.rpcUrl).toBe('https://rpc.example');
    expect(config.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
    expect(config.explorerUrl).toContain('/public/');
    expect(config.explorerUrl).toBe(
      `https://stellar.expert/explorer/public/contract/${baseValidContract}`,
    );
  });

  test('public preset derives explorerUrl containing /public/', () => {
    const config = loadConfig({
      STELLAR_NETWORK: 'public',
      SOROBAN_RPC_URL: 'https://rpc.example',
    });
    expect(config.network).toBe('public');
    expect(config.explorerUrl).toContain('/public/');
  });

  test('futurenet preset derives explorerUrl containing /futurenet/ and default RPC', () => {
    const config = loadConfig({
      STELLAR_NETWORK: 'futurenet',
    });
    expect(config.network).toBe('futurenet');
    expect(config.rpcUrl).toBe('https://rpc-futurenet.stellar.org');
    expect(config.networkPassphrase).toBe('Test SDF Future Network ; October 2022');
    expect(config.explorerUrl).toContain('/futurenet/');
  });

  test('custom network allows custom values and succeeds when all are provided', () => {
    const config = loadConfig({
      STELLAR_NETWORK: 'custom',
      SOROBAN_RPC_URL: 'https://custom-rpc.example',
      STELLAR_NETWORK_PASSPHRASE: 'Custom Passphrase ; 2026',
      STELLAR_EXPLORER_URL: 'https://custom-explorer.example',
    });
    expect(config.network).toBe('custom');
    expect(config.rpcUrl).toBe('https://custom-rpc.example');
    expect(config.networkPassphrase).toBe('Custom Passphrase ; 2026');
    expect(config.explorerUrl).toBe(
      `https://custom-explorer.example/contract/${baseValidContract}`,
    );
  });

  test('localhost http RPC is allowed', () => {
    const config = loadConfig({
      SOROBAN_RPC_URL: 'http://localhost:8000',
    });
    expect(config.rpcUrl).toBe('http://localhost:8000');

    const configIp = loadConfig({
      SOROBAN_RPC_URL: 'http://127.0.0.1:8000',
    });
    expect(configIp.rpcUrl).toBe('http://127.0.0.1:8000');
  });

  describe('table-driven validation failures', () => {
    const cases = [
      {
        name: 'invalid contract id',
        env: { ESCROW_CONTRACT_ID: 'CNOPE' },
        expectedError: 'ESCROW_CONTRACT_ID must be a valid Stellar contract address',
      },
      {
        name: 'passphrase mismatch on preset',
        env: {
          STELLAR_NETWORK: 'testnet',
          STELLAR_NETWORK_PASSPHRASE: 'Wrong Passphrase',
        },
        expectedError: 'STELLAR_NETWORK_PASSPHRASE mismatch for network "testnet"',
      },
      {
        name: 'mainnet without RPC',
        env: { STELLAR_NETWORK: 'mainnet' },
        expectedError: 'SOROBAN_RPC_URL is required for network "mainnet"',
      },
      {
        name: 'custom network without required fields',
        env: { STELLAR_NETWORK: 'custom' },
        expectedError: 'SOROBAN_RPC_URL is required for network "custom"',
      },
      {
        name: 'PORT=abc',
        env: { PORT: 'abc' },
        expectedError: 'PORT must be an integer between 1 and 65535',
      },
      {
        name: 'PORT out of range (< 1)',
        env: { PORT: '0' },
        expectedError: 'PORT must be an integer between 1 and 65535',
      },
      {
        name: 'PORT out of range (> 65535)',
        env: { PORT: '70000' },
        expectedError: 'PORT must be an integer between 1 and 65535',
      },
      {
        name: 'http:// non-local RPC',
        env: { SOROBAN_RPC_URL: 'http://insecure-rpc.example.org' },
        expectedError: 'SOROBAN_RPC_URL must be a valid https:// URL or http://localhost',
      },
      {
        name: 'bad CORS origin with path',
        env: { CORS_ALLOWED_ORIGINS: 'https://example.com/api' },
        expectedError: 'CORS_ALLOWED_ORIGINS contains invalid origin "https://example.com/api"',
      },
      {
        name: 'bad CORS origin invalid format',
        env: { CORS_ALLOWED_ORIGINS: 'not-a-url' },
        expectedError: 'CORS_ALLOWED_ORIGINS contains invalid origin "not-a-url"',
      },
      {
        name: '* in production rejected by default',
        env: {
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: '*',
        },
        expectedError: 'CORS_ALLOWED_ORIGINS cannot include "*" in production unless ALLOW_ANY_ORIGIN=true',
      },
      {
        name: 'unknown network',
        env: { STELLAR_NETWORK: 'unknown-net' },
        expectedError: 'STELLAR_NETWORK must be one of',
      },
      {
        name: 'invalid FRONTEND_URL',
        env: { FRONTEND_URL: 'invalid-frontend' },
        expectedError: 'FRONTEND_URL must be an absolute URL',
      },
      {
        name: 'invalid PUBLIC_API_BASE_URL',
        env: { PUBLIC_API_BASE_URL: 'ftp://not-http-api' },
        expectedError: 'PUBLIC_API_BASE_URL must be an absolute URL',
      },
    ];

    test.each(cases)('$name', ({ env, expectedError }) => {
      expect(() => loadConfig(env)).toThrow(ConfigError);
      try {
        loadConfig(env);
      } catch (err) {
        expect(err.message).toContain(expectedError);
        expect(err.errors.some((e) => e.includes(expectedError))).toBe(true);
      }
    });
  });

  test('production allows * only when ALLOW_ANY_ORIGIN=true', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      ALLOW_ANY_ORIGIN: 'true',
      CORS_ALLOWED_ORIGINS: '*',
    });
    expect(config.corsOrigins).toEqual(['*']);
  });

  test('multiple errors reported together', () => {
    try {
      loadConfig({
        PORT: 'abc',
        ESCROW_CONTRACT_ID: 'CNOPE',
        STELLAR_NETWORK: 'mainnet', // missing RPC
        CORS_ALLOWED_ORIGINS: 'https://example.com/path',
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.errors.length).toBeGreaterThanOrEqual(4);
      expect(err.errors.some((e) => e.includes('PORT must be an integer'))).toBe(true);
      expect(err.errors.some((e) => e.includes('ESCROW_CONTRACT_ID must be a valid Stellar contract'))).toBe(true);
      expect(err.errors.some((e) => e.includes('SOROBAN_RPC_URL is required'))).toBe(true);
      expect(err.errors.some((e) => e.includes('CORS_ALLOWED_ORIGINS contains invalid origin'))).toBe(true);
      expect(err.message).toContain('Invalid configuration:');
    }
  });
});
