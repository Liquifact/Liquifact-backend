/**
 * src/config/verificationThresholds.js
 *
 * Resolves the amount thresholds used by the invoice-verification service:
 *   - the fraud-rejection ceiling (amounts strictly above it are auto-rejected), and
 *   - the manual-review threshold (amounts at or above it require a human approval).
 *
 * Historically these were hardcoded literals (10,000,000 and 1,000,000) inside
 * `src/services/invoiceVerification.js`. They are now configuration-driven so they
 * can adapt to different currencies, tenant risk appetites, or limit changes
 * without a code change and redeploy.
 *
 * Configuration sources (all environment-backed, i.e. set by config/admin only —
 * never by request payloads):
 *
 *   INVOICE_FRAUD_CEILING              Global fraud-rejection ceiling.
 *                                      Default: 10000000 (preserves prior behavior).
 *   INVOICE_MANUAL_REVIEW_THRESHOLD    Global manual-review threshold.
 *                                      Default: 1000000 (preserves prior behavior).
 *   INVOICE_TENANT_THRESHOLDS          JSON object of per-tenant overrides, e.g.
 *     {
 *       "tenant-acme":   { "fraudCeiling": 5000000, "manualReviewThreshold": 500000 },
 *       "tenant-globex": { "manualReviewThreshold": 250000 }
 *     }
 *     Each override may set either or both fields; omitted fields fall back to the
 *     global defaults above. Overrides are validated with the same rules as the
 *     globals.
 *
 * Validation rules (applied to globals and to every tenant override after merge):
 *   - Both values must be finite numbers greater than 0.
 *   - manualReviewThreshold must be <= fraudCeiling, otherwise the manual-review
 *     band would be unreachable and the configuration is rejected.
 *
 * Invalid configuration throws {@link VerificationConfigError}. Callers that must
 * not crash (e.g. the verification service) should catch it and fail closed.
 *
 * Security: tenant identifiers are used purely as lookup keys into the
 * environment-supplied override map. Overrides cannot be injected by untrusted
 * input — the map is parsed from the environment and stored in a {@link Map},
 * which is immune to prototype-pollution keys such as `__proto__`.
 */

'use strict';

/** @type {number} Default fraud-rejection ceiling (preserves prior hardcoded behavior). */
const DEFAULT_FRAUD_CEILING = 10000000;

/** @type {number} Default manual-review threshold (preserves prior hardcoded behavior). */
const DEFAULT_MANUAL_REVIEW_THRESHOLD = 1000000;

/**
 * A resolved threshold pair for a verification decision.
 * @typedef {Object} ThresholdSet
 * @property {number} fraudCeiling - Amounts strictly greater than this are rejected.
 * @property {number} manualReviewThreshold - Amounts at or above this require manual review.
 */

/**
 * Thrown when threshold configuration (env defaults or tenant overrides) is malformed.
 */
class VerificationConfigError extends Error {
  /**
   * Creates an error describing an invalid threshold configuration.
   * @param {string} message - Human-readable configuration error.
   */
  constructor(message) {
    super(message);
    this.name = 'VerificationConfigError';
  }
}

/**
 * Parse a raw environment value into a strictly positive, finite number.
 *
 * @param {string|undefined} raw - The raw environment string (may be undefined).
 * @param {number} fallback - Default to use when `raw` is undefined or empty.
 * @param {string} label - Field name used in error messages.
 * @returns {number} The validated positive number.
 * @throws {VerificationConfigError} When the value is present but not a positive finite number.
 */
function _parseNumericEnv(raw, fallback, label) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return _assertPositiveNumber(value, label);
}

/**
 * Assert that a value is a finite number strictly greater than zero.
 *
 * @param {*} value - The candidate value.
 * @param {string} label - Field name used in error messages.
 * @returns {number} The validated number.
 * @throws {VerificationConfigError} When the value is not a positive finite number.
 */
function _assertPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new VerificationConfigError(
      `${label} must be a finite number greater than 0 (received: ${JSON.stringify(value)}).`
    );
  }
  return value;
}

/**
 * Assert that a threshold pair is internally consistent.
 *
 * @param {ThresholdSet} pair - The resolved threshold pair.
 * @param {string} context - Describes the source (e.g. "global config" or a tenant id).
 * @returns {ThresholdSet} The same validated pair.
 * @throws {VerificationConfigError} When manualReviewThreshold exceeds fraudCeiling.
 */
function _assertConsistentPair(pair, context) {
  if (pair.manualReviewThreshold > pair.fraudCeiling) {
    throw new VerificationConfigError(
      `${context}: manualReviewThreshold (${pair.manualReviewThreshold}) must not exceed ` +
        `fraudCeiling (${pair.fraudCeiling}).`
    );
  }
  return pair;
}

