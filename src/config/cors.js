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
 * Maximum allowed preflight max-age in seconds (24 hours). Browsers already
 * cap `Access-Control-Max-Age` at 86400 per the Fetch spec; enforcing this
 * server-side prevents misconfiguration from setting an overly large value.
 *
 * @constant {number}
 */
const MAX_MAX_AGE = 86400;

/**
 * Returns the hard-coded development fallback origin list.
 *
 * @returns {string[]} Array of development-safe origins.
 */
function getDevelopmentFallbackOrigins() {
  return DEV_DEFAULT_ORIGINS;
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
 * @param {{ strict?: boolean }} [opts] - Parsing options.
 * @param {boolean} [opts.strict=false] - When true, returns a structured
 *   result with rejected entries and fieldErrors.
 * @returns {string[]|{ origins: string[], rejected: string[], fieldErrors: string[][], valid: boolean }}
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
    return [
      ...new Set(
        rawEntries
          .map((entry) => (validateOriginEntry(entry).valid ? validateOriginEntry(entry).normalized : null))
          .filter(Boolean)
      ),
    ];
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
 * @param {{ strict?: boolean, max?: number }} [opts] - Parsing options.
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
 * Reloads the CORS preflight max-age from process.env.CORS_MAX_AGE and
 * returns the new value. Call this after updating CORS_MAX_AGE at runtime.
 *
 * @returns {number} Updated max-age in seconds.
 */
function reloadCorsMaxAge() {
  maxAge = parseMaxAge(process.env.CORS_MAX_AGE);
  return maxAge;
}

/**
 * Validates that `origin` (if present) is in the provided allowlist.
 * Returns `true` when the origin is absent (non-browser client) or present
 * in the allowlist.
 *
 * @param {string|undefined} origin - Incoming request origin header.
 * @param {string[]} allowlist - Array of allowed origin strings.
 * @returns {boolean}
 */
function validateCorsOrigin(origin, allowlist) {
  if (origin === undefined) {
    return true;
  }
  return allowlist.length > 0 && isAllowedOrigin(origin, allowlist);
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
        if (validateCorsOrigin(origin, allowedOrigins)) {
          return callback(null, true);
        }
        return callback(createCorsRejectionError(origin));
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
      if (validateCorsOrigin(origin, testAllowlist)) {
        return callback(null, true);
      }
      return callback(createCorsRejectionError(origin));
    },

    maxAge,
    optionsSuccessStatus: 204,
  };
}

// ── Bulk operations ───────────────────────────────────────────────────────────

/**
 * Maximum number of operations allowed in a single bulk CORS request.
 * Bounded to prevent unbounded memory use and keep per-request time predictable.
 *
 * @constant {number}
 */
const BULK_CORS_MAX_OPERATIONS = 25;

/**
 * @typedef {'add'|'remove'|'replace'} CorsOperationType
 */

/**
 * @typedef {Object} CorsOperation
 * @property {CorsOperationType} op   - The operation to perform.
 * @property {string}            origin - The origin to add, remove, or replace.
 * @property {string}            [newOrigin] - The replacement origin (required when op === 'replace').
 */

/**
 * @typedef {Object} CorsOperationResult
 * @property {number}       index        - Zero-based position in the submitted array.
 * @property {boolean}      success      - Whether the operation succeeded.
 * @property {string}       op           - The operation that was attempted.
 * @property {string}       origin       - The origin value supplied.
 * @property {string|null}  [newOrigin]  - For 'replace': the replacement value supplied.
 * @property {string|null}  error        - Human-readable error when success is false.
 */

/**
 * Validates a single bulk CORS operation entry.
 *
 * Rules enforced:
 * - `op` must be `add`, `remove`, or `replace`.
 * - `origin` must be a valid, parseable origin URL.
 * - `newOrigin` is required (and must be valid) when `op` is `replace`.
 * - `newOrigin` must not be provided for `add` or `remove`.
 *
 * @param {unknown} item - The raw operation entry from the request.
 * @returns {{ valid: boolean, error: string|null, normalized: { op: string, origin: string, newOrigin?: string }|null }}
 */
