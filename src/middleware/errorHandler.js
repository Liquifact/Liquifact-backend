
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
  if (err.nestedErrorFormat && err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  let problem;

  if (err instanceof AppError) {
    problem = formatProblemDetails({
      type: err.type,
      title: err.title,
      status: err.status,
      detail: err.detail,
      instance: err.instance || req.originalUrl,
      stack: err.stack,
    });
  } else if (err.statusCode && typeof err.statusCode === 'number') {
    const status = err.statusCode;
    problem = formatProblemDetails({
      type: 'https://liquifact.com/probs/http-error',
      title: err.message || (status === 400 ? 'Bad Request' : `HTTP ${status}`),
      status,
      detail: err.message || 'Request could not be completed.',
      instance: req.originalUrl,
      stack: err.stack,
    });
  } else {
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

  res.header('Content-Type', 'application/problem+json');
  res.status(problem.status).json(problem);
}

/**
 * Dedicated 500 handler that never leaks internal messages (tests / legacy callers).
 * @param {Error} err
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 * @returns {void}
 */
function handleInternalError(err, req, res, next) {
  res.status(500).json({ error: 'Internal server error' });
}

errorHandler.handleInternalError = handleInternalError;

module.exports = errorHandler;
