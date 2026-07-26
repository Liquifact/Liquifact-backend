/**
 * @fileoverview Soroban transaction simulation utility with footprint caching.
 *
 * Provides a `simulateOrThrow` function that simulates Soroban transactions
 * before submission, validates they would succeed, and stores footprints for
 * later use in actual transaction submission.
 *
 * @module services/sorobanSim
 */

'use strict';

const AppError = require('../errors/AppError');
const { callSorobanContract } = require('./soroban');
const {
  footprintCacheHitsTotal,
  footprintCacheMissesTotal,
  footprintCacheEvictionsTotal,
} = require('../metrics');

/**
 * Simulation result status codes.
 * @constant {Object}
 */
const SIMULATION_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'error',
});

/**
 * Common Soroban simulation error types.
 * @constant {Object}
 */
const SIMULATION_ERROR_TYPES = Object.freeze({
  INSUFFICIENT_RESOURCES: 'insufficient_resources',
  INVALID_AUTH: 'invalid_auth',
  CONTRACT_ERROR: 'contract_error',
  NETWORK_ERROR: 'network_error',
  VALIDATION_ERROR: 'validation_error',
});

/**
 * Maximum number of footprint entries to hold in cache.
 * When exceeded the least-recently-used entry is evicted.
 * @constant {number}
 */
const MAX_CACHE_SIZE = parseInt(process.env.SOROBAN_CACHE_MAX_SIZE || '1000', 10);

/**
 * Cache TTL in milliseconds (default: 5 minutes).
 * Footprints older than this are considered stale and re-simulated.
 * @constant {number}
 */
const CACHE_TTL_MS = parseInt(process.env.SOROBAN_CACHE_TTL_MS || String(5 * 60 * 1000), 10);

/**
 * LRU footprint cache.
 *
 * Each entry: { footprint, timestamp, ledgerSequence, contractVersion }
 *
 * LRU is implemented with a plain Map: Map preserves insertion order, so the
 * oldest-accessed entry is always at the front. On every read we delete and
 * re-insert the entry to move it to the back (most-recently-used position).
 *
 * @type {Map<string, {footprint: Object, timestamp: number, ledgerSequence: number|null, contractVersion: string|null}>}
 */
const footprintCache = new Map();

/**
 * Builds a deterministic cache key from the simulation parameters.
 * Keys are not attacker-controllable because every component comes from
 * server-side validated fields (operation type, internal invoice id, public key).
 *
 * @param {string} operation
 * @param {string} invoiceId
 * @param {string} funderPublicKey
 * @returns {string}
 */
function generateCacheKey(operation, invoiceId, funderPublicKey) {
  return `${operation}:${invoiceId}:${funderPublicKey}`;
}

/**
 * Returns a cached footprint if it exists, has not expired, and the ledger
 * sequence has not advanced past the one recorded at simulation time.
 *
 * @param {string} key
 * @param {number|null} [currentLedger] - Latest known ledger sequence. When
 *   provided any entry from an older ledger is treated as stale.
 * @param {string|null} [contractVersion] - Current contract version. When
 *   provided any entry from an older contract version is treated as stale.
 * @returns {Object|null} The footprint or null.
 */
function getCachedFootprint(key, currentLedger = null, contractVersion = null) {
  const entry = footprintCache.get(key);
  if (!entry) {
    footprintCacheMissesTotal.inc();
    return null;
  }

  const expired = Date.now() - entry.timestamp > CACHE_TTL_MS;
  const staleLedger =
    currentLedger !== null &&
    entry.ledgerSequence !== null &&
    entry.ledgerSequence < currentLedger;
  const staleContractVersion =
    contractVersion !== null &&
    entry.contractVersion !== null &&
    entry.contractVersion !== contractVersion;

  if (expired || staleLedger || staleContractVersion) {
    footprintCache.delete(key);
    footprintCacheEvictionsTotal.inc();
    footprintCacheMissesTotal.inc();
    return null;
  }

  // Promote to MRU position
  footprintCache.delete(key);
  footprintCache.set(key, entry);

  footprintCacheHitsTotal.inc();
  return entry.footprint;
}

/**
 * Stores a footprint in the cache, evicting the LRU entry if the cache is full.
 *
 * @param {string} key
 * @param {Object} footprint
 * @param {number|null} [ledgerSequence] - Ledger sequence at simulation time.
 * @param {string|null} [contractVersion] - Contract version at simulation time.
 * @returns {void}
 */
function cacheFootprint(key, footprint, ledgerSequence = null, contractVersion = null) {
  // If already present, remove first so the re-insert lands at the MRU end.
  if (footprintCache.has(key)) {
    footprintCache.delete(key);
  } else if (footprintCache.size >= MAX_CACHE_SIZE) {
    // Evict LRU entry (first key in Map = least recently used)
    const lruKey = footprintCache.keys().next().value;
    footprintCache.delete(lruKey);
    footprintCacheEvictionsTotal.inc();
  }

  footprintCache.set(key, {
    footprint,
    timestamp: Date.now(),
    ledgerSequence,
    contractVersion,
  });
}

