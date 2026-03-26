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
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler };
