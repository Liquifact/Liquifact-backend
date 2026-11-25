'use strict';

const net = require('net');
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

// Roles an API key can carry. `admin` is accepted wherever a role is required.
const ROLES = ['sme', 'investor', 'admin'];

// Accepted LOG_LEVEL values, lowest to highest severity.
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

// Known placeholder secrets rejected in production
const KNOWN_SECRET_PLACEHOLDERS = new Set(['change-me', 'change_me', 'secret', 'changeme', 'placeholder']);

/**
 * Validates secret strength in production: at least 32 characters and not a known placeholder.
 * Does not include the secret value in the error message.
 *
 * @param {string} name environment variable name
 * @param {string|undefined} value secret value
 * @param {string[]} errors accumulated errors
 */
function validateProductionSecret(name, value, errors) {
  if (value === undefined || value === '') {
    return;
  }
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (KNOWN_SECRET_PLACEHOLDERS.has(lower)) {
    errors.push(`${name} cannot be a known placeholder in production`);
  } else if (trimmed.length < 32) {
    errors.push(`${name} must be at least 32 characters in production`);
  }
}

/**
 * Parses `API_KEYS` (`id:role:sha256hex`, comma separated). Only SHA-256
 * hashes are kept; raw keys are never stored. Problems are pushed to `errors`
 * so a malformed entry fails startup with a clear message.
 *
 * @param {string|undefined} raw raw `API_KEYS` value
 * @param {string[]} errors accumulated configuration errors
 * @returns {{ id: string, role: string, hash: string }[]} parsed entries
 */
function parseApiKeys(raw, errors) {
  if (!raw || !raw.trim()) {
    return [];
  }
  const keys = [];
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const parts = entry.split(':');
      const label = `API_KEYS entry #${index + 1}`;
      if (parts.length !== 3) {
        errors.push(`${label} must have the form id:role:sha256hex`);
        return;
      }
      const [id, role, hash] = parts;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        errors.push(`${label} has an invalid id (expected 1-64 letters, digits, "_" or "-")`);
      } else if (!ROLES.includes(role)) {
        errors.push(`${label} ("${id}") has unknown role "${role}" (expected ${ROLES.join('|')})`);
      } else if (!/^[0-9a-f]{64}$/i.test(hash)) {
        errors.push(`${label} ("${id}") must store a 64-character hex SHA-256 hash`);
      } else {
        keys.push({ id, role, hash: hash.toLowerCase() });
      }
    });
  return keys;
}

/**
 * Reads an integer environment value.
 *
 * @param {string|undefined} raw raw environment value
 * @param {number} fallback value used when the variable is unset or invalid
 * @param {number} [min] smallest accepted value
 * @returns {number} the configured value
 */
function envInt(raw, fallback, min = 0) {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    return fallback;
  }
  return value;
}

const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Validates one token in a `TRUST_PROXY` CIDR/IP/subnet list.
 * Accepts IPv4/IPv6 addresses, IPv4/IPv6 CIDRs, and Express/proxy-addr
 * subnet presets (`loopback`, `linklocal`, `uniquelocal`).
 *
 * @param {string} token trimmed entry
 * @returns {boolean} whether the token is a valid proxy address/range
 */
function isValidProxyEntry(token) {
  if (!token) {
    return false;
  }
  const lower = token.toLowerCase();
  if (TRUST_PROXY_PRESETS.has(lower)) {
    return true;
  }
  const slashIndex = token.indexOf('/');
  if (slashIndex === -1) {
    return net.isIP(token) !== 0;
  }
  if (token.indexOf('/', slashIndex + 1) !== -1) {
    return false;
  }
  const addr = token.slice(0, slashIndex);
  const prefixRaw = token.slice(slashIndex + 1);
  if (!/^\d+$/.test(prefixRaw)) {
    return false;
  }
  const prefix = Number(prefixRaw);
  if (net.isIPv4(addr)) {
    return prefix >= 0 && prefix <= 32;
  }
  if (net.isIPv6(addr)) {
    return prefix >= 0 && prefix <= 128;
  }
  return false;
}

/**
 * Parses `TRUST_PROXY` for Express `app.set('trust proxy', ...)`.
 *
 * Accepted values:
 *   - unset / empty: `1` when `VERCEL=1`, otherwise `false`
 *   - `'false'`: `false`
 *   - non-negative integer string (e.g. `'0'`, `'1'`, `'2'`): hop count number
 *   - comma-separated IP / CIDR / subnet preset list (e.g. `'loopback, 10.0.0.0/8'`)
 *
 * `'true'` and any malformed values are rejected so startup fails with `ConfigError`.
 *
 * @param {string|undefined} raw raw `TRUST_PROXY` value
 * @param {Record<string, string|undefined>} env environment object
 * @param {string[]} errors accumulated configuration errors
 * @returns {boolean|number|string} Express `trust proxy` setting
 */
function parseTrustProxy(raw, env, errors) {
  if (raw === undefined || raw.trim() === '') {
    return env.VERCEL === '1' ? 1 : false;
  }
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'false') {
    return false;
  }
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    if (Number.isSafeInteger(hops)) {
      return hops;
    }
  }
  const tokens = trimmed.split(',').map((t) => t.trim());
  if (tokens.every((token) => isValidProxyEntry(token))) {
    return tokens.map((t) => (TRUST_PROXY_PRESETS.has(t.toLowerCase()) ? t.toLowerCase() : t)).join(', ');
  }
  errors.push(
    `TRUST_PROXY must be "false", a non-negative integer hop count, or a comma-separated list of IPs/CIDRs/presets (got "${raw}")`,
  );
  return false;
}

