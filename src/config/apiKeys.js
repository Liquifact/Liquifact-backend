/**
 * API Key configuration and registry.
 *
 * Parses and validates the API key store from the environment variable
 * `API_KEYS`. Each entry is a JSON-formatted object in a semicolon-separated
 * list. Example:
 *
 *   API_KEYS={"key":"lf_abc123","clientId":"service-a","scopes":["invoices:read"]};{"key":"lf_xyz789","clientId":"service-b","scopes":["invoices:write","escrow:read"],"revoked":true}
 *
 * ## Compatibility contract (covered by tests/apiKeys.compat.test.js)
 *
 * - Public exports and their signatures are stable.
 * - Absent, empty or whitespace-only `API_KEYS` yields an empty registry (auth stays optional).
 * - Empty chunks between `;` are skipped; the `[index]` in error messages counts non-empty chunks only.
 * - Entries are validated in a fixed order: object shape, unknown fields, key, clientId, scopes, revoked.
 *   The first failing check throws; nothing is partially registered.
 * - `key` and `clientId` are trimmed before storage. `revoked` defaults to `false`.
 * - Duplicate `key` values are rejected; revoked keys stay in the registry (rejected at auth time).
 * - The registry is rebuilt on every call (no module-level cache), so a retry is deterministic.
 * - Because entries are split on `;`, a `;` inside a JSON string value fails closed with a parse error.
 *
 * ## Secrecy contract
 *
 * Error messages never contain a key value. JSON parser messages are deliberately
 * not forwarded, because they can echo a snippet of the raw input (i.e. the key).
 *
 * @module config/apiKeys
 */

'use strict';

const logger = require('../logger');

/** Prefix that every valid API key must carry. */
const API_KEY_PREFIX = 'lf_';

/**
 * All scopes recognised by the system.
 * @type {string[]}
 */
const VALID_SCOPES = Object.freeze([
  'invoices:read',
  'invoices:write',
  'escrow:read',
  'admin',
]);

/**
 * The minimum required length of the full API key (prefix included),
 * measured after trimming surrounding whitespace.
 * @type {number}
 */
const MIN_KEY_LENGTH = 10;

/**
 * The maximum permitted length of the full API key string.
 * @type {number}
 */
const MAX_KEY_LENGTH = 256;

/**
 * The maximum permitted length of a clientId string.
 * @type {number}
 */
const MAX_CLIENT_ID_LENGTH = 128;

/**
 * The maximum number of scopes a single key can hold.
 * @type {number}
 */
const MAX_SCOPES_COUNT = 20;

/**
 * The maximum number of entries a single `API_KEYS` value may declare.
 *
 * Bounds the work performed while recovering from a malformed value: a hostile
 * or accidentally truncated value cannot force an unbounded parse loop.
 * @type {number}
 */
const MAX_ENTRIES_COUNT = 500;

/**
 * The maximum permitted length of the raw `API_KEYS` string.
 * @type {number}
 */
const MAX_RAW_LENGTH = 262144;

/**
 * The maximum number of characters retained from a sanitized JSON parser
 * message before it is truncated.
 * @type {number}
 */
const MAX_PARSER_MESSAGE_LENGTH = 120;

/**
 * The default number of load attempts (initial try + retries) performed by
 * {@link tryLoadApiKeyRegistry}.
 * @type {number}
 */
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * The hard ceiling on attempts, so a caller-supplied `maxAttempts` cannot turn
 * recovery into a spin loop.
 * @type {number}
 */
const MAX_ATTEMPTS_CAP = 5;

/**
 * The default delay between retries, in milliseconds.
 *
 * Zero keeps recovery deterministic and keeps the synchronous loader from
 * blocking the event loop. Supply `retryDelayMs` when backoff is wanted.
 * @type {number}
 */
const DEFAULT_RETRY_DELAY_MS = 0;

/**
 * Fallback strategy identifiers accepted by {@link tryLoadApiKeyRegistry}.
 * @type {Readonly<Record<string, string>>}
 */
const API_KEY_FALLBACK = Object.freeze({
  /** Fail closed: serve an empty registry so every lookup misses. */
  EMPTY: 'empty',
  /** Serve the most recent fully validated non-empty registry. */
  LAST_KNOWN_GOOD: 'last_known_good',
});