/**
 * Parse and validate the per-tenant override map from its raw JSON string.
 *
 * @param {string|undefined} raw - Raw INVOICE_TENANT_THRESHOLDS JSON (may be undefined).
 * @param {ThresholdSet} defaults - Global defaults used to fill omitted override fields.
 * @returns {Map<string, ThresholdSet>} Map of tenant id to validated, merged thresholds.
 * @throws {VerificationConfigError} When the JSON is malformed or any override is invalid.
 */
function _parseTenantOverrides(raw, defaults) {
  const overrides = new Map();
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return overrides;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VerificationConfigError(
      'INVOICE_TENANT_THRESHOLDS is not valid JSON. Check your environment configuration.'
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VerificationConfigError(
      'INVOICE_TENANT_THRESHOLDS must be a JSON object mapping tenant ids to overrides.'
    );
  }

  // Only the tenant's own enumerable keys are considered; using a Map for storage
  // keeps the result free of prototype-pollution surprises.
  for (const tenantId of Object.keys(parsed)) {
    const override = parsed[tenantId];
    if (override === null || typeof override !== 'object' || Array.isArray(override)) {
      throw new VerificationConfigError(
        `INVOICE_TENANT_THRESHOLDS["${tenantId}"] must be an object of threshold overrides.`
      );
    }

    const fraudCeiling = Object.prototype.hasOwnProperty.call(override, 'fraudCeiling')
      ? _assertPositiveNumber(override.fraudCeiling, `tenant "${tenantId}" fraudCeiling`)
      : defaults.fraudCeiling;

    const manualReviewThreshold = Object.prototype.hasOwnProperty.call(
      override,
      'manualReviewThreshold'
    )
      ? _assertPositiveNumber(
        override.manualReviewThreshold,
        `tenant "${tenantId}" manualReviewThreshold`
      )
      : defaults.manualReviewThreshold;

    const merged = _assertConsistentPair(
      { fraudCeiling, manualReviewThreshold },
      `tenant "${tenantId}"`
    );
    overrides.set(tenantId, merged);
  }

  return overrides;
}

/**
 * Build the full threshold configuration from the current environment.
 *
 * @returns {{ defaults: ThresholdSet, tenants: Map<string, ThresholdSet> }} Parsed config.
 * @throws {VerificationConfigError} When env defaults or overrides are invalid.
 */
function _buildConfig() {
  const defaults = _assertConsistentPair(
    {
      fraudCeiling: _parseNumericEnv(
        process.env.INVOICE_FRAUD_CEILING,
        DEFAULT_FRAUD_CEILING,
        'INVOICE_FRAUD_CEILING'
      ),
      manualReviewThreshold: _parseNumericEnv(
        process.env.INVOICE_MANUAL_REVIEW_THRESHOLD,
        DEFAULT_MANUAL_REVIEW_THRESHOLD,
        'INVOICE_MANUAL_REVIEW_THRESHOLD'
      ),
    },
    'global config'
  );

  const tenants = _parseTenantOverrides(process.env.INVOICE_TENANT_THRESHOLDS, defaults);

  return { defaults, tenants };
}

/** @type {{ defaults: ThresholdSet, tenants: Map<string, ThresholdSet> } | null} */
let _cache = null;

/**
 * Returns the parsed configuration, building and memoizing it on first use.
 *
 * @returns {{ defaults: ThresholdSet, tenants: Map<string, ThresholdSet> }} Parsed config.
 * @throws {VerificationConfigError} When env defaults or overrides are invalid.
 */
function _getConfig() {
  if (!_cache) {
    _cache = _buildConfig();
  }
  return _cache;
}

/**
 * Resolve the effective thresholds for a verification decision.
 *
 * When `tenantId` matches a configured override the tenant-specific thresholds are
 * returned; otherwise the global defaults are used. A fresh object is returned on
 * every call so callers cannot mutate the cached configuration.
 *
 * @param {string} [tenantId] - Trusted tenant identifier from the authenticated
 *   context. Untrusted request payloads must not supply this value.
 * @returns {ThresholdSet} The effective thresholds to apply.
 * @throws {VerificationConfigError} When the underlying configuration is invalid.
 */
function resolveThresholds(tenantId) {
  const { defaults, tenants } = _getConfig();

  if (tenantId !== undefined && tenantId !== null && tenants.has(String(tenantId))) {
    return { ...tenants.get(String(tenantId)) };
  }

  return { ...defaults };
}

/**
 * Test-only helper that clears the memoized configuration so a subsequent call
 * re-reads `process.env`.
 * @returns {void}
 */
function _resetThresholdCache() {
  _cache = null;
}

module.exports = {
  resolveThresholds,
  VerificationConfigError,
  DEFAULT_FRAUD_CEILING,
  DEFAULT_MANUAL_REVIEW_THRESHOLD,
  _resetThresholdCache, // test-only
};
