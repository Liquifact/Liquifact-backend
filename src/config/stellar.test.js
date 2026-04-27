/**
 * Tests for Stellar network configuration validation.
 * @module config/stellar.test
 */

const {
  validateStellarConfig,
  getNetworkPassphrase,
  getExpectedRpc,
  VALID_NETWORKS,
  NETWORK_RPC_MAP,
  NETWORK_PASSPHRASE_MAP,
} = require('./stellar');

describe('config/stellar', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'development' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateStellarConfig', () => {
    it('should accept valid TESTNET configuration', () => {
      process.env.STELLAR_NETWORK = 'TESTNET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.TESTNET;

      const result = validateStellarConfig();

      expect(result.network).toBe('TESTNET');
      expect(result.rpcUrl).toBe(NETWORK_RPC_MAP.TESTNET);
      expect(result.passphrase).toBe(NETWORK_PASSPHRASE_MAP.TESTNET);
    });

    it('should accept valid MAINNET configuration', () => {
      process.env.STELLAR_NETWORK = 'MAINNET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.MAINNET;

      const result = validateStellarConfig();

      expect(result.network).toBe('MAINNET');
      expect(result.rpcUrl).toBe(NETWORK_RPC_MAP.MAINNET);
      expect(result.passphrase).toBe(NETWORK_PASSPHRASE_MAP.MAINNET);
    });

    it('should accept valid FUTURENET configuration', () => {
      process.env.STELLAR_NETWORK = 'FUTURENET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.FUTURENET;

      const result = validateStellarConfig();

      expect(result.network).toBe('FUTURENET');
      expect(result.rpcUrl).toBe(NETWORK_RPC_MAP.FUTURENET);
      expect(result.passphrase).toBe(NETWORK_PASSPHRASE_MAP.FUTURENET);
    });

    it('should throw when STELLAR_NETWORK is missing', () => {
      delete process.env.STELLAR_NETWORK;
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.TESTNET;

      expect(() => validateStellarConfig()).toThrow('STELLAR_NETWORK is required');
    });

    it('should throw when SOROBAN_RPC_URL is missing', () => {
      process.env.STELLAR_NETWORK = 'TESTNET';
      delete process.env.SOROBAN_RPC_URL;

      expect(() => validateStellarConfig()).toThrow('SOROBAN_RPC_URL is required');
    });

    it('should throw when STELLAR_NETWORK is invalid', () => {
      process.env.STELLAR_NETWORK = 'INVALID';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.TESTNET;

      expect(() => validateStellarConfig()).toThrow('Invalid STELLAR_NETWORK');
    });

    it('should throw when TESTNET paired with MAINNET RPC', () => {
      process.env.STELLAR_NETWORK = 'TESTNET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.MAINNET;

      expect(() => validateStellarConfig()).toThrow('Mismatch');
    });

    it('should throw when MAINNET paired with TESTNET RPC', () => {
      process.env.STELLAR_NETWORK = 'MAINNET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.TESTNET;

      expect(() => validateStellarConfig()).toThrow('Mismatch');
    });

    it('should throw when FUTURENET paired with TESTNET RPC', () => {
      process.env.STELLAR_NETWORK = 'FUTURENET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.TESTNET;

      expect(() => validateStellarConfig()).toThrow('Mismatch');
    });

    it('should throw when custom RPC used with TESTNET', () => {
      process.env.STELLAR_NETWORK = 'TESTNET';
      process.env.SOROBAN_RPC_URL = 'https://custom-rpc.example.com';

      expect(() => validateStellarConfig()).toThrow(
        'STELLAR_NETWORK=TESTNET requires SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"'
      );
    });
  });

  describe('getNetworkPassphrase', () => {
    it('should return correct passphrase for TESTNET', () => {
      expect(getNetworkPassphrase('TESTNET')).toBe(NETWORK_PASSPHRASE_MAP.TESTNET);
    });

    it('should return correct passphrase for MAINNET', () => {
      expect(getNetworkPassphrase('MAINNET')).toBe(NETWORK_PASSPHRASE_MAP.MAINNET);
    });

    it('should return correct passphrase for FUTURENET', () => {
      expect(getNetworkPassphrase('FUTURENET')).toBe(NETWORK_PASSPHRASE_MAP.FUTURENET);
    });

    it('should throw for unknown network', () => {
      expect(() => getNetworkPassphrase('UNKNOWN')).toThrow('Unknown network');
    });

    it('should throw for null network', () => {
      expect(() => getNetworkPassphrase(null)).toThrow('Unknown network');
    });
  });

  describe('getExpectedRpc', () => {
    it('should return correct RPC for TESTNET', () => {
      expect(getExpectedRpc('TESTNET')).toBe(NETWORK_RPC_MAP.TESTNET);
    });

    it('should return correct RPC for MAINNET', () => {
      expect(getExpectedRpc('MAINNET')).toBe(NETWORK_RPC_MAP.MAINNET);
    });

    it('should return correct RPC for FUTURENET', () => {
      expect(getExpectedRpc('FUTURENET')).toBe(NETWORK_RPC_MAP.FUTURENET);
    });

    it('should throw for unknown network', () => {
      expect(() => getExpectedRpc('INVALID')).toThrow('Unknown network');
    });
  });

  describe('VALID_NETWORKS', () => {
    it('should contain TESTNET', () => {
      expect(VALID_NETWORKS).toContain('TESTNET');
    });

    it('should contain MAINNET', () => {
      expect(VALID_NETWORKS).toContain('MAINNET');
    });

    it('should contain FUTURENET', () => {
      expect(VALID_NETWORKS).toContain('FUTURENET');
    });

    it('should have exactly 3 networks', () => {
      expect(VALID_NETWORKS).toHaveLength(3);
    });
  });

  describe('NETWORK_RPC_MAP', () => {
    it('should have correct TESTNET RPC', () => {
      expect(NETWORK_RPC_MAP.TESTNET).toBe('https://soroban-testnet.stellar.org');
    });

    it('should have correct MAINNET RPC', () => {
      expect(NETWORK_RPC_MAP.MAINNET).toBe('https://soroban.stellar.org');
    });

    it('should have correct FUTURENET RPC', () => {
      expect(NETWORK_RPC_MAP.FUTURENET).toBe('https://rpc-futurenet.stellar.org');
    });
  });

  describe('NETWORK_PASSPHRASE_MAP', () => {
    it('should have correct TESTNET passphrase', () => {
      expect(NETWORK_PASSPHRASE_MAP.TESTNET).toBe('Test SDF Network ; September 2015');
    });

    it('should have correct MAINNET passphrase', () => {
      expect(NETWORK_PASSPHRASE_MAP.MAINNET).toBe(
        'Public Global Stellar Network ; September 2014'
      );
    });

    it('should have correct FUTURENET passphrase', () => {
      expect(NETWORK_PASSPHRASE_MAP.FUTURENET).toBe('Test SDF Future Network ; October 2022');
    });
  });
});