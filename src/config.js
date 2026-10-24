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
function tryParseUrl(val) {
  try {
    return new URL(val);
  } catch {
    return null;
  }
}

/**
 * Validates CORS origin: scheme://host[:port] with no path, or '*'
 * @param {string} origin
 * @returns {boolean}
 */
function isValidCorsOrigin(origin) {
  if (origin === '*') {
    return true;
  }
  const parsed = tryParseUrl(origin);
  if (!parsed) {
    return false;
  }
  if (!parsed.protocol || !parsed.host) {
    return false;
  }
  // Origin must have no path (or just '/'), no search, no hash
  if (parsed.pathname && parsed.pathname !== '/') {
    return false;
  }
  if (parsed.search || parsed.hash) {
    return false;
  }
  // Ensure the reconstructed origin matches the trimmed origin (ignoring trailing slash)
  const normalized = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return parsed.origin === normalized;
}

/**
 * Validates RPC URL: must be https:// or http://localhost (or 127.0.0.1)
 * @param {string} urlStr
 * @returns {boolean}
 */
function isValidRpcUrl(urlStr) {
  const parsed = tryParseUrl(urlStr);
  if (!parsed) {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  }
  return false;
}

/**
 * @param {string|undefined} raw environment value
 * @param {number} fallback value used when raw is missing or not a positive integer
 * @returns {number} parsed positive integer
 */
function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Loads, normalizes and validates configuration from an environment object.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {object} validated config object
 */
function loadConfig(env = process.env) {
  const errors = [];

  // 1. Port
  let port = 3001;
  if (env.PORT !== undefined && env.PORT !== '') {
    const parsedPort = Number(env.PORT);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`);
    } else {
      port = parsedPort;
    }
  }

  // 2. Network & Presets
  const rawNetwork = env.STELLAR_NETWORK ? env.STELLAR_NETWORK.trim().toLowerCase() : 'testnet';
  const knownNetworks = ['testnet', 'mainnet', 'public', 'futurenet', 'custom'];
  if (!knownNetworks.includes(rawNetwork)) {
    errors.push(`STELLAR_NETWORK must be one of ${knownNetworks.join(', ')} (got "${rawNetwork}")`);
  }

  const preset = PRESETS[rawNetwork];

  // Passphrase
  let networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE;
  if (preset) {
    if (networkPassphrase && networkPassphrase !== preset.networkPassphrase) {
      errors.push(
        `STELLAR_NETWORK_PASSPHRASE mismatch for network "${rawNetwork}": expected "${preset.networkPassphrase}" or unset, got "${networkPassphrase}"`,
      );
    }
    networkPassphrase = networkPassphrase || preset.networkPassphrase;
  } else if (rawNetwork === 'custom') {
    if (!networkPassphrase) {
      errors.push('STELLAR_NETWORK_PASSPHRASE is required when STELLAR_NETWORK=custom');
    }
  }

  // RPC URL
  let rpcUrl = env.SOROBAN_RPC_URL;
  if (!rpcUrl && preset && preset.rpcUrl) {
    rpcUrl = preset.rpcUrl;
  }
  if (!rpcUrl) {
    errors.push(`SOROBAN_RPC_URL is required for network "${rawNetwork}"`);
  } else if (!isValidRpcUrl(rpcUrl)) {
    errors.push(`SOROBAN_RPC_URL must be a valid https:// URL or http://localhost (got "${rpcUrl}")`);
  }

  // Explorer Base URL
  let explorerBaseUrl = env.STELLAR_EXPLORER_URL;
  if (!explorerBaseUrl && preset) {
    explorerBaseUrl = preset.explorerBaseUrl;
  }
  if (!explorerBaseUrl && rawNetwork === 'custom') {
    errors.push('STELLAR_EXPLORER_URL is required when STELLAR_NETWORK=custom');
  }

  // Contract ID
  const contractId = env.ESCROW_CONTRACT_ID || DEFAULT_CONTRACT_ID;
  if (!contractId || !StrKey.isValidContract(contractId)) {
    errors.push(`ESCROW_CONTRACT_ID must be a valid Stellar contract address starting with 'C' (got "${contractId}")`);
  }

  // Explorer URL derived
  let explorerUrl = '';
  if (explorerBaseUrl && contractId) {
    const base = explorerBaseUrl.endsWith('/') ? explorerBaseUrl.slice(0, -1) : explorerBaseUrl;
    explorerUrl = `${base}/contract/${contractId}`;
  }

  // Frontend URL
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const parsedFrontend = tryParseUrl(frontendUrl);
  if (!parsedFrontend || !['http:', 'https:'].includes(parsedFrontend.protocol)) {
    errors.push(`FRONTEND_URL must be an absolute URL (got "${frontendUrl}")`);
  }

  // Public API Base URL
  let publicApiBaseUrl = env.PUBLIC_API_BASE_URL;
  if (publicApiBaseUrl) {
    const parsedPublicApi = tryParseUrl(publicApiBaseUrl);
    if (!parsedPublicApi || !['http:', 'https:'].includes(parsedPublicApi.protocol)) {
      errors.push(`PUBLIC_API_BASE_URL must be an absolute URL (got "${publicApiBaseUrl}")`);
    }
  }

  // CORS Allowed Origins
  const rawCors = env.CORS_ALLOWED_ORIGINS !== undefined && env.CORS_ALLOWED_ORIGINS !== ''
    ? env.CORS_ALLOWED_ORIGINS
    : '*';
  const corsOrigins = rawCors
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (corsOrigins.length === 0) {
    errors.push('CORS_ALLOWED_ORIGINS must contain at least one origin or "*"');
  } else {
    for (const origin of corsOrigins) {
      if (!isValidCorsOrigin(origin)) {
        errors.push(`CORS_ALLOWED_ORIGINS contains invalid origin "${origin}"`);
      }
    }
  }

  // Production check for CORS '*'
  const isProduction = env.NODE_ENV === 'production';
  const allowAnyOrigin = env.ALLOW_ANY_ORIGIN === 'true';
  if (isProduction && corsOrigins.includes('*') && !allowAnyOrigin) {
    errors.push(
      'CORS_ALLOWED_ORIGINS cannot include "*" in production unless ALLOW_ANY_ORIGIN=true is explicitly set',
    );
  }

  // Transaction wait (ms) for `?wait=true`, capped to stay within Vercel's function limits.
  const txWaitMs = Math.min(Number(env.TX_WAIT_MS) || 20000, 25000);

  // Protocol fee in basis points (non-negative integer, default 0).
  const rawFee = Number(env.PROTOCOL_FEE_BPS);
  const protocolFeeBps = Number.isInteger(rawFee) && rawFee >= 0 ? rawFee : 0;

  if (errors.length > 0) {
    throw new ConfigError(errors);
  }

  let version = '1.0.0';
  try {
    version = require('../package.json').version;
  } catch {
    // fallback if package.json not found
  }

  return {
    port,
    network: rawNetwork,
    rpcUrl,
    networkPassphrase,
    contractId,
    explorerUrl,
    frontendUrl,
    publicApiBaseUrl,
    corsOrigins,
    txWaitMs,
    protocolFeeBps,
    auditMaxEntries: positiveInt(env.AUDIT_MAX_ENTRIES, 10000),
    version,
  };
}

const config = loadConfig();

module.exports = config;
module.exports.loadConfig = loadConfig;
module.exports.ConfigError = ConfigError;