function validateBulkCorsItem(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { valid: false, error: 'each operation must be a plain object', normalized: null };
  }

  const { op, origin, newOrigin } = item;

  const VALID_OPS = ['add', 'remove', 'replace'];
  if (typeof op !== 'string' || !VALID_OPS.includes(op)) {
    return {
      valid: false,
      error: `op must be one of: ${VALID_OPS.join(', ')}`,
      normalized: null,
    };
  }

  const originCheck = validateOriginEntry(origin);
  if (!originCheck.valid) {
    return { valid: false, error: `origin: ${originCheck.error}`, normalized: null };
  }

  if (op === 'replace') {
    if (newOrigin === undefined) {
      return { valid: false, error: 'newOrigin is required for replace operations', normalized: null };
    }
    const newOriginCheck = validateOriginEntry(newOrigin);
    if (!newOriginCheck.valid) {
      return { valid: false, error: `newOrigin: ${newOriginCheck.error}`, normalized: null };
    }
    return {
      valid: true,
      error: null,
      normalized: {
        op,
        origin: originCheck.normalized,
        newOrigin: newOriginCheck.normalized,
      },
    };
  }

  // 'add' or 'remove' — newOrigin must not be provided
  if (newOrigin !== undefined) {
    return {
      valid: false,
      error: `newOrigin must not be provided for ${op} operations`,
      normalized: null,
    };
  }

  return { valid: true, error: null, normalized: { op, origin: originCheck.normalized } };
}

/**
 * Processes a bounded array of CORS origin operations in isolation.
 *
 * Each operation is validated and applied independently — a failure in one
 * item does not prevent subsequent items from being processed.
 *
 * Supported operations:
 * - `add`     — Appends the origin to the allowlist if not already present.
 * - `remove`  — Removes the origin from the allowlist if present.
 * - `replace` — Replaces an existing origin with a new one. If the origin to
 *               replace is not present, the operation fails with an error.
 *
 * The batch size is capped at {@link BULK_CORS_MAX_OPERATIONS}. Callers
 * receive a structured response even on partial failure; the overall request
 * never returns 4xx/5xx due to individual item failures.
 *
 * @param {unknown[]} operations - Raw array of operation objects from the request body.
 * @returns {{ results: CorsOperationResult[], updatedOrigins: string[] }}
 *   `results` holds per-item outcomes; `updatedOrigins` is the new allowlist
 *   after all successful operations have been applied.
 */
function processBulkCorsOperations(operations) {
  // Work on a mutable copy of the current allowlist so that each operation
  // sees the result of the preceding successful one (order matters).
  const workingList = allowedOrigins.slice();

  const results = operations.map((item, index) => {
    const validation = validateBulkCorsItem(item);

    // Build common base for the result entry
    const rawOp = item && typeof item === 'object' ? String(item.op || '') : '';
    const rawOrigin = item && typeof item === 'object' ? String(item.origin || '') : '';
    const rawNewOrigin = item && typeof item === 'object' ? item.newOrigin : undefined;

    if (!validation.valid) {
      return {
        index,
        success: false,
        op: rawOp,
        origin: rawOrigin,
        ...(rawNewOrigin !== undefined ? { newOrigin: String(rawNewOrigin) } : {}),
        error: validation.error,
      };
    }

    const { op, origin, newOrigin } = validation.normalized;

    if (op === 'add') {
      const alreadyPresent = workingList.some(
        (entry) => normalizeOrigin(entry) === normalizeOrigin(origin),
      );
      if (!alreadyPresent) {
        workingList.push(origin);
      }
      return { index, success: true, op, origin, error: null };
    }

    if (op === 'remove') {
      const beforeLen = workingList.length;
      const normalized = normalizeOrigin(origin);
      const filtered = workingList.filter(
        (entry) => normalizeOrigin(entry) !== normalized,
      );
      workingList.length = 0;
      filtered.forEach((o) => workingList.push(o));
      const removed = beforeLen > workingList.length;
      return {
        index,
        success: true,
        op,
        origin,
        error: removed ? null : 'origin was not in the allowlist; no-op',
      };
    }

    // op === 'replace'
    const normalizedOld = normalizeOrigin(origin);
    const existingIndex = workingList.findIndex(
      (entry) => normalizeOrigin(entry) === normalizedOld,
    );
    if (existingIndex === -1) {
      return {
        index,
        success: false,
        op,
        origin,
        newOrigin,
        error: 'origin to replace was not found in the allowlist',
      };
    }
    workingList[existingIndex] = newOrigin;
    return { index, success: true, op, origin, newOrigin, error: null };
  });

  // Persist the updated allowlist for live traffic
  allowedOrigins.length = 0;
  workingList.forEach((o) => allowedOrigins.push(o));

  return { results, updatedOrigins: allowedOrigins.slice() };
}

module.exports = {
  BULK_CORS_MAX_OPERATIONS,
  CORS_REJECTION_CODE,
  CORS_REJECTION_MESSAGE,
  DEV_DEFAULT_ORIGINS,
  MAX_MAX_AGE,
  MAX_ORIGIN_LENGTH,
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
  processBulkCorsOperations,
  reloadCorsMaxAge,
  reloadCorsOrigins,
  resolveAllowlist,
  validateBulkCorsItem,
  validateCorsOrigin,
};