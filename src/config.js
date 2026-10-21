'use strict';

/**
 * Runtime configuration. Every value has a safe default so the API runs with
 * zero setup (locally, in CI and on Vercel).
 */
const CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID || 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';

// Roles an API key can carry. `admin` is accepted wherever a role is required.
const ROLES = ['sme', 'investor', 'admin'];

/**
 * Parses the `API_KEYS` env var (`id:role:sha256hex`, comma separated).
 * Only SHA-256 hashes are kept; raw keys are never stored. Malformed entries
 * are rejected at startup with a clear error.
 *
 * @param {string|undefined} raw raw `API_KEYS` value
 * @returns {{ id: string, role: string, hash: string }[]} parsed entries
 */
function parseApiKeys(raw) {
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const parts = entry.split(':');
      const label = `API_KEYS entry #${index + 1}`;
      if (parts.length !== 3) {
        throw new Error(`${label} must have the form id:role:sha256hex`);
      }
      const [id, role, hash] = parts;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new Error(`${label} has an invalid id (expected 1-64 letters, digits, "_" or "-")`);
      }
      if (!ROLES.includes(role)) {
        throw new Error(`${label} ("${id}") has unknown role "${role}" (expected ${ROLES.join('|')})`);
      }
      if (!/^[0-9a-f]{64}$/i.test(hash)) {
        throw new Error(`${label} ("${id}") must store a 64-character hex SHA-256 hash`);
      }
      return { id, role, hash: hash.toLowerCase() };
    });
}

// Maximum time (ms) to poll for a transaction's final status when the client
// requests `?wait=true`. Capped to stay within Vercel's function limits.
const TX_WAIT_MS = Math.min(Number(process.env.TX_WAIT_MS) || 20000, 25000);
const PROTOCOL_FEE_BPS = Number.isInteger(Number(process.env.PROTOCOL_FEE_BPS)) && Number(process.env.PROTOCOL_FEE_BPS) >= 0
  ? Number(process.env.PROTOCOL_FEE_BPS)
  : 0;

module.exports = {
  port: Number(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  ROLES,
  apiKeys: parseApiKeys(process.env.API_KEYS),
  devApiKey: process.env.DEV_API_KEY || '',
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