/**
 * Stable, machine-readable failure codes attached to every
 * {@link ApiKeyConfigError}. Log aggregation and alerting key off these, so
 * they must not change casually.
 * @type {Readonly<Record<string, string>>}
 */
const API_KEY_CONFIG_ERROR_CODES = Object.freeze({
  RAW_VALUE_NOT_A_STRING: 'API_KEYS_NOT_A_STRING',
  RAW_VALUE_TOO_LARGE: 'API_KEYS_TOO_LARGE',
  TOO_MANY_ENTRIES: 'API_KEYS_TOO_MANY_ENTRIES',
  JSON_PARSE_FAILED: 'API_KEYS_JSON_PARSE_FAILED',
  INVALID_ENTRY: 'API_KEYS_INVALID_ENTRY',
  UNKNOWN_FIELD: 'API_KEYS_UNKNOWN_FIELD',
  DUPLICATE_KEY: 'API_KEYS_DUPLICATE_KEY',
  ENTRIES_NOT_ARRAY: 'API_KEYS_ENTRIES_NOT_ARRAY',
  ENTRY_NOT_OBJECT: 'API_KEYS_ENTRY_NOT_OBJECT',
  ENV_SOURCE_FAILED: 'API_KEYS_ENV_SOURCE_FAILED',
  UNKNOWN: 'API_KEYS_UNKNOWN_ERROR',
});

/**
 * OS-level error codes that indicate a *transient* failure. Only errors
 * carrying one of these are eligible for retry; everything else is treated as
 * permanent so that deterministic failures fail fast and predictably.
 * @type {Set<string>}
 */
const RETRYABLE_OS_ERROR_CODES = new Set([
  'EAGAIN',
  'EWOULDBLOCK',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ETIMEDOUT',
  'ECONNRESET',
]);

/**
 * Known fields for an API key entry. Any field not in this set is
 * treated as an unknown / unsupported key.
 * @type {Set<string>}
 */
const KNOWN_ENTRY_FIELD_NAMES = Object.freeze(['key', 'clientId', 'scopes', 'revoked']);
const KNOWN_ENTRY_FIELD_SET = new Set(KNOWN_ENTRY_FIELD_NAMES);
// Keep the historical Set export, but do not let callers mutate validation.
const KNOWN_ENTRY_FIELDS = new Set(KNOWN_ENTRY_FIELD_NAMES);

/**
 * @typedef {Object} ApiKeyEntry
 * @property {string}   key      - The raw API key string (must start with `lf_`).
 * @property {string}   clientId - Unique identifier for the service client.
 * @property {readonly string[]} scopes - Permissions granted to this key.
 * @property {boolean}  revoked  - When `true` the key is rejected at auth time.
 */

/**
 * The outcome of a resilient load attempt.
 *
 * @typedef {Object} ApiKeyLoadResult
 * @property {boolean}        ok              - `true` when the registry parsed and validated cleanly.
 * @property {'ok'|'empty'|'degraded'} status - `ok` (entries loaded), `empty` (feature disabled /
 *   no entries / failed closed) or `degraded` (served from a last-known-good registry).
 * @property {Map<string, ApiKeyEntry>} registry - Always safe to use; never `null`.
 * @property {ApiKeyEntry[]} entries            - Entries backing `registry`, in load order.
 * @property {ApiKeyConfigError|null} error     - Typed failure, or `null` on success.
 * @property {string|null} errorCode            - Stable failure code, or `null` on success.
 * @property {number}        attempts           - How many attempts were made (>= 1).
 * @property {string|null}  fallbackUsed       - Fallback strategy that produced `registry`.
 * @property {string}        source             - Where the raw value came from (for telemetry).
 */

/**
 * Typed configuration error for the API key registry.
 *
 * Carries a stable `code`, the `index` of the offending entry (when known), and
 * a `retryable` verdict so callers can decide between retrying, failing closed,
 * or surfacing the problem without string-matching messages.
 */
