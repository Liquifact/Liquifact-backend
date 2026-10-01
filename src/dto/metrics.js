'use strict';

/**
 * @fileoverview Typed request/response JTOs for the metrics module.
 *
 * Defines JSDoc typedefs for every data shape that crosses a module boundary
 * (routes ⇒ services ⇒ metrics instrumentation) and provides pure
 * mapping functions that transform between raw/untrusted input and typed DTOs.
 *
 * Each mapping function validates and coerces fields so callers can rely on
 * the returned DTO having the declared shape.  Unknown or missing fields are
 * given safe defaults / filtered out — no runtime exceptions are thrown for
 * malformed input.
 *
 * ## Validation boundaries
 *
 * The functions in this module enforce the following hard invariants so that
 * invalid data cannot silently flow into downstream layers:
 *
 * ### Count fields (open, funded, settled, defaulted)
 *  - Must be a finite, non-negative integer.
 *  - Negative values are clamped to `0` during mapping (soft boundary).
 *  - Float values are floored to an integer (soft boundary).
 *  - Values above `MAX_COUNT_VALUE` are clamped to `MAX_COUNT_VALUE`.
 *  - `validateSmeMetricsInput` performs a *hard* check and throws `RangeError`
 *    for any count that is negative, non-integer, non-finite, or above the max.
 *    Call this at trust boundaries (e.g. before persisting or returning to API
 *    consumers) to detect bugs or corrupt upstream data early.
 *
 * ### Bulk operation duplicate detection
 *  - `detectDuplicateBulkOperations` returns the list of duplicate
 *    `{tenantId, userId}` pairs within a bulk request so the caller can
 *    reject or log them before processing.
 *
 * ### Persistence record params
 *  - `durationSeconds` is clamped to `[0, MAX_DURATION_SECONDS]`.
 *  - `statusCode` is validated to be a known HTTP status-code range (100–599);
 *    out-of-range values are normalised to `0` (unknown).
 *
 * ## Usage
 *
 * ```js
 * const { toSmeMetricsResponse, validateSmeMetricsInput } = require('../../dto/metrics');
 *
 * const raw = await invoiceService.getSmeInvoiceCounts(tenantId, userId);
 * validateSmeMetricsInput(raw);          // throws early if upstream data is corrupt
 * const dto = toSmeMetricsResponse(raw); // guaranteed non-negative integer fields
 * ```
 *
 * @module dto/metrics
 */

// ---------------------------------------------------------------------------
// Boundary constants
// ---------------------------------------------------------------------------

/**
 * Maximum value allowed for any single invoice-count field.
 *
 * Chosen to be large enough for any real-world tenant while still being a
 * meaningful sentinel: a count above this almost certainly indicates a data
 * corruption or integer overflow upstream.
 *
 * @type {number}
 */
const MAX_COUNT_VALUE = 10_000_000;

/**
 * Maximum accepted wall-clock duration (seconds) for a persistence record.
 * Requests that run longer than this are almost certainly stale or anomalous.
 *
 * @type {number}
 */
const MAX_DURATION_SECONDS = 300; // 5 minutes

/**
 * Minimum valid HTTP status code.
 * @type {number}
 */
const HTTP_STATUS_MIN = 100;

/**
 * Maximum valid HTTP status code.
 * @type {number}
 */
const HTTP_STATUS_MAX = 599;

// ---------------------------------------------------------------------------
// SME Metrics Dashboard DTOs
// ----------------------------------------------------------------------------

/**
 * Aggregated invoice counts returned by the SME metrics endpoint.
 * Every field is a finite, non-negative number. Fractional values are
 * preserved for backward compatibility; service-generated counts are integers.
 *
 * @typedef {Object} SmeMetricsResponse
 * @property {number} open      - Count of open invoices (pending_verification + verified).
 * @property {number} funded    - Count of funded invoices.
 * @property {number} settled   - Count of settled invoices (settled + paid).
 * @property {number} defaulted - Count of defaulted invoices.
 */

