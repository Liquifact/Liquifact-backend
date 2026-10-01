'use strict';

/**
 * @fileoverview Stellar network configuration accessor with explicit boundary
 * contract preservation.
 *
 * Public contract invariants:
 * - getStellarConfig() always returns { rpcUrl: string, networkPassphrase: string }
 * - Both fields are non-null strings derived from validated config
 * - Throws Error with clear message if config.get() fails (not validated)
 * - Return shape is stable across upgrades; new fields require version bump
 * - No side effects; safe for concurrent calls and repeated invocation
 *
 * Failure modes:
 * - Config not validated → Error('Config not validated. Call validate() first.')
 * - Missing SOROBAN_RPC_URL → config validation rejects at boot (has default)
 * - Missing NETWORK_PASSPHRASE → config validation rejects at boot (has default)
 * - Invalid types → config validation enforces string/url types at boot
 *
 * @module config/stellar
 */

const config = require('./index');

/**
 * @typedef {Object} StellarConfig
 * @property {string} rpcUrl - Soroban RPC endpoint URL (validated at boot).
 * @property {string} networkPassphrase - Stellar network passphrase.
 */

/**
 * Get Stellar-specific configuration.
 *
 * Boundary contract:
 * - Returns a plain object with exactly two string properties: rpcUrl and networkPassphrase
 * - Both values are guaranteed non-empty strings validated at application boot
 * - Throws Error if config.get() hasn't been called (fail-fast on misconfiguration)
 * - Idempotent: repeated calls return equivalent objects with the same values
 * - Thread-safe: no mutable state, safe for concurrent access
 *
 * Compatibility notes:
 * - Return shape { rpcUrl, networkPassphrase } is the public contract
 * - Adding optional fields is backward-compatible; removing/renaming is breaking
 * - Callers must handle Error thrown when config is not validated
 * - Field values come from config module defaults if env vars are absent
 *
 * @returns {StellarConfig} Stellar configuration with validated rpcUrl and networkPassphrase.
 * @throws {Error} When config.validate() has not been called prior to invocation.
 */
function getStellarConfig() {
  // config.get() enforces that validate() was called; throws if not.
  // This is the primary fail-fast boundary: misconfigured apps crash early.
  const validatedConfig = config.get();

  // SOROBAN_RPC_URL and NETWORK_PASSPHRASE are guaranteed by ConfigSchema:
  // - SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org')
  // - NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015')
  // Both have defaults, so they are always present and type-validated.
  const rpcUrl = validatedConfig.SOROBAN_RPC_URL;
  const networkPassphrase = validatedConfig.NETWORK_PASSPHRASE;

  // Defensive invariant check: even though schema guarantees non-empty strings,
  // explicitly validate to preserve the public contract under schema evolution.
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) {
    throw new Error(
      'Stellar config invariant violated: SOROBAN_RPC_URL must be a non-empty string'
    );
  }

  if (typeof networkPassphrase !== 'string' || networkPassphrase.length === 0) {
    throw new Error(
      'Stellar config invariant violated: NETWORK_PASSPHRASE must be a non-empty string'
    );
  }

  // Return the stable public contract shape.
  // Frozen to prevent caller mutation that could break assumptions.
  return Object.freeze({
    rpcUrl,
    networkPassphrase,
  });
}

/**
 * Return the passphrase for a supported Stellar network.
 * @param {string} network
 * @returns {string}
 */
function getNetworkPassphrase(network) {
  if (!isKnownNetwork(network)) {
    throw new Error(`Unknown network: ${network}`);
  }
  return NETWORK_PASSPHRASE_MAP[network];
}

/**
 * Return the canonical Soroban RPC URL for a supported Stellar network.
 * @param {string} network
 * @returns {string}
 */
function getExpectedRpc(network) {
  if (!isKnownNetwork(network)) {
    throw new Error(`Unknown network: ${network}`);
  }
  return NETWORK_RPC_MAP[network];
}

/**
 * Validate the Stellar network and its RPC/passphrase pairing.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{network: string, rpcUrl: string, passphrase: string}}
 */
