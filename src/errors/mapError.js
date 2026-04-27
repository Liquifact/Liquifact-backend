const AppError = require('./AppError');

/**
 * Default error code label from HTTP status when AppError has no explicit code.
 *
 * @param {number} status - HTTP status.
 * @returns {string}
 */
function httpStatusToCode(status) {
  if (status === 400) {
    return 'BAD_REQUEST';
  }
  if (status === 401) {
    return 'UNAUTHORIZED';
  }
  if (status === 403) {
    return 'FORBIDDEN';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  return `HTTP_${status}`;
}

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
      code: error.code || httpStatusToCode(error.status),
      message: error.detail || error.message,
      retryable: error.retryable ?? false,
      retryHint: error.retryHint ?? '',
    };
  }

  if (error && typeof error === 'object' && error.isCorsOriginRejected === true) {
    return {
      status: 403,
      code: 'FORBIDDEN',
      message: error.message || 'CORS policy: origin is not allowed.',
      retryable: false,
      retryHint: '',
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
    status: error.status || 500,
    code: error.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
    message: error.message || 'An internal server error occurred.',
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
