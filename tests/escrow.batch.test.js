'use strict';

const { batchReadEscrowStates } = require('../src/services/escrowBatchRead');
const { readEscrowState } = require('../src/services/escrowRead');

// Mock the readEscrowState function
jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  validateInvoiceId: jest.requireActual('../src/services/escrowRead').validateInvoiceId,
}));

// Mock the soroban module to control retry behavior
jest.mock('../src/services/soroban', () => {
  const actual = jest.requireActual('../src/services/soroban');
  return {
    ...actual,
    classifySorobanError: actual.classifySorobanError,
    withRetry: jest.fn((operation, config) => operation()),
  };
});

describe('escrowBatchRead Service', () => {
  const { withRetry } = require('../src/services/soroban');

  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock: withRetry just calls the operation (no retry)
    withRetry.mockImplementation((operation, config) => operation());
  });

  it('should read multiple escrow states successfully', async () => {
    const invoiceIds = ['inv_1', 'inv_2', 'inv_3'];
    readEscrowState.mockImplementation(id => Promise.resolve({
      invoiceId: id,
      status: 'active',
      fundedAmount: 1000,
      legal_hold: false,
    }));

    const result = await batchReadEscrowStates(invoiceIds);

    expect(result.results).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(readEscrowState).toHaveBeenCalledTimes(3);
    expect(result.results[0].invoiceId).toBe('inv_1');
  });

  it('should isolate failures: one failing call should not stop the batch', async () => {
    const invoiceIds = ['inv_success', 'inv_fail', 'inv_success2'];
    
    readEscrowState.mockImplementation(id => {
      if (id === 'inv_fail') {
        return Promise.reject(new Error('RPC Failure'));
      }
      return Promise.resolve({
        invoiceId: id,
        status: 'active',
        fundedAmount: 1000,
        legal_hold: false,
      });
    });

    const result = await batchReadEscrowStates(invoiceIds);

    expect(result.results).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      invoiceId: 'inv_fail',
      error: 'RPC Failure',
      code: 'INTERNAL_ERROR',
    });
    expect(readEscrowState).toHaveBeenCalledTimes(3);
  });

  it('should enforce timeouts for individual calls', async () => {
    const invoiceIds = ['inv_slow'];
    
    // Mock a slow response
    readEscrowState.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ status: 'ok' }), 100);
    }));

    const result = await batchReadEscrowStates(invoiceIds, { timeout: 50 });

    expect(result.results).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('timed out');
    expect(result.errors[0].code).toBe('ETIMEDOUT');
  });

  it('should respect concurrency limits', async () => {
    const invoiceIds = ['inv_1', 'inv_2', 'inv_3', 'inv_4', 'inv_5'];
    let activeCalls = 0;
    let maxConcurrent = 0;

    readEscrowState.mockImplementation(() => {
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      return new Promise(resolve => {
        setTimeout(() => {
          activeCalls--;
          resolve({ status: 'ok' });
        }, 20);
      });
    });

    const concurrency = 2;
    await batchReadEscrowStates(invoiceIds, { concurrency });

    // With concurrency 2, we shouldn't have more than 2 active calls at a time
    expect(maxConcurrent).toBeLessThanOrEqual(concurrency);
    expect(readEscrowState).toHaveBeenCalledTimes(5);
  });

  describe('Transient error retry behavior', () => {
    it('should retry transient errors and succeed on recovery', async () => {
      const invoiceIds = ['inv_transient'];
      let attemptCount = 0;

      readEscrowState.mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 2) {
          // First attempt fails with transient error
          const err = new Error('Service unavailable');
          err.status = 503;
          return Promise.reject(err);
        }
        // Second attempt succeeds
        return Promise.resolve({
          invoiceId: 'inv_transient',
          status: 'active',
          fundedAmount: 1000,
          legal_hold: false,
        });
      });

      // Mock withRetry to actually retry
      const { withRetry } = require('../src/services/soroban');
      withRetry.mockImplementation(async (operation, config) => {
        let lastErr;
        for (let i = 0; i <= (config.maxRetries || 3); i++) {
          try {
            return await operation();
          } catch (err) {
            lastErr = err;
            if (i === (config.maxRetries || 3)) throw err;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        throw lastErr;
      });

      const result = await batchReadEscrowStates(invoiceIds);

      expect(result.results).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.results[0].invoiceId).toBe('inv_transient');
      expect(attemptCount).toBeGreaterThan(1);
    });

    it('should exhaust retries on persistent transient errors and isolate failure', async () => {
      const invoiceIds = ['inv_persistent_transient', 'inv_success'];
      let attemptCount = 0;

      readEscrowState.mockImplementation((id) => {
        if (id === 'inv_persistent_transient') {
          attemptCount++;
          // Always fails with transient error
          const err = new Error('Gateway timeout');
          err.status = 504;
          return Promise.reject(err);
        }
        // Other invoices succeed
        return Promise.resolve({
          invoiceId: id,
          status: 'active',
          fundedAmount: 1000,
          legal_hold: false,
        });
      });

      // Mock withRetry to actually retry
      const { withRetry } = require('../src/services/soroban');
      withRetry.mockImplementation(async (operation, config) => {
        let lastErr;
        const maxRetries = config.maxRetries || 3;
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await operation();
          } catch (err) {
            lastErr = err;
            if (i === maxRetries) throw err;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        throw lastErr;
      });

      const result = await batchReadEscrowStates(invoiceIds);

      expect(result.results).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.results[0].invoiceId).toBe('inv_success');
      expect(result.errors[0].invoiceId).toBe('inv_persistent_transient');
      expect(result.errors[0].retryable).toBe(true);
      expect(result.errors[0].category).toBe('rpc-5xx');
      expect(attemptCount).toBeGreaterThan(1); // Should have retried
    });

    it('should not retry permanent errors', async () => {
      const invoiceIds = ['inv_permanent'];
      let attemptCount = 0;

      readEscrowState.mockImplementation(() => {
        attemptCount++;
        // Permanent error (e.g., 400 Bad Request)
        const err = new Error('Invalid invoice ID');
        err.status = 400;
        return Promise.reject(err);
      });

      // Mock withRetry to track calls but not actually retry permanent errors
      const { withRetry } = require('../src/services/soroban');
      withRetry.mockImplementation(async (operation, config) => {
        try {
          return await operation();
        } catch (err) {
          // Don't retry permanent errors
          throw err;
        }
      });

      const result = await batchReadEscrowStates(invoiceIds);

      expect(result.results).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].invoiceId).toBe('inv_permanent');
      expect(result.errors[0].retryable).toBe(false);
      expect(result.errors[0].category).toBe('permanent');
      expect(attemptCount).toBe(1); // Should only have been called once
    });

    it('should retry network timeout errors', async () => {
      const invoiceIds = ['inv_timeout'];
      let attemptCount = 0;

      readEscrowState.mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 2) {
          const err = new Error('Request timed out');
          err.code = 'ETIMEDOUT';
          return Promise.reject(err);
        }
        return Promise.resolve({
          invoiceId: 'inv_timeout',
          status: 'active',
          fundedAmount: 1000,
          legal_hold: false,
        });
      });

      // Mock withRetry to actually retry
      const { withRetry } = require('../src/services/soroban');
      withRetry.mockImplementation(async (operation, config) => {
        let lastErr;
        for (let i = 0; i <= (config.maxRetries || 3); i++) {
          try {
            return await operation();
          } catch (err) {
            lastErr = err;
            if (i === (config.maxRetries || 3)) throw err;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        throw lastErr;
      });

      const result = await batchReadEscrowStates(invoiceIds);

      expect(result.results).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(attemptCount).toBeGreaterThan(1);
    });

    it('should retry rate limit errors (429)', async () => {
      const invoiceIds = ['inv_ratelimit'];
      let attemptCount = 0;

      readEscrowState.mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 2) {
          const err = new Error('Too many requests');
          err.status = 429;
          return Promise.reject(err);
        }
        return Promise.resolve({
          invoiceId: 'inv_ratelimit',
          status: 'active',
          fundedAmount: 1000,
          legal_hold: false,
        });
      });

      // Mock withRetry to actually retry
      const { withRetry } = require('../src/services/soroban');
      withRetry.mockImplementation(async (operation, config) => {
        let lastErr;
        for (let i = 0; i <= (config.maxRetries || 3); i++) {
          try {
            return await operation();
          } catch (err) {
            lastErr = err;
            if (i === (config.maxRetries || 3)) throw err;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        throw lastErr;
      });

      const result = await batchReadEscrowStates(invoiceIds);

      expect(result.results).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(attemptCount).toBeGreaterThan(1);
    });

    it('should cap retry budget to respect per-invoice timeout', async () => {
      const invoiceIds = ['inv_budget'];
      const timeout = 1000; // 1 second timeout

      readEscrowState.mockImplementation(() => {
        const err = new Error('Service unavailable');
        err.status = 503;
        return Promise.reject(err);
      });

      // Mock withRetry to verify the config
      const { withRetry } = require('../src/services/soroban');
      withRetry.mockImplementation(async (operation, config) => {
        // Verify that maxElapsedMs is capped to respect timeout
        expect(config.maxElapsedMs).toBeLessThanOrEqual(timeout);
        throw new Error('Service unavailable');
      });

      await batchReadEscrowStates(invoiceIds, { timeout });

      expect(withRetry).toHaveBeenCalled();
    });

    it('should allow custom retry configuration', async () => {
      const invoiceIds = ['inv_custom'];
      const customRetryConfig = {
        maxRetries: 5,
        baseDelay: 100,
        maxDelay: 2000,
      };

      readEscrowState.mockImplementation(() => {
        return Promise.resolve({
          invoiceId: 'inv_custom',
          status: 'active',
          fundedAmount: 1000,
          legal_hold: false,
        });
      });

      // Mock withRetry to verify the config
      const { withRetry } = require('../src/services/soroban');
      withRetry.mockImplementation(async (operation, config) => {
        expect(config.maxRetries).toBe(customRetryConfig.maxRetries);
        expect(config.baseDelay).toBe(customRetryConfig.baseDelay);
        expect(config.maxDelay).toBe(customRetryConfig.maxDelay);
        return await operation();
      });

      await batchReadEscrowStates(invoiceIds, { retryConfig: customRetryConfig });

      expect(withRetry).toHaveBeenCalled();
    });
  });
});