function validateStellarConfig(env = process.env) {
  const network = env.STELLAR_NETWORK;
  if (typeof network !== 'string' || network.length === 0) {
    throw new Error('STELLAR_NETWORK is required');
  }
  if (!isKnownNetwork(network)) {
    throw new Error(`Invalid STELLAR_NETWORK: expected one of ${VALID_NETWORKS.join(', ')}`);
  }

  const rpcUrl = env.SOROBAN_RPC_URL;
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) {
    throw new Error('SOROBAN_RPC_URL is required');
  }

  const expectedRpc = getExpectedRpc(network);
  if (rpcUrl !== expectedRpc) {
    throw new Error(
      `STELLAR_NETWORK=${network} requires SOROBAN_RPC_URL="${expectedRpc}" (Mismatch).`
    );
  }

  const passphrase = getNetworkPassphrase(network);
  if (env.STELLAR_NETWORK_PASSPHRASE !== undefined &&
      env.STELLAR_NETWORK_PASSPHRASE !== passphrase) {
    throw new Error('STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK');
  }

  return { network, rpcUrl, passphrase };
}

/**
 * Supported Stellar network identifiers.
 * Frozen so no caller can widen the allow-list at runtime.
 * @type {ReadonlyArray<string>}
 */
const VALID_NETWORKS = Object.freeze(['TESTNET', 'MAINNET', 'FUTURENET']);

/**
 * Canonical Soroban RPC endpoint per network. These are the only accepted endpoints.
 * @type {Readonly<Record<string, string>>}
 */
const NETWORK_RPC_MAP = Object.freeze({
  TESTNET: 'https://soroban-testnet.stellar.org',
  MAINNET: 'https://soroban.stellar.org',
  FUTURENET: 'https://rpc-futurenet.stellar.org',
});

/**
 * Canonical network passphrase per network. A passphrase is a public network
 * identity (not a credential) and is matched byte-for-byte: it is case- and
 * whitespace-sensitive by definition.
 * @type {Readonly<Record<string, string>>}
 */
const NETWORK_PASSPHRASE_MAP = Object.freeze({
  TESTNET: 'Test SDF Network ; September 2015',
  MAINNET: 'Public Global Stellar Network ; September 2014',
  FUTURENET: 'Test SDF Future Network ; October 2022',
});

/**
 * Maximum length of an environment value echoed back in an error message. Keeps a
 * pathological or attacker-injected value from bloating logs or breaching a log
 * line-length assumption.
 * @type {number}
 */
const MAX_ECHO_LENGTH = 200;

/**
 * Stable, machine-readable failure codes. Values are part of the module's public
 * contract: logs and alerting may match on them, so they must not change meaning.
 * @type {Readonly<Record<string, string>>}
 */
const ERROR_CODES = Object.freeze({
  ENV_INVALID: 'STELLAR_CONFIG_ENV_INVALID',
  NETWORK_MISSING: 'STELLAR_NETWORK_MISSING',
  RPC_URL_MISSING: 'SOROBAN_RPC_URL_MISSING',
  NETWORK_UNKNOWN: 'STELLAR_NETWORK_UNKNOWN',
  RPC_MISMATCH: 'STELLAR_NETWORK_RPC_MISMATCH',
  CONFIG_NOT_VALIDATED: 'STELLAR_CONFIG_NOT_VALIDATED',
  PASSPHRASE_RPC_MISMATCH: 'STELLAR_PASSPHRASE_RPC_MISMATCH',
});

/**
 * Error thrown for every Stellar configuration failure.
 *
 * The `message` stays human-readable (and keeps the wording documented in
 * `docs/config.md`) while `code` gives callers a stable discriminator and
 * `details` carries already-redacted context for structured logging.
 */
class StellarConfigError extends Error {
  /**
   * Builds a Stellar configuration failure with a stable code and redacted details.
   * @param {string} code - Stable value from {@link ERROR_CODES}.
   * @param {string} message - Human-readable, secret-free description.
   * @param {Record<string, unknown>} [details] - Redacted diagnostic context.
   * @param {unknown} [cause] - Underlying error, when wrapping one.
   */
  constructor(code, message, details, cause) {
    super(message);
    this.name = 'StellarConfigError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    if (cause !== undefined) {
      this.cause = cause;
    }
    // Capture stack trace, excluding the constructor call from it.
    Error.captureStackTrace(this, StellarConfigError);
  }

  /**
   * Structured, secret-free representation for logs and error responses.
   * @returns {{ name: string, code: string, message: string, details: Record<string, unknown> }}
   */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Normalises a network identifier for lookup: trims surrounding whitespace and
 * upper-cases, so `.env` slips such as `testnet` or `TESTNET ` resolve to the same
 * canonical network. The allow-list still constrains the result, so this is
 * normalisation rather than leniency.
 * @param {string} network - Raw network identifier.
 * @returns {string} Normalised identifier.
 */
