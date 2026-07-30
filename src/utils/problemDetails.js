/**
 * @fileoverview Canonical RFC 7807 Problem Details builder.
 *
 * This module is the **single canonical builder** for RFC 7807 problem+json
 * objects across the entire application. Every error response flows through
 * `formatProblemDetails` to guarantee a consistent wire format for type,
 * title, status, detail, instance, and extension fields.
 *
 * Consumers (AppError, problemJson middleware, etc.) MUST call
 * `formatProblemDetails` rather than assembling problem objects inline.
 *
 * @see https://tools.ietf.org/html/rfc7807
 * @module utils/problemDetails
 */

"use strict";

const DEFAULT_PROBLEM_TYPE = "about:blank";
const LIQUifact_PROBLEM_BASE = "https://liquifact.com/probs";

/**
 * Maps HTTP status codes to standard problem type URIs.
 *
 * @param {number} status - HTTP status code.
 * @returns {string} Problem type URI.
 */
function getProblemType(status) {
  const problemTypes = {
    400: `${LIQUifact_PROBLEM_BASE}/bad-request`,
    401: `${LIQUifact_PROBLEM_BASE}/unauthorized`,
    403: `${LIQUifact_PROBLEM_BASE}/forbidden`,
    404: `${LIQUifact_PROBLEM_BASE}/not-found`,
    409: `${LIQUifact_PROBLEM_BASE}/conflict`,
    422: `${LIQUifact_PROBLEM_BASE}/unprocessable-entity`,
    429: `${LIQUifact_PROBLEM_BASE}/too-many-requests`,
    500: `${LIQUifact_PROBLEM_BASE}/internal-server-error`,
    502: `${LIQUifact_PROBLEM_BASE}/bad-gateway`,
    503: `${LIQUifact_PROBLEM_BASE}/service-unavailable`,
    504: `${LIQUifact_PROBLEM_BASE}/gateway-timeout`,
  };

  return problemTypes[status] || DEFAULT_PROBLEM_TYPE;
}

/**
 * Maps HTTP status codes to standard problem titles.
 *
 * @description Resolves standard human-readable summary of the problem type.
 * @param {number} status - HTTP status code.
 * @returns {string} Standard title.
 */
function getStandardTitle(status) {
  const titles = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return titles[status] || "An unexpected error occurred";
}

/**
 * RFC 7807 (Problem Details for HTTP APIs) Formatter.
 * Takes error data and formats it into a standard JSON object.
 *
 * @description Constructs a standardized RFC 7807 problem response.
 * @param {object} params - Problem details input.
 * @param {string} [params.type] - A URI reference that identifies the problem type.
 * @param {string} [params.title] - Short, human-readable summary.
 * @param {number} [params.status=500] - HTTP status code.
 * @param {string} [params.detail] - Human-readable explanation specific to this occurrence.
 * @param {string} [params.instance] - A URI reference that identifies the specific occurrence.
 * @param {string} [params.stack] - Optional stack trace (only included when not production).
 * @param {boolean} [params.isProduction=process.env.NODE_ENV === 'production'] - Whether to omit stack traces.
 * @param {string} [params.code] - Optional application-specific error code.
 * @param {boolean} [params.retryable] - Optional flag indicating if the action is retryable.
 * @param {string} [params.retryHint] - Optional advice on how/when to retry.
 * @returns {object} RFC7807 problem details object.
 */
function formatProblemDetails(params) {
  const {
    type = "about:blank",
    title = "An unexpected error occurred",
    status = 500,
    detail,
    instance,
    stack,
    isProduction = process.env.NODE_ENV === "production",
    code,
    retryable,
    retryHint,
  } = params;

  const problem = {
    type,
    title,
    status,
  };

  if (detail !== undefined) {
    problem.detail = detail;
  }

  if (instance !== undefined) {
    problem.instance = instance;
  }

  // Only include stack trace if NOT in production for security reasons
  if (!isProduction && stack) {
    problem.stack = stack;
  }

  // Extensions
  if (code !== undefined) {
    problem.code = code;
  }
  if (retryable !== undefined) {
    problem.retryable = retryable;
  }
  if (retryHint !== undefined) {
    problem.retry_hint = retryHint;
  }

  return problem;
}

module.exports = formatProblemDetails;
module.exports.getProblemType = getProblemType;
module.exports.getStandardTitle = getStandardTitle;
module.exports.DEFAULT_PROBLEM_TYPE = DEFAULT_PROBLEM_TYPE;
module.exports.LIQUifact_PROBLEM_BASE = LIQUifact_PROBLEM_BASE;