class ApiKeyConfigError extends Error {
  /**
   * Creates a typed configuration error.
   *
   * @param {string} message - Human-readable, key-material-free description.
   * @param {Object} [options={}] - Error metadata.
   * @param {string} [options.code] - One of {@link API_KEY_CONFIG_ERROR_CODES}.
   * @param {number} [options.index] - Position of the offending entry, when known.
   * @param {boolean} [options.retryable=false] - Whether a retry could plausibly succeed.
   * @param {Error} [options.cause] - The underlying error, when this wraps one.
   */
  constructor(message, options = {}) {
    const { code = API_KEY_CONFIG_ERROR_CODES.UNKNOWN, index, retryable = false, cause } = options;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiKeyConfigError';
    this.code = code;
    this.retryable = Boolean(retryable);
    if (index !== undefined) {
      this.index = index;
    }
  }
}

/**
 * Builds a typed entry-validation error.
 *
 * @param {string} message - Description placed after the `API_KEYS[i]:` prefix.
 * @param {number} index - Position in the input list.
 * @param {string} [code] - Failure code; defaults to `INVALID_ENTRY`.
 * @returns {ApiKeyConfigError} The error to throw.
 */
function entryError(message, index, code = API_KEY_CONFIG_ERROR_CODES.INVALID_ENTRY) {
  return new ApiKeyConfigError(`API_KEYS[${index}]: ${message}`, { code, index });
}

/**
 * Strips verbatim input excerpts out of a `JSON.parse` failure message.
 *
 * V8 (Node >= 20) frequently quotes the offending input directly, e.g.
 * `Unexpected token 'l', "lf_realkey0001" is not valid JSON`. Feeding that
 * straight into a log line or an HTTP 500 body would leak key material, so
 * quoted runs are replaced and the result is clipped to a fixed length.
 *
 * @param {unknown} message - The raw parser message.
 * @returns {string} A sanitized, bounded, key-material-free description.
 */
function sanitizeParserMessage(message) {
  if (typeof message !== 'string' || message.trim() === '') {
    return 'invalid JSON';
  }

  const withoutExcerpt = message
    .replace(/"(?:[^"\\]|\\.)*"/g, '"<redacted>"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'<redacted>'")
    .split('\n')[0]
    .trim();

  if (withoutExcerpt === '') {
    return 'invalid JSON';
  }

  return withoutExcerpt.length > MAX_PARSER_MESSAGE_LENGTH
    ? `${withoutExcerpt.slice(0, MAX_PARSER_MESSAGE_LENGTH - 1)}…`
    : withoutExcerpt;
}

/**
 * Normalizes any thrown value into a stable, redaction-safe verdict.
 *
 * The raw `err.message` of an unclassified error is deliberately discarded: an
 * error raised outside this module (for example by a custom `process.env`
 * getter) can embed arbitrary content, including key material.
 *
 * @param {unknown} err - The thrown value.
 * @returns {{code: string, retryable: boolean, message: string, index: (number|undefined)}} Verdict.
 */
function classifyApiKeyConfigError(err) {
  if (err instanceof ApiKeyConfigError) {
    return {
      code: err.code,
      retryable: err.retryable,
      message: err.message,
      index: err.index,
    };
  }

  if (err !== null && typeof err === 'object') {
    const rawCode = /** @type {{ code?: unknown }} */ (err).code;
    const osCode = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
    if (RETRYABLE_OS_ERROR_CODES.has(osCode)) {
      return {
        code: API_KEY_CONFIG_ERROR_CODES.ENV_SOURCE_FAILED,
        retryable: true,
        message: `API_KEYS: environment source failed with a transient error (${osCode})`,
        index: undefined,
      };
    }
  }

  return {
    code: API_KEY_CONFIG_ERROR_CODES.UNKNOWN,
    retryable: false,
    message: 'API_KEYS: configuration load failed for an unclassified reason',
    index: undefined,
  };
}

/**
 * Determines whether a thrown value is worth retrying.
 *
 * @param {unknown} err - The thrown value.
 * @returns {boolean} `true` only for transient, classification-backed errors.
 */
function isRetryableApiKeyConfigError(err) {
  return classifyApiKeyConfigError(err).retryable === true;
}

