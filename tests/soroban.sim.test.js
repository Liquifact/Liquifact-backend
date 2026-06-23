'use strict';

const {
  simulateOrThrow,
  simulateOrThrowSync,
  SIMULATION_STATUS,
  SIMULATION_ERROR_TYPES,
  clearFootprintCache,
  getCachedFootprint,
  cacheFootprint,
  generateCacheKey,
  parseSimulationError,
} = require('../src/services/sorobanSim');
const { callSorobanContract } = require('../src/services/soroban');

// Mock the soroban service
jest.mock('../src/services/soroban');

const PUBLIC_KEY = `G${'A'.repeat(55)}`;
const VALID_XDR = 'AAAA' + 'B'.repeat(100);

function baseParams(overrides = {}) {
  return {
    operation: 'fund_escrow',
    invoiceId: 'inv_123',
    funderPublicKey: PUBLIC_KEY,
    transactionXdr: VALID_XDR,
    ...overrides,
  };
}

describe('sorobanSim - Simulation Utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearFootprintCache();
  });

  afterEach(() => {
    clearFootprintCache();
  });

  describe('generateCacheKey', () => {
    it('generates consistent cache keys for same parameters', () => {
      const key1 = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      const key2 = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      expect(key1).toBe(key2);
    });

    it('generates different cache keys for different parameters', () => {
      const key1 = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      const key2 = generateCacheKey('fund_escrow', 'inv_456', PUBLIC_KEY);
      expect(key1).not.toBe(key2);
    });
  });

  describe('cacheFootprint and getCachedFootprint', () => {
    it('stores and retrieves footprints', () => {
      const key = 'test:key';
      const footprint = { read: ['addr1'], write: ['addr2'] };
      
      cacheFootprint(key, footprint);
      const retrieved = getCachedFootprint(key);
      
      expect(retrieved).toEqual(footprint);
    });

    it('returns null for non-existent cache entries', () => {
      const retrieved = getCachedFootprint('nonexistent');
      expect(retrieved).toBeNull();
    });

    it('expires cache entries after TTL', () => {
      const key = 'test:expire';
      const footprint = { read: ['addr1'] };
      
      cacheFootprint(key, footprint);
      
      // Mock Date.now to return a time beyond TTL
      const originalNow = Date.now;
      Date.now = jest.fn(() => originalNow() + 6 * 60 * 1000); // 6 minutes later
      
      const retrieved = getCachedFootprint(key);
      expect(retrieved).toBeNull();
      
      Date.now = originalNow;
    });

    it('enforces maximum cache size', () => {
      for (let i = 0; i <= 10000; i++) {
        cacheFootprint(`key${i}`, { read: [`addr${i}`] });
      }

      // First key should be evicted
      expect(getCachedFootprint('key0')).toBeNull();
      expect(getCachedFootprint('key10000')).not.toBeNull();
    });
  });

  describe('clearFootprintCache', () => {
    it('clears all cached footprints', () => {
      cacheFootprint('key1', { read: ['addr1'] });
      cacheFootprint('key2', { read: ['addr2'] });
      
      clearFootprintCache();
      
      expect(getCachedFootprint('key1')).toBeNull();
      expect(getCachedFootprint('key2')).toBeNull();
    });
  });

  describe('parseSimulationError', () => {
    it('identifies insufficient resources errors', () => {
      const error = new Error('Insufficient resources for operation');
      expect(parseSimulationError(error)).toBe(SIMULATION_ERROR_TYPES.INSUFFICIENT_RESOURCES);
    });

    it('identifies auth errors', () => {
      const error = new Error('Invalid signature');
      expect(parseSimulationError(error)).toBe(SIMULATION_ERROR_TYPES.INVALID_AUTH);
    });

    it('identifies contract errors', () => {
      const error = new Error('Contract invocation failed');
      expect(parseSimulationError(error)).toBe(SIMULATION_ERROR_TYPES.CONTRACT_ERROR);
    });

    it('identifies network errors', () => {
      const error = new Error('Network timeout');
      expect(parseSimulationError(error)).toBe(SIMULATION_ERROR_TYPES.NETWORK_ERROR);
    });

    it('defaults to validation error for unknown messages', () => {
      const error = new Error('Unknown error');
      expect(parseSimulationError(error)).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
    });

    it('handles errors without message', () => {
      const error = new Error();
      expect(parseSimulationError(error)).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
    });
  });

  describe('validateSimulationParams', () => {
    it('throws validation error for missing operation', async () => {
      const params = baseParams({ operation: undefined });
      
      const result = await simulateOrThrow(params);
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('throws validation error for missing invoiceId', async () => {
      const params = baseParams({ invoiceId: undefined });
      
      const result = await simulateOrThrow(params);
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('throws validation error for missing funderPublicKey', async () => {
      const params = baseParams({ funderPublicKey: undefined });
      
      const result = await simulateOrThrow(params);
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('throws validation error for missing transactionXdr', async () => {
      const params = baseParams({ transactionXdr: undefined });
      
      const result = await simulateOrThrow(params);
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts valid parameters', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'], write: ['addr2'] },
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.SUCCESS);
    });
  });

  describe('simulateOrThrow - successful simulation', () => {
    it('returns success status with footprint on successful simulation', async () => {
      const mockFootprint = { read: ['addr1', 'addr2'], write: ['addr3'] };
      const mockResourceConfig = { instructionFee: 100, resourceFee: 1000 };
      
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: mockFootprint,
        resourceConfig: mockResourceConfig,
      });

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(result.footprint).toEqual(mockFootprint);
      expect(result.resourceConfig).toEqual(mockResourceConfig);
      expect(result.cached).toBe(false);
      expect(result.errorType).toBeNull();
    });

    it('caches footprint on successful simulation when useCache is true', async () => {
      const mockFootprint = { read: ['addr1'], write: ['addr2'] };
      
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: mockFootprint,
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      const params = baseParams();
      await simulateOrThrow(params);
      
      const cacheKey = generateCacheKey(params.operation, params.invoiceId, params.funderPublicKey);
      const cached = getCachedFootprint(cacheKey);
      
      expect(cached).toEqual(mockFootprint);
    });

    it('does not cache footprint when useCache is false', async () => {
      const mockFootprint = { read: ['addr1'], write: ['addr2'] };
      
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: mockFootprint,
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      const params = baseParams({ options: { useCache: false } });
      await simulateOrThrow(params);
      
      const cacheKey = generateCacheKey(params.operation, params.invoiceId, params.funderPublicKey);
      const cached = getCachedFootprint(cacheKey);
      
      expect(cached).toBeNull();
    });

    it('returns cached result when available', async () => {
      const params = baseParams();
      const cacheKey = generateCacheKey(params.operation, params.invoiceId, params.funderPublicKey);
      
      // Pre-populate cache
      const cachedFootprint = { read: ['cached_addr'], write: ['cached_write'] };
      cacheFootprint(cacheKey, cachedFootprint);
      
      const result = await simulateOrThrow(params);
      
      expect(result.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(result.footprint).toEqual(cachedFootprint);
      expect(result.cached).toBe(true);
      expect(callSorobanContract).not.toHaveBeenCalled();
    });
  });

  describe('simulateOrThrow - failed simulations', () => {
    it('returns failure status for insufficient resources error', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('Insufficient resources for operation')
      );

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.INSUFFICIENT_RESOURCES);
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe('SIMULATION_INSUFFICIENT_RESOURCES');
      expect(result.error.retryable).toBe(false);
    });

    it('returns failure status for invalid auth error', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('Invalid signature provided')
      );

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.INVALID_AUTH);
      expect(result.error.code).toBe('SIMULATION_INVALID_AUTH');
      expect(result.error.retryable).toBe(false);
    });

    it('returns failure status for contract error', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('Contract invocation failed with error code 1')
      );

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.CONTRACT_ERROR);
      expect(result.error.code).toBe('SIMULATION_CONTRACT_ERROR');
      expect(result.error.retryable).toBe(false);
    });

    it('returns failure status for network error (retryable)', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('Network timeout during RPC call')
      );

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.NETWORK_ERROR);
      expect(result.error.code).toBe('SIMULATION_NETWORK_ERROR');
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryHint).toContain('Retry the request');
    });

    it('returns failure status for validation error (non-retryable)', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('Invalid transaction format')
      );

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
      expect(result.error.code).toBe('SIMULATION_VALIDATION_ERROR');
      expect(result.error.retryable).toBe(false);
      expect(result.error.retryHint).toContain('Fix the transaction payload');
    });

    it('handles simulation returning unsuccessful result', async () => {
      callSorobanContract.mockResolvedValue({
        success: false,
        footprint: null,
      });

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.error).toBeDefined();
    });

    it('includes context in simulation error', async () => {
      const params = baseParams({
        operation: 'fund_escrow',
        invoiceId: 'inv_test',
        funderPublicKey: 'GTEST123',
      });
      
      callSorobanContract.mockRejectedValue(new Error('Test error'));

      const result = await simulateOrThrow(params);
      
      expect(result.error.context).toMatchObject({
        operation: 'fund_escrow',
        invoiceId: 'inv_test',
        funderPublicKey: 'GTEST123',
        errorType: expect.any(String),
      });
    });

    it('rejects invalid XDR (too short)', async () => {
      const params = baseParams({ transactionXdr: 'SHORT' });
      
      callSorobanContract.mockImplementation(() => {
        throw new Error('Invalid transaction XDR: too short');
      });

      const result = await simulateOrThrow(params);
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
    });
  });

  describe('simulateOrThrowSync', () => {
    it('returns result on successful simulation', async () => {
      const mockFootprint = { read: ['addr1'], write: ['addr2'] };
      
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: mockFootprint,
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      const result = await simulateOrThrowSync(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(result.footprint).toEqual(mockFootprint);
    });

    it('throws error on failed simulation', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('Insufficient resources for operation')
      );

      await expect(simulateOrThrowSync(baseParams())).rejects.toMatchObject({
        code: 'SIMULATION_INSUFFICIENT_RESOURCES',
        retryable: false,
      });
    });

    it('throws validation error on invalid parameters', async () => {
      const params = baseParams({ operation: undefined });

      await expect(simulateOrThrowSync(params)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    });

    it('throws network error as retryable', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('Network timeout')
      );

      await expect(simulateOrThrowSync(baseParams())).rejects.toMatchObject({
        code: 'SIMULATION_NETWORK_ERROR',
        retryable: true,
        status: 503,
      });
    });
  });

  describe('rpcConfig option', () => {
    it('passes rpcConfig to callSorobanContract', async () => {
      const rpcConfig = { maxRetries: 5, baseDelay: 500 };
      
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      await simulateOrThrow(baseParams({ options: { rpcConfig } }));
      
      expect(callSorobanContract).toHaveBeenCalledWith(
        expect.any(Function),
        rpcConfig
      );
    });
  });

  describe('edge cases', () => {
    it('handles error without message property', async () => {
      const error = new Error();
      delete error.message;
      
      callSorobanContract.mockRejectedValue(error);

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
    });

    it('handles null error message', async () => {
      const error = new Error(null);
      
      callSorobanContract.mockRejectedValue(error);

      const result = await simulateOrThrow(baseParams());
      
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
    });

    it('handles case-insensitive error message matching', async () => {
      callSorobanContract.mockRejectedValue(
        new Error('INSUFFICIENT RESOURCES FOR OPERATION')
      );

      const result = await simulateOrThrow(baseParams());
      
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.INSUFFICIENT_RESOURCES);
    });
  });

  describe('multiple simulations', () => {
    it('handles multiple concurrent simulations with different keys', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      const params1 = baseParams({ invoiceId: 'inv_1' });
      const params2 = baseParams({ invoiceId: 'inv_2' });
      
      const [result1, result2] = await Promise.all([
        simulateOrThrow(params1),
        simulateOrThrow(params2),
      ]);
      
      expect(result1.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(result2.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(callSorobanContract).toHaveBeenCalledTimes(2);
    });

    it('uses cache for repeated simulation with same parameters', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      const params = baseParams();
      
      await simulateOrThrow(params);
      await simulateOrThrow(params);
      
      expect(callSorobanContract).toHaveBeenCalledTimes(1);
    });
  });
});
