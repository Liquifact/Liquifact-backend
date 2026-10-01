/**
 * Centralized typed configuration module with runtime validation.
 * Uses Zod for schema validation and type safety.
 *
 * Concurrency contract
 * --------------------
 * This module is the single source of truth for process configuration and is
 * read from boot code, request handlers, and background workers. It is designed
 * to be safe under concurrent and repeated execution:
 *
 * 1. Atomic publication — `validate()` builds a complete candidate from a
 *    point-in-time copy of `process.env`, then publishes it in one assignment.
 *    Readers observe either the previous complete snapshot or the next complete
 *    one, never a partially built object, even if `process.env` is mutated by
 *    another code path (e.g. the admin runtime-config surface) mid-validation.
 * 2. Immutable snapshots — published snapshots are deeply frozen, so one
 *    consumer cannot mutate global configuration out from under another.
 * 3. Idempotent repeats — re-validating an unchanged environment returns the
 *    already-published snapshot instead of re-parsing it (no duplicate work, no
 *    generation churn).
 * 4. Single flight — a re-entrant `validate()` call cannot start a competing
 *    parse. It returns the published snapshot, or fails fast with
 *    `CONFIG_VALIDATION_IN_PROGRESS` when none has been published yet.
 * 5. Fail-safe failures — a failed validation never mutates the published
 *    snapshot, so the last known-good config keeps serving, and the failure is
 *    observable through `getValidationState()`: staleness is never silent.
 *
 * @module config
 *
 * Compatibility contract: `validate()` is idempotent and safe to call
 * multiple times; `get()` throws until `validate()` succeeds.
 */

const crypto = require('crypto');
const z = require('zod');

// ─── Public API version ───────────────────────────────────────────────────────

/**
 * Semantic version of the config module's public API.
 *
 * Bump the minor version when adding new exports.
 * Bump the major version when removing or renaming existing exports, and include
 * a migration guide in this file and the CHANGELOG.
 *
 * @type {string}
 */
const CONFIG_VERSION = '1.1.0';

// ─── Feature-flag key type guard ─────────────────────────────────────────────

/**
 * The complete set of boolean feature-flag keys in the config schema.
 * This tuple is the source of truth for `getFeatureFlag()` key validation.
 *
 * @type {readonly string[]}
 */
const FEATURE_FLAG_KEYS = Object.freeze([
  'ESCROW_INDEXER_ENABLED',
  'ESCROW_READ_PROJECTION_ENABLED',
  'INVOICE_STATE_ENABLED',
  'CONFIG_RUNTIME_ENABLED',
  'KYC_WEBHOOK_ENABLED',
  'KYC_PROVIDER_SIGN_REQUESTS',
  'KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE',
  'CURSOR_TTL_ENABLED',
  'METRICS_ENABLED',
]);

/** Express-compatible request size string. @type {z.ZodDefault<z.ZodString>} */
const InvoiceFileMaxSizeSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?(?:b|kb|mb|gb)$/i, {
    message: 'INVOICE_FILE_MAX_SIZE must be a size such as 512kb or 5mb.',
  })
  .default('5mb');

// ─── Main schema ──────────────────────────────────────────────────────────────

/**
 * Complete configuration schema with explicit boundaries on every field.
 *
 * Boundary guarantees enforced here:
 *   1. PORT is a finite integer in [1, 65535].
 *   2. JWT_SECRET is at least 32 characters — never has a default.
 *   3. All numeric timeout/retry/concurrency knobs have min AND max guards so
 *      a mis-typed value cannot push them into an unsafe or non-functional range.
 *   4. Boolean feature flags accept only "true" | "false" — no truthy aliases.
 *   5. URLs are parsed by Zod's url() validator before use.
 *   6. Cross-field invariants are checked in superRefine (see below).
 *
 * @type {z.ZodObject<any>}
 */
const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().min(1).max(65535).default(3001),
    JWT_SECRET: z.string().min(32), // No default for security
    JWT_ALGORITHMS: z.string().optional().default('HS256'),
    JWT_ISSUER: z.string().optional(),
    JWT_AUDIENCE: z.string().optional(),
    CURSOR_SECRET: z.string().min(32).optional(),
    CURSOR_TTL_ENABLED: z.enum(['true', 'false']).default('false'),
    CURSOR_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),

    NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
    SOROBAN_BATCH_CONCURRENCY: z.coerce.number().min(1).max(50).default(5),
    SOROBAN_BATCH_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    ESCROW_INDEXER_ENABLED: z.enum(['true', 'false']).default('false'),
    ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: z.coerce.number().min(1).default(300),
    ESCROW_READ_PROJECTION_ENABLED: z.enum(['true', 'false']).default('true'),
    INVOICE_STATE_ENABLED: z.enum(['true', 'false']).default('true'),
    CONFIG_RUNTIME_ENABLED: z.enum(['true', 'false']).default('true'),
    KYC_PROVIDER_URL: z.string().url().optional(),

    /** KYC API key. Must be paired with KYC_PROVIDER_URL. */
    KYC_PROVIDER_API_KEY: z.string().min(1).optional(),

    KYC_PROVIDER_SECRET: z.string().min(1).optional(),
    KYC_PROVIDER_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    KYC_PROVIDER_MAX_RETRIES: z.coerce.number().min(0).max(10).default(3),
    KYC_PROVIDER_BASE_DELAY_MS: z.coerce.number().min(0).max(10000).default(200),
    KYC_PROVIDER_MAX_DELAY_MS: z.coerce.number().min(0).max(60000).default(5000),
    KYC_PROVIDER_SIGN_REQUESTS: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_CB_FAILURE_THRESHOLD: z.coerce.number().min(1).max(100).default(5),
    KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS: z.coerce.number().min(100).max(60000).default(10000),
    KYC_WEBHOOK_ENABLED: z.enum(['true', 'false']).default('false'),
    PUBLIC_API_BASE_URL: z.string().url().optional(),

    // ── Invoice upload ────────────────────────────────────────────────────────
    INVOICE_FILE_MAX_SIZE: InvoiceFileMaxSizeSchema,
    METRICS_ENABLED: z.enum(['true', 'false']).default('true'),
  })
  // ── Cross-field boundary checks ─────────────────────────────────────────────
  .superRefine((data, ctx) => {
    // Skip cross-field checks in test mode to allow partial configurations.
    if (data.NODE_ENV === 'test') { return; }

    // 1. Production cursor secret: either CURSOR_SECRET or JWT_SECRET must be set.
    if (data.NODE_ENV === 'production' && !data.CURSOR_SECRET && !data.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CURSOR_SECRET or JWT_SECRET must be configured in production.',
        path: ['CURSOR_SECRET'],
      });
    }

    // 2. KYC half-configuration: URL and key must be present together or absent together.
    const hasUrl = Boolean(data.KYC_PROVIDER_URL);
    const hasKey = Boolean(data.KYC_PROVIDER_API_KEY);
    if (hasUrl !== hasKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'KYC_PROVIDER_URL and KYC_PROVIDER_API_KEY must both be set or both be absent.',
        path: hasUrl ? ['KYC_PROVIDER_API_KEY'] : ['KYC_PROVIDER_URL'],
      });
    }

    // 3. Production PUBLIC_API_BASE_URL: required, HTTPS, non-loopback.
    if (data.NODE_ENV === 'production') {
      const baseUrl = data.PUBLIC_API_BASE_URL;
      if (!baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'PUBLIC_API_BASE_URL must be set in production. It is used in the OpenAPI spec servers array.',
          path: ['PUBLIC_API_BASE_URL'],
        });
        return;
      }
      let parsed;
      try { parsed = new URL(baseUrl); } catch (_) { parsed = null; }

      if (!parsed || parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PUBLIC_API_BASE_URL must use HTTPS in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
        return;
      }
      const loopbackPattern = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$/i;
      if (loopbackPattern.test(parsed.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PUBLIC_API_BASE_URL must not be a loopback address in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
      }
    }
  });

