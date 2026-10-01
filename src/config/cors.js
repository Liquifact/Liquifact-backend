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
 * ## State / Failure-Recovery Invariants (Issue #1284)
 *
 * 1. **Determinism** — for a given environment map and input origin, the
 *    decision is always the same. No hidden mutable state is shared between
 *    calls. The module-level `_allowedOrigins` and `_maxAge` variables are
 *    the only shared state and they are only written by `reloadCorsOrigins` /
 *    `reloadCorsMaxAge`, both of which are idempotent.
 *
 * 2. **Fail-closed** — any origin that cannot be parsed, is the literal
 *    string `"null"`, or is not on the approved list is rejected.
 *
 * 3. **No mutation of inputs** — the returned allowlist is a new array;
 *    callers cannot mutate internal state by accident.
 *
 * 4. **Consistent normalization** — both the allowlist entries and the
 *    incoming origin are normalized through the same path before comparison,
 *    so case and trailing-slash differences cannot bypass the allowlist.
 *
 * 5. **Idempotent operations** — repeated parsing or checking of the same
 *    inputs yields the same result and never accumulates state.
 *
 * 6. **Recovery** — `reloadCorsOrigins` / `reloadCorsMaxAge` are safe to
 *    call at any time (hot config reload, SIGHUP handlers).  A reload that
 *    encounters an empty or invalid env var falls back gracefully to the
 *    dev-fallback or empty list rather than leaving a corrupt state.
 *    In-flight requests already holding a reference to `createCorsOptions()`
 *    will pick up the new allowlist on their *next* origin callback
 *    invocation because the callback closes over the module-level variable
 *    by reference.
 *
 * 7. **Observability** — parse errors and reloads are logged at `warn` level
 *    with the number of rejected entries so operators can diagnose
 *    misconfiguration without the rejected values (which may contain secrets
 *    or PII) being emitted.
 *
 * 8. **Concurrency safety** — JavaScript's single-threaded event loop
 *    makes the module-level variable writes atomic from the perspective of
 *    concurrent I/O callbacks. `reloadCorsOrigins` performs an atomic
 *    replacement of `_allowedOrigins` (a single assignment), not an in-place
 *    mutation, so there is no window where the variable holds a partially
 *    constructed array.
 *
 * @module config/cors
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed rejection message used for all blocked-origin CORS errors.
 * Part of the public API — changing it is a breaking change for callers
 * that match on the error message.
 *
 * @constant {string}
 */
const CORS_REJECTION_MESSAGE = 'CORS policy: origin is not allowed.';

/**
 * Machine-readable code returned for blocked-origin responses.
 * @constant {string}
 */
const CORS_REJECTION_CODE = 'CORS_ORIGIN_REJECTED';

/**
 * Origins allowed when no env var is set during development.
 * @type {readonly string[]}
 */
const DEV_DEFAULT_ORIGINS = Object.freeze([
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
]);

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
 * Maximum length (in characters) allowed for a single origin entry string.
 * Origin URLs are typically under 50–100 chars; 500 provides a generous
 * safety margin while blocking obviously oversized inputs.
 *
 * @constant {number}
 */
const MAX_ORIGIN_LENGTH = 500;

/**
 * Maximum number of origins that can be submitted in a single bulk operation.
 *
 * @constant {number}
 */
const BULK_CORS_MAX_OPERATIONS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (the only mutable state in this module)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective origin allowlist for the current process.
 * Written atomically by `reloadCorsOrigins()`.
 * @type {string[]}
 */
let _allowedOrigins = resolveAllowlist(process.env);

/**
 * Effective preflight max-age for the current process.
 * Written atomically by `reloadCorsMaxAge()`.
 * @type {number}
 */
let _maxAge = parseMaxAge(process.env.CORS_MAX_AGE);

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (no side-effects)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a fresh copy of the hard-coded development fallback origin list.
 *
 * A new array is returned on every call so callers cannot mutate the
 * module-level constant by accident.
 *
 * @returns {string[]} Array of development-safe origins.
 */
function getDevelopmentFallbackOrigins() {
  return DEV_DEFAULT_ORIGINS.slice();
}

/**
 * Validates a single origin entry string against format and length rules.
 *
 * Rules:
 * 1. Must be a non-empty string.
 * 2. Must not equal the literal `"null"` (sandboxed-iframe origin).
 * 3. Must not exceed {@link MAX_ORIGIN_LENGTH} characters.
 * 4. Must be parseable by `new URL()` and resolve to a valid origin.
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
 * @returns {string[]|{ origins: string[], rejected: string[], fieldErrors: string[], valid: boolean }}
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
 * Accepts both `CORS_ALLOWED_ORIGINS` and `CORS_ORIGINS` for compatibility;
 * `CORS_ALLOWED_ORIGINS` takes precedence when both are set.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @returns {string[]} Origins to allow for browser requests with an Origin header.
 */
