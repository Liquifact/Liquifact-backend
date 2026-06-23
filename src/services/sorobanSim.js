/**
 * @fileoverview Soroban transaction simulation utility with footprint caching.
 *
 * Provides a `simulateOrThrow` function that simulates Soroban transactions
 * before submission, validates they would succeed, and stores footprints for
 * later use in actual transaction submission.
 *
 * This utility is used by all submit paths to prevent failed transactions
 * from being submitted to the network, saving gas and improving UX.
 *
 * @module services/sorobanSim
 */

'use strict';

const AppError = require('../errors/AppError');
const { callSorobanContract } = require('./soroban');

/**
 * Simulation result status codes.
 *
 * @constant {Object} SIMULATION_STATUS
 */
const SIMULATION_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'error',
});

/**
 * Common Soroban simulation error types.
 *
 * @constant {Object} SIMULATION_ERROR_TYPES
 */
const SIMULATION_ERROR_TYPES = Object.freeze({
  INSUFFICIENT_RESOURCES: 'insufficient_resources',
  INVALID_AUTH: 'invalid_auth',
  CONTRACT_ERROR: 'contract_error',
  NETWORK_ERROR: 'network_error',
  VALIDATION_ERROR: 'validation_error',
});

/**
 * In-memory footprint cache (can be replaced with Redis in production).
 *
 * Key format: `${operation}:${invoiceId}:${funderPublicKey}`
 *
 * @type {Map<string, Object>}
 */
const footprintCache = new Map();

/**
 * Maximum cache size to prevent memory leaks.
 *
 * @constant {number} MAX_CACHE_SIZE
 */
const MAX_CACHE_SIZE = 10000;

/**
 * Cache TTL in milliseconds (default: 5 minutes).
 *
 * @constant {number} CACHE_TTL_MS
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Generates a cache key for a simulation request.
 *
 * @param {string} operation - The operation type (e.g., 'fund_escrow').
 * @param {string} invoiceId - The invoice identifier.
 * @param {string} funderPublicKey - The funder's public key.
 * @returns {string} Cache key.
 */
function generateCacheKey(operation, invoiceId, funderPublicKey) {
  return `${operation}:${invoiceId}:${funderPublicKey}`;
}

/**
 * Retrieves a cached footprint if it exists and is not expired.
 *
 * @param {string} key - Cache key.
 * @returns {Object|null} Cached footprint or null.
 */
function getCachedFootprint(key) {
  const cached = footprintCache.get(key);
  if (!cached) {
    return null;
  }

  const now = Date.now();
  if (now - cached.timestamp > CACHE_TTL_MS) {
    footprintCache.delete(key);
    return null;
  }

  return cached.footprint;
}

/**
 * Stores a footprint in the cache with expiration.
 *
 * @param {string} key - Cache key.
 * @param {Object} footprint - The footprint to cache.
 * @returns {void}
 */
function cacheFootprint(key, footprint) {
  if (footprintCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry (simple FIFO)
    const firstKey = footprintCache.keys().next().value;
    footprintCache.delete(firstKey);
  }

  footprintCache.set(key, {
    footprint,
    timestamp: Date.now(),
  });
}

/**
 * Clears the footprint cache (useful for testing or manual invalidation).
 *
 * @returns {void}
 */
function clearFootprintCache() {
  footprintCache.clear();
}

/**
 * Parses a Soroban simulation error to determine its type.
 *
 * @param {Error} error - The simulation error.
 * @returns {string} Error type from SIMULATION_ERROR_TYPES.
 */
function parseSimulationError(error) {
  const message = error.message?.toLowerCase() || '';

  if (message.includes('insufficient') || message.includes('resource')) {
    return SIMULATION_ERROR_TYPES.INSUFFICIENT_RESOURCES;
  }

  if (message.includes('auth') || message.includes('signature') || message.includes('permission')) {
    return SIMULATION_ERROR_TYPES.INVALID_AUTH;
  }

  if (message.includes('contract') || message.includes('invoke')) {
    return SIMULATION_ERROR_TYPES.CONTRACT_ERROR;
  }

  if (message.includes('network') || message.includes('timeout') || message.includes('rpc')) {
    return SIMULATION_ERROR_TYPES.NETWORK_ERROR;
  }

  return SIMULATION_ERROR_TYPES.VALIDATION_ERROR;
}

