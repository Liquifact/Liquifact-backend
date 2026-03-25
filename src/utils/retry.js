/**
 * Utility for retrying operations with exponential backoff.
 * 
 * @module retry
 */

/**
 * A predicate function to determine if an error should trigger a retry.
 * @callback ShouldRetry
 * @param {Error} error The error thrown by the operation.
 * @returns {boolean} True if the operation should be retried, false otherwise.
 */

/**
 * Executes a given asynchronous operation with exponential backoff retries.
 * Provides security validation to prevent unbounded retries or unreasonable delays.
 * 
 * @param {Function} operation - An asynchronous function to execute.
 * @param {Object} [options={}] - Configuration options for the retry behavior.
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts (capped at 10).
 * @param {number} [options.baseDelay=500] - Initial delay in milliseconds (capped at 10000ms).
 * @param {number} [options.maxDelay=10000] - Maximum delay between retries in milliseconds (capped at 60000ms).
 * @param {ShouldRetry} [options.shouldRetry] - Function to evaluate if an error is transient (defaults to always true).
 * @returns {Promise<any>} The result of the operation if it succeeds.
 * @throws {Error} The last error thrown if all retries are exhausted, or an error that fails the shouldRetry check.
 */
async function withRetry(operation, options = {}) {
  // Security bounds
  const MAX_RETRIES_CAP = 10;
  const MAX_DELAY_CAP = 60000;
  const MAX_BASE_DELAY_CAP = 10000;

  const {
    maxRetries: rawMaxRetries = 3,
    baseDelay: rawBaseDelay = 500,
    maxDelay: rawMaxDelay = 10000,
    shouldRetry = () => true
  } = options;

  // Validate and cap configuration to prevent accidental resource exhaustion
  const maxRetries = Math.max(0, Math.min(rawMaxRetries, MAX_RETRIES_CAP));
  const baseDelay = Math.max(0, Math.min(rawBaseDelay, MAX_BASE_DELAY_CAP));
  const maxDelay = Math.max(0, Math.min(rawMaxDelay, MAX_DELAY_CAP));

  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Calculate exponential backoff
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const delay = Math.min(exponentialDelay, maxDelay);
      
      // Add Jitter (±20%)
      const jitteredDelay = delay * (0.8 + Math.random() * 0.4);

      attempt++;
      await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
    }
  }
}

module.exports = {
  withRetry
};
