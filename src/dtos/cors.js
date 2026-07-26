'use strict';

/**
 * @fileoverview Typed DTOs (Data Transfer Objects) for the CORS boundary.
 *
 * This module defines the canonical shape of CORS configuration as it crosses
 * the module boundary, along with pure mapping functions that convert between
 * the internal representation (environment variables, `cors` package options)
 * and these DTOs.
 *
 * No behaviour changes — all existing functions in `src/config/cors.js`
 * continue to work identically. These DTOs provide type-safe wrappers that
 * can be adopted incrementally at the call sites.
 *
 * ## DTO types
 *
 * | DTO                    | Direction  | Purpose                              |
 * |------------------------|------------|--------------------------------------|
 * | `CorsConfigDto`        | env → app  | Resolved CORS policy from env vars   |
 * | `CorsOriginResultDto`  | app → cors | Per-request origin validation result |
 *
 * @module dtos/cors
 */

const corsConfig = require('../config/cors');

// ── DTO type definitions ─────────────────────────────────────────────────────

/**
 * Resolved CORS configuration read from environment variables.
 *
 * This is the typed output of the configuration parsing layer, representing
 * every piece of static CORS policy derived from the environment.
 *
 * @typedef {Object} CorsConfigDto
 * @property {string[]} allowedOrigins  - List of origins permitted to make
 *   credentialed cross-origin requests (empty = deny all).
 * @property {number}   maxAge          - `Access-Control-Max-Age` in seconds
 *   for preflight caching.
 * @property {number}   optionsSuccessStatus - HTTP status for successful
 *   OPTIONS preflight responses (always 204).
 * @property {boolean}  isDevelopmentFallback - `true` when the allowlist was
 *   derived from the hard-coded dev fallback rather than explicit env vars.
 */

/**
 * Per-request origin validation result.
 *
 * Produced when an inbound request is evaluated against the CORS policy.
 * This is the boundary type between the CORS policy logic and the `cors`
 * middleware callback.
 *
 * @typedef {Object} CorsOriginResultDto
 * @property {boolean} allowed           - `true` when the origin should receive
 *   `Access-Control-Allow-Origin`.
 * @property {string}  [reason]          - Human-readable rejection reason when
 *   `allowed` is `false`.
 * @property {string}  [errorCode]       - Machine-readable error code
 *   (e.g. `CORS_ORIGIN_NOT_ALLOWED`, `CORS_NULL_ORIGIN`).
 */

/** @type {string} */
const CORS_ORIGIN_NOT_ALLOWED_CODE = 'CORS_ORIGIN_NOT_ALLOWED';

/** @type {string} */
const CORS_NULL_ORIGIN_CODE = 'CORS_NULL_ORIGIN';

// ── DTO constructors / factories ─────────────────────────────────────────────

/**
 * Builds a {@link CorsConfigDto} from the given environment object by
 * delegating to the existing config parser.
 *
 * This is the canonical entry point for reading typed CORS configuration.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @returns {CorsConfigDto}
 *
 * @example
 * const dto = corsConfigDtoFromEnv(process.env);
 * console.log(dto.allowedOrigins); // ['https://app.example.com']
 * console.log(dto.maxAge);         // 600
 */
function corsConfigDtoFromEnv(env = process.env) {
  const allowedOrigins = corsConfig.getAllowedOriginsFromEnv(env);
  const isDevelopmentFallback =
    allowedOrigins.length > 0 &&
    corsConfig.getDevelopmentFallbackOrigins().every((o) => allowedOrigins.includes(o)) &&
    !env.CORS_ORIGINS &&
    !env.CORS_ALLOWED_ORIGINS &&
    env.NODE_ENV === 'development';

  // Use the env-specific CORS_MAX_AGE when a custom env is provided;
  // fall back to the module-level getMaxAge() for the real process.env path.
  const maxAge = env !== process.env && env.CORS_MAX_AGE !== undefined
    ? corsConfig.parseMaxAge(env.CORS_MAX_AGE)
    : corsConfig.getMaxAge();

  return {
    allowedOrigins: [...allowedOrigins],
    maxAge,
    optionsSuccessStatus: 204,
    isDevelopmentFallback,
  };
}