/**
 * Converts a thrown value into the {@link ApiKeyConfigError} attached to a
 * load result, preserving the original failure as `cause` and re-applying the
 * sanitized verdict.
 *
 * @param {unknown} err - The thrown value.
 * @param {ReturnType<typeof classifyApiKeyConfigError>} [verdict] - Pre-computed verdict.
 * @returns {ApiKeyConfigError} A typed, redaction-safe error.
 */
function toApiKeyConfigError(err, verdict = classifyApiKeyConfigError(err)) {
  if (err instanceof ApiKeyConfigError) {
    return err;
  }
  return new ApiKeyConfigError(verdict.message, {
    code: verdict.code,
    index: verdict.index,
    retryable: verdict.retryable,
    cause: err instanceof Error ? err : undefined,
  });
}

/**
 * Emits the single structured log line describing a failed registry load.
 *
 * Only the stable code, retry verdict, attempt count and chosen fallback are
 * logged — never the raw value, an entry, or a parser excerpt.
 *
 * @param {ReturnType<typeof classifyApiKeyConfigError>} verdict - Failure verdict.
 * @param {Object} context - Recovery context.
 * @param {number} context.attempts - Attempts made before giving up.
 * @param {string} context.fallback - Fallback strategy that was applied.
 * @param {string} context.source - Where the raw value was read from.
 * @returns {void}
 */
function logApiKeyConfigFailure(verdict, context) {
  logger.error(
    {
      event: 'api_key.config_load_failed',
      error_code: verdict.code,
      error_type: verdict.code,
      retryable: verdict.retryable,
      entry_index: verdict.index,
      attempts: context.attempts,
      fallback: context.fallback,
      source: context.source,
      message: verdict.message,
    },
    'API key registry load failed; serving a safe fallback state',
  );
}

/**
 * Detects and reports unknown fields in an API key entry object.
 *
 * `Object.keys` also surfaces own `__proto__` properties created by
 * `JSON.parse`, so a prototype-pollution attempt through `API_KEYS` is
 * rejected here like any other unknown field.
 *
 * @param {object} entry - The raw entry object.
 * @param {number} index - Position in the input list (for error messages).
 * @returns {void}
 * @throws {ApiKeyConfigError} When any unknown field is present.
 */
function rejectUnknownFields(entry, index) {
  const extraKeys = Object.keys(entry).filter(
    (k) => !KNOWN_ENTRY_FIELD_SET.has(k)
  );
  if (extraKeys.length > 0) {
    throw entryError(
      `unknown field(s) "${extraKeys.join('", "')}" — only "key", "clientId", "scopes", and "revoked" are supported`,
      index,
      API_KEY_CONFIG_ERROR_CODES.UNKNOWN_FIELD,
    );
  }
}

/**
 * Validates that a raw key entry object satisfies all structural and value
 * constraints before it is admitted to the registry.
 *
 * The returned entry is frozen: a validated entry is the single source of truth
 * for a key, and allowing a caller to mutate it in place would make
 * authentication depend on call order.
 *
 * @param {unknown} entry - Candidate entry decoded from the environment.
 * @param {number}  index - Position in the input list (for error messages).
 * @returns {ApiKeyEntry} The frozen, validated entry.
 * @throws {ApiKeyConfigError} When any field is missing, wrong type, or holds an invalid value.
 */
