/**
 * Global error handling middleware
 * Ensures consistent error responses and prevents stack leaks in production.
 * @param {Error} err - Error object.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} _next - Express next middleware function.
 * @returns {void}
 */

const errorHandler = (err, req, res, _next) => {
  console.error(err);

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';

  // If error is an auth error, force 401
  if (
    message === 'Authentication token is required' ||
    message === 'Invalid Authorization header format. Expected "Bearer <token>"' ||
    message === 'Invalid token' ||
    message === 'Token has expired'
  ) {
    statusCode = 401;
  }

  // Hide internal error details in production
  if (process.env.NODE_ENV === 'production' && statusCode === 500) {
    message = 'Internal server error';
  }

  // For 4xx errors, return { error: message } (string)
  if (statusCode >= 400 && statusCode < 500) {
    return res.status(statusCode).json({ error: message });
  }

  // For 5xx errors, return { error: { message } }
  res.status(statusCode).json({ error: { message } });
};

module.exports = errorHandler;
