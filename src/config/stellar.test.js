/**
 * Tests for Stellar network configuration validation.
 * @module config/stellar.test
 */

const {
  validateStellarConfig,
  getStellarConfig,
  getNetworkPassphrase,
  getExpectedRpc,
  VALID_NETWORKS,
  NETWORK_RPC_MAP,
  NETWORK_PASSPHRASE_MAP,
  ERROR_CODES,
  StellarConfigError,
} = require('./stellar');
const configIndex = require('./index');

/**
 * Captures the {name, code, message} triple thrown for a given env map.
 * @param {Object} env - Environment map to validate.
 * @returns {{code: string, message: string, name: string}} Error shape.
 */
const failureOf = (env) => {
  try {
    validateStellarConfig(env);
  } catch (error) {
    return { code: error.code, message: error.message, name: error.name };
  }
  throw new Error('expected validateStellarConfig to throw');
};

/**
 * Captures the error thrown for a given env map, keeping the full error object.
 * @param {Object} env - Environment map to validate.
 * @returns {Error} The thrown error.
 */
const thrownBy = (env) => {
  try {
    validateStellarConfig(env);
  } catch (error) {
    return error;
  }
  throw new Error('expected validateStellarConfig to throw');
};

describe('config/stellar', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'development' };
    delete process.env.STELLAR_NETWORK_PASSPHRASE;
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
      expect(result.passphrase).toBe(NETWORK_PASSHRASE_MAP.TESTNET);
    });

    it('should accept valid MAINNET configuration', () => {
      process.env.STELLAR_NETWORK = 'MAINNET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.MAINNET;

      const result = validateStellarConfig();

      expect(result.network).toBe('MAINNET');
      expect(result.rpcUrl).toBe(NETWORK_RPC_MAP.MAINNET);
      expect(result.passphrase).toBe(NETWORK_PASSHRASE_MAP.MAINNET);
    });

    it('should accept valid FUTURENET configuration', () => {
      process.env.STELLAR_NETWORK = 'FUTURENET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.FUTURENET;

      const result = validateStellarConfig();

      expect(result.network).toBe('FUTURENET');
      expect(result.rpcUrl).toBe(NETWORK_RPC_MAP.FUTURENET);
      expect(result.passphrase).toBe(NETWORK_PASSHRASE_MAP.FUTURENET);
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

    it('should reject whitespace-padded and case-mismatched network names', () => {
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.TESTNET;

      for (const network of [' TESTNET', 'TESTNET ', 'testnet']) {
        process.env.STELLAR_NETWORK = network;
        expect(() => validateStellarConfig()).toThrow('Invalid STELLAR_NETWORK');
      }
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

    it('should reject whitespace, malformed, and boundary-modified RPC URLs', () => {
      process.env.STELLAR_NETWORK = 'TESTNET';

      for (const rpcUrl of [
        ' https://soroban-testnet.stellar.org',
        'https://soroban-testnet.stellar.org/',
        'not a URL',
      ]) {
        process.env.SOROBAN_RPC_URL = rpcUrl;
        expect(() => validateStellarConfig()).toThrow('requires SOROBAN_RPC_URL');
      }
    });

    it('should reject an explicitly configured passphrase for another network', () => {
      process.env.STELLAR_NETWORK = 'MAINNET';
      process.env.SOROBAN_RPC_URL = NETWORK_RPC_MAP.MAINNET;
      process.env.STELLAR_NETWORK_PASSPHRASE = NETWORK_PASSPHRASE_MAP.TESTNET;

      expect(() => validateStellarConfig()).toThrow(
        'STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK'
      );
    });
  });

  describe('getNetworkPassphrase', () => {
    it('should return correct passphrase for TESTNET', () => {
      expect(getNetworkPassphrase('TESTNET')).toBe(NETWORK_PASSHRASE_MAP.TESTNET);
    });

    it('should return correct passphrase for MAINNET', () => {
      expect(getNetworkPassphrase('MAINNET')).toBe(NETWORK_PASSHRASE_MAP.MAINNET);
    });

    it('should return correct passphrase for FUTURENET', () => {
      expect(getNetworkPassphrase('FUTURENET')).toBe(NETWORK_PASSHRASE_MAP.FUTURENET);
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
      expect(getExpectedRtc('TESTNET')).toBe(NETWORK_RPC_MAP.TESTNET);
    });

    it('should return correct RPC for MAINNET', () => {
      expect(getExpectedRtc('MAINNET')).toBe(NETWORK_RPC_MAP.MAINNET);
    });

    it('should return correct RPC for FUTURENET', () => {
      expect(getExpectedRtc('FUTURENET')).toBe(NETWORK_RPC_MAP.FUTURENET);
    });

    it('should throw for unknown network', () => {
      expect(() => getExpectedRtc('INVALID')).toThrow('Unknown network');
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
      expect(NETWORK_PASSHRASE_MAP.TESTNET).toBe('Test FDF Network ; September 2015');
    });

    it('should have correct MAINNET passphrase', () => {
      expect(NETWORK_PASSHRASE_MAP.MAINNET).toBe(
        'Public Global Stellar Network ; September 2014'
      );
    });

    it('should have correct FUTURENET passphrase', () => {
      expect(NETWORK_PASSHRASE_MAP.FUTURENET).toBe('Test SDF Future Network ; October 2022');
    });
  });

  // ---------------------------------------------------------------------------
  // Failure recovery: determinism, recoverability and observability.
  // ---------------------------------------------------------------------------

  describe('validateStellarConfig failure recovery', () => {
    const VALID_ENV = Object.freeze({
      STELLAR_NETWORK: 'TESTNET',
      SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET,
    });

    it('returns an identical result on every repeat for the same input', () => {
      const results = [];
      for (let i = 0; i < 50; i += 1) {
        results.push(validateStellarConfig({ ...VALID_ENV }));
      }
      for (const result of results) {
        expect(result).toEqual(results[0]);
      }
    });

    it('returns a fresh, unfrozen-by-reference result object each call', () => {
      const first = validateStellarConfig({ ...VALID_ENV });
      const second = validateStellarConfig({ ...VALID_ENV });
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });

    it('produces the identical error for identical invalid input', () => {
      const invalid = { STELLAR_NETWORK: 'TESTNET', SOROBAN_RPC_URL: NETWORK_RPC_MAP.MAINNET };
      expect(failureOf({ ...invalid })).toEqual(failureOf({ ...invalid }));
    });

    it('does not mutate the environment map it was given', () => {
      const env = { ...VALID_ENV };
      const snapshot = { ...env };
      validateStellarConfig(env);
      expect(env).toEqual(snapshot);
    });

    it('recovers after a failure without process reload', () => {
      expect(failureOf({ STELLAR_NETWORK: 'TESTNET', SOROBAN_RPC_URL: 'https://wrong.example' }))
        .toMatchObject({ code: ERROR_CODES.RPC_MISMATCH });
      expect(validateStellarConfig({ ...VALID_ENV })).toEqual({
        network: 'TESTNET',
        rpcUrl: NETWORK_RPC_MAP.TESTNET,
        passphrase: NETWORK_PASSPHRASE_MAP.TESTNET,
      });
    });

    it('recovers across repeated fail/succeed cycles without state drift', () => {
      const bad = { STELLAR_NETWORK: 'MAINNET', SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET };
      const good = { STELLAR_NETWORK: 'MAINNET', SOROBAN_RPC_URL: NETWORK_RPC_MAP.MAINNET };
      for (let i = 0; i < 5; i += 1) {
        expect(failureOf({ ...bad }).code).toBe(ERROR_CODES.RPC_MISMATCH);
        expect(validateStellarConfig({ ...good }).network).toBe('MAINNET');
      }
    });

    it('keeps concurrent validations isolated to their own environment', async () => {
      const envs = VALID_NETWORKS.map((network) => ({
        STELLAR_NETWORK: network,
        SOROBAN_RPC_URL: NETWORK_RPC_MAP[network],
      }));
      const results = await Promise.all(
        envs.map(async (env) => validateStellarConfig(env)),
      );
      expect(results.map((r) => r.network)).toEqual(['TESTNET', 'MAINNET', 'FUTURENET']);
      expect(results.map((r) => r.rpcUrl)).toEqual(VALID_NETWORKS.map((n) => NETWORK_RPC_MAP[n]));
      expect(results.map((r) => r.passphrase)).toEqual(
        VALID_NETWORKS.map((n) => NETWORK_PASSPHRASE_MAP[n]),
      );
    });

    it('does not leak a failed validation result into a later valid call', () => {
      const failed = failureOf({ STELLAR_NETWORK: 'TESTNET', SOROBAN_RPC_URL: 'nope' });
      const succeeded = validateStellarConfig({ ...VALID_ENV });
      expect(failed.code).toBe(ERROR_CODES.RPC_MISMATCH);
      expect(succeeded.rpcUrl).toBe(NETWORK_RPC_MAP.TESTNET);
    });
  });

  describe('validateStellarConfig input normalization', () => {
    it('trims surrounding whitespace from both variables', () => {
      const result = validateStellarConfig({
        STELLAR_NETWORK: '  TESTNET  ',
        SOROBAN_RPC_URL: `  ${NETWORK_RPC_MAP.TESTNET}  `,
      });
      expect(result).toEqual({
        network: 'TESTNET',
        rpcUrl: NETWORK_RPC_MAP.TESTNET,
        passphrase: NETWORK_PASSPHRASE_MAP.TESTNET,
      });
    });

    it('accepts a lowercase network name', () => {
      expect(
        validateStellarConfig({
          STELLAR_NETWORK: 'testnet',
          SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET,
        }).network,
      ).toBe('TESTNET');
    });

    it('accepts a canonical URL with a trailing slash', () => {
      expect(
        validateStellarConfig({
          STELLAR_NETWORK: 'TESTNET',
          SOROBAN_RPC_URL: `${NETWORK_RPC_MAP.TESTNET}/`,
        }).rpcUrl,
      ).toBe(NETWORK_RPC_MAP.TESTNET);
    });

    it('accepts a canonical URL with upper-cased host', () => {
      expect(
        validateStellarConfig({
          STELLAR_NETWORK: 'TESTNET',
          SOROBAN_RPC_URL: 'https://SOROBAN-TESTNET.STELLAR.ORG',
        }).rpcUrl,
      ).toBe(NETWORK_RPC_MAP.TESTNET);
    });

    it('rejects a plaintext downgrade of a canonical endpoint', () => {
      expect(
        failureOf({ STELLAR_NETWORK: 'TESTNET', SOROBAN_RPC_URL: 'http://soroban-testnet.stellar.org' }),
      ).toMatchObject({ code: ERROR_CODES.RPC_MISMATCH });
    });

    it('rejects a canonical endpoint carrying a path, query or fragment', () => {
      for (const url of [
        `${NETWORK_RPC_MAP.TESTNET}/rpc`,
        `${NETWORK_RPC_MAP.TESTNET}?x=1`,
        `${NETWORK_RPC_MAP.TESTNET}#frag`,
      ]) {
        expect(failureOf({ STELLAR_NETWORK: 'TESTNET', SOROBAN_RPC_URL: url }).code).toBe(
          ERROR_CODES.RPC_MISMATCH,
        );
      }
    });

    it('rejects a non-URL RPC value', () => {
      expect(failureOf({ STELLAR_NETWORK: 'TESTNET', SOROBAN_RPC_URL: 'not-a-url' }).code).toBe(
        ERROR_CODES.RPC_MISMATCH,
      );
    });
  });

  describe('validateStellarConfig boundary cases', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('treats an %s STELLAR_NETWORK as missing', (_label, value) => {
      expect(
        failureOf({ STELLAR_NETWORK: value, SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET }),
      ).toMatchObject({ code: ERROR_CODES.NETWORK_MISSING, message: 'STELLAR_NETWORK is required' });
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('treats an %s SOROBAN_RPC_URL as missing', (_label, value) => {
      expect(
        failureOf({ STELLAR_NETWORK: 'TESTNET', SOROBAN_RPC_URL: value }),
      ).toMatchObject({ code: ERROR_CODES.RPC_URL_MISSING, message: 'SOROBAN_RPC_URL is required' });
    });

    it('reports the missing network before inspecting the RPC URL', () => {
      expect(failureOf({ SOROBAN_RPC_URL: 'anything' }).code).toBe(ERROR_CODES.NETWORK_MISSING);
    });

    it('reports an unknown network before checking the RPC pairing', () => {
      expect(
        failureOf({ STELLAR_NETWORK: 'LOCALNET', SOROBAN_RPC_URL: 'https://localhost:8000' }).code,
      ).toBe(ERROR_CODES.NETWORK_UNKNOWN);
    });

    it('does not truncate a rejected network value at exactly the echo limit', () => {
      const exact = 'A'.repeat(200);
      expect(
        failureOf({ STELLAR_NETWORK: exact, SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET }).message,
      ).toBe(`Invalid STELLAR_NETWORK: ${exact}`);
    });

    it('truncates a rejected network value one character past the echo limit', () => {
      const over = 'A'.repeat(201);
      const message = failureOf({
        STELLAR_NETWORK: over,
        SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET,
      }).message;
      expect(message).toBe(`Invalid STELLAR_NETWORK: ${'A'.repeat(200)}...(truncated)`);
    });

    it.each([
      ['null', null],
      ['a string', 'production'],
      ['a number', 42],
    ])('rejects %s as an environment map', (_label, value) => {
      expect(failureOf(value).code).toBe(ERROR_CODES.ENV_INVALID);
    });

    it.each([[undefined], [null], [''], ['   '], ['LOCALNET'], ['MAINNETX']])(
      'rejects %p as an unknown network in the lookup helpers',
      (value) => {
        expect(() => getExpectedRpc(value)).toThrow('Unknown network');
        expect(() => getNetworkPassphrase(value)).toThrow('Unknown network');
      },
    );

    it('does not resolve inherited object properties as networks', () => {
      for (const value of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        expect(() => getExpectedRpc(value)).toThrow('Unknown network');
        expect(() => getNetworkPassphrase(value)).toThrow('Unknown network');
      }
    });

    it.each(['testnet', '  MAINNET  ', 'futurenet'])(
      'resolves %p case-insensitively in the lookup helpers',
      (value) => {
        const expected = value.trim().toUpperCase();
        expect(getExpectedRpc(value)).toBe(NETWORK_RPC_MAP[expected]);
        expect(getNetworkPassphrase(value)).toBe(NETWORK_PASSPHRASE_MAP[expected]);
      },
    );
  });

  describe('error observability and redaction', () => {
    it('redacts credentials embedded in the rejected RPC URL', () => {
      const thrown = thrownBy({
        STELLAR_NETWORK: 'TESTNET',
        SOROBAN_RPC_URL: 'https://rpc-user:sup3r-secret@soroban-testnet.stellar.org',
      });
      expect(thrown.code).toBe(ERROR_CODES.RPC_MISMATCH);
      expect(thrown.message).not.toContain('sup3r-secret');
      expect(thrown.message).not.toContain('rpc-user');
      expect(thrown.message).toContain('[redacted]@soroban-testnet.stellar.org');
      expect(JSON.stringify(thrown.toJSON())).not.toContain('sup3r-secret');
    });

    it('strips control characters so a value cannot forge log lines', () => {
      const injected = 'LOCALNET\nERROR forged log line';
      const thrown = failureOf({
        STELLAR_NETWORK: injected,
        SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET,
      });
      expect(thrown.message).not.toContain('\n');
      expect(thrown.message).toBe('Invalid STELLAR_NETWORK: LOCALNETERROR forged log line');
    });

    it('exposes a stable code and redacted details on every failure', () => {
      const thrown = thrownBy({
        STELLAR_NETWORK: 'TESTNET',
        SOROBAN_RPC_URL: 'https://rpc-user:sup3r-secret@rpc.example.com',
      });
      expect(thrown).toBeInstanceOf(StellarConfigError);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.name).toBe('StellarConfigError');
      expect(thrown.details).toEqual({
        network: 'TESTNET',
        expectedRpcUrl: NETWORK_RPC_MAP.TESTNET,
        actualRpcUrl: 'https://[redacted]@rpc.example.com',
      });
      expect(Object.isFrozen(thrown.details)).toBe(true);
    });

    it('lists the supported networks on an unknown-network failure', () => {
      const thrown = thrownBy({
        STELLAR_NETWORK: 'LOCALNET',
        SOROBAN_RPC_URL: NETWORK_RPC_MAP.TESTNET,
      });
      expect(thrown.details.validNetworks).toEqual(VALID_NETWORKS);
    });

    it('keeps documented ERROR_CODES values stable for log pipelines', () => {
      expect(ERROR_CODES).toEqual({
        ENV_INVALID: 'STELLAR_CONFIG_ENV_INVALID',
        NETWORK_MISSING: 'STELLAR_NETWORK_MISSING',
        RPC_URL_MISSING: 'SOROBAN_RPC_URL_MISSING',
        NETWORK_UNKNOWN: 'STELLAR_NETWORK_UNKNOWN',
        RPC_MISMATCH: 'STELLAR_NETWORK_RPC_MISMATCH',
        CONFIG_NOT_VALIDATED: 'STELLAR_CONFIG_NOT_VALIDATED',
        PASSPHRASE_RPC_MISMATCH: 'STELLAR_PASSPHRASE_RPC_MISMATCH',
      });
    });
  });

  describe('getStellarConfig', () => {
    afterEach(() => {
      process.env = originalEnv;
      configIndex.validate();
    });

    /**
     * Repopulates the validated config store from an explicit pair.
     * @param {string} passphrase - NETWORK_PASSPHRASE value.
     * @param {string} rpcUrl - SOROBAN_RPC_URL value.
     * @returns {void}
     */
    const seedStore = (passphrase, rpcUrl) => {
      process.env.NETWORK_PASSPHRASE = passphrase;
      process.env.SOROBAN_RPC_URL = rpcUrl;
      configIndex.validate();
    };

    it('returns the documented shape for the default testnet pairing', () => {
      seedStore(NETWORK_PASSPHRASE_MAP.TESTNET, NETWORK_RPC_MAP.TESTNET);
      expect(getStellarConfig()).toEqual({
        rpcUrl: NETWORK_RPC_MAP.TESTNET,
        networkPassphrase: NETWORK_PASSPHRASE_MAP.TESTNET,
      });
    });

    it('returns the documented shape for the mainnet pairing', () => {
      seedStore(NETWORK_PASSPHRASE_MAP.MAINNET, NETWORK_RPC_MAP.MAINNET);
      expect(getStellarConfig()).toEqual({
        rpcUrl: NETWORK_RPC_MAP.MAINNET,
        networkPassphrase: NETWORK_PASSPHRASE_MAP.MAINNET,
      });
    });

    it('rejects a canonical passphrase paired with another network endpoint', () => {
      seedStore(NETWORK_PASSPHRASE_MAP.TESTNET, NETWORK_RPC_MAP.MAINNET);
      let thrown;
      try {
        getStellarConfig();
      } catch (error) {
        thrown = error;
      }
      expect(thrown.code).toBe(ERROR_CODES.PASSPHRASE_RPC_MISMATCH);
      expect(thrown.details).toEqual({
        passphraseNetwork: 'TESTNET',
        rpcNetwork: 'MAINNET',
        expectedRpcUrl: NETWORK_RPC_MAP.TESTNET,
        actualRpcUrl: NETWORK_RPC_MAP.MAINNET,
      });
    });

    it('names the identified network in the message without echoing the passphrase', () => {
      seedStore(NETWORK_PASSPHRASE_MAP.FUTURENET, NETWORK_RPC_MAP.MAINNET);
      expect(() => getStellarConfig()).toThrow('NETWORK_PASSPHRASE identifies FUTURENET');
    });

    it('allows a non-canonical RPC endpoint, e.g. a private proxy or local sandbox', () => {
      seedStore(NETWORK_PASSPHRASE_MAP.TESTNET, 'http://localhost:8000');
      expect(getStellarConfig()).toEqual({
        rpcUrl: 'http://localhost:8000',
        networkPassphrase: NETWORK_PASSPHRASE_MAP.TESTNET,
      });
    });

    it('allows a canonical passphrase pointed at a private HTTPS proxy', () => {
      seedStore(NETWORK_PASSPHRASE_MAP.MAINNET, 'https://rpc.internal.example.com');
      expect(getStellarConfig()).toEqual({
        rpcUrl: 'https://rpc.internal.example.com',
        networkPassphrase: NETWORK_PASSPHRASE_MAP.MAINNET,
      });
    });

    it('allows a non-canonical passphrase, e.g. a self-hosted network', () => {
      seedStore('My Private Network ; January 2026', NETWORK_RPC_MAP.TESTNET);
      expect(getStellarConfig()).toEqual({
        rpcUrl: NETWORK_RPC_MAP.TESTNET,
        networkPassphrase: 'My Private Network ; January 2026',
      });
    });

    it('recovers on the next call once the store pairing is corrected', () => {
      seedStore(NETWORK_PASSPHRASE_MAP.TESTNET, NETWORK_RPC_MAP.MAINNET);
      expect(() => getStellarConfig()).toThrow(StellarConfigError);
      seedStore(NETWORK_PASSPHRASE_MAP.TESTNET, NETWORK_RPC_MAP.TESTNET);
      expect(getStellarConfig().rpcUrl).toBe(NETWORK_RPC_MAP.TESTNET);
    });

    it('throws the documented error when validate() has not run', () => {
      jest.isolateModules(() => {
        const isolated = require('./stellar');
        let thrown;
        try {
          isolated.getStellarConfig();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(isolated.StellarConfigError);
        expect(thrown.code).toBe('STELLAR_CONFIG_NOT_VALIDATED');
        expect(thrown.message).toBe('Config not validated. Call validate() first.');
        expect(thrown.cause).toBeInstanceOf(Error);
      });
    });
  });

  describe('canonical matrix integrity', () => {
    it('maps every valid network to an RPC URL and a passphrase', () => {
      for (const network of VALID_NETWORKS) {
        expect(typeof NETWORK_RPC_MAP[network]).toBe('string');
        expect(typeof NETWORK_PASSPHRASE_MAP[network]).toBe('string');
      }
    });

    it('defines no RPC URL or passphrase outside the supported networks', () => {
      expect(Object.keys(NETWORK_RPC_MAP).sort()).toEqual([...VALID_NETWORKS].sort());
      expect(Object.keys(NETWORK_PASSPHRASE_MAP).sort()).toEqual([...VALID_NETWORKS].sort());
    });

    it('keeps RPC URLs and passphrases unique per network', () => {
      expect(new Set(Object.values(NETWORK_RPC_MAP)).size).toBe(VALID_NETWORKS.length);
      expect(new Set(Object.values(NETWORK_PASSPHRASE_MAP)).size).toBe(VALID_NETWORKS.length);
    });

    it('only ever uses https canonical endpoints', () => {
      for (const rpcUrl of Object.values(NETWORK_RPC_MAP)) {
        expect(rpcUrl.startsWith('https://')).toBe(true);
      }
    });

    it('freezes the exported matrix so callers cannot widen it', () => {
      expect(Object.isFrozen(VALID_NETWORKS)).toBe(true);
      expect(Object.isFrozen(NETWORK_RPC_MAP)).toBe(true);
      expect(Object.isFrozen(NETWORK_PASSPHRASE_MAP)).toBe(true);
      expect(Object.isFrozen(ERROR_CODES)).toBe(true);

      try {
        VALID_NETWORKS.push('LOCALNET');
      } catch (_err) {
        // Strict-mode callers get a TypeError; the value must be unchanged either way.
      }
      try {
        NETWORK_RPC_MAP.LOCALNET = 'http://localhost:8000';
      } catch (_err) {
        // As above.
      }
      expect(VALID_NETWORKS).toHaveLength(3);
      expect(NETWORK_RPC_MAP.LOCALNET).toBeUndefined();
    });
  });
});