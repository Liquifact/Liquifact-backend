'use strict';

/**
 * @fileoverview Shared validation helpers for persistence handlers.
 *
 * Centralises the repeated validation preambles that were previously inlined
 * across jobPersistence.js, jobQueue.js, and worker.js.  Extracting them here
 * means each rule is defined once, tested once, and updated in one place.
 *
 * ## Exported helpers
 *
 * - `assertJobStructure(job)` — throws if `job` is missing required fields.
 * - `validatePayloadRoundTrip(raw)` — returns `{ ok, payload|error }` after
 *    round-tripping a raw DB value through JSON to confirm it is a plain object.
 * - `parseEnvInt(value, defaultValue, min, max)` — safely parses an
 *    environment-variable string into a bounded integer.
 *
 * None of these helpers have side-effects; they are pure functions and can be
 * used in any context without importing additional modules.
 *
 * @module workers/persistenceValidation
 */

// ---------------------------------------------------------------------------
// assertJobStructure
// ---------------------------------------------------------------------------

/**
 * Required fields every job object must carry.
 * Adding a field here automatically tightens the check in every consumer.
 *
 * @type {string[]}
 */
const REQUIRED_JOB_FIELDS = ['id', 'type'];

/**
 * Asserts that `job` is a plain object containing all required fields and that
 * each required field holds a non-empty string value.
 *
 * This replaces the repeated inline guard:
 * ```js
 * if (!job || !job.id || !job.type) {
 *   throw new Error('Invalid job structure');
 * }
 * ```
 *
 * @param {unknown} job - Value to validate.
 * @throws {Error} When `job` is null / non-object, or any required field is
 *   missing, falsy, or not a non-empty string.
 */
function assertJobStructure(job) {
  if (job === null || job === undefined || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('Invalid job structure: job must be a plain object');
  }

  for (const field of REQUIRED_JOB_FIELDS) {
    const value = job[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `Invalid job structure: field "${field}" must be a non-empty string, ` +
        `got ${value === null ? 'null' : typeof value}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// validatePayloadRoundTrip
// ---------------------------------------------------------------------------

/**
 * Validates and sanitises a raw value read from a DB JSONB column by
 * round-tripping it through `JSON.parse / JSON.stringify`.
 *
 * Rules enforced:
 *  - The result must be a plain object (not `null`, not an array, not a
 *    primitive).
 *  - Non-serialisable values introduced between persist and restore are
 *    stripped by the round-trip.
 *
 * This replaces the standalone `sanitisePayload` in `jobPersistence.js` and
 * unifies it with the structurally identical check that appeared in other
 * persistence code paths.
 *
 * @param {unknown} raw - The raw value to validate (DB row payload column).
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 *   A discriminated-union result: `ok: true` carries the sanitised payload;
 *   `ok: false` carries a human-readable reason string.
 */
function validatePayloadRoundTrip(raw) {
  try {
    // Accept both already-parsed objects (from JSONB drivers) and raw strings.
    const serialised = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const parsed = JSON.parse(serialised);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'payload must be a plain object' };
    }

    return { ok: true, payload: parsed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// parseEnvInt
// ---------------------------------------------------------------------------

/**
 * Safely parses an environment-variable string into a bounded integer.
 *
 * This replaces the repeated inline pattern:
 * ```js
 * const parsed = parseInt(process.env.SOME_VAR || '1000', 10);
 * return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
 * ```
 *
 * Behaviour:
 *  - When `value` is `undefined`, `null`, or an empty / non-numeric string,
 *    `defaultValue` is returned unchanged.
 *  - When the parsed integer falls outside `[min, max]`, the nearest boundary
 *    is returned (i.e. the value is *clamped*, not rejected).
 *  - `min` and `max` are both inclusive.
 *
 * @param {string|null|undefined} value - Raw environment-variable string.
 * @param {number} defaultValue - Fallback when parsing fails or value is absent.
 * @param {number} [min=-Infinity] - Lower inclusive bound.
 * @param {number} [max=Infinity]  - Upper inclusive bound.
 * @returns {number} Bounded integer.
 *
 * @example
 * // process.env.MY_TIMEOUT = '500'
 * parseEnvInt(process.env.MY_TIMEOUT, 1000, 100, 5000); // → 500
 *
 * @example
 * // process.env.MY_TIMEOUT = 'bad'
 * parseEnvInt(process.env.MY_TIMEOUT, 1000, 100, 5000); // → 1000
 *
 * @example
 * // process.env.MY_TIMEOUT = '50'
 * parseEnvInt(process.env.MY_TIMEOUT, 1000, 100, 5000); // → 100 (clamped)
 */
function parseEnvInt(value, defaultValue, min = -Infinity, max = Infinity) {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.min(Math.max(parsed, min), max);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  assertJobStructure,
  validatePayloadRoundTrip,
  parseEnvInt,
  // Expose internals for tests
  REQUIRED_JOB_FIELDS,
};
