const CORS_REJECTION_MESSAGE = 'Not allowed by CORS';
const CORS_REJECTION_SYMBOL = Symbol('CorsOriginRejected');

/**
 * Creates a CORS rejection error with a 403 status.
 *
 * @returns {Error} A CORS rejection error.
 */
function createCorsRejectionError() {
  const err = new Error(CORS_REJECTION_MESSAGE);
  err.status = 403;
  err[CORS_REJECTION_SYMBOL] = true;
  return err;
}

/**
 * Checks if an error is a CORS origin rejection error.
 *
 * @param {Error} err - The error to check.
 * @returns {boolean} True if the error is a CORS rejection error.
 */
function isCorsOriginRejectedError(err) {
  return err != null && err[CORS_REJECTION_SYMBOL] === true;
}

/**
 * Parses a comma-separated string of allowed origins.
 *
 * @param {string|undefined} value - The raw env string.
 * @returns {string[]} Array of trimmed, non-empty origin strings.
 */
function parseAllowedOrigins(value) {
  if (!value) { return []; }
  return value.split(',').map((o) => o.trim()).filter(Boolean);
}

/**
 * Returns the development fallback origins.
 *
 * @returns {string[]} Localhost origins for development.
 */
function getDevelopmentFallbackOrigins() {
  return ['http://localhost:3000', 'http://localhost:5173'];
}

/**
 * Returns allowed origins from environment variables.
 *
 * @param {object} env - Environment variables object.
 * @returns {string[]} Array of allowed origins.
 */
function getAllowedOriginsFromEnv(env) {
  if (env.CORS_ALLOWED_ORIGINS) {
    return parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  }
  if (env.NODE_ENV === 'development') {
    return getDevelopmentFallbackOrigins();
  }
  return [];
}

/**
 * Creates and returns the CORS configuration options for the application.
 *
 * @param {object} env - Environment variables object.
 * @returns {import('cors').CorsOptions} The CORS options object.
 */
function createCorsOptions(env) {
  const allowedOrigins = getAllowedOriginsFromEnv(env || process.env);
  return {
    origin: (origin, callback) => {
      if (!origin) { return callback(null, true); }
      if (allowedOrigins.includes(origin)) { return callback(null, true); }
      return callback(createCorsRejectionError());
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
function handleCorsError(err, req, res, next) {
  if (isCorsOriginRejectedError(err)) {
    res.status(403).json({ error: err.message });
    return;
  }
  next(err);
}

module.exports = {
  CORS_REJECTION_MESSAGE,
  createCorsOptions,
  createCorsRejectionError,
  getAllowedOriginsFromEnv,
  getDevelopmentFallbackOrigins,
  handleCorsError,
  isCorsOriginRejectedError,
  parseAllowedOrigins,
};