function validateEntry(entry, index) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw entryError('entry must be a JSON object', index);
  }

  // Reject unknown fields before detailed field validation
  rejectUnknownFields(entry, index);

  const { key, clientId, scopes, revoked } = entry;

  if (typeof key !== 'string' || key.trim() === '') {
    throw entryError('"key" must be a non-empty string', index);
  }

  // Validate the *normalized* value so that padding cannot smuggle a key past
  // the length bounds (e.g. ' lf_short ' is only 8 characters once trimmed).
  const normalizedKey = key.trim();

  if (!normalizedKey.startsWith(API_KEY_PREFIX)) {
    throw entryError(`"key" must start with "${API_KEY_PREFIX}"`, index);
  }

  // Invariant: the stored (trimmed) key must meet the minimum length, so the
  // check is made on the trimmed value. Otherwise whitespace padding could
  // smuggle in a key shorter than MIN_KEY_LENGTH.
  if (key.trim().length < MIN_KEY_LENGTH) {
    throw new Error(
      `API_KEYS[${index}]: "key" must be at least ${MIN_KEY_LENGTH} characters long`
    );
  }

  if (normalizedKey.length > MAX_KEY_LENGTH) {
    throw entryError(`"key" must not exceed ${MAX_KEY_LENGTH} characters`, index);
  }

  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw entryError('"clientId" must be a non-empty string', index);
  }

  const normalizedClientId = clientId.trim();

  if (normalizedClientId.length > MAX_CLIENT_ID_LENGTH) {
    throw entryError(
      `"clientId" must not exceed ${MAX_CLIENT_ID_LENGTH} characters`,
      index,
    );
  }

  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw entryError('"scopes" must be a non-empty array', index);
  }

  if (scopes.length > MAX_SCOPES_COUNT) {
    throw entryError(`"scopes" must not exceed ${MAX_SCOPES_COUNT} entries`, index);
  }

  const uniqueScopes = new Set();
  for (const scope of scopes) {
    if (!VALID_SCOPES.includes(scope)) {
      throw entryError(
        `unknown scope "${scope}". Valid scopes: ${VALID_SCOPES.join(', ')}`,
        index,
      );
    }
    if (uniqueScopes.has(scope)) {
      throw new Error(`API_KEYS[${index}]: duplicate scope "${scope}"`);
    }
    uniqueScopes.add(scope);
  }

  if (revoked !== undefined && typeof revoked !== 'boolean') {
    throw entryError('"revoked" must be a boolean when present', index);
  }

  return Object.freeze({
    key: normalizedKey,
    clientId: normalizedClientId,
    scopes: Object.freeze([...scopes]),
    revoked: Boolean(revoked),
  });
}

/**
 * Reads the raw `API_KEYS` value from an environment source.
 *
 * The property read is isolated so that a source with a throwing getter (a
 * `Proxy`, or a patched `process.env`) surfaces as a retryable typed error
 * instead of an opaque `TypeError`.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variables source.
 * @returns {string|undefined} The raw value, possibly `undefined`.
 * @throws {ApiKeyConfigError} When the source is unusable or the read fails.
 */
function readApiKeysEnv(env = process.env) {
  if (env === null || typeof env !== 'object') {
    throw new ApiKeyConfigError('API_KEYS: environment source must be an object', {
      code: API_KEY_CONFIG_ERROR_CODES.RAW_VALUE_NOT_A_STRING,
    });
  }

  try {
    return env.API_KEYS;
  } catch (err) {
    const rawCode =
      err !== null && typeof err === 'object'
        ? /** @type {{ code?: unknown }} */ (err).code
        : undefined;
    const osCode = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
    throw new ApiKeyConfigError(
      `API_KEYS: environment source could not be read${
        RETRYABLE_OS_ERROR_CODES.has(osCode) ? ` (${osCode})` : ''
      }`,
      {
        code: API_KEY_CONFIG_ERROR_CODES.ENV_SOURCE_FAILED,
        retryable: RETRYABLE_OS_ERROR_CODES.has(osCode),
        cause: err instanceof Error ? err : undefined,
      },
    );
  }
}

/**
 * Parses the raw `API_KEYS` environment variable string into a list of
 * validated {@link ApiKeyEntry} objects.
 *
 * Returns an empty array when the variable is absent or blank so that the
 * middleware can remain in an optional / disabled state without crashing.
 *
 * @param {string | undefined} raw - The raw value of the `API_KEYS` env var.
 * @returns {ApiKeyEntry[]} Ordered list of parsed and validated key entries.
 * @throws {ApiKeyConfigError} When any entry fails structural or value validation.
 */
