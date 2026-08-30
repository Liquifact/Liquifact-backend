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
 * @param {Function} [options.retryDelay] - Optional function returning a caller supplied delay in ms.
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
    shouldRetry = () => true,
    retryDelay = null,
    onRetry = null, // optional callback invoked on each failed attempt: ({ attempt, error })
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
      const willRetry = attempt < maxRetries && shouldRetry(error);

      // Invoke onRetry callback so callers can record the failed attempt
      try {
        if (typeof onRetry === 'function') {
          // expose attempt number as 1-based
          onRetry({ attempt: attempt + 1, error });
        }
      } catch (cbErr) {
        // Swallow callback errors to avoid interfering with retry behavior
      }

      if (!willRetry) {
        throw error;
      }

      const callerDelay = typeof retryDelay === 'function'
        ? retryDelay(error, attempt + 1)
        : null;
      if (Number.isFinite(callerDelay) && callerDelay >= 0) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, Math.min(callerDelay, MAX_DELAY_CAP)));
        continue;
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

function parseRetryAfterMs(value, now = Date.now()) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, timestamp - now);
}

/**
 * Classifies a nodemailer/SMTP error as transient or permanent.
 * 
 * Permanent errors (5xx SMTP codes or specific error types) should NOT be retried:
 * - 550-554: Permanent failures (invalid recipient, policy rejection, etc.)
 * - "Invalid recipient", "User unknown", "Mailbox not found" patterns
 * 
 * Transient errors (4xx codes, network errors) should be retried:
 * - 421-429: Temporary service unavailable, try again later
 * - ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH: Network connectivity issues
 * - Generic transport errors without a 5xx code
 * 
 * @param {Error} error - The error thrown by nodemailer or transport
 * @returns {boolean} True if the error is permanent, false if transient
 */
function isPermanentSmtpError(error) {
  if (!error) return false;

  const message = (error.message || '').toLowerCase();
  const response = error.response || '';
  const code = error.code || '';

  // Permanent SMTP error codes (5xx)
  if (response && /^(550|551|552|553|554)/.test(response)) {
    return true;
  }

  // Common permanent error patterns
  if (/invalid recipient|user unknown|mailbox not found|domain not found/.test(message)) {
    return true;
  }

  // Permanent system errors
  if (code === 'EBADRQC' || code === 'EDQUOT') {
    return true;
  }

  return false;
}

/**
 * Sends an email with bounded exponential backoff retry.
 * Automatically classifies SMTP errors as permanent or transient before deciding to retry.
 * 
 * Permanent errors (5xx, invalid recipient, etc.) fail immediately without retry.
 * Transient errors (4xx, network timeouts) are retried with exponential backoff + jitter.
 * 
 * @param {Object} transport - nodemailer transport instance
 * @param {Object} mailOptions - mail options (to, subject, text/html, from, etc.)
 * @param {Object} [opts={}] - retry configuration
 * @param {number} [opts.maxAttempts=3] - max retry attempts (capped at 10)
 * @param {number} [opts.baseDelayMs=1000] - initial backoff delay in ms (capped at 10s)
 * @param {Function} [opts.onRetry] - callback invoked on each retry attempt: ({ attempt, error })
 * @returns {Promise<Object>} Result from transport.sendMail() on success
 * @throws {Error} If all retries exhausted, or a permanent error is encountered
 */
async function sendMailWithRetry(transport, mailOptions, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    onRetry = null,
  } = opts;

  const shouldRetry = (error) => {
    const isPermanent = isPermanentSmtpError(error);
    return !isPermanent; // retry only if NOT permanent
  };

  return withRetry(
    () => transport.sendMail(mailOptions),
    {
      maxRetries: maxAttempts - 1, // withRetry counts from 0, so maxRetries = attempts - 1
      baseDelay: baseDelayMs,
      shouldRetry,
      onRetry,
    }
  );
}

module.exports = {
  withRetry,
  parseRetryAfterMs,
  sendMailWithRetry,
  isPermanentSmtpError,
};
