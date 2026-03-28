const { withRetry } = require('./retry');

/**
 * Test suite for the retry utility.
 * @returns {void}
 */
describe('Retry Utility', () => {
  it('should succeed on the first try without retrying', async () => {
    const operation = jest.fn().mockResolvedValue('success');
    
    const result = await withRetry(operation);
    
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    let attempts = 0;
    const operation = jest.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(new Error('Transient Error'));
      }
      return Promise.resolve('success');
    });

    const result = await withRetry(operation, { maxRetries: 3, baseDelay: 10 });
    
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should fail after exhausting all retries', async () => {
    const error = new Error('Persistent Error');
    const operation = jest.fn().mockRejectedValue(error);

    await expect(
      withRetry(operation, { maxRetries: 2, baseDelay: 10 })
    ).rejects.toThrow('Persistent Error');
    expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should abort retries if shouldRetry returns false', async () => {
    const error = new Error('Fatal Error');
    const operation = jest.fn().mockRejectedValue(error);
  /**
   * Determines whether to retry based on the error.
   * @param {Error} err - The error to evaluate.
   * @returns {boolean} True if the operation should retry, false otherwise.
   */
  const shouldRetry = (err) => err.message !== 'Fatal Error';    await expect(
      withRetry(operation, { maxRetries: 3, baseDelay: 10, shouldRetry })
    ).rejects.toThrow('Fatal Error');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should respect maximum delay caps (tested quickly)', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('Fail'));
    const startTime = Date.now();
    
    // We want the delay calculation to hit the maxDelay cap.
    // maxDelay is set to 50ms.
    // baseDelay caps at 10000ms. We set it high so it forces maxDelay.
    try {
      await withRetry(operation, { maxRetries: 1, baseDelay: 1000, maxDelay: 50 });
    } catch {
      // Ignored
    }
    
    const duration = Date.now() - startTime;
    // Delay without jitter is min(1000 * 1, 50) = 50ms.
    // Jittered delay is between 40ms and 60ms.
    // So the total duration should be around 40-70ms (allowing a little overhead).
    expect(duration).toBeGreaterThanOrEqual(30);
    expect(duration).toBeLessThanOrEqual(100);
  });

  /**
   * Ensures that maxRetries is capped for security and does not allow excessive attempts.
   * @returns {Promise<void>} Resolves when test completes.
   */
  it('should enforce security caps on maxRetries', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('Fail'));
    
    // pass maxRetries exceeding the cap (e.g. 100). The cap is 10.
    // Setting baseDelay to 1ms to make it execute quickly.
    await expect(
      withRetry(operation, { maxRetries: 100, baseDelay: 1 })
    ).rejects.toThrow('Fail');
    
    // Cap is 10, so 1 initial attempt + 10 retries = 11 attempts total
    expect(operation).toHaveBeenCalledTimes(11);
  });
});