/**
 * Parses a boolean environment flag ("true"/"1" => true).
 *
 * @param {string|undefined} raw raw environment value
 * @param {boolean} fallback value used when unset
 * @returns {boolean}
 */
function envBool(raw, fallback = false) {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';
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

  // Source account used to build read-only Soroban simulations (never signs or submits).
  const simulationSourceAccount = env.SIMULATION_SOURCE_ACCOUNT || 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';
  if (!StrKey.isValidEd25519PublicKey(simulationSourceAccount)) {
    errors.push(`SIMULATION_SOURCE_ACCOUNT must be a valid Stellar G-address (got "${simulationSourceAccount}")`);
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

  // Graceful shutdown timeout (ms, positive integer, default 10000).
  let shutdownTimeoutMs = 10000;
  if (env.SHUTDOWN_TIMEOUT_MS !== undefined && env.SHUTDOWN_TIMEOUT_MS !== '') {
    const parsedShutdownTimeout = Number(env.SHUTDOWN_TIMEOUT_MS);
    if (!Number.isInteger(parsedShutdownTimeout) || parsedShutdownTimeout < 1) {
      errors.push(`SHUTDOWN_TIMEOUT_MS must be a positive integer (got "${env.SHUTDOWN_TIMEOUT_MS}")`);
    } else {
      shutdownTimeoutMs = parsedShutdownTimeout;
    }
  }

  // Log level (debug | info | warn | error, default info).
  let logLevel = 'info';
  if (env.LOG_LEVEL !== undefined && env.LOG_LEVEL.trim() !== '') {
    const normalizedLevel = env.LOG_LEVEL.trim().toLowerCase();
    if (!LOG_LEVELS.includes(normalizedLevel)) {
      errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${env.LOG_LEVEL}")`);
    } else {
      logLevel = normalizedLevel;
    }
  }

  // API keys for mutating routes (see middleware/auth.js)
  const apiKeys = parseApiKeys(env.API_KEYS, errors);

  // Maximum number of webhook subscriptions (positive integer, default 100).
  let webhooksMax = 100;
  if (env.WEBHOOKS_MAX !== undefined && env.WEBHOOKS_MAX !== '') {
    const parsedMax = Number(env.WEBHOOKS_MAX);
    if (!Number.isInteger(parsedMax) || parsedMax < 1) {
      errors.push(`WEBHOOKS_MAX must be a positive integer (got "${env.WEBHOOKS_MAX}")`);
    } else {
      webhooksMax = parsedMax;
    }
  }

  const rateLimitValue = (name, fallback, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') { return fallback; }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      errors.push(`${name} must be an integer between 1 and ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  };
  const rateLimit = {
    windowMs: rateLimitValue('RATE_LIMIT_WINDOW_MS', 60000, 86400000),
    max: rateLimitValue('RATE_LIMIT_MAX', 60, 1000000),
    maxClients: rateLimitValue('RATE_LIMIT_MAX_CLIENTS', 10000, 1000000),
    adminAuthWindowMs: rateLimitValue('ADMIN_AUTH_RATE_LIMIT_WINDOW_MS', 60000, 86400000),
    adminAuthMax: rateLimitValue('ADMIN_AUTH_RATE_LIMIT_MAX', 10, 1000000),
  };

  const webhookFailureThreshold = envInt(env.WEBHOOK_FAILURE_THRESHOLD, 10, 1);
  const webhookCooldownMs = envInt(env.WEBHOOK_COOLDOWN_MS, 300000, 0);

  // Express trust proxy setting (default: 1 hop on Vercel, false otherwise).
  const trustProxy = parseTrustProxy(env.TRUST_PROXY, env, errors);

  // Secret strength validation in production
  if (isProduction) {
    validateProductionSecret('ADMIN_API_TOKEN', env.ADMIN_API_TOKEN, errors);
    validateProductionSecret('CRON_SECRET', env.CRON_SECRET, errors);
  }

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
    simulationSourceAccount,
    explorerUrl,
    frontendUrl,
    publicApiBaseUrl,
    corsOrigins,
    txWaitMs,
    protocolFeeBps,
    indexerStateFile: env.INDEXER_STATE_FILE?.trim() || null,
    shutdownTimeoutMs,
    logLevel,
    auditMaxEntries: envInt(env.AUDIT_MAX_ENTRIES, 10000, 1),
    webhooksMax,
    webhookFailureThreshold,
    webhookCooldownMs,
    // Optimistic concurrency: when true, fund/settle/cancel/escrow-link
    // mutations must send an If-Match header (428 Precondition Required otherwise).
    requireIfMatch: envBool(env.REQUIRE_IF_MATCH, false),
    trustProxy,
    // Readiness probe: per-check timeout, maximum accepted ledger age and how
    // long a probe result may be reused before the RPC is called again.
    readyCheckTimeoutMs: envInt(env.READY_CHECK_TIMEOUT_MS, 2000, 1),
    readyMaxLedgerAgeSeconds: envInt(env.READY_MAX_LEDGER_AGE_SECONDS, 60, 1),
    readyCacheSeconds: envInt(env.READY_CACHE_SECONDS, 10, 0),
    nodeEnv: env.NODE_ENV || 'development',
    ROLES,
    apiKeys,
    devApiKey: env.DEV_API_KEY || '',
    adminApiToken: env.ADMIN_API_TOKEN || null,
    cronSecret: env.CRON_SECRET || null,
    rateLimit,
    version,
  };
}

const config = loadConfig();

module.exports = config;
module.exports.loadConfig = loadConfig;
module.exports.ConfigError = ConfigError;
