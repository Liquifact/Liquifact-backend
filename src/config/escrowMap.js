/**
 * @fileoverview Escrow address mapping configuration for invoice-to-contract resolution.
 * 
 * Provides secure mapping of invoice IDs to their corresponding Stellar escrow contract
 * addresses using environment-based configuration for early phases. Supports allowlist
 * validation and environment separation for multi-deployment scenarios.
 * 
 * @module config/escrowMap
 */

'use strict';

const z = require('zod');
const { get: getConfig } = require('./index');

/**
 * Schema for individual escrow mapping entries.
 * Validates invoice ID format and Stellar address structure.
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
    .optional()
    .default('development')
    .regex(/^(development|staging|production)$/, 'Environment must be development, staging, or production'),
  isActive: z.boolean()
    .default(true)
});

/**
 * Schema for the complete escrow mapping configuration.
 * Supports JSON string parsing from environment variables.
 */
const EscrowMappingConfigSchema = z.object({
  mappings: z.array(EscrowMappingEntrySchema)
    .min(0, 'Mappings array cannot be negative')
    .max(1000, 'Too many mappings - maximum 1000 allowed'),
  defaultEnvironment: z.string()
    .default('development')
    .regex(/^(development|staging|production)$/, 'Default environment must be valid'),
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
 * In-memory cache for resolved mappings to avoid repeated parsing.
 * Cache key: `${invoiceId}:${environment}`
 * Cache value: { address, timestamp }
 */
const mappingCache = new Map();

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
  
  // Default empty config if not set
  if (!envValue || envValue.trim() === '') {
    return {
      mappings: [],
      defaultEnvironment: 'development',
      allowlistEnabled: true,
      cacheEnabled: true,
      cacheTtlSeconds: 300
    };
  }

  try {
    const parsed = JSON.parse(envValue);
    const result = EscrowMappingConfigSchema.parse(parsed);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid escrow mapping configuration: ${error.message}`);
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
  } catch (error) {
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
function resolveEscrowAddress(invoiceId, environment) {
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

  // Check cache first if enabled
  if (config.cacheEnabled && mappingCache.has(cacheKey)) {
    const cached = mappingCache.get(cacheKey);
    const ageSeconds = (Date.now() - cached.timestamp) / 1000;
    
    if (ageSeconds < config.cacheTtlSeconds) {
      return cached.address;
    } else {
      // Remove expired entry
      mappingCache.delete(cacheKey);
    }
  }

  // Validate against allowlist
  if (config.allowlistEnabled && !isInvoiceAllowlisted(invoiceId, targetEnv)) {
    return null; // Not found in allowlist
  }

  // Find matching mapping
  const mapping = config.mappings.find(m => 
    m.invoiceId === invoiceId &&
    m.environment === targetEnv &&
    m.isActive
  );

  if (!mapping) {
    return null;
  }

  // Cache the result if enabled
  if (config.cacheEnabled) {
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
    entries: entries.map(entry => ({
      ageSeconds: (now - entry.timestamp) / 1000
    }))
  };
}

module.exports = {
  resolveEscrowAddress,
  isInvoiceAllowlisted,
  getActiveMappings,
  validateMappingConfig,
  clearCache,
  getCacheStats,
  parseEscrowMappingConfig,
  EscrowMappingEntrySchema,
  EscrowMappingConfigSchema
};
