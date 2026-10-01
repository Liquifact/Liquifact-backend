/*
 * src/config/escrowMap.js
 *
 * Resolves an invoiceId to its on-chain LiquifactEscrow contract address and
 * provides the inverse lookup (contract address → invoiceId) for the escrow indexer.
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
 * the current environment. Funding callers translate this to a 404.
 *
 * Compatibility contracts:
 *   - `resolveEscrowAddress` returns `null` for invalid input and for unknown
 *     invoices. It never throws for a well-formed string invoiceId.
 *   - `resolveInvoiceByAddress` returns `null` for unknown, inactive, or
 *     foreign-environment addresses. It never throws.
 *   - The forward and reverse lookups share the same environment scoping
 *     rule (current environment OR configured defaultEnvironment) so a
 *     round-trip is always consistent.
 *   - Config parsing is pure with respect to cache state: a read never mutates
 *     the cache except to insert/evict a resolved entry.
 */
function getCacheSettings() {
  const parsed = parseCacheConfig();
  return {
    ttlMs: parsed.escrowTtl,
    // Read the key `parseCacheConfig` actually publishes. The previous
    // `escrowCacheMaxEntries` lookup always resolved to `undefined`, so
    // `Number.isFinite` was always false and the bound was silently pinned to
    // a magic 100 — `ESCROW_CACHE_MAX_ENTRIES` had no effect on this cache.
    // `parseCacheConfig` now guarantees a positive integer here, so the guard
    // is retained only as defence in depth against an out-of-contract value.
    maxEntries: Number.isFinite(parsed.escrowMaxEntries) ? parsed.escrowMaxEntries : 100,
  };
}

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.escrowMap = factory();
  }
})(this, function () {
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
      .regex(/^[GC][A-Z0-9]{55}$/, 'Invalid Stellar address format - must start with G or C and be 56 characters'),
    environment: z.string()
      .regex(/^(development|staging|production|test)$/, 'Environment must be valid')
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
      .regex(/^(development|staging|production|test)$/, 'Default environment must be valid')
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
   * @returns {{mappings: Array, defaultEnvironment: string, allowlistEnabled: boolean, cacheEnabled: boolean, cacheTtlSeconds: number}}
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
  function _evictOldestEntry() {
    const oldestKey = mappingCache.keys().next().value;
    if (oldestKey !== undefined) {
      mappingCache.delete(oldestKey);
    }
  }

  /**
   * Clears the mapping cache and resets its counters.
   *
   * @returns {void}
   */
  function clearCache() {
    mappingCache.clear();
    cacheHits = 0;
    cacheMisses = 0;
  }

  /**
   * Parses and validates the ESCROW_ADDR_BY_INVOICE environment variable.
   *
   * Expected format: JSON string with mappings array
   * Example: '{"mappings":[{"invoiceId":"inv_123","escrowAddress":"GABC...","environment":"development"}]}'
   *
   * @returns {z.infer typeof EscrowMappingConfigSchema} Validated mapping configuration
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

    try {
      const raw = JSON.parse(envValue);
      return EscrowMappingConfigSchema.parse(raw);
    } catch (error) {
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

    // Find mapping for the invoice ID
    const mapping = config.mappings.find(m => 
      m.invoiceId === invoiceId &&
      m.environment === targetEnv &&
      m.isActive
    );

    const address = mapping ? mapping.escrowAddress : null;

    // Cache the result if enabled
    if (config.cacheEnabled && address) {
      if (mappingCache.size >= cacheSettings.maxEntries) {
        _evictOldestEntry();
      }
      mappingCache.set(cacheKey, {
        address,
        timestamp: Date.now(),
      });
    }

    return address;
  }

  /**
   * Resolve the escrow contract address for a given invoiceId.
   *
   * @param {string} invoiceId
   * @returns {string|null} Stellar contract address (C... or G...), or null when not found
   * @throws {Error} when the config JSON is malformed
   */
  function resolveEscrowAddress(invoiceId) {
    if (!invoiceId || typeof invoiceId !== 'string') {
      return null;
    }
    const targetEnv = getCurrentEnvironment();
    const config = parseEscrowMappingConfig();
    const match = config.mappings.find(
      (m) => m.invoiceId === invoiceId && m.environment === targetEnv && m.isActive !== false
    );
    return match ? match.escrowAddress : null;
  }

  /**
   * Reverse lookup: resolve an invoice ID from an active escrow contract address.
   *
   * Only addresses present in the environment-scoped, active mapping allowlist are
   * resolved. Unknown, inactive, or foreign-environment addresses return `null` — the indexer must never fabricate an invoice ID.
   *
   * @param {string} contractAddress - Stellar contract address from Horizon `contract_id`.
   * @returns {string|null} Mapped invoice ID, or null when not allowlisted.
   */
  function resolveInvoiceByAddress(contractAddress) {
    if (!contractAddress || typeof contractAddress !== 'string') {
      return null;
    }

    try {
      const config = parseEscrowMappingConfig();
      const targetEnv = getCurrentEnvironment();

      const match = config.mappings.find(
        (mapping) =>
          mapping.escrowAddress === contractAddress &&
          (mapping.environment === targetEnv || mapping.environment === config.defaultEnvironment) &&
          mapping.isActive !== false
      );

      return match ? match.invoiceId : null;
    } catch (_err) {
      return null;
    }
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

    return config.mappings.filter(mapping => mapping.environment === targetEnv && mapping.isActive)
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
      const seen = new Map();
      config.mappings.forEach((mapping) => {
        const key = `${mapping.environment}:${mapping.invoiceId}`;
        if (seen.has(key)) {
          diagnostics.isValid = false;
          diagnostics.errors.push(
            `Duplicate invoiceId "${mapping.invoiceId}" in environment "${mapping.environment}"`
          );
        } else {
          seen.set(key, mapping);
        }
      });

      // Check for duplicate escrow addresses within the same environment
      const seenAddresses = new Map();
      config.mappings.forEach((mapping) => {
        const key = `${mapping.environment}:${mapping.escrowAddress}`;
        if (seenAddresses.has(key)) {
          diagnostics.isValid = false;
          diagnostics.errors.push(
            `Duplicate escrowAddress "${mapping.escrowAddress}" in environment "${mapping.environment}"`
          );
        } else {
          seenAddresses.set(key, mapping);
        }
      });

      // Warn when the default environment has no mappings
      const hasDefaultEnvMappings = config.mappings.some(
        (mapping) => mapping.environment === config.defaultEnvironment
      );
      if (!hasDefaultEnvMappings && config.mappings.length > 0) {
        diagnostics.warnings.push(
          `No mappings for default environment "${config.defaultEnvironment}"`
        );
      }
    } catch (error) {
      diagnostics.isValid = false;
      diagnostics.errors.push(error.message);
    }

    return diagnostics;
  }

  /**
   * Resets internal caches. Exposed for testing and config reload.
   *
   * @returns {void}
   */
  function resetCache() {
    clearCache();
    cachedSource = null;
  }

  /**
   * Returns cache statistics for observability.
   *
   * @returns {{hits: number, misses: number, size: number}}
   */
  function getCacheStats() {
    return {
      hits: cacheHits,
      misses: cacheMisses,
      size: mappingCache.size,
    };
  }

  return {
    resolveEscrowAddress,
    resolveInvoiceByAddress,
    getActiveMappings,
    validateMappingConfig,
    isInvoiceAllowlisted,
    parseEscrowMappingConfig,
    getCurrentEnvironment,
    resetCache,
    getCacheStats,
    // Exported for testing
    _internals: {
      clearCache,
      getCacheSettings,
      touchCacheKey,
      _evictOldestEntry,
    },
  };
});
