const { withRetry } = require('../utils/retry');

/**
 * Determines if a Soroban API error is transient and should be retried.
 * 
 * @param {Error} error The error thrown from the API call.
 * @returns {boolean} True if the error is transient (e.g., rate limit, timeout, server error).
 */
function isTransientError(error) {
  const transientMessages = [
    'rate limit',
    'timeout',
    'econnreset',
    'econnrefused',
    '500', '502', '503', '504', '429'
  ];
  
  const errorMessage = (error.message || '').toLowerCase();
  return transientMessages.some(msg => errorMessage.includes(msg));
}

/**
 * Executes a call to the Soroban API with exponential backoff and retries.
 * 
 * @param {Function} contractCallFn The API call function to execute.
 * @param {Object} [retryOptions={}] Optional retry configurations to override defaults.
 * @returns {Promise<any>} The response from the contract.
 */
async function callSorobanContract(contractCallFn, retryOptions = {}) {
  const defaultOptions = {
    maxRetries: 3,
    baseDelay: 500,
    maxDelay: 10000,
    shouldRetry: isTransientError
  };

  return withRetry(contractCallFn, { ...defaultOptions, ...retryOptions });
}

module.exports = {
  callSorobanContract,
  isTransientError
};
