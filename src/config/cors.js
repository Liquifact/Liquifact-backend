const { isCorsOriginRejectedError } = require('./cors');

/**
 * Creates and returns the CORS configuration options for the application.
 *
 * @returns {import('cors').CorsOptions} The CORS options object.
 */
function createCorsOptions() {
  return {
    /**
     * Origin validation function.
     *
     * @param {string|undefined} origin - The request origin.
     * @param {Function} callback - The CORS callback.
     */
    origin: (origin, callback) => {
      // Logic for origin validation
      callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}

/**
 * Handles CORS errors and returns a 403 Forbidden response for rejected origins.
 *
 * @param {Error} err - The error object.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
const handleCorsError = (err, req, res, next) => {
  if (isCorsOriginRejectedError(err)) {
    res.status(403).json({ error: err.message });
    return;
  }
  next(err);
};

module.exports = {
  createCorsOptions,
  handleCorsError,
  isCorsOriginRejectedError,
};