/**
 * Response metadata block for the SME metrics endpoint.
 *
 * Optional pagination fields (`invoices`, `total`, `limit`, `hasMore`,
 * `nextCursor`) are present only when the request included `cursor` or `limit`.
 *
 * @typedef {Object} SmeMetricsMeta
 * @property {string}           timestamp   - ISO-8601 timestamp of the response.
 * @property {string}           version     - API version string (semver).
 * @property {Array<Object?}   [invoices]   - Paginated invoice rows for the current page.
 * @property {number}           [total]     - Total matching invoice count across all pages.
 * @property {number}           [limit]     - Page size applied to the response.
 * @property {boolean}          [hasMore]   - Whether additional pages exist.
 * @property {string|null}     [nextCursor] - Opaque cursor for the next page (null when terminal).
 */

/**
 * Top-level API response envelope for the SME metrics endpoint.
 *
 * @typedef {Object} SmeMetricsApiResponse
 * @property {SmeMetricsResponse} data      - Aggregated invoice counts.
 * @property {SmeMetricsMeta}     meta      - Response metadata.
 * @property {Object|null}        error     - Error detail object (null on success).
 * @property {string}             timestamp - ISO-8601 timestamp of the response.
 */

// ----------------------------------------------------------------------------
// Persistence Instrumentation DTOs
// ----------------------------------------------------------------------------

/**
 * Bounded endpoint label for persistence metrics.
 * Unknown endpoints are collapsed to `'unknown'`.
 *
 * @typedef {'sme_invoice_upload'|'sme_invoice_presigned_url'|'unknown'} PersistenceEndpoint
 */

/**
 * Bounded HTTP status-class label for persistence metrics.
 *
 * @typedef {'2xx'|'4xx'|'5xx'} PersistenceStatusClass
 */

/**
 * Bounded cause label for persistence request errors.
 *
 * @typedef {'validation'|'storage'|'internal'|'none'} PersistenceCause
 */

/**
 * Normalised parameters passed to the persistence metrics recorder.
 *
 * All fields have already been run through their respective bounded-label
 * normalisers — callers can rely on the values matching one of the declared
 * union members.
 *
 * @typedef {Object} PersistenceRecordParams
 * @property {PersistenceEndpoint}      endpoint        - Normalised endpoint label.
 * @property {number}                   statusCode      - Final HTTP status code.
 * @property {number}                   durationSeconds - Request wall-clock duration in seconds.
 * @property {PersistenceCause}         cause           - Normalised error cause label.
 * @property {boolean}                  success         - Whether the request completed without error.
 * @property {number}                   errorCount      - 1 when the request failed, 0 otherwise.
 * @property {import('express').Request} [req]          - Express request (for scoped logging).
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerces a raw value to a bounded, non-negative integer count.
 *
 * Soft boundary rules applied in order:
 *  1. Non-numeric / NaN values → `0`
 *  2. Negative values → clamped to `0`
 *  3. Float values → floored to integer
 *  4. Values above `MAX_COUNT_VALUE` → clamped to `MAX_COUNT_VALUE`
 *
 * This function never throws; use {@link validateSmeMetricsInput} for hard
 * rejection at trust boundaries.
 *
 * @param {unknown} value - Raw value to coerce.
 * @returns {number} A bounded non-negative integer.
 */
function _coerceCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  if (floored < 0) return 0;
  if (floored > MAX_COUNT_VALUE) return MAX_COUNT_VALUE;
  return floored;
}

// ---------------------------------------------------------------------------
// SME Metrics — mapping functions
// ----------------------------------------------------------------------------

/** @type {ReadonlyArray<'open'|'funded'|'settled'|'defaulted'>} */
const SME_METRIC_FIELDS = Object.freeze(['open', 'funded', 'settled', 'defaulted']);
const INVALID_PROPERTY = Symbol('invalid-property');

/**
 * Safely identifies object inputs without allowing revoked proxies to escape.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} Whether value is a non-array object.
 */
function isObjectRecord(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch (_err) {
    return false;
  }
}

/**
 * Reads a property without allowing a hostile getter/proxy trap to abort DTO
 * normalization. INVALID_PROPERTY is distinct from a missing or undefined
 * property so callers can apply the documented fallback deterministically.
 *
 * @param {*} obj - Source object.
 * @param {string} key - Property to read.
 * @returns {*} The property value, or INVALID_PROPERTY if access failed.
 */
