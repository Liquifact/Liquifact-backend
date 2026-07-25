/**
 * src/config/escrowMap.js
 *
 * Resolves an invoiceId to its on-chain LiquifactEscrow contract address and
 * provides the inverse lookup (contract address → invoiceId) for the escrow
 * indexer.
 *
 * Configuration is supplied via the ESCROW_ADDR_BY_INVOICE environment variable
 * (JSON). This avoids storing addresses in source code and allows per-environment
 * rotation without a redeploy.
 *
 * Schema of ESCROW_ADDR_BY_INVOICE (see README for full example):
 * {
 *   "mappings": [
 *     {
 *       "invoiceId": "inv_001",
 *       "escrowAddress": "GABC...123",
 *       "environment": "production",
 *       "isActive": true
 *     }
 *   ],
 *   "defaultEnvironment": "production",
 *   "allowlistEnabled": true,
 *   "cacheEnabled": true,
 *   "cacheTtlSeconds": 300
 * }
 *
 * Throws EscrowNotFoundError when no active mapping exists for the invoice in
 * the current environment. Callers should translate this to a 404 / 422.
 */

'use strict';

const { isValidStellarAddress } = require('../utils/validators');

/**
 * Thrown when no active escrow mapping exists for an invoice ID.
 */
class EscrowNotFoundError extends Error {
  /**
   * Creates an error for a missing invoice mapping.
   * @param {string} invoiceId - The invoice ID that could not be resolved.
   */
  constructor(invoiceId) {
    super(`No active escrow contract mapped for invoiceId: ${invoiceId}`);
    this.name = 'EscrowNotFoundError';
    this.invoiceId = invoiceId;
  }
}

/**
 * Thrown when ESCROW_ADDR_BY_INVOICE JSON is malformed or invalid.
 */
class EscrowMapConfigError extends Error {
  /**
   * Creates an error for invalid escrow map configuration.
   * @param {string} message - Human-readable configuration error.
   */
  constructor(message) {
    super(message);
    this.name = 'EscrowMapConfigError';
  }
}

/**
 * Parse and validate the raw config JSON from the environment.
 * @returns {{ mappings: Array, defaultEnvironment: string, allowlistEnabled: boolean, cacheEnabled: boolean, cacheTtlSeconds: number }}
 */
function _parseConfig() {
  const raw = process.env.ESCROW_ADDR_BY_INVOICE;
  if (!raw) {
    return {
      mappings: [],
      defaultEnvironment: 'development',
      allowlistEnabled: false,
      cacheEnabled: true,
      cacheTtlSeconds: 300,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EscrowMapConfigError(
      'ESCROW_ADDR_BY_INVOICE is not valid JSON. Check your environment configuration.'
    );
  }

  if (!Array.isArray(parsed.mappings)) {
    throw new EscrowMapConfigError('ESCROW_ADDR_BY_INVOICE.mappings must be an array.');
  }

  for (const m of parsed.mappings) {
    if (!m.invoiceId || typeof m.invoiceId !== 'string') {
      throw new EscrowMapConfigError('Each mapping must have a string invoiceId.');
    }
    if (!m.escrowAddress || !isValidStellarAddress(m.escrowAddress)) {
      throw new EscrowMapConfigError(
        `Mapping for ${m.invoiceId} has an invalid Stellar escrowAddress.`
      );
    }
  }

  return {
    mappings: parsed.mappings,
    defaultEnvironment: parsed.defaultEnvironment || 'development',
    allowlistEnabled: Boolean(parsed.allowlistEnabled),
    cacheEnabled: parsed.cacheEnabled !== false,
    cacheTtlSeconds: Number.isFinite(Number(parsed.cacheTtlSeconds))
      ? Number(parsed.cacheTtlSeconds)
      : 300,
  };
}

/** @type {{ config: object, reverseIndex: Map<string, string>, builtAt: number } | null} */
let _cache = null;

/**
 * Returns the active runtime environment used for mapping selection.
 *
 * @param {object} config - Parsed escrow map configuration.
 * @returns {string}
 */
function _currentEnvironment(config) {
  return process.env.NODE_ENV || config.defaultEnvironment;
}

/**
 * Rebuilds the module-level config cache and address→invoice reverse index.
 *
 * @returns {void}
 */
function _rebuildCache() {
  const config = _parseConfig();
  const env = _currentEnvironment(config);
  const reverseIndex = new Map();

  for (const mapping of config.mappings) {
    if (mapping.isActive === false) {
      continue;
    }
    if (mapping.environment !== env) {
      continue;
    }
    reverseIndex.set(mapping.escrowAddress, mapping.invoiceId);
  }

  _cache = {
    config,
    reverseIndex,
    builtAt: Date.now(),
  };
}

/**
 * Returns cached config, rebuilding when cache is disabled or TTL has expired.
 *
 * @returns {object}
 */
function _getConfig() {
  const now = Date.now();

  if (_cache) {
    const { config, builtAt } = _cache;
    if (config.cacheEnabled === false) {
      _rebuildCache();
      return _cache.config;
    }
    if (config.cacheTtlSeconds > 0 && now - builtAt >= config.cacheTtlSeconds * 1000) {
      _rebuildCache();
      return _cache.config;
    }
    return config;
  }

  _rebuildCache();
  return _cache.config;
}

/**
 * Returns the cached reverse index (address → invoiceId), refreshing when needed.
 *
 * @returns {Map<string, string>}
 */
function _getReverseIndex() {
  _getConfig();
  return _cache.reverseIndex;
}

/** Exposed for tests to reset the cache between test cases. */
function _resetCache() {
  _cache = null;
}

/**
 * Resolve the escrow contract address for a given invoiceId.
 *
 * @param {string} invoiceId
 * @returns {string} Stellar contract address (C... or G...)
 * @throws {EscrowNotFoundError} when no active mapping exists
 * @throws {EscrowMapConfigError} when the config JSON is malformed
 */
function resolveEscrowAddress(invoiceId) {
  const { mappings } = _getConfig();
  const env = _currentEnvironment(_cache.config);

  const match = mappings.find(
    (m) => m.invoiceId === invoiceId && m.isActive !== false && m.environment === env
  );

  if (!match) {
    // When allowlist is disabled and no mapping exists, still fail — callers
    // must always have an explicit mapping to prevent accidental fund misrouting.
    throw new EscrowNotFoundError(invoiceId);
  }

  return match.escrowAddress;
}

/**
 * Reverse lookup: resolve an invoice ID from an active escrow contract address.
 *
 * Only addresses present in the environment-scoped, active mapping allowlist are
 * resolved. Unknown, inactive, or foreign-environment addresses return `null` —
 * the indexer must never fabricate an invoice ID.
 *
 * @param {string} contractAddress - Stellar contract address from Horizon `contract_id`.
 * @returns {string|null} Mapped invoice ID, or null when not allowlisted.
 */
function resolveInvoiceByAddress(contractAddress) {
  if (contractAddress === null || contractAddress === undefined) {
    return null;
  }

  const address = String(contractAddress).trim();
  if (!isValidStellarAddress(address)) {
    return null;
  }

  return _getReverseIndex().get(address) || null;
}

module.exports = {
  resolveEscrowAddress,
  resolveInvoiceByAddress,
  EscrowNotFoundError,
  EscrowMapConfigError,
  _resetCache, // test-only
};
