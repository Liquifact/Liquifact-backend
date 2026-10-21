'use strict';

/**
 * Runtime configuration. Every value has a safe default so the API runs with
 * zero setup (locally, in CI and on Vercel).
 */
const CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID || 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';

// Maximum time (ms) to poll for a transaction's final status when the client
// requests `?wait=true`. Capped to stay within Vercel's function limits.
const TX_WAIT_MS = Math.min(Number(process.env.TX_WAIT_MS) || 20000, 25000);
const PROTOCOL_FEE_BPS = Number.isInteger(Number(process.env.PROTOCOL_FEE_BPS)) && Number(process.env.PROTOCOL_FEE_BPS) >= 0
  ? Number(process.env.PROTOCOL_FEE_BPS)
  : 0;

/**
 * Reads an integer environment variable.
 *
 * @param {string} name environment variable name
 * @param {number} fallback value used when the variable is unset or invalid
 * @param {number} [min] smallest accepted value
 * @returns {number} the configured value
 */
function envInt(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    return fallback;
  }
  return value;
}

module.exports = {
  port: Number(process.env.PORT) || 3001,
  network: process.env.STELLAR_NETWORK || 'testnet',
  rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  contractId: CONTRACT_ID,
  explorerUrl: `https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`,
  frontendUrl: process.env.FRONTEND_URL || 'https://liquifact-frontend.vercel.app',
  corsOrigins: (process.env.CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  txWaitMs: TX_WAIT_MS,
  protocolFeeBps: PROTOCOL_FEE_BPS,
  // Readiness probe: per-check timeout, maximum accepted ledger age and how
  // long a probe result may be reused before the RPC is called again.
  readyCheckTimeoutMs: envInt('READY_CHECK_TIMEOUT_MS', 2000, 1),
  readyMaxLedgerAgeSeconds: envInt('READY_MAX_LEDGER_AGE_SECONDS', 60, 1),
  readyCacheSeconds: envInt('READY_CACHE_SECONDS', 10, 0),
  version: require('../package.json').version,
};