function readPropertySafely(obj, key) {
  try {
    return obj[key];
  } catch (_err) {
    return INVALID_PROPERTY;
  }
}

/**
 * Checks own-property presence without allowing proxy traps to escape.
 *
 * @param {*} obj - Source object.
 * @param {string} key - Property to inspect.
 * @returns {boolean} Whether the object owns the property.
 */
function hasOwnPropertySafely(obj, key) {
  try {
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch (_err) {
    return false;
  }
}

/**
 * Converts a value to a finite number, returning fallback if conversion fails.
 *
 * @param {*} value - Value to convert.
 * @param {number} fallback - Value used when conversion is unsafe.
 * @returns {number} Finite numeric result or fallback.
 */
function toFiniteNumber(value, fallback) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  } catch (_err) {
    return fallback;
  }
}

/**
 * Safely converts a value to a string, preserving the specified fallback on
 * coercion errors (for example, an object with a throwing toString method).
 *
 * @param {*} value - Value to convert.
 * @param {string} fallback - Fallback string.
 * @returns {string} Converted value or fallback.
 */
function toStringSafely(value, fallback) {
  try {
    return String(value);
  } catch (_err) {
    return fallback;
  }
}

/**
 * Error for malformed internal metrics data. The message contains only a
 * bounded field name; raw metric values are deliberately never retained.
 */
class MetricsDtoValidationError extends Error {
  /**
  * Creates a sanitized validation error for malformed metrics output.
  *
   * @param {string} field - A known metric field, or 'response'.
   */
  constructor(field) {
    super(`Invalid SME metrics data for field: ${field}`);
    this.name = 'MetricsDtoValidationError';
    this.code = 'METRICS_DTO_INVALID_DATA';
    this.field = field;
  }
}

/**
 * Coerces numeric input without allowing exceptional values to escape.
 *
 * @param {unknown} value - Candidate numeric value.
 * @returns {number|null} Finite number, or null when coercion is invalid.
 */
function toFiniteNumber(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

/**
 * Normalises a non-negative metric value while preserving legacy fractions.
 *
 * @param {unknown} value - Candidate count value.
 * @returns {number}
 */
function toNonNegativeMetric(value) {
  const number = toFiniteNumber(value);
  return number !== null && number >= 0 ? number : 0;
}

/**
 * Copies the page array and its plain row objects to isolate response DTOs.
 *
 * @param {Object[]} rows - Invoice rows from the service.
 * @returns {Object[]}
 */
function snapshotInvoiceRows(rows) {
  return rows.map((row) => (
    row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : row
  ));
}

/**
 * Maps a raw invoice-counts object to a typed {@link SmeMetricsResponse} DTO.
 *
 * Every field is coerced to a safe non-negative integer via {@link _coerceCount}:
 *  - Non-numeric, NaN, and negative values become `0`.
 *  - Float values are floored.
 *  - Values above `MAX_COUNT_VALUE` are clamped to `MAX_COUNT_VALUE`.
 *
 * Unknown keys on the raw object are silently stripped.
 * This function never throws.
 *
 * @param {unknown} raw - Raw counts object from the invoice service or DB query.
 * @returns {SmeMetricsResponse} Normalised DTO with all four keys guaranteed.
 */
function toSmeMetricsResponse(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    open: _coerceCount(obj.open),
    funded: _coerceCount(obj.funded),
    settled: _coerceCount(obj.settled),
    defaulted: _coerceCount(obj.defaulted),
  };
  return {
    open: readCount('open'),
    funded: readCount('funded'),
    settled: readCount('settled'),
    defaulted: readCount('defaulted'),
  };
}

/**
 * Strictly maps counts supplied by the invoice service for an API response.
 * Unlike the legacy normalizer above, this path rejects missing, unsafe, or
 * invalid fields instead of turning upstream data failures into zero counts.
 * This keeps the existing permissive public mapper compatible while ensuring
 * the live endpoint never reports a plausible but silently incomplete result.
 *
 * @param {unknown} raw - Raw count response from the invoice service.
 * @returns {SmeMetricsResponse} Validated counts.
 * @throws {MetricsDtoValidationError} When the source shape/counts are invalid.
 */
