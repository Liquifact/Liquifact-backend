/**
 * API Key configuration and registry.
 *
 * Parses and validates the API key store from the environment variable
 * `API_KEYS`. Each entry is a JSON-formatted object in a semicolon-separated
 * list. Example:
 *
 *   API_KEYS={"key":"lf_abc123","clientId":"service-a","scopes":["invoices:read"]};{"key":"lf_xyz789","clientId":"service-b","scopes":["invoices:write","escrow:read"],"revoked":true}
 *
 * @module config/apiKeys
 */

/** Prefix that every valid API key must carry. */
const API_KEY_PREFIX = 'lf_';

/**
 * All scopes recognised by the system.
 * @type {string[]}
 */
const VALID_SCOPES = [
  'invoices:read',
  'invoices:write',
  'escrow:read',
];

/**
 * The minimum required length of the full API key (prefix included).
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
 * Known fields for an API key entry. Any field not in this set is
 * treated as an unknown / unsupported key.
 * @type {Set<string>}
 */
const KNOWN_ENTRY_FIELDS = new Set(['key', 'clientId', 'scopes', 'revoked']);

/**
 * @typedef {Object} ApiKeyEntry
 * @property {string}   key      - The raw API key string (must start with `lf_`).
 * @property {string}   clientId - Unique identifier for the service client.
 * @property {string[]} scopes   - Permissions granted to this key.
 * @property {boolean}  [revoked] - When `true` the key is rejected at auth time.
 */

/**
 * Detects and reports unknown fields in an API key entry object.
 *
 * @param {object} entry - The raw entry object.
 * @param {number} index - Position in the input list (for error messages).
 * @throws {Error} When any unknown field is present.
 */
function rejectUnknownFields(entry, index) {
  const extraKeys = Object.keys(entry).filter(
    (k) => !KNOWN_ENTRY_FIELDS.has(k)
  );
  if (extraKeys.length > 0) {
    throw new Error(
      `API_KEYS[${index}]: unknown field(s) "${extraKeys.join('", "')}" — only "key", "clientId", "scopes", and "revoked" are supported`
    );
  }
}

/**
 * Validates that a raw key entry object satisfies all structural and value
 * constraints before it is admitted to the registry.
 *
 * @param {unknown} entry - Candidate entry decoded from the environment.
 * @param {number}  index - Position in the input list (for error messages).
 * @returns {ApiKeyEntry} The validated entry cast to the expected shape.
 * @throws {Error} When any field is missing, wrong type, or holds an invalid value.
 */
function validateEntry(entry, index) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`API_KEYS[${index}]: entry must be a JSON object`);
  }

  // Reject unknown fields before detailed field validation
  rejectUnknownFields(entry, index);

  const { key, clientId, scopes, revoked } = entry;

  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error(`API_KEYS[${index}]: "key" must be a non-empty string`);
  }

  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new Error(
      `API_KEYS[${index}]: "key" must start with "${API_KEY_PREFIX}"`
    );
  }

  if (key.length < MIN_KEY_LENGTH) {
    throw new Error(
      `API_KEYS[${index}]: "key" must be at least ${MIN_KEY_LENGTH} characters long`
    );
  }

  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `API_KEYS[${index}]: "key" must not exceed ${MAX_KEY_LENGTH} characters`
    );
  }

  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error(`API_KEYS[${index}]: "clientId" must be a non-empty string`);
  }

  if (clientId.trim().length > MAX_CLIENT_ID_LENGTH) {
    throw new Error(
      `API_KEYS[${index}]: "clientId" must not exceed ${MAX_CLIENT_ID_LENGTH} characters`
    );
  }

  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(`API_KEYS[${index}]: "scopes" must be a non-empty array`);
  }

  if (scopes.length > MAX_SCOPES_COUNT) {
    throw new Error(
      `API_KEYS[${index}]: "scopes" must not exceed ${MAX_SCOPES_COUNT} entries`
    );
  }

  for (const scope of scopes) {
    if (!VALID_SCOPES.includes(scope)) {
      throw new Error(
        `API_KEYS[${index}]: unknown scope "${scope}". Valid scopes: ${VALID_SCOPES.join(', ')}`
      );
    }
  }

  if (revoked !== undefined && typeof revoked !== 'boolean') {
    throw new Error(`API_KEYS[${index}]: "revoked" must be a boolean when present`);
  }

  return {
    key: key.trim(),
    clientId: clientId.trim(),
    scopes: [...scopes],
    revoked: Boolean(revoked),
  };
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
 * @throws {Error} When any entry fails structural or value validation.
 */
function parseApiKeys(raw) {
  if (!raw || raw.trim() === '') {
    return [];
  }

  return raw
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, index) => {
      let parsed;
      try {
        parsed = JSON.parse(chunk);
      } catch (_err) {
        throw new Error(
          `API_KEYS[${index}]: failed to parse JSON — ${_err.message}`
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
 * @throws {Error} When the same key string appears more than once.
 */
function buildKeyRegistry(entries) {
  const registry = new Map();

  for (const entry of entries) {
    if (registry.has(entry.key)) {
      throw new Error(
        `API_KEYS: duplicate key detected for clientId "${entry.clientId}"`
      );
    }
    registry.set(entry.key, entry);
  }

  return registry;
}

/**
 * Loads and returns the API key registry from the current process environment.
 *
 * The result is built fresh on every call so that unit tests can override
 * `process.env.API_KEYS` without module-level caching interfering.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variables source.
 * @returns {Map<string, ApiKeyEntry>} The populated key registry.
 */
function loadApiKeyRegistry(env = process.env) {
  const entries = parseApiKeys(env.API_KEYS);
  return buildKeyRegistry(entries);
}

module.exports = {
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES_COUNT,
  KNOWN_ENTRY_FIELDS,
  VALID_SCOPES,
  parseApiKeys,
  buildKeyRegistry,
  loadApiKeyRegistry,
  validateEntry,
  rejectUnknownFields,
};