function parseApiKeys(raw) {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (typeof raw !== 'string') {
    throw new ApiKeyConfigError(
      `API_KEYS: must be a string (received ${typeof raw})`,
      { code: API_KEY_CONFIG_ERROR_CODES.RAW_VALUE_NOT_A_STRING },
    );
  }

  if (raw.trim() === '') {
    return [];
  }

  if (raw.length > MAX_RAW_LENGTH) {
    throw new ApiKeyConfigError(`API_KEYS: must not exceed ${MAX_RAW_LENGTH} characters`, {
      code: API_KEY_CONFIG_ERROR_CODES.RAW_VALUE_TOO_LARGE,
    });
  }

  const chunks = raw
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, index) => {
      let parsed;
      try {
        parsed = JSON.parse(chunk);
      } catch (_err) {
        // Do NOT forward _err.message: V8 parser errors can echo a snippet of
        // the input, which here contains the raw API key.
        throw new Error(
          `API_KEYS[${index}]: failed to parse JSON — entry is not valid JSON (parser details withheld to avoid exposing key material)`
        );
      }
      return validateEntry(parsed, index);
    });
}

/**
 * Builds a Map from key string → {@link ApiKeyEntry} for O(1) lookup.
 *
 * @param {ApiKeyEntry[]} entries - The list produced by {@link parseApiKeys}.
 * @returns {Map<string, ApiKeyEntry>} Lookup map keyed by the raw key string.
 * @throws {ApiKeyConfigError} When `entries` is not an array, holds a non-object,
 *   or the same key string appears more than once.
 */
function buildKeyRegistry(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('API_KEYS: entries must be an array');
  }

  const registry = new Map();

  // Validate and normalize every input, even for callers that bypass parsing.
  // The local map is returned only after all entries pass validation.
  for (const [index, candidate] of entries.entries()) {
    const validated = validateEntry(candidate, index);
    // The registry owns an immutable snapshot; caller-owned objects and arrays
    // cannot later change key identity, client metadata, revocation, or scopes.
    const entry = Object.freeze({
      ...validated,
      scopes: Object.freeze([...validated.scopes]),
    });
    if (registry.has(entry.key)) {
      throw new Error(
        `API_KEYS: duplicate key detected for clientId "${entry.clientId}"`
      );
    }

    if (registry.has(entry.key)) {
      throw new ApiKeyConfigError(`API_KEYS: duplicate key detected for clientId "${entry.clientId}"`, {
        code: API_KEY_CONFIG_ERROR_CODES.DUPLICATE_KEY,
      });
    }

    registry.set(entry.key, entry);
  });

  return registry;
}

/**
 * Loads and returns the API key registry from the current process environment.
 *
 * The result is built fresh on every call so that unit tests can override
 * `process.env.API_KEYS` without module-level caching interfering. Callers that
 * must not propagate a configuration failure should prefer
 * {@link tryLoadApiKeyRegistry}, which resolves to a safe fallback instead of
 * throwing.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variables source.
 * @returns {Map<string, ApiKeyEntry>} The populated key registry.
 * @throws {ApiKeyConfigError} When any entry fails structural or value validation.
 */
function loadApiKeyRegistry(env = process.env) {
  const entries = parseApiKeys(readApiKeysEnv(env));
  return buildKeyRegistry(entries);
}

/**
 * @type {Map<string, ApiKeyEntry>|null}
 * Most recent fully validated non-empty registry, used only by the opt-in
 * `last_known_good` fallback. Never populated from a degraded load, so a bad
 * redeploy can never be promoted into the fallback.
 */
let lastKnownGoodRegistry = null;

/**
 * Default synchronous sleep, used only when a caller opts into a non-zero retry
 * delay. `Atomics.wait` keeps the loader synchronous without spinning the CPU.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {void}
 */
function blockingSleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Clamps a caller-supplied attempt count into a safe, deterministic range.
 *
 * @param {unknown} value - The requested attempt count.
 * @returns {number} An integer in `[1, MAX_ATTEMPTS_CAP]`.
 */
function clampAttempts(value) {
  const attempts = Number(value);
  if (!Number.isInteger(attempts) || attempts < 1) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.min(attempts, MAX_ATTEMPTS_CAP);
}

/**
 * Resolves the registry to serve after a failed load.
 *
 * @param {string} fallback - The requested fallback strategy.
 * @returns {{registry: Map<string, ApiKeyEntry>, source: string}} Fallback registry and its label.
 */
function resolveFallbackRegistry(fallback) {
  if (fallback === API_KEY_FALLBACK.LAST_KNOWN_GOOD && lastKnownGoodRegistry !== null) {
    return { registry: lastKnownGoodRegistry, source: API_KEY_FALLBACK.LAST_KNOWN_GOOD };
  }
  return { registry: new Map(), source: API_KEY_FALLBACK.EMPTY };
}