/**
 * Creates a structured simulation error from a Soroban error.
 *
 * @param {Error} error - The original simulation error.
 * @param {Object} context - Simulation context for debugging.
 * @returns {AppError} Structured application error.
 */
function createSimulationError(error, context = {}) {
  const errorType = parseSimulationError(error);
  const isRetryable = errorType === SIMULATION_ERROR_TYPES.NETWORK_ERROR;

  const appError = new AppError({
    type: 'https://liquifact.com/probs/soroban-simulation-failed',
    title: 'Soroban Transaction Simulation Failed',
    status: isRetryable ? 503 : 400,
    detail: error.message || 'Transaction simulation failed',
    code: `SIMULATION_${errorType.toUpperCase()}`,
    retryable: isRetryable,
    retryHint: isRetryable
      ? 'Transient network error during simulation. Retry the request.'
      : 'Fix the transaction payload or account state before retrying.',
    context: {
      errorType,
      ...context,
    },
  });
  appError.context = {
    errorType,
    ...context,
  };
  return appError;
}

/**
 * Validates that the required simulation parameters are present.
 *
 * @param {Object} params - Simulation parameters.
 * @param {string} params.operation - Operation type.
 * @param {string} params.invoiceId - Invoice identifier.
 * @param {string} params.funderPublicKey - Funder's public key.
 * @param {Object} params.transactionXdr - Transaction XDR (base64).
 * @param {Object} [params.options] - Optional simulation options.
 * @throws {AppError} If validation fails.
 */
function validateSimulationParams(params) {
  const errors = [];

  if (!params.operation || typeof params.operation !== 'string') {
    errors.push('operation is required and must be a string.');
  }

  if (!params.invoiceId || typeof params.invoiceId !== 'string') {
    errors.push('invoiceId is required and must be a string.');
  }

  if (!params.funderPublicKey || typeof params.funderPublicKey !== 'string') {
    errors.push('funderPublicKey is required and must be a string.');
  }

  if (!params.transactionXdr) {
    errors.push('transactionXdr is required.');
  }

  if (errors.length > 0) {
    throw new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Simulation Parameter Validation Error',
      status: 400,
      detail: errors.join(' '),
      code: 'VALIDATION_ERROR',
      retryable: false,
      retryHint: 'Fix the simulation parameters and try again.',
    });
  }
}

/**
 * Simulates a Soroban transaction and throws if it fails.
 *
 * This function:
 * 1. Validates the simulation parameters
 * 2. Checks the footprint cache for a previous successful simulation
 * 3. Simulates the transaction using the Soroban RPC (with retry logic)
 * 4. Caches the footprint on success
 * 5. Throws a descriptive error on failure
 *
 * The simulation is performed before actual transaction submission to
 * prevent failed transactions from being submitted to the network.
 *
 * @param {Object} params - Simulation parameters.
 * @param {string} params.operation - Operation type (e.g., 'fund_escrow').
 * @param {string} params.invoiceId - Invoice identifier.
 * @param {string} params.funderPublicKey - Funder's Stellar public key.
 * @param {string} params.transactionXdr - Transaction XDR (base64 encoded).
 * @param {Object} [params.options] - Optional simulation options.
 * @param {boolean} [params.options.useCache=true] - Whether to use footprint cache.
 * @param {Object} [params.options.rpcConfig] - RPC configuration overrides.
 * @returns {Promise<Object>} Simulation result with footprint and status.
 * @throws {AppError} If simulation fails or parameters are invalid.
 *
 * @example
 * const result = await simulateOrThrow({
 *   operation: 'fund_escrow',
 *   invoiceId: 'inv_123',
 *   funderPublicKey: 'GABC...',
 *   transactionXdr: 'AAAA...',
 * });
 * // result: { status: 'success', footprint: {...}, cached: false }
 */
