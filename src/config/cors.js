const DEVELOPMENT_FALLBACK_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const CORS_REJECTION_MESSAGE = 'Origin not allowed by CORS';

/**
 * Parses a comma-separated origin allowlist into normalized exact-match origins.
 *
 * @param {string | undefined} value Raw environment variable value.
 * @returns {string[]} Normalized list of allowed origins.
 */
function parseAllowedOrigins(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Returns the built-in localhost allowlist used when development mode has no
 * explicit CORS configuration.
 *
 * @returns {string[]} Local development origins.
 */
function getDevelopmentFallbackOrigins() {
  return [...DEVELOPMENT_FALLBACK_ORIGINS];
}

/**
 * Resolves the effective origin allowlist for the current environment.
 *
 * @param {NodeJS.ProcessEnv} env Environment variables to evaluate.
 * @returns {string[]} Effective exact-match allowlist.
 */
function getAllowedOriginsFromEnv(env = process.env) {
  const configuredOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

  if (configuredOrigins.length > 0) {
    return configuredOrigins;
  }

  if (env.NODE_ENV === 'development') {
    return getDevelopmentFallbackOrigins();
  }

  return [];
}

/**
 * Creates the explicit error object used to reject a blocked browser origin.
 *
 * @returns {Error & { status: number }} CORS rejection error.
 */
function createCorsRejectionError() {
  const error = new Error(CORS_REJECTION_MESSAGE);
  error.status = 403;
  return error;
}

/**
 * Determines whether the supplied error is the dedicated CORS rejection error.
 *
 * @param {Error | undefined} error Error raised during request handling.
 * @returns {boolean} True when the error is a blocked-origin CORS error.
 */
function isCorsOriginRejectedError(error) {
  return Boolean(
    error &&
    error.status === 403 &&
    error.message === CORS_REJECTION_MESSAGE
  );
}

/**
 * Builds Express CORS options using an environment-driven exact-match allowlist.
 *
 * Requests without an Origin header remain allowed so non-browser clients and
 * same-origin traffic are not blocked by CORS policy.
 *
 * @param {NodeJS.ProcessEnv} env Environment variables to evaluate.
 * @returns {{ origin: (origin: string | undefined, callback: Function) => void }} CORS options.
 */
/**
 * Creates CORS options for the Express CORS middleware.
 * @param {Object} [env=process.env] - Environment variables.
 * @returns {{origin: function(string, function): void}} CORS options.
 */
/**
 * Creates CORS options for the application.
 * @param {Object} [env=process.env] - The environment variables.
 * @returns {{ origin: (origin: string | undefined, callback: Function) => void }} CORS options.
 */
function createCorsOptions(env = process.env) {
  const allowedOrigins = getAllowedOriginsFromEnv(env);
  const allowedOriginsSet = new Set(allowedOrigins);

  return {
    /**
     * CORS origin validation callback.
     * @param {string|undefined} origin - The request origin.
     * @param {Function} callback - Callback to signal CORS result.
     * @returns {void}
     */
    origin(origin, callback) {
      if (!origin || allowedOriginsSet.has(origin)) {
        return callback(null, true);
      }

      return callback(createCorsRejectionError());
    },
  };
}

module.exports = {
  CORS_REJECTION_MESSAGE,
  createCorsOptions,
  createCorsRejectionError,
  getAllowedOriginsFromEnv,
  getDevelopmentFallbackOrigins,
  isCorsOriginRejectedError,
  parseAllowedOrigins,
};