function toStrictSmeMetricsResponse(raw) {
  if (!isObjectRecord(raw)) {
    throw new MetricsDtoValidationError('response');
  }

  /** @type {SmeMetricsResponse} */
  const result = { open: 0, funded: 0, settled: 0, defaulted: 0 };
  for (const field of SME_METRIC_FIELDS) {
    const value = readPropertySafely(raw, field);
    if (!hasOwnPropertySafely(raw, field) || value === INVALID_PROPERTY || !Number.isSafeInteger(value) || value < 0) {
      throw new MetricsDtoValidationError(field);
    }
    result[field] = value;
  }
  return result;
}

/**
 * Validates raw invoice counts at a hard trust boundary.
 *
 * Throws a `RangeError` when any count field violates the invariants that must
 * hold for production-safe data:
 *  - Must be a finite number (not `Infinity`, `NaN`, a string, etc.)
 *  - Must be a non-negative integer (no floats, no negatives)
 *  - Must not exceed `MAX_COUNT_VALUE`
 *
 * Call this *before* persisting metrics or returning them to downstream
 * consumers.  The mapping function {@link toSmeMetricsResponse} applies soft
 * coercion and never throws; this function is the companion hard gate for
 * situations where silent coercion is unacceptable.
 *
 * @param {unknown} raw - Raw counts object to validate.
 * @throws {TypeError}  When `raw` is not a plain object.
 * @throws {RangeError} When any count field fails a boundary check.
 * @returns {void}
 */
function validateSmeMetricsInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('metrics input must be a plain object');
  }

  const fields = ['open', 'funded', 'settled', 'defaulted'];
  for (const field of fields) {
    const value = raw[field];

    // Reject non-numeric types immediately (null, undefined, string, object, boolean)
    if (typeof value !== 'number') {
      throw new RangeError(
        `metrics field "${field}" must be a finite number; received ${JSON.stringify(value)}`
      );
    }

    // Reject non-finite numbers (NaN, Infinity, -Infinity)
    if (!Number.isFinite(value)) {
      throw new RangeError(
        `metrics field "${field}" must be a finite number; received ${value}`
      );
    }

    if (value < 0) {
      throw new RangeError(
        `metrics field "${field}" must be non-negative; received ${value}`
      );
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(
        `metrics field "${field}" must be an integer; received ${value}`
      );
    }
    if (value > MAX_COUNT_VALUE) {
      throw new RangeError(
        `metrics field "${field}" must not exceed ${MAX_COUNT_VALUE}; received ${value}`
      );
    }
  }
}

/**
 * Maps a raw meta-like object to a normalised {@link SmeMetricsMeta} DTO.
 *
 * Optional pagination fields are preserved when present on the raw input;
 * otherwise they are omitted from the returned meta object.
 *
 * ## Invariants
 * - `timestamp` and `version` are always non-empty strings.
 * - `total` and `limit`, when present, are non-negative safe integers.
 * - `hasMore`, when present, is a boolean.
 * - `nextCursor`, when present, is either a string or `null`.
 *
 * @param {unknown} raw - Raw meta-like object (e.g. from invoice service or
 *   a manually constructed meta block in the route handler).
 * @returns {SmeMetricsMeta} Normalised meta DTO.
 */
function toSmeMetricsMeta(raw) {
  /** @type {*} */
  const obj = isObjectRecord(raw) ? raw : {};
  const timestamp = readPropertySafely(obj, 'timestamp');
  const version = readPropertySafely(obj, 'version');

  // Mandatory fields with defaults.
  /** @type {SmeMetricsMeta} */
  const meta = {
    timestamp: typeof timestamp === 'string' ? timestamp : new Date().toISOString(),
    version: typeof version === 'string' ? version : '0.1.0',
  };

  // Optional pagination fields — only include when the source had them.
  if (Array.isArray(obj.invoices)) {
    // Snapshot page membership/order so later mutations cannot change another
    // response built from the same service result.
    meta.invoices = snapshotInvoiceRows(obj.invoices);
  }
  const total = readPropertySafely(obj, 'total');
  if (typeof total === 'number' && Number.isFinite(total)) {
    meta.total = Math.max(0, Math.floor(total));
  }
  const limit = readPropertySafely(obj, 'limit');
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    meta.limit = limit;
  }
  const hasMore = readPropertySafely(obj, 'hasMore');
  if (typeof hasMore === 'boolean') {
    meta.hasMore = hasMore;
  }
  // Explicitly handle nextCursor — null is a valid terminal value.
  const hasNextCursor = hasOwnPropertySafely(obj, 'nextCursor');
  if (hasNextCursor) {
    const nextCursor = readPropertySafely(obj, 'nextCursor');
    if (nextCursor !== INVALID_PROPERTY) {
      meta.nextCursor = nextCursor === undefined ? null : nextCursor;
    }
  }

  return /** @type {SmeMetricsMeta} */ (meta);
}