/**
 * Validates a single origin against the policy and returns a typed
 * {@link CorsOriginResultDto}.
 *
 * This function mirrors the logic inside `createCorsOptions().origin` but
 * returns a pure data DTO instead of calling the `cors` callback.
 *
 * @param {string|undefined} origin - The `Origin` request header value.
 * @param {string[]} allowedOrigins - The allowlist to validate against.
 * @returns {CorsOriginResultDto}
 *
 * @example
 * const result = validateOriginDto('https://app.example.com', ['https://app.example.com']);
 * // { allowed: true }
 *
 * const result2 = validateOriginDto('https://evil.com', ['https://app.example.com']);
 * // { allowed: false, reason: 'CORS policy: origin is not allowed.', errorCode: 'CORS_ORIGIN_NOT_ALLOWED' }
 */
function validateOriginDto(origin, allowedOrigins) {
  // No Origin header → always pass (non-browser clients)
  if (origin === undefined) {
    return { allowed: true };
  }

  // Literal "null" origin (sandboxed iframe) → always reject
  if (origin === 'null') {
    return {
      allowed: false,
      reason: corsConfig.CORS_REJECTION_MESSAGE,
      errorCode: CORS_NULL_ORIGIN_CODE,
    };
  }

  // Empty allowlist → reject
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return {
      allowed: false,
      reason: corsConfig.CORS_REJECTION_MESSAGE,
      errorCode: CORS_ORIGIN_NOT_ALLOWED_CODE,
    };
  }

  // Normalised comparison against allowlist
  if (corsConfig.isAllowedOrigin(origin, allowedOrigins)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: corsConfig.CORS_REJECTION_MESSAGE,
    errorCode: CORS_ORIGIN_NOT_ALLOWED_CODE,
  };
}

/**
 * Converts a {@link CorsConfigDto} back to the options object expected by
 * the `cors` npm package.
 *
 * This is a pure mapping function — it does not close over module-level
 * mutable state or read environment variables.
 *
 * @param {CorsConfigDto} dto - The typed CORS configuration.
 * @returns {import('cors').CorsOptions}
 *
 * @example
 * const dto = corsConfigDtoFromEnv();
 * const corsOptions = corsConfigDtoToOptions(dto);
 * app.use(cors(corsOptions));
 */
function corsConfigDtoToOptions(dto) {
  const allowedOrigins = [...(dto.allowedOrigins || [])];

  return {
    /**
     * Validates request origin against the allowlist from the DTO.
     *
     * @param {string|undefined} origin - The request origin header value.
     * @param {Function} callback - CORS callback (err, allow).
     * @returns {void}
     */
    origin(origin, callback) {
      const result = validateOriginDto(origin, allowedOrigins);

      if (result.allowed) {
        return callback(null, true);
      }

      const err = corsConfig.createCorsRejectionError(origin);
      err.errorCode = result.errorCode;
      return callback(err);
    },

    maxAge: dto.maxAge != null ? dto.maxAge : 600,
    optionsSuccessStatus: dto.optionsSuccessStatus != null ? dto.optionsSuccessStatus : 204,
  };
}

/**
 * Converts a {@link CorsConfigDto} to a plain object suitable for
 * serialisation (e.g. to JSON in an admin health endpoint).
 *
 * @param {CorsConfigDto} dto - The typed CORS configuration.
 * @returns {Object} JSON-safe representation.
 */
function corsConfigDtoToJson(dto) {
  return {
    allowedOrigins: [...(dto.allowedOrigins || [])],
    maxAge: dto.maxAge,
    optionsSuccessStatus: dto.optionsSuccessStatus,
    isDevelopmentFallback: Boolean(dto.isDevelopmentFallback),
  };
}

/**
 * Parses a JSON-compatible object back into a {@link CorsConfigDto},
 * validating and defaulting missing fields.
 *
 * @param {Object} json - JSON-compatible object (e.g. from a config file).
 * @returns {CorsConfigDto}
 */
function corsConfigDtoFromJson(json) {
  return {
    allowedOrigins: Array.isArray(json.allowedOrigins)
      ? json.allowedOrigins.filter((o) => typeof o === 'string')
      : [],
    maxAge: Number.isInteger(json.maxAge) && json.maxAge > 0 ? json.maxAge : 600,
    optionsSuccessStatus: json.optionsSuccessStatus != null ? json.optionsSuccessStatus : 204,
    isDevelopmentFallback: Boolean(json.isDevelopmentFallback),
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // DTO factory functions
  corsConfigDtoFromEnv,
  validateOriginDto,
  corsConfigDtoToOptions,
  corsConfigDtoToJson,
  corsConfigDtoFromJson,

  // Error codes
  CORS_ORIGIN_NOT_ALLOWED_CODE,
  CORS_NULL_ORIGIN_CODE,
};
