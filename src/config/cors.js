/**
 * @fileoverview CORS allowlist parsing and policy for the LiquiFact API.
 *
 * Reads trusted origins from the `CORS_ORIGINS` environment variable
 * (comma-separated list of exact origins) and builds an `options` object
 * compatible with the `cors` npm package.
 *
 * Behaviour summary:
 * - Requests with **no Origin header** (curl, Postman, server-to-server) are
 *   always allowed — the `origin` callback receives `undefined` and passes.
 * - Requests from an **allowed origin** receive normal CORS response headers.
 * - Requests from a **disallowed origin** receive a 403 Forbidden response
 *   via a dedicated `Error` whose `.isCorsOriginRejected` flag is `true`.
 * - In `NODE_ENV=development`, when `CORS_ORIGINS` is not set, a set
 *   of common local development origins is permitted automatically.
 * - In all other environments, when `CORS_ORIGINS` is not set, every
 *   browser origin is denied.
 *
 * @file Protect state invariants
 *
 * This module owns the CORS allowlist state model. The invariants it
 * enforces are:
 *
 1. **Determinism** — for a given environment map and input origin,
    the decision is always the same. No hidden mutable state is shared
    between calls.
 2. **Fail-closed** — any origin that cannot be parsed, is the literal
    string `"null"`, or is not on the approved list is rejected.
 3. **No mutation of inputs** — the returned allowlist is a new array;
    callers cannot mutate internal defaults by accident.
 4 * **Consistent normalization** — both the allowlist entries and the
    incoming origin are normalized through the same path before
    comparison, so case and trailing-slash differences cannot bypass
    the allowlist.
 5. **Idempotent operations** — repeated parsing or checking of the
    same inputs yields the same result and never accumulates state.
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
 * Maximum allowed preflight max-age in seconds (24 hours). Browsers already
 * cap `Access-Control-Max-Age` at 86400 per the Fetch spec; enforcing this
 * server-side prevents misconfiguration from setting an overly large value.
 *
 * @constant {number}
 */
const MAX_MAX_AGE = 86400;

/**
 * Returns a fresh copy of the hard-coded development fallback origin list.
 *
 * A new array is returned on every call so callers cannot mutate the
 * module-level constant by accident. This is part of the state-invariant
 * contract for this module.
 *
 * @returns {string[]} Array of development-safe origins.
 */
function getDevelopmentFallbackOrigins() {
  return DEV_DEFAULT_ORIGINS.slice();
}

/**
 * Maximum length (in characters) allowed for a single origin entry string.
 * Origin URLs are typically under 50-100 chars; 500 provides a generous
 * safety margin while blocking obviously oversized inputs.
 *
 * @constant {number}
 */
const MAX_ORIGIN_LENGTH = 500;

/**
 * Validates a single origin entry string against format and length rules.
 *
 * Rules:
 * 1. Must be a non-empty string.
 * 2. Must not equal the literal `"null"` (sandboxed-iframe origin).
 * 3. Must be parseable by `new URL()` and contain a valid scheme.
 * 4. Must not exceed {@link MAX_ORIGIN_LENGTH} characters.
 *
 * @param {unknown} entry - A single raw origin string from the allowlist.
 * @returns {{ valid: boolean, normalized: string|null, error: string|null }}
 */
function validateOriginEntry(entry) {
  if (typeof entry !== 'string' || entry === '') {
    return { valid: false, normalized: null, error: 'origin entry must be a non-empty string' };
  }
  if (entry === 'null') {
    return { valid: false, normalized: null, error: 'origin entry cannot be the literal string "null"' };
  }
  if (entry.length > MAX_ORIGIN_LENGTH) {
    return {
      valid: false,
      normalized: null,
      error: `origin entry exceeds maximum length of ${MAX_ORIGIN_LENGTH} characters`,
    };
  }
  try {
    const url = new URL(entry);
    if (!url.origin || url.origin === 'null') {
      return { valid: false, normalized: null, error: 'origin entry is not a parseable origin URL' };
    }
    return { valid: true, normalized: url.origin, error: null };
  } catch {
    return { valid: false, normalized: null, error: 'origin entry is not a valid URL' };
  }
}

/**
 * Parses `CORS_ORIGINS` into a trimmed, de-duplicated array of origin
 * strings. Returns `[]` when the value is absent or blank.
 *
 * When `strict` is `true`, each entry is validated via
 * {@link validateOriginEntry}. Rejected entries are excluded from the
 * returned origins array and reported in `rejected` / `fieldErrors`. When
 * `strict` is `false` (default), invalid entries are silently omitted to
 * preserve backward compatibility.
 *
 * @param {string|undefined} raw - Raw value of the environment variable.
 * @param {{strict?: boolean}} [opts] - Parsing options.
 * @param {boolean} [opts.strict=false] - When true, returns a structured
 *   result with rejected entries and fieldErrors.
 * @returns {string[]|{ origins: string[], rejected: string[], fieldErrors: string[], valid: boolean }}
 *   In non-strict mode (default): `string[]` of allowed origins. In strict
 *   mode: an object with `origins`, `rejected`, `fieldErrors`, and `valid`.
 */