/**
 * Safely checks whether a value is an array, including revoked proxies.
 *
 * @param {*} value - Value to inspect.
 * @returns {boolean} Whether value is an array.
 */
function isArraySafely(value) {
  try {
    return Array.isArray(value);
  } catch (_err) {
    return false;
  }
}

/**
 * Assembles a full {@link SmeMetricsApiResponse} from its parts.
 *
 * This is a pure composition helper — it does not inspect or validate its
 * arguments beyond basic type safety.
 *
 * ## Invariants
 * - `data` is always a valid {@link SmeMetricsResponse} (normalised via
 *   {@link toSmeMetricsResponse}).
 * - `meta` is always a valid {@link SmeMetricsMeta} (normalised via
 *   {@link toSmeMetricsMeta}).
 * - `error` is either `null` or a plain object.
 *
 * @param {SmeMetricsResponse} data      - Aggregated invoice counts.
 * @param {SmeMetricsMeta}     meta      - Response metadata block.
 * @param {Object|null}       [error]   - Optional error detail object.
 * @returns {SmeMetricsApiResponse} The complete top-level API response DTO.
 */
function toSmeMetricsApiResponse(data, meta, error = null) {
  return {
    data: toSmeMetricsResponse(data),
    meta: toSmeMetricsMeta(meta),
    error: (error && typeof error === 'object' && !Array.isArray(error)) ? error : null,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Bulk operation duplicate detection
// ---------------------------------------------------------------------------

/**
 * Detects duplicate `{tenantId, userId}` pairs within a bulk-metrics
 * operations array.
 *
 * Two operations are considered duplicates when they share the same
 * `tenantId` **and** `userId` (exact string match).  The first occurrence is
 * treated as the canonical entry; every subsequent occurrence of the same pair
 * is reported as a duplicate.
 *
 * This function never throws; non-array input returns an empty array.
 *
 * @param {Array<{tenantId: string, userId: string}>} operations
 *   The `operations` array from a bulk metrics request body.
 * @returns {Array<{tenantId: string, userId: string, index: number}>}
 *   Duplicate entries with their position (`index`) in the original array.
 *   Empty when no duplicates are found.
 *
 * @example
 * detectDuplicateBulkOperations([
 *   { tenantId: 'T1', userId: 'U1' },
 *   { tenantId: 'T1', userId: 'U1' }, // ← duplicate at index 1
 *   { tenantId: 'T2', userId: 'U2' },
 * ]);
 * // → [{ tenantId: 'T1', userId: 'U1', index: 1 }]
 */
function detectDuplicateBulkOperations(operations) {
  if (!Array.isArray(operations)) return [];

  const seen = new Set();
  const duplicates = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op || typeof op !== 'object') continue;

    const key = `${String(op.tenantId)}::${String(op.userId)}`;
    if (seen.has(key)) {
      duplicates.push({ tenantId: op.tenantId, userId: op.userId, index: i });
    } else {
      seen.add(key);
    }
  }

  return duplicates;
}

// ---------------------------------------------------------------------------
// Persistence instrumentation — mapping functions
// ----------------------------------------------------------------------------

