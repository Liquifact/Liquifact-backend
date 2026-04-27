/**
 * @fileoverview CORS allowlist parsing and policy for the LiquiFact API.
 *
 * Reads trusted origins from the `CORS_ORIGINS` environment variable
 * (comma-separated list of exact origins) and builds an `options` object
 * compatible with the `cors` npm package.
 *
 * Behaviour summary:
 * - Requests with **no Origin header** (curl, Postman, server-to-server) are
 * always allowed — the `origin` callback receives `undefined` and passes.
 * - Requests from an **allowed origin** receive normal CORS response headers.
 * - Requests from a **disallowed origin** receive a 403 Forbidden response
 * via a dedicated `Error` whose `.isCorsOriginRejected` flag is `true`.
 * - In `NODE_ENV=development`, when `CORS_ORIGINS` is not set, a set
 * of common local development origins is permitted automatically.
 * - In all other environments, when `CORS_ORIGINS` is not set, every
 * browser origin is denied.
 *
 * @module config/cors
 */

'use strict';

/**
 * Fixed rejection message used for all blocked-origin CORS errors.
 *
 * @constant {string}
 */
const CORS_REJECTION_MESSAGE = 'CORS policy: origin is not allowed.';

/** @type {string[]} Origins allowed when no env var is set during development. */
const DEV_DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

/**
 * Returns the hard-coded development fallback origin list.
 *
 * @returns {string[]} Array of development-safe origins.
 */
function getDevelopmentFallbackOrigins() {
  return DEV_DEFAULT_ORIGINS;
}

/**
 * Parses `CORS_ORIGINS` into a trimmed, de-duplicated array of origin
 * strings. Returns `[]` when the value is absent or blank.
 *
 * @param {string|undefined} raw - Raw value of the environment variable.
 * @returns {string[]} Array of allowed origins (empty when unset).
 */
function parseAllowedOrigins(raw) {
  if (!raw || raw.trim() === '') {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Resolves the allowlist from an environment map.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @returns {string[]} Origins to allow for browser requests with an Origin header.
 */
function getAllowedOriginsFromEnv(env = process.env) {
  // Accept both CORS_ALLOWED_ORIGINS and CORS_ORIGINS for compatibility.
  const fromEnv = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS || env.CORS_ORIGINS);
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  if (env.NODE_ENV === 'development') {
    return getDevelopmentFallbackOrigins();
  }
  return [];
}

/**
 * Resolves the effective origin allowlist from the given environment object.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @returns {string[]} Allowlist to enforce.
 */
function resolveAllowlist(env = process.env) {
  return getAllowedOriginsFromEnv(env);
}

/**
 * Sentinel error thrown when an incoming `Origin` is not on the allowlist.
 * The `isCorsOriginRejected` flag lets downstream error handlers identify it
 * without `instanceof` checks across module boundaries.
 *
 * @param {string} [_origin] - The rejected origin value (unused; message is fixed).
 * @returns {Error} Annotated error instance.
 */
function createCorsRejectionError(_origin) {
  const err = new Error(CORS_REJECTION_MESSAGE);
  err.isCorsOriginRejected = true;
  err.isCorsOriginRejectedError = true;
  err.status = 403;
  return err;
}

/**
 * Returns `true` if `err` is the dedicated blocked-origin CORS error produced
 * by {@link createCorsRejectionError}.
 *
 * @param {unknown} err - Value to test.
 * @returns {boolean}
 */
function isCorsOriginRejectedError(err) {
  return err !== null && err !== undefined && err.isCorsOriginRejected === true;
}

/**
 * Builds the options object for the `cors` middleware package.
 *
 * The `origin` callback implements exact-match checking against the resolved
 * allowlist. It calls `callback(null, true)` to approve an origin, and
 * `callback(err)` with the rejection error to deny it.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map (for testing).
 * @returns {import('cors').CorsOptions} Options ready to pass to `cors()`.
 *
 * @example
 * const cors = require('cors');
 * const { createCorsOptions } = require('./config/cors');
 * app.use(cors(createCorsOptions()));
 */
function createCorsOptions(env = process.env) {
  const allowlist = getAllowedOriginsFromEnv(env);

  return {
    /**
     * Validates request origin against the allowlist.
     *
     * @param {string|undefined} origin - The request origin header value.
     * @param {Function} callback - CORS callback (err, allow).
     * @returns {void}
     */
    origin(origin, callback) {
      if (origin === undefined) {
        return callback(null, true);
      }

      if (allowlist.length === 0) {
        return callback(createCorsRejectionError(origin));
      }

      if (allowlist.includes(origin)) {
        return callback(null, true);
      }

      return callback(createCorsRejectionError(origin));
    },

    optionsSuccessStatus: 204,
  };
}

module.exports = {
  CORS_REJECTION_MESSAGE,
  DEV_DEFAULT_ORIGINS,
  createCorsOptions,
  createCorsRejectionError,
  getAllowedOriginsFromEnv,
  getDevelopmentFallbackOrigins,
  isCorsOriginRejectedError,
  parseAllowedOrigins,
  resolveAllowlist,
};