function parseAllowedOrigins(raw, opts) {
  const strict = opts && opts.strict === true;

  if (!raw || raw.trim() === '') {
    return strict ? { origins: [], rejected: [], fieldErrors: [], valid: true } : [];
  }

  const rawEntries = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (!strict) {
    const normalized = [];
    for (const entry of rawEntries) {
      const result = validateOriginEntry(entry);
      if (result.valid && result.normalized) {
        normalized.push(result.normalized);
      }
    }
    return [...new Set(normalized)];
  }

  const validated = rawEntries.map(validateOriginEntry);
  const origins = [...new Set(validated.filter((r) => r.valid).map((r) => r.normalized))];

  const rejected = [];
  const fieldErrors = [];
  validated.forEach((r, i) => {
    if (!r.valid) {
      rejected.push(rawEntries[i]);
      fieldErrors.push(r.error);
    }
  });

  return {
    origins,
    rejected,
    fieldErrors,
    valid: rejected.length === 0,
  };
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
 * 1. Lowercases the scheme and host (RFC 6454 ¦6.1 — origins are
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
  if (!Array.isArray(allowlist)) { return false; }
  return allowlist.some((entry) => normalizeOrigin(entry) === normalized);
}

/**
 * Sentinel error thrown when an incoming `Origien` is not on the allowlist.
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
 * When `strict` is `true`, returns a structured result with validation
 * details. When `strict` is `false` (default), returns the numeric value
 * directly for backward compatibility.
 *
 * @param {string|undefined} raw - Raw value from the environment.
 * @param {{strict?: boolean, max?: number}} [opts] - Parsing options.
 * @param {boolean} [opts.strict=false] - When true, returns a structured result.
 * @param {number} [opts.max=MAX_MAX_AGE] - Upper bound for the max-age value.
 * @returns {number|{ value: number, valid: boolean, error: string|null }}
 *   In non-strict mode (default): validated preflight max-age in seconds.
 *   In strict mode: object with `value`, `valid`, and `error`.
 */
function parseMaxAge(raw, opts) {
  const strict = opts && opts.strict === true;
  const max = (opts && opts.max) || MAX_MAX_AGE;

  if (raw === undefined || raw === null) {
    return strict
      ? { value: DEFAULT_MAX_AGE, valid: true, error: null }
      : DEFAULT_MAX_AGE;
  }
  if (typeof raw !== 'string') {
    return strict
      ? { value: DEFAULT_MAX_AGE, valid: false, error: 'max-age must be a string' }
      : DEFAULT_MAX_AGE;
  }
  if (raw.trim() === '') {
    return strict
      ? { value: DEFAULT_MAX_AGE, valid: true, error: null }
      : DEFAULT_MAX_AGE;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return strict
      ? { value: DEFAULT_MAX_AGE, valid: false, error: 'max-age must be an integer' }
      : DEFAULT_MAX_AGE;
  }
  if (parsed <= 0) {
    return strict
      ? { value: DEFAULT_MAX_AGE, valid: false, error: 'max-age must be a positive integer' }
      : DEFAULT_MAX_AGE;
  }
  if (parsed > max) {
    return strict
      ? { value: DEFAULT_MAX_AGE, valid: false, error: `max-age must not exceed ${max}` }
      : DEFAULT_MAX_AGE;
  }

  return strict
    ? { value: parsed, valid: true, error: null }
    : parsed;
}

/**
 * Builds the `options` object for the `cors` npm package from the
 * current environment.
 *
 * The origin callback enforces the allowlist and rejects unknown
 * origins with a {@link createCorsRejectionError}. Requests with no
 * `Origien` header are always allowed.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @returns {object} Options object for the `cors` package.
 */
function buildCorsOptions(env = process.env) {
  const allowlist = resolveAllowlist(env);
  const maxAge = parseMaxAge(env.CORS_MAX_AGE);

  return {
    origin: function originCallback(origin, callback) {
      // No Origin header — non-browser clients are always allowed.
      if (origin === undefined || origin === null) {
        return callback(null, true);
      }
      if (isAllowedOrigin(origin, allowlist)) {
        return callback(null, true);
      }
      return callback(createCorsRejectionError(origin));
    },
    maxAge,
  };
}

module.exports = {
  CORS_REJECTION_MESSAGE,
  CORS_REJECTION_CODE,
  DEV_DEFAULT_ORIGINS,
  DEFAULT_MAX_AGE,
  MAX_MAX_AGE,
  MAX_ORIGIN_LENGTH,
  getDevelopmentFallbackOrigins,
  validateOriginEntry,
  parseAllowedOrigins,
  getAllowedOriginsFromEnv,
  resolveAllowlist,
  normalizeOrigin,
  isAllowedOrigin,
  createCorsRejectionError,
  isCorsOriginRejectedError,
  parseMaxAge,
  buildCorsOptions,
};