/**
 * Maps raw persistence-outcome arguments to a typed {@link PersistenceRecordParams} DTO.
 *
 * Boundary rules applied:
 *  - `statusCode` is validated to the range `[HTTP_STATUS_MIN, HTTP_STATUS_MAX]`
 *    (100–599); values outside this range are normalised to `0` (unknown).
 *  - `durationSeconds` is clamped to `[0, MAX_DURATION_SECONDS]` to prevent
 *    obviously-bogus values from skewing metrics.
 *
 * ## Invariants
 * - `endpoint` is a non-empty string; unknown values collapse to `'unknown'`.
 * - `statusCode` is an integer in `[100, 599]`; invalid values collapse to `200`.
 * - `durationSeconds` is a non-negative finite number; invalid values collapse to `0`.
 * - `cause` is one of `'validation' | 'storage' | 'internal' | 'none'`.
 *
 * @param {Object} raw                          - Raw outcome data.
 * @param {string} raw.endpoint                 - Endpoint label (already normalised).
 * @param {number} raw.statusCode               - HTTP status code.
 * @param {number} raw.durationSeconds          - Wall-clock duration in seconds.
 * @param {string} [raw.cause='none']           - Error cause label (already normalised).
 * @param {boolean} [raw.success]               - Whether the request succeeded.
 * @param {number} [raw.errorCount]             - Error count (0 or 1).
 * @param {import('express').Request} [raw.req] - Express request for scoped logging.
 * @returns {PersistenceRecordParams} Normalised DTO.
 */
function toPersistenceRecordParams(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const statusCode = toFiniteNumber(obj.statusCode);
  const durationSeconds = toFiniteNumber(obj.durationSeconds);

  // Validate statusCode to a sensible HTTP range; out-of-range → 200 (safe default).
  const rawStatusNum = Number(obj.statusCode);
  const finalStatusCode =
    Number.isFinite(rawStatusNum) &&
    rawStatusNum >= HTTP_STATUS_MIN &&
    rawStatusNum <= HTTP_STATUS_MAX
      ? Math.floor(rawStatusNum)
      : 200;

  // Clamp durationSeconds to [0, MAX_DURATION_SECONDS].
  // NaN → 0; Infinity → MAX_DURATION_SECONDS; -Infinity → 0.
  const rawDuration = Number(obj.durationSeconds);
  let durationSeconds;
  if (Number.isNaN(rawDuration)) {
    durationSeconds = 0;
  } else if (rawDuration === Infinity) {
    durationSeconds = MAX_DURATION_SECONDS;
  } else if (rawDuration === -Infinity) {
    durationSeconds = 0;
  } else {
    durationSeconds = Math.min(Math.max(0, rawDuration), MAX_DURATION_SECONDS);
  }

  return {
    endpoint: String(obj.endpoint || 'unknown'),
    statusCode: finalStatusCode,
    durationSeconds,
    cause: /** @type {PersistenceCause} */ (String(obj.cause || 'none')),
    req: obj.req || undefined,
  };
}

// ----------------------------------------------------------------------------
// Validation helpers (primarily for tests / guards)
// ----------------------------------------------------------------------------

/**
 * Checks whether a value is a conformant {@link SmeMetricsResponse} DTO.
 *
 * A conformant DTO has all four count fields as non-negative, finite numbers.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} `true` when the value has the expected shape.
 */
function isValidSmeMetricsResponse(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    [value.open, value.funded, value.settled, value.defaulted].every(
      (count) => typeof count === 'number' && Number.isFinite(count) && count >= 0,
    )
  );
}

/**
 * Checks whether a value is a conformant {@link PersistenceRecordParams} DTO.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} `true` when the value has the expected shape.
 */
function isValidPersistenceRecordParams(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.endpoint === 'string' &&
    Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599 &&
    typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0 &&
    typeof value.cause === 'string'
  );
}

module.exports = {
  // Boundary constants
  MAX_COUNT_VALUE,
  MAX_DURATION_SECONDS,
  HTTP_STATUS_MIN,
  HTTP_STATUS_MAX,

  // SME metrics mapping
  toSmeMetricsResponse,
  toStrictSmeMetricsResponse,
  toSmeMetricsMeta,
  toSmeMetricsApiResponse,

  // Hard-boundary validator
  validateSmeMetricsInput,

  // Bulk duplicate detection
  detectDuplicateBulkOperations,

  // Persistence instrumentation mapping
  toPersistenceRecordParams,

  // Validation helpers
  isValidSmeMetricsResponse,
  isValidPersistenceRecordParams,
  MetricsDtoValidationError,
};