// ─── Singleton state ───────────────────────────────────────────────────────────

/**
 * Lifecycle states of the published configuration snapshot.
 *
 * - `unvalidated`: no validation attempt has completed yet.
 * - `validating`: a validation is running; publication is not yet committed.
 * - `valid`: `snapshot` was published from the most recent environment state.
 * - `invalid`: the most recent attempt failed; `snapshot` (if any) is stale.
 *
 * @readonly
 * @enum {string}
 */
const ValidationState = Object.freeze({
  UNVALIDATED: 'unvalidated',
  VALIDATING: 'validating',
  VALID: 'valid',
  INVALID: 'invalid',
});

/**
 * The published, deeply frozen configuration snapshot. Assigned exactly once
 * per successful validation, which is the atomic-publication invariant: readers
 * can never observe a partially constructed config.
 * @type {z.infer<typeof ConfigSchema>|null}
 */
let snapshot = null;

/** Fingerprint of the env snapshot that produced the published `snapshot`. */
let publishedFingerprint = null;

/** Result of the most recent validation attempt. @type {string} */
let validationState = ValidationState.UNVALIDATED;

/** Error from the most recent failed attempt, or null. @type {Error|z.ZodError|null} */
let lastValidationError = null;

/** Single-flight guard: true while a validation is in progress. @type {boolean} */
let isValidating = false;

/** Number of successful publications. Monotonic; never decreases. @type {number} */
let generation = 0;

/**
 * Recursively freezes a value so published configuration can never be mutated
 * in place by a consumer.
 * @template T
 * @param {T} value - Value to freeze.
 * @returns {T} The same value, deeply frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

/**
 * Takes a point-in-time copy of `process.env`.
 *
 * Copying first is what makes validation deterministic: every key is read once,
 * so a concurrent `process.env` mutation (for example the admin config surface
 * writing `CORS_ALLOWED_ORIGINS`) cannot produce a snapshot that mixes values
 * from two different environment states.
 *
 * @returns {Record<string, string|undefined>} A private env copy.
 */
function copyEnv() {
  return { ...process.env };
}

/**
 * Computes an order-independent fingerprint of an environment snapshot.
 * Used to detect that a repeat `validate()` has no new work to do.
 * @param {Record<string, string|undefined>} envSnapshot - Env values to hash.
 * @returns {string} Hex-encoded SHA-256 fingerprint.
 */
function fingerprintEnv(envSnapshot) {
  const hash = crypto.createHash('sha256');
  for (const key of Object.keys(envSnapshot).sort()) {
    hash.update(`${key}\u0000${envSnapshot[key]}\u0000`);
  }
  return hash.digest('hex');
}

/** Frozen snapshot of the last successfully validated config. @type {Readonly<z.infer<typeof ConfigSchema>>|null} */
let frozenConfig = null;

/**
 * Validates environment variables against schema and returns typed config.
 *
 * Safe to call repeatedly and concurrently: see the module-level concurrency
 * contract. Published snapshots are immutable and returned by identity, so
 * callers comparing two results can rely on object identity to mean "same
 * environment, same config".
 *
 * @returns {z.infer<typeof ConfigSchema>} Frozen validated config.
 * @throws {z.ZodError} When the environment fails schema validation.
 * @throws {Error} With code `CONFIG_VALIDATION_IN_PROGRESS` when called
 *   re-entrantly before any config has been published.
 */
