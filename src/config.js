'use strict';

const { StrKey } = require('@stellar/stellar-sdk');

class ConfigError extends Error {
  /**
   * @param {string[]} errors
   */
  constructor(errors) {
    const message = `Invalid configuration:\n  - ${errors.join('\n  - ')}`;
    super(message);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const DEFAULT_CONTRACT_ID = 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';
const DEFAULT_FRONTEND_URL = 'https://liquifact-frontend.vercel.app';

const PRESETS = {
  testnet: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    explorerBaseUrl: 'https://stellar.expert/explorer/testnet',
  },
  public: {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    rpcUrl: null, // must be provided
    explorerBaseUrl: 'https://stellar.expert/explorer/public',
  },
  mainnet: {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    rpcUrl: null, // must be provided
    explorerBaseUrl: 'https://stellar.expert/explorer/public',
  },
  futurenet: {
    networkPassphrase: 'Test SDF Future Network ; October 2022',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    explorerBaseUrl: 'https://stellar.expert/explorer/futurenet',
  },
};

/**
 * Validates whether a string is a valid URL.
 * @param {string} val
 * @returns {URL|null}
 */
const CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID || 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';

// Maximum time (ms) to poll for a transaction's final status when the client
// requests `?wait=true`. Capped to stay within Vercel's function limits.
const TX_WAIT_MS = Math.min(Number(process.env.TX_WAIT_MS) || 20000, 25000);
const PROTOCOL_FEE_BPS = Number.isInteger(Number(process.env.PROTOCOL_FEE_BPS)) && Number(process.env.PROTOCOL_FEE_BPS) >= 0
  ? Number(process.env.PROTOCOL_FEE_BPS)
  : 0;

module.exports = {
  port: Number(process.env.PORT) || 3001,
  network: process.env.STELLAR_NETWORK || 'testnet',
  rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE || 'Test DEV Network ; September 2015',
  contractId: CONTRACT_ID,
  explorerUrl: `https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`,
  frontendUrl: process.env.FRONTEND_URL || 'https://liquifact-frontend.vercel.app',
  corsOrigins: (process.env.CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  txWaitMs: TX_WAIT_MS,
  protocolFeeBps: PROTOCOL_FEE_BPS,
  version: require('../package.json').version,
};
