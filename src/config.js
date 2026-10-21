'use strict';

/**
 * Runtime configuration. Every value has a safe default so the API runs with
 * zero setup (locally, in CI and on Vercel).
 */
const CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID || 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';

module.exports = {
  port: Number(process.env.PORT) || 3001,
  network: process.env.STELLAR_NETWORK || 'testnet',
  rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  contractId: CONTRACT_ID,
  simulationSourceAccount: process.env.SIMULATION_SOURCE_ACCOUNT || 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
  explorerUrl: `https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`,
  frontendUrl: process.env.FRONTEND_URL || 'https://liquifact-frontend.vercel.app',
  corsOrigins: (process.env.CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  version: require('../package.json').version,
};