/**
 * Loads the API key registry without ever throwing.
 *
 * Retries only classification-backed transient failures, then resolves a
 * deterministic safe state and records exactly one structured log line. The
 * same environment value always produces the same result, which makes the
 * behaviour reproducible in tests and in incident response.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variables source.
 * @param {Object} [options={}] - Recovery options.
 * @param {number} [options.maxAttempts=DEFAULT_MAX_ATTEMPTS] - Total attempts, clamped to `MAX_ATTEMPTS_CAP`.
 * @param {number} [options.retryDelayMs=DEFAULT_RETRY_DELAY_MS] - Fixed (jitter-free) delay between retries.
 * @param {(ms: number) => void} [options.sleep=blockingSleep] - Injectable sleep, for deterministic tests.
 * @param {string} [options.fallback='empty'] - `empty` (fail closed) or `last_known_good`.
 * @param {string} [options.source='env'] - Free-form source label recorded in telemetry.
 * @returns {ApiKeyLoadResult} A frozen, always-usable result.
 */
function tryLoadApiKeyRegistry(env = process.env, options = {}) {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = blockingSleep,
    fallback = API_KEY_FALLBACK.EMPTY,
    source = 'env',
  } = options;

  const attemptsAllowed = clampAttempts(maxAttempts);
  let failure = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const entries = parseApiKeys(readApiKeysEnv(env));
      const registry = buildKeyRegistry(entries);

      if (registry.size > 0) {
        lastKnownGoodRegistry = registry;
      }

      return Object.freeze({
        ok: true,
        status: registry.size > 0 ? 'ok' : 'empty',
        registry,
        entries,
        error: null,
        errorCode: null,
        attempts: attempt,
        fallbackUsed: null,
        source,
      });
    } catch (err) {
      failure = err;
      if (!isRetryableApiKeyConfigError(err) || attempt === attemptsAllowed) {
        break;
      }
      sleep(retryDelayMs);
    }
  }

  const verdict = classifyApiKeyConfigError(failure);
  const recovered = resolveFallbackRegistry(fallback);

  logApiKeyConfigFailure(verdict, {
    attempts: attemptsUsed,
    fallback: recovered.source,
    source,
  });

  return Object.freeze({
    ok: false,
    status: recovered.registry.size > 0 ? 'degraded' : 'empty',
    registry: recovered.registry,
    entries: [...recovered.registry.values()],
    error: toApiKeyConfigError(failure, verdict),
    errorCode: verdict.code,
    attempts: attemptsUsed,
    fallbackUsed: recovered.source,
    source,
  });
}

/**
 * Returns the size of the retained last-known-good registry.
 *
 * Exposed for health checks and runbook diagnostics; returns `0` when no
 * successful non-empty load has happened in this process.
 *
 * @returns {number} Number of entries in the retained registry, or `0`.
 */
function getLastKnownGoodEntryCount() {
  return lastKnownGoodRegistry === null ? 0 : lastKnownGoodRegistry.size;
}

/**
 * Clears the retained last-known-good registry.
 *
 * Test-only escape hatch: a suite that exercises the `last_known_good` fallback
 * must reset this so state cannot leak between tests.
 *
 * @returns {void}
 */
function resetApiKeyRecoveryState() {
  lastKnownGoodRegistry = null;
}

module.exports = {
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES_COUNT,
  MAX_ENTRIES_COUNT,
  MAX_RAW_LENGTH,
  MAX_PARSER_MESSAGE_LENGTH,
  MAX_ATTEMPTS_CAP,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  KNOWN_ENTRY_FIELDS,
  VALID_SCOPES,
  API_KEY_FALLBACK,
  API_KEY_CONFIG_ERROR_CODES,
  RETRYABLE_OS_ERROR_CODES,
  ApiKeyConfigError,
  parseApiKeys,
  buildKeyRegistry,
  loadApiKeyRegistry,
  tryLoadApiKeyRegistry,
  readApiKeysEnv,
  validateEntry,
  rejectUnknownFields,
};