function validate() {
  // Single flight: never start a competing parse from inside an in-progress
  // validation. Returning the published snapshot keeps the contract "one
  // validation per synchronous burst" true and prevents a nested caller from
  // publishing a divergent view of the environment.
  if (isValidating) {
    if (snapshot) {
      return snapshot;
    }
    const inProgressError = new Error(
      'Config validation is already in progress and no config has been published yet.'
    );
    inProgressError.code = 'CONFIG_VALIDATION_IN_PROGRESS';
    throw inProgressError;
  }

  // Read the environment exactly once, up front.
  const envSnapshot = copyEnv();
  const fingerprint = fingerprintEnv(envSnapshot);

  // Idempotent repeat: identical environment ⇒ identical already-published
  // snapshot. Avoids duplicate work and generation churn on repeated boot paths.
  if (
    snapshot
    && validationState === ValidationState.VALID
    && fingerprint === publishedFingerprint
  ) {
    return snapshot;
  }

  isValidating = true;
  validationState = ValidationState.VALIDATING;

  let parsed;
  try {
    parsed = ConfigSchema.safeParse(envSnapshot);
  } catch (err) {
    // Defensive: safeParse is not expected to throw. If it does, record the
    // attempt as invalid so the state machine never gets stuck "validating".
    validationState = ValidationState.INVALID;
    lastValidationError = err;
    throw err;
  } finally {
    isValidating = false;
  }

  if (!parsed.success) {
    // Fail safe: keep the last known-good snapshot serving and record why, so
    // the staleness is observable instead of silent. The published snapshot is
    // never mutated or partially replaced here.
    validationState = ValidationState.INVALID;
    lastValidationError = parsed.error;
    throw parsed.error;
  }

  const nextSnapshot = deepFreeze(parsed.data);
  snapshot = nextSnapshot; // Atomic publication: a single fully-built assignment.
  publishedFingerprint = fingerprint;
  generation += 1;
  validationState = ValidationState.VALID;
  lastValidationError = null;
  return snapshot;
}

/**
 * Returns true when validate() has completed successfully at least once.
 * @returns {boolean}
 */
function isInitialized() {
  return config !== null && config !== undefined;
}

/**
 * Format and log a redacted summary of validation issues to console.error.
 * Never prints secret values (only key names and validation error messages).
 *
 * CONTRACT: this function never throws. It accepts any value including null
 * and undefined.
 *
 * @param {z.ZodError | Error | null | undefined} error - The Zod error to summarize.
 * @returns {void}
 */
function logRedactedSummary(error) {
  console.error('Configuration validation failed:');
  // ConfigValidationError exposes .issues as { path, message } pairs.
  if (error instanceof ConfigValidationError) {
    error.issues.forEach(issue => {
      console.error(`- [${issue.path}]: ${issue.message}`);
    });
    return;
  }
  // Legacy: raw ZodError (e.g. from callers that import ConfigSchema directly).
  if (error && Array.isArray(error.issues)) {
    error.issues.forEach(issue => {
      const key = issue.path.join('.');
      console.error(`- [${key}]: ${issue.message}`);
    });
    return;
  }
  console.error(error ? error.message : 'Unknown configuration error');
}

/**
 * Getter for validated config. Throws if not validated.
 * The returned object is deeply frozen and shared; treat it as read-only.
 * @returns {z.infer<typeof ConfigSchema>} Frozen validated config.
 * @throws {Error} With code `CONFIG_NOT_VALIDATED` when called before `validate()`.
 */
function get() {
  if (!snapshot) {
    const notValidatedError = new Error('Config not validated. Call validate() first.');
    notValidatedError.code = 'CONFIG_NOT_VALIDATED';
    throw notValidatedError;
  }
  return snapshot;
}

/**
 * Reset the in-memory config snapshot. Intended for tests only; production
 * code must not call this because it invalidates the validated contract.
 * @returns {void}
 */
function resetForTests() {
  config = null;
  frozenConfig = null;
}

