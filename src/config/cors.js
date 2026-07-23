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

/** Machine-readable code returned for blocked-origin responses. */
const CORS_REJECTION_CODE = 'CORS_ORIGIN_REJECTED';

/** @type {string[]} Origins allowed when no env var is set during development. */
const DEV_DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

/**
 * Default preflight max-age in seconds (10 minutes). Used when
 * `CORS_MAX_AGE` is unset or contains an invalid value.
 *
 * @type {number}
 */
const DEFAULT_MAX_AGE = 600;

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
 * Normalizes a browser origin string for allowlist comparison.
 *
 * Rules applied:
 * 1. Lowercases the scheme and host (RFC 6454 §6.1 — origins are
 *    case-insensitive in scheme/host).
 * 2. Strips a single trailing slash so that `https://app.example.com/`
 *    and `https://app.example.com` compare equal.
 *
 * Returns `null` for the literal string `"null"` (sandboxed-iframe origin)
 * and for any value that is not a non-empty string.
 *
 * @param {unknown} origin - Raw origin value from the request header.
 * @returns {string|null} Normalized origin, or `null` when it cannot be
 *   mapped to a valid origin string.
 */
function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') { return null; }
  // The literal string "null" comes from sandboxed iframes / data-URI
  // navigations and must never be treated as an allowed origin.
  if (origin === 'null') { return null; }

  try {
    const url = new URL(origin);
    // Reconstruct origin from parsed URL to normalise scheme+host case and
    // strip the trailing slash that URL.prototype.origin never includes.
    return url.origin; // already lower-cased by the URL parser
  } catch {
    // Not a parseable URL — treat as unrecognised and deny.
    return null;
  }
}

/**
 * Returns `true` when `origin` is in the `allowlist` after both sides are
 * normalized via {@link normalizeOrigin}.
 *
 * The literal string `"null"` and any un-parseable origin always return
 * `false`.
 *
 * @param {string} origin - Incoming request origin.
 * @param {string[]} allowlist - Array of trusted origins.
 * @returns {boolean}
 */
function isAllowedOrigin(origin, allowlist) {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) { return false; }
  return allowlist.some((entry) => normalizeOrigin(entry) === normalized);
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
  err.code = CORS_REJECTION_CODE;
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
 * Parses the `CORS_MAX_AGE` environment variable and returns a validated
 * positive integer suitable for the `maxAge` option of the `cors` package.
 *
 * Defaults to {@link DEFAULT_MAX_AGE} (600 seconds / 10 minutes) when the
 * value is unset, empty, or not a valid positive integer.
 *
 * @param {string|undefined} raw - Raw value from the environment.
 * @returns {number} Validated preflight max-age in seconds.
 */
function parseMaxAge(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return DEFAULT_MAX_AGE;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_MAX_AGE;
}

/**
 * Current preflight `Access-Control-Max-Age` in seconds, read from
 * `process.env.CORS_MAX_AGE` at module load time.
 *
 * @type {number}
 */
let maxAge = parseMaxAge(process.env.CORS_MAX_AGE);

/**
 * Returns the current preflight `Access-Control-Max-Age` value in seconds.
 *
 * @returns {number} Max-age in seconds.
 */
function getMaxAge() {
  return maxAge;
}

/**
 * Mutable origin allowlist shared by the module-level CORS options object.
 * Initialised from environment variables at module load, and updated by
 * {@link reloadCorsOrigins} without restarting the server.
 *
 * @type {string[]}
 */
let allowedOrigins = getAllowedOriginsFromEnv();

/**
 * Reloads the origin allowlist from environment variables without restarting
 * the server.
 *
 * Re-reads `CORS_ORIGINS` (and `CORS_ALLOWED_ORIGINS` for backward
 * compatibility), re-parses the comma-separated list, and replaces the
 * internal allowlist used by the active CORS options object. In development
 * mode, falls back to the standard localhost origins when no env var is set.
 *
 * This function is safe to call multiple times (e.g. from an admin endpoint
 * or a config file watcher). New requests immediately use the updated
 * allowlist; in-flight requests already past the CORS middleware are not
 * affected.
 */
