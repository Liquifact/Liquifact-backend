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

const z = require('zod');
const { get: getConfig } = require('./index');
const { parseCacheConfig } = require('./cache');
let configReadCacheHits = { inc() {} };
let configReadCacheMisses = { inc() {} };

try {
  ({ configReadCacheHits, configReadCacheMisses } = require('../metrics'));
} catch (_error) {
  // Metrics are optional in isolated config tests.
}

/**
 * Thrown when no active escrow mapping exists for an invoice ID.
 */
const EscrowMappingEntrySchema = z.object({
  invoiceId: z.string()
    .min(1, 'Invoice ID cannot be empty')
    .max(100, 'Invoice ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invoice ID must contain only alphanumeric characters, underscores, and hyphens'),
  escrowAddress: z.string()
    .min(1, 'Escrow address cannot be empty')
    .regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar address format - must start with G and be 56 characters'),
  environment: z.string()
    .regex(/^(development|staging|production)$/, 'Environment must be development, staging, or production')
    .default('development'),
  isActive: z.boolean()
    .default(true)
});

/**
 * Thrown when ESCROW_ADDR_BY_INVOICE JSON is malformed or invalid.
 */
const EscrowMappingConfigSchema = z.object({
  mappings: z.array(EscrowMappingEntrySchema)
    .min(0, 'Mappings array cannot be negative')
    .max(1000, 'Too many mappings - maximum 1000 allowed'),
  defaultEnvironment: z.string()
    .regex(/^(development|staging|production)$/, 'Default environment must be valid')
    .default('development'),
  allowlistEnabled: z.boolean()
    .default(true),
  cacheEnabled: z.boolean()
    .default(true),
  cacheTtlSeconds: z.number()
    .min(5)
    .max(3600)
    .default(300)
});

/**
 * Parse and validate the raw config JSON from the environment.
 * @returns {{ mappings: Array, defaultEnvironment: string, allowlistEnabled: boolean, cacheEnabled: boolean, cacheTtlSeconds: number }}
 */
const mappingCache = new Map();
let cachedSource = null;
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Reads the cache bounds and TTL from environment configuration.
 *
 * @returns {{ ttlMs: number, maxEntries: number }} Cache settings.
 */
function getCacheSettings() {
  const parsed = parseCacheConfig();
  return {
    ttlMs: parsed.escrowTtl,
    maxEntries: Number.isFinite(parsed.escrowCacheMaxEntries) ? parsed.escrowCacheMaxEntries : 100,
  };
}

/**
 * Refreshes a cache entry's recency without changing its payload.
 *
 * @param {string} cacheKey - Cache key to touch.
 * @param {{ address: string, timestamp: number }} entry - Cached entry.
 * @returns {void}
 */
function touchCacheKey(cacheKey, entry) {
  mappingCache.delete(cacheKey);
  mappingCache.set(cacheKey, entry);
}

/**
 * Evicts the least-recently used cache entry.
 *
 * @returns {void}
 */
function evictOldestEntry() {
  const oldestKey = mappingCache.keys().next().value;
  if (oldestKey !== undefined) {
    mappingCache.delete(oldestKey);
  }
}

/**
 * Parses and validates the ESCROW_ADDR_BY_INVOICE environment variable.
 * 
 * Expected format: JSON string with mappings array
 * Example: '{"mappings":[{"invoiceId":"inv_123","escrowAddress":"GABC...","environment":"development"}]}'
 * 
 * @returns {z.infer<typeof EscrowMappingConfigSchema>} Validated mapping configuration
 * @throws {Error} If environment variable is invalid or malformed
 */
function parseEscrowMappingConfig() {
  const envValue = process.env.ESCROW_ADDR_BY_INVOICE;
  if (envValue !== cachedSource) {
    clearCache();
    cachedSource = envValue;
  }
  
  // Default empty config if not set
  if (!envValue || envValue.trim() === '') {
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
    throw new Error(`Failed to parse ESCROW_ADDR_BY_INVOICE JSON: ${error.message}`);
  }
}

