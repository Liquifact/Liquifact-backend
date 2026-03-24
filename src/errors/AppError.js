const { randomUUID } = require('crypto');

/**
 * Application error with stable API-facing metadata.
 */
class AppError extends Error {
  /**
   * @param {object} options Error options.
   * @param {string} options.code Stable machine-readable error code.
   * @param {string} options.message Safe user-facing message.
   * @param {number} options.status HTTP status code.
   * @param {boolean} options.retryable Whether the caller may safely retry.
   * @param {string} options.retryHint Safe retry guidance.
   * @param {boolean} [options.expose=true] Whether the message is safe to expose.
   */
  constructor({ code, message, status, retryable, retryHint, expose = true }) {
    super(message || 'Request failed');
    this.name = 'AppError';
    this.code = code || 'INTERNAL_SERVER_ERROR';
    this.status = status || 500;
    this.retryable = Boolean(retryable);
    this.retryHint = retryHint || 'Do not retry until the issue is resolved.';
    this.expose = expose;
    this.id = randomUUID();
  }
}

module.exports = {
  AppError,
};
