'use strict';

/**
 * Runtime configuration. Every value has a safe default so the API runs with
 * zero setup (locally, in CI and on Vercel).
 */
const CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID || 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';

/**
 * Minimum tenor in calendar days from today (UTC) that a new invoice's dueDate
 * must satisfy. A value of 1 means tomorrow is the earliest accepted date.
 * Corresponds to the escrow contract's MaturityInPast guard (error 166).
 * Set via MIN_TENOR_DAYS env var.
 */
const minTenorDays = Number(process.env.MIN_TENOR_DAYS) || 1;

/**
 * Maximum tenor in calendar days from today (UTC). Defaults to 1825 (≈ 5 years)
 * to match the deployed contract's maturity_max_horizon of 157 680 000 seconds
 * (~1825 days). Invoices beyond this horizon are rejected by the escrow contract
 * with MaturityExceedsMaxHorizon (error 167).
 * Set via MAX_TENOR_DAYS env var.
 */
const maxTenorDays = Number(process.env.MAX_TENOR_DAYS) || 1825;

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
  txWaitMs: Number(process.env.TX_WAIT_MS) || 30000,
  protocolFeeBps: Number(process.env.PROTOCOL_FEE_BPS) || 0,
  version: require('../package.json').version,
  minTenorDays,
  maxTenorDays,
};
