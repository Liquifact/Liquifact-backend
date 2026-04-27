/**
 * @fileoverview RFC 7807 Problem Details middleware for Express.
 * 
 * Implements standardized problem+json error responses with type, title, status,
 * and optional instance fields. Provides secure error handling with request
 * correlation and proper content-type negotiation.
 * 
 * @see https://tools.ietf.org/html/rfc7807
 * @module middleware/problemJson
 */

'use strict';

const AppError = require('../errors/AppError');
const { mapError } = require('../errors/mapError');
const logger = require('../logger');

/**
 * Default problem type URI for unclassified errors.
 */
const DEFAULT_PROBLEM_TYPE = 'about:blank';

/**
 * Base URI for LiquiFact problem types.
 */
const LIQUifact_PROBLEM_BASE = 'https://liquifact.com/probs';

/**
 * Maps HTTP status codes to standard problem type URIs.
 * 
 * @param {number} status - HTTP status code
 * @returns {string} Problem type URI
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
 * Creates a RFC 7807 compliant problem details object.
 * 
 * @param {Object} options - Problem details options
 * @param {string} options.type - Problem type URI
 * @param {string} options.title - Short, human-readable summary
 * @param {number} options.status - HTTP status code
 * @param {string} options.detail - Human-readable explanation
 * @param {string} [options.instance] - URI identifying specific occurrence
 * @param {string} [options.requestId] - Request correlation ID
 * @returns {Object} RFC 7807 problem details object
 */
function createProblemDetails({ type, title, status, detail, instance, requestId }) {
  const problem = {
    type: type || getProblemType(status),
    title: title || 'An error occurred',
    status: status || 500,
  };

  if (detail) {
    problem.detail = detail;
  }

  if (instance) {
    problem.instance = instance;
  }

  // Add request ID as instance if not provided
  if (!instance && requestId) {
    problem.instance = `urn:uuid:${requestId}`;
  }

  return problem;
}

/**
 * Express middleware that handles errors and returns RFC 7807 problem+json responses.
 * 
 * Features:
 * - Proper Content-Type: application/problem+json
 * - Request correlation via instance field or X-Request-ID header
 * - Secure error handling (no stack traces in production)
 * - Support for AppError instances and generic errors
 * - Comprehensive logging with correlation context
 * 
 * @param {Error|unknown} error - The error that occurred
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} _next - Express next function (unused)
 * @returns {void}
 */
function problemJsonHandler(error, req, res, _next) {
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  
  // Log the error with full context
  logError(error, requestId, req);

  // Map the error to a standardized format
  const mappedError = mapError(error);
  
  // Create RFC 7807 problem details
  const problemDetails = createProblemDetails({
    type: error instanceof AppError ? error.type : getProblemType(mappedError.status),
    title: error instanceof AppError ? error.title : mappedError.message,
    status: mappedError.status,
    detail: mappedError.message,
    instance: error instanceof AppError ? error.instance : req.originalUrl,
    requestId,
  });

  // Add custom fields if present in AppError
  if (error instanceof AppError) {
    if (error.code !== undefined) {
      problemDetails.code = error.code;
    }
    if (error.retryable !== undefined) {
      problemDetails.retryable = error.retryable;
    }
    if (error.retryHint) {
      problemDetails.retry_hint = error.retryHint;
    }
  }

  // Set content type for problem+json
  res.setHeader('Content-Type', 'application/problem+json');
  
  // Send problem details response
  res.status(mappedError.status).json(problemDetails);
}

/**
 * Logs errors with correlation context without exposing sensitive information.
 * 
 * @param {Error|unknown} error - The error to log
 * @param {string} requestId - Request correlation ID
 * @param {import('express').Request} req - Express request object
 * @returns {void}
 */
function logError(error, requestId, req) {
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  const logContext = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress,
  };

  // Include error details in development
  if (isDevelopment) {
    logContext.err = error;
    if (error instanceof Error && error.stack) {
      logContext.stack = error.stack;
    }
  } else {
    // In production, only include safe error information
    logContext.errorName = error instanceof Error ? error.name : 'Unknown';
    logContext.errorMessage = error instanceof Error ? error.message : 'Non-error thrown';
    logContext.errorCode = error instanceof AppError ? error.code : undefined;
  }

  const message = error instanceof Error ? error.message : 'Non-error value thrown';
  
  if (error instanceof AppError && error.status < 500) {
    // Client errors (4xx) - log as warning
    logger.warn(logContext, `Client error: ${message}`);
  } else {
    // Server errors (5xx) - log as error
    logger.error(logContext, `Server error: ${message}`);
  }
}

/**
 * Express 404 handler that creates a proper problem details response.
 * 
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} _res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {void}
 */
function notFoundHandler(req, _res, next) {
  next(
    new AppError({
      type: getProblemType(404),
      title: 'Not Found',
      status: 404,
      detail: `The requested resource ${req.method} ${req.originalUrl} was not found.`,
      instance: req.originalUrl,
    })
  );
}

/**
 * Middleware factory that creates a problem+json error handler with custom options.
 * 
 * @param {Object} [options={}] - Configuration options
 * @param {string} [options.problemBase] - Base URI for problem types
 * @param {boolean} [options.includeStackInDev=true] - Include stack traces in development
 * @returns {Function} Express error handler middleware
 */
function createProblemJsonHandler(options = {}) {
  const {
    problemBase = LIQUifact_PROBLEM_BASE,
    includeStackInDev = true,
  } = options;

  return (error, req, res, next) => {
    // Custom configuration can be handled here
    problemJsonHandler(error, req, res, next);
  };
}

module.exports = {
  problemJsonHandler,
  createProblemJsonHandler,
  notFoundHandler,
  createProblemDetails,
  getProblemType,
  DEFAULT_PROBLEM_TYPE,
  LIQUifact_PROBLEM_BASE,
};
