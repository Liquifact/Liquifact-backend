/**
 * Custom Error class for RFC 7807 compliant errors.
 * Extends the built-in Error class to include Problem Details fields.
 */
class AppError extends Error {
  /**
   * Initializes a new instance of AppError.
   * @param {Object} params
   * @param {string} params.type - A URI reference [RFC3986] that identifies the problem type.
   * @param {string} params.title - A short, human-readable summary of the problem type.
   * @param {number} params.status - The HTTP status code (e.g., 400, 404, 500).
   * @param {string} params.detail - A human-readable explanation specific to this occurrence of the problem.
   * @param {string} [params.instance] - A URI reference that identifies the specific occurrence of the problem.
   */
  constructor({ type, title, status, detail, instance }) {
    super(title);
    this.name = this.constructor.name;
    this.type = type || 'about:blank';
    this.title = title;
    this.status = status || 500;
    this.detail = detail;
    this.instance = instance;

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
