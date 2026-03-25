const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Logger utility that automatically includes the request correlation ID if available.
 * Uses AsyncLocalStorage to track request context without passing it through every function.
 */
const logger = {
  /**
   * Logs an info message.
   * @param {string} message The message to log.
   * @param {Object} [meta={}] Optional metadata.
   */
  info(message, meta = {}) {
    const requestId = storage.getStore();
    console.log(JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      requestId,
      message,
      ...meta,
    }));
  },

  /**
   * Logs an error message.
   * @param {string} message The message to log.
   * @param {Error|Object} [error={}] The error object or metadata.
   */
  error(message, error = {}) {
    const requestId = storage.getStore();
    const errorData = error instanceof Error 
      ? { error: error.message, stack: error.stack }
      : { ...error };

    console.error(JSON.stringify({
      level: 'error',
      timestamp: new Date().toISOString(),
      requestId,
      message,
      ...errorData,
    }));
  },

  /**
   * Logs a warning message.
   * @param {string} message The message to log.
   * @param {Object} [meta={}] Optional metadata.
   */
  warn(message, meta = {}) {
    const requestId = storage.getStore();
    console.warn(JSON.stringify({
      level: 'warn',
      timestamp: new Date().toISOString(),
      requestId,
      message,
      ...meta,
    }));
  },

  /**
   * The AsyncLocalStorage instance used for request context.
   */
  storage,
};

module.exports = logger;
