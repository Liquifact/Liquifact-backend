const { callSorobanContract } = require('./soroban');

describe('Soroban Integration Wrapper', () => {

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
          const err = new Error('Gateway Timeout');
          err.code = 'ETIMEDOUT';
          return Promise.reject(err);
        }
        return Promise.resolve('recovered');
      });

      const result = await callSorobanContract(operation);
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
