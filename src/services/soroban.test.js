const metrics = require('../metrics');
const {
  callSorobanContract,
  withRetry,
  sharedBreaker,
  getRetryCauseLabel,
} = require('./soroban');

async function getMetricsText() {
  return metrics.registry.metrics();
}

describe('Soroban Integration Wrapper', () => {
  beforeEach(() => {
    metrics.registry.resetMetrics();
    sharedBreaker.state = 'CLOSED';
    sharedBreaker.failureCount = 0;
    sharedBreaker.nextAttemptTime = 0;
  });

  describe('callSorobanContract', () => {
    it('should execute successfully without retries', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      const result = await callSorobanContract(operation);
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient errors using the wrapper', async () => {
      let attempts = 0;
      const operation = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('503 Service Unavailable');
          err.status = 503;
          return Promise.reject(err);
        }
        return Promise.resolve('recovered');
      });

      const result = await callSorobanContract(operation);
      expect(result).toBe('recovered');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('records a success latency sample with a bounded method label', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      await callSorobanContract(operation, {
        maxRetries: 0,
        baseDelay: 0,
        maxDelay: 0,
        metricMethod: 'simulateTransaction',
      });

      const metricsText = await getMetricsText();
      expect(metricsText).toMatch(
        /soroban_rpc_call_duration_seconds_count\{method="simulate_transaction",outcome="success"\} 1/
      );
    });

    it('records a circuit_open latency outcome when the breaker fails fast', async () => {
      sharedBreaker.state = 'OPEN';
      sharedBreaker.nextAttemptTime = Date.now() + 10000;
      const operation = jest.fn().mockResolvedValue('never-called');

      await expect(
        callSorobanContract(operation, {
          maxRetries: 0,
          baseDelay: 0,
          maxDelay: 0,
          metricMethod: 'contract_call',
        })
      ).rejects.toThrow();

      const metricsText = await getMetricsText();
      expect(operation).not.toHaveBeenCalled();
      expect(metricsText).toMatch(
        /soroban_rpc_call_duration_seconds_count\{method="contract_call",outcome="circuit_open"\} 1/
      );
    });

    it('collapses untrusted method hints to unknown so secrets do not appear in labels', async () => {
      const operation = jest.fn().mockResolvedValue('ok');
      const secretLikeMethod = 'wallet:secret-token-123';

      await callSorobanContract(operation, {
        maxRetries: 0,
        baseDelay: 0,
        maxDelay: 0,
        metricMethod: secretLikeMethod,
      });

      const metricsText = await getMetricsText();
      expect(metricsText).toMatch(
        /soroban_rpc_call_duration_seconds_count\{method="unknown",outcome="success"\} 1/
      );
      expect(metricsText).not.toContain(secretLikeMethod);
    });

    it('records an error latency outcome when the call fails with a non-transient error', async () => {
      // Non-transient errors use outcome="error" distinct from
      // "circuit_open" and "success" branches in callSorobanContract.
      const operation = jest.fn().mockRejectedValue(new Error('Invalid arguments'));

      await expect(
        callSorobanContract(operation, {
          maxRetries: 0,
          baseDelay: 0,
          maxDelay: 0,
          metricMethod: 'contract_call',
        })
      ).rejects.toThrow('Invalid arguments');

      const metricsText = await getMetricsText();
      expect(metricsText).toMatch(
        /soroban_rpc_call_duration_seconds_count\{method="contract_call",outcome="error"\} 1/
      );
      // Method and outcome are the only labels on the histogram — no extras.
      expect(metricsText).not.toMatch(/soroban_rpc_call_duration_seconds_count\{[^}]*,[^}]*,[^}]*\}/);
    });

    it('should fail immediately on non-transient error', async () => {
      const error = new Error('Invalid arguments');
      const operation = jest.fn().mockRejectedValue(error);

      await expect(callSorobanContract(operation)).rejects.toThrow('Invalid arguments');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should trip the circuit breaker on sustained transient errors', async () => {
      const operation = jest.fn().mockImplementation(() => {
        const err = new Error('503 Service Unavailable');
        err.status = 503;
        return Promise.reject(err);
      });

      // Provide a fast retry config so test doesn't hang
      const fastConfig = { maxRetries: 0, baseDelay: 0, maxDelay: 0 };

      // Fail enough times to trip the breaker (default threshold is 5)
      for (let i = 0; i < 5; i++) {
        await expect(callSorobanContract(operation, fastConfig)).rejects.toThrow('503 Service Unavailable');
      }

      // Next call should fail fast from the breaker
      const fastFailOp = jest.fn();
      let caughtError;
      try {
        await callSorobanContract(fastFailOp, fastConfig);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError.code).toBe('CIRCUIT_OPEN');
      expect(fastFailOp).not.toHaveBeenCalled();
    });
  });

  describe('withRetry elapsed-time budget (maxElapsedMs)', () => {
    let dateNowSpy;
    let dateCallCount;

    beforeEach(() => {
      dateCallCount = 0;
      dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        dateCallCount++;
        // first call = startTime, subsequent calls = large elapsed
        return dateCallCount === 1 ? 0 : 100;
      });
    });

    afterEach(() => {
      dateNowSpy.mockRestore();
    });

    it('should exhaust budget and throw last error when maxElapsedMs is exceeded', async () => {
      // Simulate time progression: startTime=0, elapsed after first failure=50 (within budget),
      // elapsed after second failure=200 (exceeds 100ms budget)
      dateNowSpy.mockRestore();
      const values = [0, 50, 200];
      let idx = 0;
      dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => values[idx++]);

      const err = new Error('503 Service Unavailable');
      err.status = 503;
      const operation = jest.fn().mockRejectedValue(err);

      await expect(
        withRetry(operation, { maxRetries: 5, baseDelay: 0, maxDelay: 0, maxElapsedMs: 100 })
      ).rejects.toThrow('503 Service Unavailable');

      // Initial attempt + one retry that exhausts the budget
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should not retry when budget is 0 and operation fails', async () => {
      const err = new Error('503 Service Unavailable');
      err.status = 503;
      const operation = jest.fn().mockRejectedValue(err);

      await expect(
        withRetry(operation, { maxRetries: 5, baseDelay: 0, maxDelay: 0, maxElapsedMs: 0 })
      ).rejects.toThrow('503 Service Unavailable');

      // Initial attempt fails, second Date.now() call returns 100 → elapsed = 100 ≥ 0 → budget exhausted
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should continue retrying when budget is not yet exhausted', async () => {
      // For this test we need Date.now() to return small values so budget is not consumed
      dateNowSpy.mockRestore();
      dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        dateCallCount++;
        return dateCallCount === 1 ? 0 : 5;
      });

      let attempts = 0;
      const operation = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('503 Service Unavailable');
          err.status = 503;
          return Promise.reject(err);
        }
        return Promise.resolve('recovered');
      });

      const result = await withRetry(operation, {
        maxRetries: 5, baseDelay: 0, maxDelay: 0, maxElapsedMs: 10000
      });

      expect(result).toBe('recovered');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['429', () => {
        const err = new Error('Too Many Requests');
        err.status = 429;
        return err;
      }],
      ['5xx', () => {
        const err = new Error('503 Service Unavailable');
        err.status = 503;
        return err;
      }],
      ['timeout', () => {
        const err = new Error('timed out');
        err.code = 'ETIMEDOUT';
        return err;
      }],
    ])('increments the retry cause counter for %s retries', async (cause, buildError) => {
      let attempts = 0;
      const operation = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(buildError());
        }
        return Promise.resolve('ok');
      });

      await withRetry(operation, {
        maxRetries: 2,
        baseDelay: 0,
        maxDelay: 0,
        maxElapsedMs: 10000,
      });

      const metricsText = await getMetricsText();
      expect(metricsText).toMatch(new RegExp(`soroban_rpc_retry_causes_total\\{cause="${cause}"\\} 1`));
    });

    it('should succeed immediately when operation does not fail', async () => {
      const operation = jest.fn().mockResolvedValue('ok');

      const result = await withRetry(operation, {
        maxRetries: 3, baseDelay: 200, maxDelay: 5000, maxElapsedMs: 10000
      });

      expect(result).toBe('ok');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should stop at attempt cap before budget is exhausted (attempt cap wins)', async () => {
      const err = new Error('503 Service Unavailable');
      err.status = 503;
      const operation = jest.fn().mockRejectedValue(err);

      // maxRetries=1 means 2 total attempts; budget is generous (100ms elapsed < 10000ms)
      await expect(
        withRetry(operation, { maxRetries: 1, baseDelay: 0, maxDelay: 0, maxElapsedMs: 10000 })
      ).rejects.toThrow('503 Service Unavailable');

      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should throw immediately on non-retryable error regardless of budget', async () => {
      const error = new Error('Invalid arguments');
      const operation = jest.fn().mockRejectedValue(error);

      await expect(
        withRetry(operation, { maxRetries: 5, baseDelay: 0, maxDelay: 0, maxElapsedMs: 10000 })
      ).rejects.toThrow('Invalid arguments');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should increment the budget exhausted metric when budget is exceeded', async () => {
      const incSpy = jest.spyOn(metrics.sorobanRetryBudgetExhaustedTotal, 'inc');

      const err = new Error('503 Service Unavailable');
      err.status = 503;
      const operation = jest.fn().mockRejectedValue(err);

      await expect(
        withRetry(operation, { maxRetries: 5, baseDelay: 0, maxDelay: 0, maxElapsedMs: 50 })
      ).rejects.toThrow('503 Service Unavailable');

      expect(incSpy).toHaveBeenCalledTimes(1);

      incSpy.mockRestore();
    });

    it('does not increment retry cause counters when the budget is exhausted before a retry occurs', async () => {
      dateNowSpy.mockRestore();
      const values = [0, 100];
      let idx = 0;
      dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => values[idx++]);

      const err = new Error('503 Service Unavailable');
      err.status = 503;
      const operation = jest.fn().mockRejectedValue(err);

      await expect(
        withRetry(operation, { maxRetries: 5, baseDelay: 0, maxDelay: 0, maxElapsedMs: 50 })
      ).rejects.toThrow('503 Service Unavailable');

      const metricsText = await getMetricsText();
      expect(metricsText).not.toMatch(/soroban_rpc_retry_causes_total\{cause="5xx"\} 1/);
    });

    it('should use default maxElapsedMs from SOROBAN_RETRY_CONFIG when not provided', async () => {
      const operation = jest.fn().mockResolvedValue('defaults-ok');

      const result = await withRetry(operation);
      expect(result).toBe('defaults-ok');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should surface the original error (user-safe) after budget exhaustion', async () => {
      const err = new Error('Service Temporarily Unavailable');
      err.status = 503;
      err.code = 'SOROBAN_RPC_ERR';
      const operation = jest.fn().mockRejectedValue(err);

      let thrown;
      try {
        await withRetry(operation, { maxRetries: 5, baseDelay: 0, maxDelay: 0, maxElapsedMs: 50 });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeDefined();
      expect(thrown.message).toBe('Service Temporarily Unavailable');
      expect(thrown.status).toBe(503);
      expect(thrown.code).toBe('SOROBAN_RPC_ERR');
    });

    it('maps retry classifications to bounded retry-cause labels', () => {
      expect(getRetryCauseLabel({ retryable: true, category: 'rate-limit', reason: 'status:429' })).toBe('429');
      expect(getRetryCauseLabel({ retryable: true, category: 'rpc-5xx', reason: 'status:503' })).toBe('5xx');
      expect(getRetryCauseLabel({ retryable: true, category: 'network', reason: 'network-code:ETIMEDOUT' })).toBe('timeout');
      expect(getRetryCauseLabel({ retryable: true, category: 'network', reason: 'network-code:ECONNRESET' })).toBe('unknown');
    });
  });
});
