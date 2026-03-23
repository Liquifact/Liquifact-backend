const { AppError } = require('./AppError');

/**
 * Map framework and application errors into a stable HTTP error contract.
 *
 * @param {unknown} error Thrown error value.
 * @returns {{status: number, code: string, message: string, retryable: boolean, retryHint: string}}
 */
function mapError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.expose ? error.message : 'An internal server error occurred.',
      retryable: error.retryable,
      retryHint: error.retryHint,
    };
  }

  if (isBodyParserSyntaxError(error)) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Malformed JSON request body.',
      retryable: false,
      retryHint: 'Fix the JSON payload and try again.',
    };
  }

  if (error && typeof error === 'object' && error.code === 'ECONNREFUSED') {
    return {
      status: 503,
      code: 'UPSTREAM_ERROR',
      message: 'A dependent service is temporarily unavailable.',
      retryable: true,
      retryHint: 'Retry the request in a few moments.',
    };
  }

  return {
    status: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An internal server error occurred.',
    retryable: false,
    retryHint: 'Do not retry until the issue is resolved or support is contacted.',
  };
}

/**
 * Detect Express JSON parser syntax errors.
 *
 * @param {unknown} error Thrown error value.
 * @returns {boolean}
 */
function isBodyParserSyntaxError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      error.type === 'entity.parse.failed' &&
      error.status === 400,
  );
}

module.exports = {
  mapError,
  isBodyParserSyntaxError,
};
