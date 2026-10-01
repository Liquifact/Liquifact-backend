'use strict';

/**
 * @fileoverview Typed DTOs (Data Transfer Objects) for the CORS boundary.
 *
 * This module defines the canonical shape of CORS configuration as it crosses
 * the module boundary, along with pure mapping functions that convert between
 * the internal representation (environment variables, `cors` package options)
 * and these DTOs.
 *
 * DTO conversions preserve a fail-closed origin policy and validate the
 * bounded numeric settings at every serialization boundary. Existing valid
 * values keep the same behavior.
 *
 * ## DTO types
 *
 * | DTO                    | Direction  | Purpose                              |
 * |------------------------|------------|--------------------------------------|
 * | `CorsConfigDto`        | env → app  | Resolved CORS policy from env vars   |
 * | `CorsOriginResultDto`  | app → cors | Per-request origin validation result |
 *
 * ## Compatibility contract
 *
 * The section below freezes the public surface of this module and is pinned by
 * `src/dtos/cors.test.js`. It is **additive-only**: new exports, new optional
 * fields and newly accepted inputs may be added, but existing export names,
 * their JavaScript types, the DTO shapes and the error-code string values must
 * never be removed, renamed or changed. Removing or changing them is a breaking
 * change and requires a tested migration path.
 *
 * ### Exported names (`Object.keys(require('./cors'))`)
 *
 * | Export                          | Type     | Signature / value          |
 * |---------------------------------|----------|----------------------------|
 * | `corsConfigDtoFromEnv`          | function | `(env?) → CorsConfigDto`   |
 * | `validateOriginDto`             | function | `(origin, allowedOrigins) → CorsOriginResultDto` |
 * | `corsConfigDtoToOptions`        | function | `(dto) → cors.CorsOptions` |
 * | `corsConfigDtoToJson`           | function | `(dto) → JSON-safe DTO`    |
 * | `corsConfigDtoFromJson`         | function | `(json) → CorsConfigDto`   |
 * | `CORS_ORIGIN_NOT_ALLOWED_CODE`  | string   | `'CORS_ORIGIN_NOT_ALLOWED'` |
 * | `CORS_NULL_ORIGIN_CODE`         | string   | `'CORS_NULL_ORIGIN'`       |
 * | `CORS_CONFIG_DTO_INVALID_CODE`  | string   | `'CORS_CONFIG_DTO_INVALID'` |
 *
 * ### Frozen DTO shapes
 *
 * - `CorsConfigDto`: `{ allowedOrigins: string[], maxAge: number,
 *   optionsSuccessStatus: number, isDevelopmentFallback: boolean }`.
 * - `CorsOriginResultDto`: `{ allowed: true }` on success, or
 *   `{ allowed: false, reason: string, errorCode: string }` on rejection.
 *
 * ### Behavioural guarantees
 *
 * - Total on absent/malformed roots: `null`, `undefined`, arrays and primitives
 *   are treated as empty records and yield the documented defaults — `maxAge`
 *   600, `optionsSuccessStatus` 204, `isDevelopmentFallback` false — never
 *   throwing.
 * - `validateOriginDto(undefined, …)` allows non-browser callers; the literal
 *   `'null'` origin, non-string/empty origins and empty allowlists fail closed
 *   with a machine-readable `errorCode` and never throw.
 * - Returned `allowedOrigins` arrays are fresh, de-duplicated and normalized, so
 *   callers cannot mutate module state or the input.
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
 * @property {number}   maxAge          - Integer `Access-Control-Max-Age` in
 *   seconds (1–86400) for preflight caching.
 * @property {number}   optionsSuccessStatus - 2xx HTTP status for successful
 *   OPTIONS preflight responses (defaults to 204).
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

/** @type {string} Machine-readable code for a non-string or empty origin. */
const CORS_INVALID_ORIGIN_CODE = 'CORS_INVALID_ORIGIN';

/** @type {string} Machine-readable code for validating against an empty allowlist. */
const CORS_EMPTY_ALLOWLIST_CODE = 'CORS_EMPTY_ALLOWLIST';

/** @type {string} Machine-readable code for an invalid/malformed DTO payload. */
const CORS_CONFIG_DTO_INVALID_CODE = 'CORS_CONFIG_DTO_INVALID';

const DEFAULT_OPTIONS_SUCCESS_STATUS = 204;
const MIN_OPTIONS_SUCCESS_STATUS = 200;
const MAX_OPTIONS_SUCCESS_STATUS = 299;

/**
 * Returns a detached list of unique, canonical origins from untrusted input.
 * Invalid entries are discarded so malformed configuration cannot widen the
 * policy or cause a request-time exception.
 * @param {unknown} origins - Candidate origin array.
 * @returns {string[]} Canonical valid origins.
 */
