/**
 * Global error handler middleware.
 *
 * @param {Error} err - Error object.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} _next - Express next callback.
 * @returns {void}
 */
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';
  const message = isProduction && statusCode === 500
    ? 'Internal server error'
    : err.message || 'Internal server error';

  res.status(statusCode).json({
    error: {
      message,
      ...(isProduction ? {} : { stack: err.stack }),
    },
  });
}

module.exports = errorHandler;