/**
 * Gets the current environment from the app config.
 * Falls back to NODE_ENV if not available.
 * 
 * @returns {string} Current environment (development, staging, production)
 */
function getCurrentEnvironment() {
  try {
    const config = getConfig();
    return config.NODE_ENV || 'development';
  } catch (_error) {
    // Config not validated, fall back to environment variable
    return process.env.NODE_ENV || 'development';
  }
}

/**
 * Validates that an invoice ID is in the allowlist for the current environment.
 * 
 * @param {string} invoiceId - Invoice ID to validate
 * @param {string} [environment] - Target environment (defaults to current)
 * @returns {boolean} True if invoice ID is allowlisted
 */
function isInvoiceAllowlisted(invoiceId, environment) {
  if (!invoiceId || typeof invoiceId !== 'string') {
    return false;
  }

  const config = parseEscrowMappingConfig();
  const targetEnv = environment || getCurrentEnvironment();

  // If allowlist is disabled, allow all (for testing)
  if (!config.allowlistEnabled) {
    return true;
  }

  // Check if invoice exists in mappings for the target environment
  return config.mappings.some(mapping => 
    mapping.invoiceId === invoiceId &&
    mapping.environment === targetEnv &&
    mapping.isActive
  );
}

/**
 * Resolves an invoice ID to its corresponding Stellar escrow contract address.
 * 
 * @param {string} invoiceId - Invoice ID to resolve
 * @param {string} [environment] - Target environment (defaults to current)
 * @returns {string|null} Stellar contract address or null if not found
 * @throws {Error} If invoice ID is invalid or not allowlisted
 */
