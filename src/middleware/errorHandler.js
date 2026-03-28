const AppError = require('../errors/AppError');
const formatProblemDetails = require('../utils/problemDetails');

/**
 * Global error handling middleware
 * Ensures consistent error responses and prevents stack leaks in production.
 * @param {Error} err - Error object.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} _next - Express next middleware function.
 * @returns {void}
 */
function errorHandler(err, req, res, _next) {
  let problem;

  // Check if it's a known AppError instance
  if (err instanceof AppError) {
    problem = formatProblemDetails({
      type: err.type,
      title: err.title,
      status: err.status,
      detail: err.detail,
      instance: err.instance || req.originalUrl,
      stack: err.stack,
    });
  } else {
    // If it's an unknown error, provide a fallback 500 status
    console.error('Unhandled Error:', err);
    problem = formatProblemDetails({
      type: 'https://example.com/probs/unexpected-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred while processing your request.',
      instance: req.originalUrl,
      stack: err.stack,
    });
  }

  // RFC 7807 requires the Content-Type to be 'application/problem+json'
  res.header('Content-Type', 'application/problem+json');
  res.status(problem.status).json(problem);
}

module.exports = errorHandler;