function normalizeAllowedOrigins(origins) {
  if (!Array.isArray(origins)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const origin of origins) {
    const result = corsConfig.validateOriginEntry(origin);
    if (result.valid && !seen.has(result.normalized)) {
      seen.add(result.normalized);
      normalized.push(result.normalized);
    }
  }
  return normalized;
}

/**
 * Converts an untrusted DTO value to a supported CORS preflight max-age.
 * @param {unknown} value - Candidate max-age value.
 * @returns {number} Integer max-age from 1 to 86400, or the safe default.
 */
function normalizeMaxAge(value) {
  if (!Number.isInteger(value)) {
    return corsConfig.parseMaxAge(undefined);
  }
  return corsConfig.parseMaxAge(String(value));
}

/**
 * Keeps only successful HTTP response status codes supported for preflight.
 * @param {unknown} value - Candidate response status.
 * @returns {number} A 2xx status, or 204 when invalid.
 */
function normalizeOptionsSuccessStatus(value) {
  return Number.isInteger(value) && value >= MIN_OPTIONS_SUCCESS_STATUS && value <= MAX_OPTIONS_SUCCESS_STATUS
    ? value
    : DEFAULT_OPTIONS_SUCCESS_STATUS;
}

/**
 * Treats malformed DTO roots as empty records at deserialization boundaries.
 * @param {unknown} value - Candidate DTO or JSON value.
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Reports development fallback metadata only for the actual fallback list.
 * @param {string[]} origins - Canonical origin list.
 * @returns {boolean}
 */
function isDevelopmentFallbackList(origins) {
  const fallback = normalizeAllowedOrigins(corsConfig.getDevelopmentFallbackOrigins());
  return origins.length === fallback.length && origins.every((origin, index) => origin === fallback[index]);
}

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
  const usesProcessEnv = env === process.env;
  const safeEnv = asRecord(env);
  const allowedOrigins = normalizeAllowedOrigins(corsConfig.getAllowedOriginsFromEnv(safeEnv));
  const isDevelopmentFallback =
    allowedOrigins.length > 0 &&
    isDevelopmentFallbackList(allowedOrigins) &&
    !safeEnv.CORS_ORIGINS &&
    !safeEnv.CORS_ALLOWED_ORIGINS &&
    safeEnv.NODE_ENV === 'development';

  // A custom env is an isolated snapshot: missing max-age means its default,
  // never a value inherited from the process-wide CORS configuration.
  const maxAge = usesProcessEnv
    ? corsConfig.parseMaxAge(process.env.CORS_MAX_AGE)
    : corsConfig.parseMaxAge(safeEnv.CORS_MAX_AGE);

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

  // Reject non-string origins (defensive: header parsing should never
  // produce these, but callers may pass arbitrary values).
  if (typeof origin !== 'string') {
    return {
      allowed: false,
      reason: corsConfig.CORS_REJECTION_MESSAGE,
      errorCode: CORS_INVALID_ORIGIN_CODE,
    };
  }

  // Empty string origin is not a valid browser origin → reject.
  if (origin.length === 0) {
    return {
      allowed: false,
      reason: corsConfig.CORS_REJECTION_MESSAGE,
      errorCode: CORS_INVALID_ORIGIN_CODE,
    };
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
      errorCode: CORS_EMPTY_ALLOWLIST_CODE,
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
  const safeDto = asRecord(dto);
  const allowedOrigins = normalizeAllowedOrigins(safeDto.allowedOrigins);

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

    maxAge: normalizeMaxAge(safeDto.maxAge),
    optionsSuccessStatus: normalizeOptionsSuccessStatus(safeDto.optionsSuccessStatus),
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
  const safeDto = asRecord(dto);
  const allowedOrigins = normalizeAllowedOrigins(safeDto.allowedOrigins);
  return {
    allowedOrigins,
    maxAge: normalizeMaxAge(safeDto.maxAge),
    optionsSuccessStatus: normalizeOptionsSuccessStatus(safeDto.optionsSuccessStatus),
    isDevelopmentFallback: safeDto.isDevelopmentFallback === true,
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
  const safeJson = asRecord(json);
  const allowedOrigins = normalizeAllowedOrigins(safeJson.allowedOrigins);
  return {
    allowedOrigins,
    maxAge: normalizeMaxAge(safeJson.maxAge),
    optionsSuccessStatus: normalizeOptionsSuccessStatus(safeJson.optionsSuccessStatus),
    isDevelopmentFallback: safeJson.isDevelopmentFallback === true,
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
  CORS_CONFIG_DTO_INVALID_CODE,
};
