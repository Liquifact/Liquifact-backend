const formatProblemDetails = require("../utils/problemDetails");

/**
 * Custom Error class for RFC 7807 compliant errors.
 * Extends the built-in Error class to include Problem Details fields.
 */
class AppError extends Error {
  /**
   * Creates a new AppError instance.
   *
   * @param {Object} params
   * @param {string} params.type - A URI reference [RFC3986] that identifies the problem type.
   * @param {string} params.title - A short, human-readable summary of the problem type.
   * @param {number} params.status - The HTTP status code (e.g., 400, 404, 500).
   * @param {string} params.detail - A human-readable explanation specific to this occurrence of the problem.
   * @param {string} [params.instance] - A URI reference that identifies the specific occurrence of the problem.
   * @param params.code
   * @param params.retryable
   * @param params.retryHint
   * @returns {AppError}
   */
  constructor(params) {
    const { title, context } = params || {};
    super(title);
    this.name = this.constructor.name;

    // Delegate to canonical builder for ALL field assembly/defaulting
    const problem = formatProblemDetails({
      ...params,
      stack: undefined,
    });

    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.code = problem.code;
    this.retryable = problem.retryable;
    this.retryHint = problem.retry_hint;
    this.fieldErrors = params && Object.prototype.hasOwnProperty.call(params, 'fieldErrors') ? params.fieldErrors : undefined;
    this.context = context || null;

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
