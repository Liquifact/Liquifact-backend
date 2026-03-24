const { callSorobanContract, isTransientError } = require('./soroban');

describe('Soroban Integration Wrapper', () => {
  describe('isTransientError', () => {
    it('should identify transient error messages', () => {
      expect(isTransientError(new Error('Network timeout'))).toBe(true);
      expect(isTransientError(new Error('Rate limit exceeded (HTTP 429)'))).toBe(true);
      expect(isTransientError(new Error('Server responded with 503'))).toBe(true);
    });

    it('should return false for non-transient errors', () => {
      expect(isTransientError(new Error('Invalid arguments'))).toBe(false);
      expect(isTransientError(new Error('Contract execution trapped'))).toBe(false);
      expect(isTransientError(new Error('404 Not Found'))).toBe(false);
    });
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
          return Promise.reject(new Error('503 Service Unavailable'));
        }
        return Promise.resolve('recovered');
      });

      // Override baseDelay to make test fast
      const result = await callSorobanContract(operation, { baseDelay: 10 });
      expect(result).toBe('recovered');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should fail immediately on non-transient error', async () => {
      const error = new Error('Invalid arguments');
      const operation = jest.fn().mockRejectedValue(error);

      await expect(callSorobanContract(operation)).rejects.toThrow('Invalid arguments');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });
});