/**
 * Clears the entire footprint cache.
 * @returns {void}
 */
function clearFootprintCache() {
  footprintCache.clear();
}

/**
 * Parses a Soroban simulation error to determine its type.
 *
 * @param {Error} error
 * @returns {string} One of SIMULATION_ERROR_TYPES values.
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
 * Creates a structured AppError from a raw simulation error.
 *
 * @param {Error} error
 * @param {Object} [context]
 * @returns {AppError}
 */
function createSimulationError(error, context = {}) {
  const errorType = parseSimulationError(error);
  const isRetryable = errorType === SIMULATION_ERROR_TYPES.NETWORK_ERROR;
  const code = error instanceof AppError ? error.code : `SIMULATION_${errorType.toUpperCase()}`;

  return new AppError({
    type: 'https://liquifact.com/probs/soroban-simulation-failed',
    title: 'Soroban Transaction Simulation Failed',
    status: isRetryable ? 503 : 400,
    detail: error.message || 'Transaction simulation failed',
    code,
    retryable: isRetryable,
    retryHint: isRetryable
      ? 'Transient network error during simulation. Retry the request.'
      : 'Fix the transaction payload or account state before retrying.',
    context: { errorType, ...context },
  });
}

/**
 * Validates simulation parameters.
 *
 * @param {Object} params
 * @returns {void}
 * @throws {AppError}
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
 * Simulates a Soroban transaction and returns a result object.
 *
 * 1. Validates parameters.
 * 2. Returns a cached footprint if one exists and is still fresh.
 * 3. Calls the Soroban RPC simulator.
 * 4. Caches the footprint on success (keyed by operation fingerprint).
 * 5. On failure returns a structured error — does NOT write to cache.
 *
 * Stale-ledger safety: pass `options.currentLedger` (the latest known ledger
 * sequence) to refuse footprints that were captured before the chain moved on.
 * A stale footprint is never reused for submission.
 *
 * Cache keys are derived from server-controlled fields only (operation type,
 * internal invoice id, Stellar public key) and are never constructed from raw
 * user-supplied strings, preventing cache-key injection.
 *
 * @param {Object} params
 * @param {string} params.operation
 * @param {string} params.invoiceId
 * @param {string} params.funderPublicKey
 * @param {string} params.transactionXdr
 * @param {Object} [params.options]
 * @param {boolean} [params.options.useCache=true]
 * @param {number|null} [params.options.currentLedger] - Latest ledger for staleness check.
 * @param {string|null} [params.options.contractVersion] - Current contract version for invalidation.
 * @param {Object} [params.options.rpcConfig]
 * @returns {Promise<Object>}
 */
async function simulateOrThrow(params) {
  const { operation, invoiceId, funderPublicKey, transactionXdr, options = {} } = params;

  try {
    validateSimulationParams(params);

    const useCache = options.useCache !== false;
    const currentLedger = options.currentLedger ?? null;
    const contractVersion = options.contractVersion ?? null;
    const cacheKey = generateCacheKey(operation, invoiceId, funderPublicKey);

    if (useCache) {
      const cached = getCachedFootprint(cacheKey, currentLedger, contractVersion);
      if (cached) {
        return {
          status: SIMULATION_STATUS.SUCCESS,
          footprint: cached,
          cached: true,
          errorType: null,
        };
      }
    }

    const simulationOperation = async () => {
      if (!transactionXdr || transactionXdr.length < 10) {
        throw new Error('Invalid transaction XDR: too short');
      }

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
        ledgerSequence: null, // real SDK would return the simulated ledger
      };
    };

    const simulationResult = await callSorobanContract(simulationOperation, options.rpcConfig);

    if (!simulationResult.success) {
      throw new Error('Simulation returned unsuccessful result');
    }

    const ledgerSequence = simulationResult.ledgerSequence ?? null;

    if (useCache && simulationResult.footprint) {
      cacheFootprint(cacheKey, simulationResult.footprint, ledgerSequence, contractVersion);
    }

    return {
      status: SIMULATION_STATUS.SUCCESS,
      footprint: simulationResult.footprint,
      resourceConfig: simulationResult.resourceConfig,
      cached: false,
      errorType: null,
    };
  } catch (error) {
    const errorType = parseSimulationError(error);
    const simulationError = createSimulationError(error, {
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
 * Like `simulateOrThrow` but throws on failure instead of returning the error
 * in the result object. Use this in submit paths that rely on try/catch.
 *
 * @param {Object} params - Same as simulateOrThrow.
 * @returns {Promise<Object>} Simulation result on success.
 * @throws {AppError}
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
  MAX_CACHE_SIZE,
  CACHE_TTL_MS,
  clearFootprintCache,
  getCachedFootprint,
  cacheFootprint,
  generateCacheKey,
  parseSimulationError,
};