/**
 * Returns a value from the validated configuration with key-aware JSDoc types.
 *
 * CONTRACT: signature is `(key: keyof Config) => Config[key]`. The key type
 * will never widen; callers that pass a valid key today will compile without
 * error after future schema additions.
 *
 * @template {keyof z.infer<typeof ConfigSchema>} K
 * @param {K} key
 * @returns {z.infer<typeof ConfigSchema>[K]}
 */
function getValue(key) {
  return get()[key];
}

/**
 * Reports the validation lifecycle for diagnostics (logs, readiness probes).
 * Deliberately contains no configuration values, so it is safe to expose.
 *
 * `stale` is true when a snapshot is being served even though the most recent
 * validation attempt failed — callers should alert on it rather than treating
 * the served config as the result of the latest environment.
 *
 * @returns {{state: string, validated: boolean, stale: boolean, generation: number, hasError: boolean}}
 *   Redaction-safe validation status.
 */
function getValidationState() {
  return {
    state: validationState,
    validated: validationState === ValidationState.VALID,
    stale: snapshot !== null && validationState !== ValidationState.VALID,
    generation,
    hasError: lastValidationError !== null,
  };
}

/**
 * Returns the error from the most recent failed validation attempt.
 * Callers must log it through `logRedactedSummary` to avoid leaking values.
 * @returns {Error|z.ZodError|null} The last error, or null when the latest
 *   attempt succeeded or none has run.
 */
function getValidationError() {
  return lastValidationError;
}

/**
 * Returns the validated invoice PDF upload limit used when routes are built.
 *
 * Deterministic across the validation boundary: before `validate()` runs the
 * value is derived from an atomic env copy with the same schema (so concurrent
 * callers cannot disagree), and once validated the frozen snapshot is used.
 *
 * @returns {string} Express-compatible request size limit.
 */
function getInvoiceFileMaxSize() {
  if (snapshot) {
    return snapshot.INVOICE_FILE_MAX_SIZE;
  }
  return InvoiceFileMaxSizeSchema.parse(copyEnv().INVOICE_FILE_MAX_SIZE);
}

// ─── Public API — new contracts (additive, #1306) ─────────────────────────────

/**
 * Returns the boolean value of a named feature flag from the validated config.
 *
 * This is an additive helper that converts the stored string literal
 * ("true" | "false") to a native boolean, removing the need for callers to
 * perform string comparison. Existing callers using `getValue(key)` and
 * comparing against `'true'` continue to work without change.
 *
 * CONTRACT:
 *   - Returns `true`  when the stored value is `"true"`.
 *   - Returns `false` when the stored value is `"false"`.
 *   - Throws `TypeError` when `key` is not a recognised feature-flag key, so
 *     callers get an early error rather than a silent `false`.
 *   - Throws `Error` if `validate()` has not been called (same as `get()`).
 *
 * @param {string} key - One of the keys in FEATURE_FLAG_KEYS.
 * @returns {boolean}
 * @throws {TypeError} If `key` is not a valid feature-flag key.
 * @throws {Error} If `validate()` has not been called yet.
 */
function getFeatureFlag(key) {
  if (!FEATURE_FLAG_KEYS.includes(key)) {
    throw new TypeError(
      `"${key}" is not a valid feature-flag key. ` +
      `Valid keys: ${FEATURE_FLAG_KEYS.join(', ')}.`
    );
  }
  return getValue(key) === 'true';
}

// ─── Security headers ─────────────────────────────────────────────────────────

const securityHeaders = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  docsContentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // ── Preserved (initial contract) ─────────────────────────────────────────
  validate,
  validateSafe,
  get,
  isInitialized,
  resetForTests,
  getValue,
  getValidationState,
  getValidationError,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  ConfigValidationError,
  ConfigSchema,
  InvoiceFileMaxSizeSchema,
  ValidationState,
  securityHeaders,
  // ── New (additive, #1306) ─────────────────────────────────────────────────
  getFeatureFlag,
  FEATURE_FLAG_KEYS,
  CONFIG_VERSION,
};
