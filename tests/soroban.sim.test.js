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
const metrics = require('../src/metrics');

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

/** Spy on a metrics counter so we can assert .inc() calls. */
function spyCounter(counter) {
  return jest.spyOn(counter, 'inc');
}

describe('sorobanSim - Simulation Utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearFootprintCache();
  });

  afterEach(() => {
    clearFootprintCache();
  });

  // ─── generateCacheKey ────────────────────────────────────────────────────────

  describe('generateCacheKey', () => {
    it('generates consistent keys for the same parameters', () => {
      const k1 = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      const k2 = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      expect(k1).toBe(k2);
    });

    it('generates different keys for different parameters', () => {
      const k1 = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      const k2 = generateCacheKey('fund_escrow', 'inv_456', PUBLIC_KEY);
      expect(k1).not.toBe(k2);
    });
  });

  // ─── cacheFootprint / getCachedFootprint ─────────────────────────────────────

  describe('cacheFootprint and getCachedFootprint', () => {
    it('stores and retrieves a footprint', () => {
      const key = 'test:key';
      const footprint = { read: ['addr1'], write: ['addr2'] };
      cacheFootprint(key, footprint);
      expect(getCachedFootprint(key)).toEqual(footprint);
    });

    it('returns null for a non-existent key', () => {
      expect(getCachedFootprint('nonexistent')).toBeNull();
    });

    it('expires entries after TTL', () => {
      const key = 'test:expire';
      cacheFootprint(key, { read: ['addr1'] });

      const orig = Date.now;
      Date.now = jest.fn(() => orig() + 6 * 60 * 1000); // 6 min later
      expect(getCachedFootprint(key)).toBeNull();
      Date.now = orig;
    });

    it('rejects a footprint when currentLedger has advanced', () => {
      const key = 'test:ledger';
      cacheFootprint(key, { read: ['addr1'] }, 100); // simulated at ledger 100
      expect(getCachedFootprint(key, 101)).toBeNull();       // ledger moved to 101
    });

    it('accepts a footprint when currentLedger matches', () => {
      const key = 'test:ledger-same';
      cacheFootprint(key, { read: ['addr1'] }, 100);
      expect(getCachedFootprint(key, 100)).not.toBeNull();
    });

    it('rejects a footprint when contractVersion has advanced', () => {
      const key = 'test:contract-version';
      cacheFootprint(key, { read: ['addr1'] }, 100, 'v1');
      expect(getCachedFootprint(key, 100, 'v2')).toBeNull();
    });

    it('accepts a footprint when no currentLedger is supplied', () => {
      const key = 'test:ledger-null';
      cacheFootprint(key, { read: ['addr1'] }, 100);
      expect(getCachedFootprint(key, null)).not.toBeNull();
    });

    it('accepts a footprint when the cached entry has no ledgerSequence', () => {
      const key = 'test:ledger-none';
      cacheFootprint(key, { read: ['addr1'] }, null);
      expect(getCachedFootprint(key, 999)).not.toBeNull();
    });
  });

  // ─── LRU eviction ─────────────────────────────────────────────────────────────

  describe('LRU eviction', () => {
    const { MAX_CACHE_SIZE } = require('../src/services/sorobanSim');

    it('evicts the least-recently-used entry when the cache is full', () => {
      // Fill the cache to capacity
      for (let i = 0; i < MAX_CACHE_SIZE; i++) {
        cacheFootprint(`key${i}`, { read: [`addr${i}`] });
      }

      // Access key0 to make it MRU
      getCachedFootprint('key0');

      // Adding one more entry should evict key1 (now LRU), not key0
      cacheFootprint('keyNew', { read: ['new'] });

      expect(getCachedFootprint('key0')).not.toBeNull();  // MRU — kept
      expect(getCachedFootprint('key1')).toBeNull();       // LRU — evicted
      expect(getCachedFootprint('keyNew')).not.toBeNull(); // just inserted
    });

    it('promotes a re-cached entry to MRU position', () => {
      for (let i = 0; i < MAX_CACHE_SIZE; i++) {
        cacheFootprint(`slot${i}`, { read: [`addr${i}`] });
      }

      // Re-insert slot0 to move it to MRU
      cacheFootprint('slot0', { read: ['updated'] });

      // Adding another entry should evict slot1, not slot0
      cacheFootprint('slotNew', { read: ['new'] });

      expect(getCachedFootprint('slot0')).not.toBeNull();
      expect(getCachedFootprint('slot1')).toBeNull();
    });
  });

  // ─── Metrics counters ─────────────────────────────────────────────────────────

  describe('metrics counters', () => {
    it('increments hit counter on cache hit', () => {
      const incHit = spyCounter(metrics.footprintCacheHitsTotal);
      cacheFootprint('hit:key', { read: ['a'] });
      getCachedFootprint('hit:key');
      expect(incHit).toHaveBeenCalledTimes(1);
    });

    it('increments miss counter on cache miss', () => {
      const incMiss = spyCounter(metrics.footprintCacheMissesTotal);
      getCachedFootprint('miss:key');
      expect(incMiss).toHaveBeenCalledTimes(1);
    });

    it('increments eviction counter on TTL expiry', () => {
      const incEvict = spyCounter(metrics.footprintCacheEvictionsTotal);
      cacheFootprint('ttl:key', { read: ['a'] });

      const orig = Date.now;
      Date.now = jest.fn(() => orig() + 10 * 60 * 1000);
      getCachedFootprint('ttl:key');
      Date.now = orig;

      expect(incEvict).toHaveBeenCalledTimes(1);
    });

    it('increments eviction counter on stale-ledger invalidation', () => {
      const incEvict = spyCounter(metrics.footprintCacheEvictionsTotal);
      cacheFootprint('stale:key', { read: ['a'] }, 50);
      getCachedFootprint('stale:key', 51);
      expect(incEvict).toHaveBeenCalledTimes(1);
    });

    it('increments eviction counter on LRU eviction', () => {
      const { MAX_CACHE_SIZE } = require('../src/services/sorobanSim');
      const incEvict = spyCounter(metrics.footprintCacheEvictionsTotal);

      for (let i = 0; i < MAX_CACHE_SIZE; i++) {
        cacheFootprint(`lru${i}`, { read: [`a${i}`] });
      }
      cacheFootprint('lruOver', { read: ['x'] });

      expect(incEvict).toHaveBeenCalledTimes(1);
    });
  });

  // ─── clearFootprintCache ──────────────────────────────────────────────────────

  describe('clearFootprintCache', () => {
    it('removes all entries', () => {
      cacheFootprint('a', { read: ['1'] });
      cacheFootprint('b', { read: ['2'] });
      clearFootprintCache();
      expect(getCachedFootprint('a')).toBeNull();
      expect(getCachedFootprint('b')).toBeNull();
    });
  });

  // ─── parseSimulationError ─────────────────────────────────────────────────────

  describe('parseSimulationError', () => {
    it.each([
      ['Insufficient resources', SIMULATION_ERROR_TYPES.INSUFFICIENT_RESOURCES],
      ['Invalid signature', SIMULATION_ERROR_TYPES.INVALID_AUTH],
      ['Contract invocation failed', SIMULATION_ERROR_TYPES.CONTRACT_ERROR],
      ['Network timeout', SIMULATION_ERROR_TYPES.NETWORK_ERROR],
      ['Unknown problem', SIMULATION_ERROR_TYPES.VALIDATION_ERROR],
    ])('classifies "%s"', (msg, expected) => {
      expect(parseSimulationError(new Error(msg))).toBe(expected);
    });

    it('handles an error with no message', () => {
      const err = new Error();
      delete err.message;
      expect(parseSimulationError(err)).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
    });

    it('is case-insensitive', () => {
      expect(parseSimulationError(new Error('INSUFFICIENT RESOURCES'))).toBe(
        SIMULATION_ERROR_TYPES.INSUFFICIENT_RESOURCES,
      );
    });
  });

  // ─── validateSimulationParams ─────────────────────────────────────────────────

  describe('validateSimulationParams', () => {
    it.each(['operation', 'invoiceId', 'funderPublicKey', 'transactionXdr'])(
      'returns failure when %s is missing',
      async (field) => {
        const result = await simulateOrThrow(baseParams({ [field]: undefined }));
        expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
        expect(result.error.code).toBe('VALIDATION_ERROR');
      },
    );

    it('accepts valid parameters', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['a'] },
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });
      const result = await simulateOrThrow(baseParams());
      expect(result.status).toBe(SIMULATION_STATUS.SUCCESS);
    });
  });

  // ─── simulateOrThrow — success ───────────────────────────────────────────────

  describe('simulateOrThrow — successful simulation', () => {
    it('returns SUCCESS with footprint', async () => {
      const footprint = { read: ['addr1', 'addr2'], write: ['addr3'] };
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint,
        resourceConfig: { instructionFee: 100, resourceFee: 1000 },
      });

      const result = await simulateOrThrow(baseParams());
      expect(result.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(result.footprint).toEqual(footprint);
      expect(result.cached).toBe(false);
      expect(result.errorType).toBeNull();
    });

    it('caches footprint after successful simulation', async () => {
      const footprint = { read: ['addr1'] };
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint,
        resourceConfig: {},
      });

      const params = baseParams();
      await simulateOrThrow(params);

      const key = generateCacheKey(params.operation, params.invoiceId, params.funderPublicKey);
      expect(getCachedFootprint(key)).toEqual(footprint);
    });

    it('does not cache when useCache is false', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: {},
      });

      const params = baseParams({ options: { useCache: false } });
      await simulateOrThrow(params);

      const key = generateCacheKey(params.operation, params.invoiceId, params.funderPublicKey);
      expect(getCachedFootprint(key)).toBeNull();
    });

    it('returns cached result without calling RPC again', async () => {
      const params = baseParams();
      const key = generateCacheKey(params.operation, params.invoiceId, params.funderPublicKey);
      const cachedFootprint = { read: ['cached'] };
      cacheFootprint(key, cachedFootprint);

      const result = await simulateOrThrow(params);
      expect(result.cached).toBe(true);
      expect(result.footprint).toEqual(cachedFootprint);
      expect(callSorobanContract).not.toHaveBeenCalled();
    });

    it('re-simulates when currentLedger is newer than cached ledger', async () => {
      const key = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      cacheFootprint(key, { read: ['stale'] }, 10);

      const freshFootprint = { read: ['fresh'] };
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: freshFootprint,
        resourceConfig: {},
        ledgerSequence: 11,
      });

      const result = await simulateOrThrow(baseParams({ options: { currentLedger: 11 } }));
      expect(result.cached).toBe(false);
      expect(result.footprint).toEqual(freshFootprint);
      expect(callSorobanContract).toHaveBeenCalledTimes(1);
    });

    it('re-simulates when contractVersion is newer than cached version', async () => {
      const key = generateCacheKey('fund_escrow', 'inv_123', PUBLIC_KEY);
      cacheFootprint(key, { read: ['stale'] }, 10, 'v1');

      const freshFootprint = { read: ['fresh'] };
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: freshFootprint,
        resourceConfig: {},
        ledgerSequence: 10,
      });

      const result = await simulateOrThrow(baseParams({ options: { contractVersion: 'v2' } }));
      expect(result.cached).toBe(false);
      expect(result.footprint).toEqual(freshFootprint);
      expect(callSorobanContract).toHaveBeenCalledTimes(1);
    });
  });

  // ─── simulateOrThrow — failure ───────────────────────────────────────────────

  describe('simulateOrThrow — failed simulations', () => {
    it.each([
      ['Insufficient resources', SIMULATION_ERROR_TYPES.INSUFFICIENT_RESOURCES, 'SIMULATION_INSUFFICIENT_RESOURCES', false],
      ['Invalid signature', SIMULATION_ERROR_TYPES.INVALID_AUTH, 'SIMULATION_INVALID_AUTH', false],
      ['Contract invocation failed', SIMULATION_ERROR_TYPES.CONTRACT_ERROR, 'SIMULATION_CONTRACT_ERROR', false],
      ['Network timeout', SIMULATION_ERROR_TYPES.NETWORK_ERROR, 'SIMULATION_NETWORK_ERROR', true],
      ['Unknown problem', SIMULATION_ERROR_TYPES.VALIDATION_ERROR, 'SIMULATION_VALIDATION_ERROR', false],
    ])('handles "%s" error', async (msg, errorType, code, retryable) => {
      callSorobanContract.mockRejectedValue(new Error(msg));
      const result = await simulateOrThrow(baseParams());
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(errorType);
      expect(result.error.code).toBe(code);
      expect(result.error.retryable).toBe(retryable);
    });

    it('does not cache on simulation failure', async () => {
      callSorobanContract.mockRejectedValue(new Error('Network timeout'));
      const params = baseParams();
      await simulateOrThrow(params);

      const key = generateCacheKey(params.operation, params.invoiceId, params.funderPublicKey);
      expect(getCachedFootprint(key)).toBeNull();
    });

    it('handles unsuccessful simulation result (success: false)', async () => {
      callSorobanContract.mockResolvedValue({ success: false, footprint: null });
      const result = await simulateOrThrow(baseParams());
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
    });

    it('includes operation context in error', async () => {
      callSorobanContract.mockRejectedValue(new Error('Test error'));
      const result = await simulateOrThrow(baseParams({ operation: 'fund_escrow', invoiceId: 'inv_ctx' }));
      expect(result.error.context).toMatchObject({
        operation: 'fund_escrow',
        invoiceId: 'inv_ctx',
      });
    });

    it('rejects invalid XDR (too short)', async () => {
      callSorobanContract.mockImplementation(() => {
        throw new Error('Invalid transaction XDR: too short');
      });
      const result = await simulateOrThrow(baseParams({ transactionXdr: 'SHORT' }));
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
      expect(result.errorType).toBe(SIMULATION_ERROR_TYPES.VALIDATION_ERROR);
    });
  });

  // ─── simulateOrThrowSync ──────────────────────────────────────────────────────

  describe('simulateOrThrowSync', () => {
    it('returns result on success', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: {},
      });
      const result = await simulateOrThrowSync(baseParams());
      expect(result.status).toBe(SIMULATION_STATUS.SUCCESS);
    });

    it('throws on simulation failure', async () => {
      callSorobanContract.mockRejectedValue(new Error('Insufficient resources'));
      await expect(simulateOrThrowSync(baseParams())).rejects.toMatchObject({
        code: 'SIMULATION_INSUFFICIENT_RESOURCES',
        retryable: false,
      });
    });

    it('throws validation error for invalid params', async () => {
      await expect(simulateOrThrowSync(baseParams({ operation: undefined }))).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    });

    it('throws network error as retryable (503)', async () => {
      callSorobanContract.mockRejectedValue(new Error('Network timeout'));
      await expect(simulateOrThrowSync(baseParams())).rejects.toMatchObject({
        code: 'SIMULATION_NETWORK_ERROR',
        retryable: true,
        status: 503,
      });
    });
  });

  // ─── rpcConfig pass-through ───────────────────────────────────────────────────

  describe('rpcConfig option', () => {
    it('passes rpcConfig to callSorobanContract', async () => {
      const rpcConfig = { maxRetries: 5, baseDelay: 500 };
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: {},
      });

      await simulateOrThrow(baseParams({ options: { rpcConfig } }));
      expect(callSorobanContract).toHaveBeenCalledWith(expect.any(Function), rpcConfig);
    });
  });

  // ─── edge cases ───────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles error without message', async () => {
      const err = new Error();
      delete err.message;
      callSorobanContract.mockRejectedValue(err);
      const result = await simulateOrThrow(baseParams());
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
    });

    it('handles null error message', async () => {
      callSorobanContract.mockRejectedValue(new Error(null));
      const result = await simulateOrThrow(baseParams());
      expect(result.status).toBe(SIMULATION_STATUS.FAILURE);
    });

    it('deduplicates concurrent simulations via cache on second call', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: {},
      });

      const params = baseParams();
      await simulateOrThrow(params);
      const second = await simulateOrThrow(params);

      expect(second.cached).toBe(true);
      expect(callSorobanContract).toHaveBeenCalledTimes(1);
    });

    it('handles independent concurrent simulations without cross-contamination', async () => {
      callSorobanContract.mockResolvedValue({
        success: true,
        footprint: { read: ['addr1'] },
        resourceConfig: {},
      });

      const [r1, r2] = await Promise.all([
        simulateOrThrow(baseParams({ invoiceId: 'inv_a' })),
        simulateOrThrow(baseParams({ invoiceId: 'inv_b' })),
      ]);

      expect(r1.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(r2.status).toBe(SIMULATION_STATUS.SUCCESS);
      expect(callSorobanContract).toHaveBeenCalledTimes(2);
    });
  });
});