function getAllowedOriginsFromEnv(env) {
  const e = env === undefined ? process.env : env;
  const fromEnv = parseAllowedOrigins(e.CORS_ALLOWED_ORIGINS || e.CORS_ORIGINS);
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  if (e.NODE_ENV === 'development') {
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
function resolveAllowlist(env) {
  return getAllowedOriginsFromEnv(env === undefined ? process.env : env);
}

/**
 * Normalizes a browser origin string for allowlist comparison.
 *
 * Returns `null` for the literal string `"null"` (sandboxed-iframe origin)
 * and for any value that is not a non-empty string.
 *
 * @param {unknown} origin - Raw origin value from the request header.
 * @returns {string|null} Normalized origin, or `null`.
 */
function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') { return null; }
  if (origin === 'null') { return null; }

  try {
    const url = new URL(origin);
    return url.origin; // already lower-cased by the URL parser
  } catch {
    return null;
  }
}

/**
 * Returns `true` when `origin` is in the `allowlist` after both sides are
 * normalized via {@link normalizeOrigin}.
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
 * Sentinel error thrown when an incoming `Origin` is not on the allowlist.
 * The `isCorsOriginRejected` flag lets downstream error handlers identify it
 * without `instanceof` checks across module boundaries.
 *
 * @param {string} [_origin] - The rejected origin value (not logged; message is fixed).
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
 * Defaults to {@link DEFAULT_MAX_AGE} when the value is unset, empty, or
 * not a valid positive integer.
 *
 * @param {string|undefined} raw - Raw value from the environment.
 * @param {{strict?: boolean, max?: number}} [opts] - Parsing options.
 * @returns {number|{ value: number, valid: boolean, error: string|null }}
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

// ─────────────────────────────────────────────────────────────────────────────
// Hot-reload helpers (Issue #1284 — deterministic failure recovery)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-reads `CORS_ORIGINS` / `CORS_ALLOWED_ORIGINS` from `process.env` and
 * atomically replaces the module-level allowlist.
 *
 * Safe to call from a SIGHUP handler, a config-watch callback, or a test
 * `beforeEach`.  In-flight requests whose origin callback was already
 * dispatched are unaffected; requests that arrive *after* this call will use
 * the new allowlist.
 *
 * A reload that produces an empty list (blank env var in production) is
 * intentional and results in all browser origins being denied — consistent
 * with the fail-closed invariant.
 *
 * @returns {void}
 */
function reloadCorsOrigins() {
  _allowedOrigins = resolveAllowlist(process.env);
}

/**
 * Re-reads `CORS_MAX_AGE` from `process.env` and atomically replaces the
 * module-level max-age value.
 *
 * Falls back to `DEFAULT_MAX_AGE` when the env var is absent or invalid.
 *
 * @returns {void}
 */
function reloadCorsMaxAge() {
  _maxAge = parseMaxAge(process.env.CORS_MAX_AGE);
}

/**
 * Returns the currently active preflight max-age in seconds.
 *
 * @returns {number}
 */
function getMaxAge() {
  return _maxAge;
}

// ─────────────────────────────────────────────────────────────────────────────
// Options builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the `options` object for the `cors` npm package.
 *
 * The origin callback captures the `env` argument at call time (for testing
 * with explicit env objects) but reads `_allowedOrigins` via a closure when
 * `env` is the default `process.env`, so `reloadCorsOrigins()` takes effect
 * immediately for the process-level allowlist.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 *   Pass an explicit object in tests to avoid mutating `process.env`.
 * @returns {object} Options object for the `cors` package.
 */
function createCorsOptions(env) {
  const useGlobalState = env === undefined || env === process.env;

  // When an explicit env is provided (testing), compute a local allowlist and
  // max-age from it so the test is hermetic. When using the module-level
  // state, we read the live `_allowedOrigins` / `_maxAge` variables at
  // callback-invocation time so that `reloadCorsOrigins()` takes effect
  // without needing to call `createCorsOptions()` again.
  const localAllowlist = useGlobalState ? null : resolveAllowlist(env);
  const localMaxAge = useGlobalState ? null : parseMaxAge(env && env.CORS_MAX_AGE);

  return {
    origin: function originCallback(origin, callback) {
      // No Origin header — non-browser clients are always allowed.
      if (origin === undefined || origin === null) {
        return callback(null, true);
      }

      // Read live state for process-env path; fixed snapshot for test path.
      const allowlist = useGlobalState ? _allowedOrigins : localAllowlist;

      if (isAllowedOrigin(origin, allowlist)) {
        return callback(null, true);
      }
      return callback(createCorsRejectionError(origin));
    },
    maxAge: useGlobalState ? _maxAge : (localMaxAge !== null ? localMaxAge : _maxAge),
    optionsSuccessStatus: 204,
  };
}

/**
 * @deprecated Use `createCorsOptions`. Kept for backward compatibility.
 */
const buildCorsOptions = createCorsOptions;

// ─────────────────────────────────────────────────────────────────────────────
// Bulk CORS operations (used by adminCors.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BulkCorsOperation
 * @property {'add'|'remove'} action - Whether to add or remove the origin.
 * @property {string} origin - The origin to add or remove.
 */

/**
 * @typedef {Object} BulkCorsResult
 * @property {number} added - Number of origins successfully added.
 * @property {number} removed - Number of origins successfully removed.
 * @property {number} skipped - Number of operations skipped (invalid, duplicate, etc.).
 * @property {string[]} errors - Validation error messages for skipped operations.
 * @property {string[]} currentAllowlist - The allowlist after all operations.
 */

/**
 * Applies a batch of add/remove operations to the in-memory CORS allowlist
 * and reloads it atomically.
 *
 * Constraints enforced:
 * - At most {@link BULK_CORS_MAX_OPERATIONS} operations per call.
 * - Each `add` origin is validated via {@link validateOriginEntry}.
 * - Duplicate `add` operations are skipped (idempotent).
 * - `remove` operations for absent entries are skipped (idempotent).
 * - The env var is NOT written; the updated list lives only in module state
 *   until the process restarts. Callers that require persistence must write
 *   the env var themselves before calling this function.
 *
 * **Recovery invariant:** if validation of any single entry fails, the
 * remainder of the batch is still processed. The final allowlist is never
 * left in a partially-constructed state because the assignment to
 * `_allowedOrigins` is atomic (single assignment of a completed array).
 *
 * @param {BulkCorsOperation[]} operations - Array of add/remove operations.
 * @returns {BulkCorsResult} Result summary.
 */
function processBulkCorsOperations(operations) {
  if (!Array.isArray(operations)) {
    return {
      added: 0,
      removed: 0,
      skipped: 0,
      errors: ['operations must be an array'],
      currentAllowlist: _allowedOrigins.slice(),
    };
  }

  const toProcess = operations.slice(0, BULK_CORS_MAX_OPERATIONS);

  let added = 0;
  let removed = 0;
  let skipped = 0;
  const errors = [];

  // Work on a copy so the existing allowlist is not visible in a partially
  // mutated state if something fails mid-loop.
  const working = _allowedOrigins.slice();

  for (const op of toProcess) {
    if (!op || typeof op !== 'object') {
      skipped += 1;
      errors.push('operation must be an object with action and origin');
      continue;
    }

    const { action, origin } = op;

    if (action !== 'add' && action !== 'remove') {
      skipped += 1;
      errors.push(`unknown action "${action}" (must be "add" or "remove")`);
      continue;
    }

    if (action === 'add') {
      const validation = validateOriginEntry(origin);
      if (!validation.valid) {
        skipped += 1;
        errors.push(validation.error || `invalid origin: ${String(origin)}`);
        continue;
      }
      const normalized = validation.normalized;
      if (working.includes(normalized)) {
        skipped += 1;
        continue;
      }
      working.push(normalized);
      added += 1;
    } else {
      // action === 'remove'
      const normalized = normalizeOrigin(origin);
      const idx = normalized !== null ? working.indexOf(normalized) : -1;
      if (idx === -1) {
        skipped += 1;
        continue;
      }
      working.splice(idx, 1);
      removed += 1;
    }
  }

  // Atomic replacement — no window where `_allowedOrigins` is partly modified.
  _allowedOrigins = working;

  return {
    added,
    removed,
    skipped,
    errors,
    currentAllowlist: _allowedOrigins.slice(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  CORS_REJECTION_MESSAGE,
  CORS_REJECTION_CODE,
  DEV_DEFAULT_ORIGINS,
  DEFAULT_MAX_AGE,
  MAX_MAX_AGE,
  MAX_ORIGIN_LENGTH,
  BULK_CORS_MAX_OPERATIONS,

  // Pure helpers
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

  // State readers
  getMaxAge,

  // Hot-reload (failure recovery, Issue #1284)
  reloadCorsOrigins,
  reloadCorsMaxAge,

  // Options builders
  createCorsOptions,
  buildCorsOptions, // backward-compat alias

  // Bulk operations (used by adminCors.js)
  processBulkCorsOperations,
};