function normalizeNetwork(network) {
  return String(network).trim().toUpperCase();
}

/**
 * Strips control characters from a value bound for a log line, so a value
 * containing newlines or ANSI escapes cannot forge additional log records.
 * @param {unknown} value - Raw value.
 * @returns {string} Value without control characters.
 */
function stripControlCharacters(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * Renders an environment value safe to echo in an error message: control characters
 * removed and length bounded.
 * @param {unknown} value - Raw value from the environment.
 * @returns {string} Redacted, length-bounded rendering.
 */
function redactValue(value) {
  const text = stripControlCharacters(value).trim();
  if (text.length <= MAX_ECHO_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_ECHO_LENGTH)}...(truncated)`;
}

/**
 * Redacts URL userinfo (`https://user:secret@host` -> `https://[redacted]@host`) and
 * bounds the length. Applied to every URL before it reaches an error, `details`
 * payload or log line, because RPC URLs are a realistic place for credentials to
 * hide (private endpoints with basic auth).
 * @param {unknown} value - Raw URL value.
 * @returns {string} Redacted URL safe to log.
 */
function redactUrl(value) {
  const text = redactValue(value);
  const schemeEnd = text.indexOf('://');
  if (schemeEnd === -1) {
    return text;
  }
  const authorityStart = schemeEnd + 3;
  const slashIndex = text.indexOf('/', authorityStart);
  const authorityEnd = slashIndex === -1 ? text.length : slashIndex;
  const authority = text.slice(authorityStart, authorityEnd);
  const atIndex = authority.lastIndexOf('@');
  if (atIndex === -1) {
    return text;
  }
  return `${text.slice(0, authorityStart)}[redacted]@${authority.slice(atIndex + 1)}${text.slice(
    authorityEnd,
  )}`;
}

/**
 * Reduces an RPC URL to the form compared against the canonical matrix.
 *
 * Returns `null` when the value cannot be proven to be one of the canonical
 * endpoints (unparseable, plaintext, credentialed, or carrying a path/query/hash),
 * which callers treat as "unknown endpoint" rather than silently accepting it.
 *
 * @param {unknown} value - Raw RPC URL.
 * @returns {string|null} Canonicalised `https://host`, or `null` when not canonicalisable.
 */
function canonicalizeRpcUrl(value) {
  let parsed;
  try {
    // `new URL` stringifies its argument, so coercing here also keeps a non-string
    // input from throwing before the catch below can return the safe "unknown" result.
    parsed = new URL(String(value).trim());
  } catch (_err) {
    return null;
  }
  // Plaintext is never equivalent to a canonical https endpoint: rejecting it here
  // is what prevents a typo from downgrading RPC traffic.
  if (parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null;
  }
  return `https://${parsed.hostname.toLowerCase()}`;
}

/**
 * Resolves the canonical passphrase for a network.
 *
 * @param {string} network - Network identifier; normalised before lookup.
 * @returns {string} Canonical network passphrase.
 * @throws {StellarConfigError} `STELLAR_NETWORK_UNKNOWN` when the network is not supported.
 */
function getNetworkPassphrase(network) {
  const key = normalizeNetwork(network);
  if (!VALID_NETWORKS.includes(key)) {
    throw new StellarConfigError(
      ERROR_CODES.NETWORK_UNKNOWN,
      `Unknown network: ${redactValue(network)}`,
      { network: redactValue(network), validNetworks: VALID_NETWORKS.slice() },
    );
  }
  return NETWORK_PASSPHRASE_MAP[key];
}

/**
 * Resolves the canonical Soroban RPC endpoint for a network.
 *
 * @param {string} network - Network identifier; normalised before lookup.
 * @returns {string} Canonical RPC URL.
 * @throws {StellarConfigError} `STELLAR_NETWORK_UNKNOWN` when the network is not supported.
 */
function getExpectedRpc(network) {
  const key = normalizeNetwork(network);
  if (!VALID_NETWORKS.includes(key)) {
    throw new StellarConfigError(
      ERROR_CODES.NETWORK_UNKNOWN,
      `Unknown network: ${redactValue(network)}`,
      { network: redactValue(network), validNetworks: VALID_NETWORKS.slice() },
    );
  }
  return NETWORK_RPC_MAP[key];
}

/**
 * Resolves the network whose canonical passphrase matches exactly.
 *
 * Passphrases are compared byte-for-byte because they are case- and
 * whitespace-sensitive by definition, which also keeps the mapping injective: a
 * passphrase identifies at most one network.
 *
 * @param {unknown} passphrase - Network passphrase to identify.
 * @returns {string|null} Network name, or `null` when the passphrase is not canonical
 *   (a self-hosted or otherwise custom network).
 */
function resolveNetworkByPassphrase(passphrase) {
  return VALID_NETWORKS.find((network) => NETWORK_PASSPHRASE_MAP[network] === passphrase) ?? null;
}

/**
 * Resolves the network whose canonical RPC endpoint matches the supplied URL.
 *
 * @param {unknown} rpcUrl - RPC URL to identify.
 * @returns {string|null} Network name, or `null` when the URL is not a canonical
 *   endpoint for exactly one supported network.
 */
function resolveNetworkByRpcUrl(rpcUrl) {
  const canonical = canonicalizeRpcUrl(rpcUrl);
  if (canonical === null) {
    return null;
  }
  return VALID_NETWORKS.find((network) => NETWORK_RPC_MAP[network] === canonical) ?? null;
}

/**
 * Reads a required environment variable, treating unset/empty/whitespace-only values
 * as absent so that `FOO=` and an unset `FOO` fail identically.
 * @param {Record<string, string | undefined>} env - Environment map to read from.
 * @param {string} key - Variable name.
 * @returns {string|null} Trimmed value, or `null` when absent.
 */
function readRequiredEnv(env, key) {
  const raw = env[key];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validates the boot-time Stellar configuration against the canonical network matrix.
 *
 * This is the fail-fast gate intended to run before the HTTP server starts. It reads
 * the live environment on every call (no caching, no memoisation) so that the result
 * is always a pure function of the current environment.
 *
 * Failure is always the same for the same input, and nothing is written on the way
 * out, so a rejected call can be corrected and retried without reloading the process.
 *
 * @param {Record<string, string | undefined>} [env=process.env] - Environment map.
 *   Injectable for deterministic tests.
 * @returns {{ network: string, rpcUrl: string, passphrase: string }} Resolved config.
 * @throws {StellarConfigError} `STELLAR_CONFIG_ENV_INVALID` when `env` is not an object;
 *   `STELLAR_NETWORK_MISSING` / `SOROBAN_RPC_URL_MISSING` when a variable is absent;
 *   `STELLAR_NETWORK_UNKNOWN` when the network is unsupported;
 *   `STELLAR_NETWORK_RPC_MISMATCH` when the RPC URL is not the canonical endpoint.
 */
function validateStellarConfig(env = process.env) {
  if (env === null || typeof env !== 'object') {
    throw new StellarConfigError(
      ERROR_CODES.ENV_INVALID,
      'Stellar configuration environment must be an object.',
      { received: env === null ? 'null' : typeof env },
    );
  }

  const rawNetwork = readRequiredEnv(env, 'STELLAR_NETWORK');
  if (rawNetwork === null) {
    throw new StellarConfigError(ERROR_CODES.NETWORK_MISSING, 'STELLAR_NETWORK is required', {
      requiredVariable: 'STELLAR_NETWORK',
      validNetworks: VALID_NETWORKS.slice(),
    });
  }

  const rawRpcUrl = readRequiredEnv(env, 'SOROBAN_RPC_URL');
  if (rawRpcUrl === null) {
    throw new StellarConfigError(ERROR_CODES.RPC_URL_MISSING, 'SOROBAN_RPC_URL is required', {
      network: normalizeNetwork(rawNetwork),
      requiredVariable: 'SOROBAN_RPC_URL',
    });
  }

  const network = normalizeNetwork(rawNetwork);
  if (!VALID_NETWORKS.includes(network)) {
    throw new StellarConfigError(
      ERROR_CODES.NETWORK_UNKNOWN,
      `Invalid STELLAR_NETWORK: ${redactValue(rawNetwork)}`,
      {
        network: redactValue(rawNetwork),
        validNetworks: VALID_NETWORKS.slice(),
      },
    );
  }

  const expectedRpcUrl = getExpectedRpc(network);
  const canonicalActual = canonicalizeRpcUrl(rawRpcUrl);
  if (canonicalActual !== expectedRpcUrl) {
    throw new StellarConfigError(
      ERROR_CODES.RPC_MISMATCH,
      `Mismatch: STELLAR_NETWORK=${network} requires SOROBAN_RPC_URL="${expectedRpcUrl}", but got "${redactUrl(
        rawRpcUrl,
      )}". This combination would cause on-chain validation failures.`,
      {
        network,
        expectedRpcUrl,
        actualRpcUrl: redactUrl(rawRpcUrl),
      },
    );
  }

  return { network, rpcUrl: expectedRpcUrl, passphrase: getNetworkPassphrase(network) };
}

/**
 * Asserts that a passphrase/RPC pair taken from the validated config store cannot be
 * a network mismatch.
 *
 * Only *provable* inconsistencies are rejected. A canonical passphrase paired with
 * another network's canonical endpoint is rejected because the pairing is certainly
 * wrong and would sign against the wrong network identity. A non-canonical passphrase
 * (self-hosted network) or a non-canonical RPC URL (private proxy, local sandbox) is
 * allowed, because no canonical matrix entry describes it and rejecting it would break
 * legitimate deployments that cannot be validated from configuration alone.
 *
 * @param {unknown} rpcUrl - Configured RPC URL.
 * @param {unknown} networkPassphrase - Configured network passphrase.
 * @returns {void}
 * @throws {StellarConfigError} `STELLAR_PASSPHRASE_RPC_MISMATCH` on a proven mismatch.
 */
function assertPassphraseRpcConsistency(rpcUrl, networkPassphrase) {
  const passphraseNetwork = resolveNetworkByPassphrase(networkPassphrase);
  if (passphraseNetwork === null) {
    return;
  }
  const rpcNetwork = resolveNetworkByRpcUrl(rpcUrl);
  if (rpcNetwork === null || rpcNetwork === passphraseNetwork) {
    return;
  }
  throw new StellarConfigError(
    ERROR_CODES.PASSPHRASE_RPC_MISMATCH,
    `Mismatch: NETWORK_PASSPHRASE identifies ${passphraseNetwork} but SOROBAN_RPC_URL is the ${rpcNetwork} endpoint "${redactUrl(
      rpcUrl,
    )}". This combination would cause on-chain validation failures.`,
    {
      passphraseNetwork,
      rpcNetwork,
      expectedRpcUrl: NETWORK_RPC_MAP[passphraseNetwork],
      actualRpcUrl: redactUrl(rpcUrl),
    },
  );
}

/**
 * Returns the Soroban RPC URL and network passphrase for request-time use.
 *
 * Reads the Zod-validated store from {@link module:config/index}, so `validate()` must
 * have run. The store validates `SOROBAN_RPC_URL` and `NETWORK_PASSPHRASE`
 * independently and does not pair them, which is why this accessor re-checks the
 * pairing before handing the values to a signer.
 *
 * @returns {{ rpcUrl: string, networkPassphrase: string }} The Soroban RPC configuration.
 * @throws {StellarConfigError} `STELLAR_CONFIG_NOT_VALIDATED` when `validate()` has not
 *   run; `STELLAR_PASSPHRASE_RPC_MISMATCH` when the stored pair is provably inconsistent.
 */
function getStellarConfig() {
  let store;
  try {
    store = config.get();
  } catch (error) {
    throw new StellarConfigError(
      ERROR_CODES.CONFIG_NOT_VALIDATED,
      'Config not validated. Call validate() first.',
      {},
      error,
    );
  }

  const { SOROBAN_RPC_URL: rpcUrl, NETWORK_PASSPHRASE: networkPassphrase } =
    /** @type {{ SOROBAN_RPC_URL: string, NETWORK_PASSPHRASE: string }} */ (store);
  assertPassphraseRpcConsistency(rpcUrl, networkPassphrase);
  return { rpcUrl, networkPassphrase };
}

module.exports = {
  VALID_NETWORKS,
  NETWORK_RPC_MAP,
  NETWORK_PASSPHRASE_MAP,
  ERROR_CODES,
  StellarConfigError,
  validateStellarConfig,
  getStellarConfig,
  getNetworkPassphrase,
  getExpectedRpc,
};