function reloadCorsOrigins() {
  allowedOrigins = getAllowedOriginsFromEnv();
}

/**
 * Builds the options object for the `cors` middleware package.
 *
 * The `origin` callback implements **exact-match** checking against the
 * resolved allowlist. It calls `callback(null, true)` to approve an origin,
 * and `callback(err)` with the rejection error to deny it.
 *
 * Requests without an `Origin` header are always passed through
 * (`callback(null, true)`).
 *
 * When `CORS_ORIGINS` (or `CORS_ALLOWED_ORIGINS`) is not set:
 * - In `development` mode, a hard-coded set of localhost origins is allowed.
 * - In all other environments, every browser origin is denied.
 *
 * When called with the default `process.env` (or no argument), the returned
 * options object reads from a module-level mutable allowlist so that a
 * subsequent call to {@link reloadCorsOrigins} takes effect without creating
 * a new middleware instance.
 *
 * When called with a custom environment map (e.g. in tests), the returned
 * options object uses an isolated allowlist derived from that map.
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
  // When called with the real process.env (or no argument), the origin
  // function closes over the module-level mutable allowlist so that
  // reloadCorsOrigins() is reflected immediately. The allowlist is
  // re-synced from the current environment so that callers who mutate
  // process.env before calling createCorsOptions() get the expected
  // result (this is relied on by some tests).
  //
  // When called with a test-specific env object, a standalone allowlist
  // with its own closed-over allowlist is used for isolation.
  if (env === process.env) {
    allowedOrigins = getAllowedOriginsFromEnv();

    return {
      /**
       * Validates request origin against the mutable module-level allowlist.
       *
       * - `undefined` (no Origin header): always passed — non-browser clients.
       * - `"null"` (sandboxed iframe): always rejected.
       * - Otherwise: normalized comparison against the allowlist.
       *   Only an explicitly listed origin receives `Allow-Origin`; arbitrary
       *   origins are never reflected together with credentials.
       *
       * @param {string|undefined} origin - The request origin header value.
       * @param {Function} callback - CORS callback (err, allow).
       * @returns {void}
       */
      origin(origin, callback) {
        if (origin === undefined) {
          return callback(null, true);
        }

        if (allowedOrigins.length === 0 || !isAllowedOrigin(origin, allowedOrigins)) {
          return callback(createCorsRejectionError(origin));
        }

        return callback(null, true);
      },

      maxAge,
      optionsSuccessStatus: 204,
    };
  }

  // Test / custom env path: create a standalone options object with its own
  // isolated allowlist so tests remain independent.
  const testAllowlist = getAllowedOriginsFromEnv(env);

  return {
    /**
     * Validates request origin against the test-specific allowlist.
     *
     * - `undefined` (no Origin header): always passed — non-browser clients.
     * - `"null"` (sandboxed iframe): always rejected.
     * - Otherwise: normalized comparison against the allowlist.
     *   Only an explicitly listed origin receives `Allow-Origin`; arbitrary
     *   origins are never reflected together with credentials.
     *
     * @param {string|undefined} origin - The request origin header value.
     * @param {Function} callback - CORS callback (err, allow).
     * @returns {void}
     */
    origin(origin, callback) {
      if (origin === undefined) {
        return callback(null, true);
      }

      if (testAllowlist.length === 0 || !isAllowedOrigin(origin, testAllowlist)) {
        return callback(createCorsRejectionError(origin));
      }

      return callback(null, true);
    },

    maxAge,
    optionsSuccessStatus: 204,
  };
}

module.exports = {
  CORS_REJECTION_CODE,
  CORS_REJECTION_MESSAGE,
  DEV_DEFAULT_ORIGINS,
  createCorsOptions,
  createCorsRejectionError,
  getAllowedOriginsFromEnv,
  getDevelopmentFallbackOrigins,
  getMaxAge,
  isAllowedOrigin,
  isCorsOriginRejectedError,
  normalizeOrigin,
  parseAllowedOrigins,
  parseMaxAge,
  reloadCorsOrigins,
  resolveAllowlist,
};