function _legacyResolveEscrowAddress(invoiceId, environment) {
  // Input validation
  if (!invoiceId || typeof invoiceId !== 'string') {
    throw new Error('Invoice ID is required and must be a string');
  }

  if (invoiceId.trim() === '') {
    throw new Error('Invoice ID cannot be empty');
  }

  const targetEnv = environment || getCurrentEnvironment();
  const config = parseEscrowMappingConfig();
  const cacheKey = `${invoiceId}:${targetEnv}`;
  const cacheSettings = getCacheSettings();

  // Check cache first if enabled
  if (config.cacheEnabled && mappingCache.has(cacheKey)) {
    const cached = mappingCache.get(cacheKey);
    const ageSeconds = (Date.now() - cached.timestamp) / 1000;
    
    if (ageSeconds * 1000 < cacheSettings.ttlMs) {
      cacheHits += 1;
      configReadCacheHits.inc();
      touchCacheKey(cacheKey, cached);
      return cached.address;
    } else {
      // Remove expired entry
      mappingCache.delete(cacheKey);
    }
  }

  cacheMisses += 1;
  configReadCacheMisses.inc();

  // Validate against allowlist
  if (config.allowlistEnabled && !isInvoiceAllowlisted(invoiceId, targetEnv)) {
    return null; // Not found in allowlist
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

  // Cache the result if enabled
  if (config.cacheEnabled) {
    if (mappingCache.size >= cacheSettings.maxEntries) {
      evictOldestEntry();
    }
    mappingCache.set(cacheKey, {
      address: mapping.escrowAddress,
      timestamp: Date.now()
    });
  }

  return mapping.escrowAddress;
}

/**
 * Gets all active mappings for a specific environment.
 * 
 * @param {string} [environment] - Target environment (defaults to current)
 * @returns {Array<{invoiceId: string, escrowAddress: string}>} Array of active mappings
 */
function getActiveMappings(environment) {
  const targetEnv = environment || getCurrentEnvironment();
  const config = parseEscrowMappingConfig();

  return config.mappings
    .filter(mapping => mapping.environment === targetEnv && mapping.isActive)
    .map(mapping => ({
      invoiceId: mapping.invoiceId,
      escrowAddress: mapping.escrowAddress
    }));
}

/**
 * Validates the escrow mapping configuration and returns diagnostics.
 * Useful for health checks and startup validation.
 * 
 * @returns {Object} Validation results with any errors found
 */
function validateMappingConfig() {
  const diagnostics = {
    isValid: true,
    errors: [],
    warnings: [],
    mappingCount: 0,
    activeMappings: 0,
    environments: new Set()
  };

  try {
    const config = parseEscrowMappingConfig();
    diagnostics.mappingCount = config.mappings.length;
    diagnostics.activeMappings = config.mappings.filter(m => m.isActive).length;

    // Collect environments
    config.mappings.forEach(mapping => {
      diagnostics.environments.add(mapping.environment);
    });

    // Check for duplicate invoice IDs within the same environment
    const invoiceEnvPairs = new Set();
    config.mappings.forEach(mapping => {
      const pair = `${mapping.invoiceId}:${mapping.environment}`;
      if (invoiceEnvPairs.has(pair)) {
        diagnostics.errors.push(`Duplicate invoice ID "${mapping.invoiceId}" in environment "${mapping.environment}"`);
        diagnostics.isValid = false;
      }
      invoiceEnvPairs.add(pair);
    });

    // Check for inactive mappings that might need cleanup
    const inactiveCount = config.mappings.filter(m => !m.isActive).length;
    if (inactiveCount > diagnostics.mappingCount * 0.5) {
      diagnostics.warnings.push(`High ratio of inactive mappings (${inactiveCount}/${diagnostics.mappingCount})`);
    }

    // Validate Stellar addresses format
    config.mappings.forEach(mapping => {
      if (!mapping.escrowAddress.startsWith('G') || mapping.escrowAddress.length !== 56) {
        diagnostics.errors.push(`Invalid Stellar address format for invoice "${mapping.invoiceId}"`);
        diagnostics.isValid = false;
      }
    });

  } catch (error) {
    diagnostics.isValid = false;
    diagnostics.errors.push(error.message);
  }

  return {
    ...diagnostics,
    environments: Array.from(diagnostics.environments)
  };
}

/**
 * Clears the internal mapping cache.
 * Useful for testing or when configuration changes.
 */
function clearCache() {
  mappingCache.clear();
  cachedSource = null;
  cacheHits = 0;
  cacheMisses = 0;
}

/**
 * Gets cache statistics for monitoring.
 * 
 * @returns {Object} Cache statistics
 */
function getCacheStats() {
  const entries = Array.from(mappingCache.values());
  const now = Date.now();
  
  return {
    size: mappingCache.size,
    maxSize: getCacheSettings().maxEntries,
    hits: cacheHits,
    misses: cacheMisses,
    entries: entries.map(entry => ({
      ageSeconds: (now - entry.timestamp) / 1000
    }))
  };
}

/**
 * Invalidates a single cached mapping entry.
 *
 * @param {string} invoiceId - Invoice ID whose cached mapping should be removed.
 * @param {string} [environment] - Target environment.
 * @returns {boolean} True if an entry was removed.
 */
function invalidateEscrowCache(invoiceId, environment) {
  const targetEnv = environment || getCurrentEnvironment();
  return mappingCache.delete(`${invoiceId}:${targetEnv}`);
}

/**
 * Invalidates all cached mappings for an environment.
 *
 * @param {string} [environment] - Target environment.
 * @returns {number} Number of entries removed.
 */
function invalidateEscrowCacheByEnvironment(environment) {
  const targetEnv = environment || getCurrentEnvironment();
  let removed = 0;
  for (const key of Array.from(mappingCache.keys())) {
    if (key.endsWith(`:${targetEnv}`)) {
      mappingCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

module.exports = {
  resolveEscrowAddress,
  isInvoiceAllowlisted,
  getActiveMappings,
  validateMappingConfig,
  clearCache,
  getCacheStats,
  invalidateEscrowCache,
  invalidateEscrowCacheByEnvironment,
  parseEscrowMappingConfig,
  EscrowMappingEntrySchema,
  EscrowMappingConfigSchema
};
