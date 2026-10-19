'use strict';

/**
 * Runtime configuration. Every value has a safe default so the API runs with
 * zero setup (locally, in CI and on Vercel).
 */
const CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID || 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P';

/**
 * Parses SUPPORTED_ASSETS ("XLM,USDC:GA5Z...") once at startup.
 *
 * @param {string} raw comma separated asset list
 * @returns {{ code: string, issuer: string|null }[]} supported assets
 */
function parseAssets(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, issuer] = entry.split(':');
      return { code: code.trim().toUpperCase(), issuer: issuer ? issuer.trim().toUpperCase() : null };
    })
    .filter((a) => /^[A-Z0-9]{1,12}$/.test(a.code));
}

module.exports = {
  supportedAssets: parseAssets(process.env.SUPPORTED_ASSETS || 'XLM,USDC'),
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
  version: require('../package.json').version,
};