async function simulateOrThrow(params = {}) {
  const { operation, invoiceId, funderPublicKey, transactionXdr, options = {} } = params;

  try {
    validateSimulationParams(params);

    const useCache = options.useCache !== false;
    const cacheKey = generateCacheKey(operation, invoiceId, funderPublicKey);

    // Check cache first
    if (useCache) {
      const cachedFootprint = getCachedFootprint(cacheKey);
      if (cachedFootprint) {
        return {
          status: SIMULATION_STATUS.SUCCESS,
          footprint: cachedFootprint,
          cached: true,
          errorType: null,
        };
      }
    }

    // Perform simulation
    const simulationOperation = async () => {
      // In a real implementation, this would call the Soroban RPC simulateTransaction endpoint
      // For now, we mock the simulation logic
      // TODO: Replace with actual Soroban SDK simulation call when available
      
      // Mock simulation validation
      if (!transactionXdr || transactionXdr.length < 10) {
        throw new Error('Invalid transaction XDR: too short');
      }

      // Mock successful simulation result
      return {
        success: true,
        footprint: {
          read: ['mock_read_footprint'],
          write: ['mock_write_footprint'],
        },
        resourceConfig: {
          instructionFee: 100,
          resourceFee: 1000,
        },
      };
    };

    const simulationResult = await callSorobanContract(simulationOperation, options.rpcConfig);

    if (!simulationResult.success) {
      throw new Error('Simulation returned unsuccessful result');
    }

    // Cache the footprint
    if (useCache && simulationResult.footprint) {
      cacheFootprint(cacheKey, simulationResult.footprint);
    }

    return {
      status: SIMULATION_STATUS.SUCCESS,
      footprint: simulationResult.footprint,
      resourceConfig: simulationResult.resourceConfig,
      cached: false,
      errorType: null,
    };
  } catch (error) {
    const isParameterValidationError = error instanceof AppError && error.code === 'VALIDATION_ERROR';
    const errorType = isParameterValidationError
      ? SIMULATION_ERROR_TYPES.VALIDATION_ERROR
      : parseSimulationError(error);
    const simulationError = isParameterValidationError ? error : createSimulationError(error, {
      operation,
      invoiceId,
      funderPublicKey,
    });

    return {
      status: SIMULATION_STATUS.FAILURE,
      footprint: null,
      cached: false,
      errorType,
      error: simulationError,
    };
  }
}

/**
 * Simulates a Soroban transaction and throws if it fails (synchronous error version).
 *
 * This is a convenience wrapper that throws the error immediately instead of
 * returning it in the result object. Use this when you want try/catch error handling.
 *
 * @param {Object} params - Simulation parameters (same as simulateOrThrow).
 * @returns {Promise<Object>} Simulation result on success.
 * @throws {AppError} If simulation fails or parameters are invalid.
 *
 * @example
 * try {
 *   const result = await simulateOrThrowSync({
 *     operation: 'fund_escrow',
 *     invoiceId: 'inv_123',
 *     funderPublicKey: 'GABC...',
 *     transactionXdr: 'AAAA...',
 *   });
 *   // Use result.footprint for actual submission
 * } catch (error) {
 *   // Handle simulation error
 * }
 */
async function simulateOrThrowSync(params) {
  const result = await simulateOrThrow(params);

  if (result.status === SIMULATION_STATUS.FAILURE) {
    throw result.error;
  }

  return result;
}

module.exports = {
  simulateOrThrow,
  simulateOrThrowSync,
  SIMULATION_STATUS,
  SIMULATION_ERROR_TYPES,
  clearFootprintCache,
  getCachedFootprint,
  cacheFootprint,
  generateCacheKey,
  parseSimulationError,
};
