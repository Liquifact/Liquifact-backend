const AppError = require("./AppError");

/**
 * Default error code label from HTTP status when AppError has no explicit code.
 *
 * @param {number} status - HTTP status.
 * @returns {string}
 */
function httpStatusToCode(status) {
  if (status === 400) {
    return "BAD_REQUEST";
  }
  if (status === 401) {
    return "UNAUTHORIZED";
  }
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status === 409) {
    return "CONFLICT";
  }
  if (status === 422) {
    return "UNPROCESSABLE_ENTITY";
  }
  if (status === 429) {
    return "TOO_MANY_REQUESTS";
  }
  if (status === 500) {
    return "INTERNAL_SERVER_ERROR";
  }
  if (status === 503) {
    return "SERVICE_UNAVAILABLE";
  }
  if (status === 404) {
    return "NOT_FOUND";
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
  if (error && (error instanceof AppError || error.name === "AppError")) {
    return {
      status: error.status,
      code: error.code || httpStatusToCode(error.status),
      message: error.detail || error.message,
      retryable: error.retryable ?? false,
      retryHint: error.retryHint ?? "",
    };
  }

  if (
    error &&
    typeof error === "object" &&
    error.isCorsOriginRejected === true
  ) {
    return {
      status: 403,
      code: "FORBIDDEN",
      message: error.message || "CORS policy: origin is not allowed.",
      retryable: false,
      retryHint: "",
    };
  }

  if (isBodyParserSyntaxError(error)) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Malformed JSON request body.",
      retryable: false,
      retryHint: "Fix the JSON payload and try again.",
    };
  }

  if (error && typeof error === "object" && error.code === "ECONNREFUSED") {
    return {
      status: 503,
      code: "UPSTREAM_ERROR",
      message: "A dependent service is temporarily unavailable.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }

  if (error && typeof error === "object" && error.code === "CIRCUIT_OPEN") {
    return {
      status: 503,
      code: "CIRCUIT_OPEN",
      message: "Service temporarily unavailable due to upstream outage. Circuit breaker is OPEN.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }
  const status = (error && error.status) || 500;
  const retryableStatuses = [429, 503];
  const retryable = retryableStatuses.includes(status);
  let retryHint = "Do not retry until the issue is resolved or support is contacted.";
  if (status === 429) {
    retryHint = "Wait for the rate limit window to reset before retrying.";
  } else if (status === 503) {
    retryHint = "Retry the request in a few moments.";
  }
  return {
    status,
    code: httpStatusToCode(status),
    message:
      status === 500
        ? "An internal server error occurred."
        : (error && error.message) || "An internal server error occurred.",
    retryable,
    retryHint,
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
    typeof error === "object" &&
    error.type === "entity.parse.failed" &&
    error.status === 400,
  );
}

module.exports = {
  mapError,
  isBodyParserSyntaxError,
};
