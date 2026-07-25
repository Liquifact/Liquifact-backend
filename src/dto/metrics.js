'use strict';

/**
 * @fileoverview Typed request/response DTOs for the metrics module.
 *
 * Defines JSDoc typedefs for every data shape that crosses a module boundary
 * (routes &#x21D2; services &#x21D2; metrics instrumentation) and provides pure
 * mapping functions that transform between raw/untrusted input and typed DTOs.
 *
 * Each mapping function validates and coerces fields so callers can rely on
 * the returned DTO having the declared shape.  Unknown or missing fields are
 * given safe defaults / filtered out — no runtime exceptions are thrown for
 * malformed input.
 *
 * ## Usage
 *
 * ```js
 * const { toSmeMetricsResponse } = require('../../dto/metrics');
 *
 * const raw = await invoiceService.getSmeInvoiceCounts(tenantId, userId);
 * const dto = toSmeMetricsResponse(raw);
 * // dto is now guaranteed { open: number, funded: number, settled: number, defaulted: number }
 * ```
 *
 * @module dto/metrics
 */

// ---------------------------------------------------------------------------
// SME Metrics Dashboard DTOs
// ---------------------------------------------------------------------------

/**
 * Aggregated invoice counts returned by the SME metrics endpoint.
 * Every field is a non-negative integer.
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
 * @property {Array<Object>}   [invoices]   - Paginated invoice rows for the current page.
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

// ---------------------------------------------------------------------------
// Persistence Instrumentation DTOs
// ---------------------------------------------------------------------------

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
 * @property {import('express').Request} [req]          - Express request (for scoped logging).
 */

// ---------------------------------------------------------------------------
// SME Metrics — mapping functions
// ---------------------------------------------------------------------------

/**
 * Maps a raw invoice-counts object to a typed {@link SmeMetricsResponse} DTO.
 *
 * Every field is coerced to a safe integer.  Unknown keys on the raw object
 * are silently stripped.  This function never throws.
 *
 * @param {unknown} raw - Raw counts object from the invoice service or DB query.
 * @returns {SmeMetricsResponse} Normalised DTO with all four keys guaranteed.
 */
function toSmeMetricsResponse(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    open: Number(obj.open) || 0,
    funded: Number(obj.funded) || 0,
    settled: Number(obj.settled) || 0,
    defaulted: Number(obj.defaulted) || 0,
  };
}

/**
 * Maps a raw meta-like object to a normalised {@link SmeMetricsMeta} DTO.
 *
 * Optional pagination fields are preserved when present on the raw input;
 * otherwise they are omitted from the returned meta object.
 *
 * @param {unknown} raw - Raw meta-like object (e.g. from invoice service or
 *   a manually constructed meta block in the route handler).
 * @returns {SmeMetricsMeta} Normalised meta DTO.
 */
function toSmeMetricsMeta(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  // Mandatory fields with defaults.
  const meta = {
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString(),
    version: typeof obj.version === 'string' ? obj.version : '0.1.0',
  };

  // Optional pagination fields — only include when the source had them.
  if (Array.isArray(obj.invoices)) {
    meta.invoices = obj.invoices;
  }
  if (typeof obj.total === 'number' && Number.isFinite(obj.total)) {
    meta.total = Math.max(0, Math.floor(obj.total));
  }
  if (typeof obj.limit === 'number' && Number.isFinite(obj.limit)) {
    meta.limit = obj.limit;
  }
  if (typeof obj.hasMore === 'boolean') {
    meta.hasMore = obj.hasMore;
  }
  // Explicitly handle nextCursor — null is a valid terminal value.
  if (Object.prototype.hasOwnProperty.call(obj, 'nextCursor')) {
    meta.nextCursor = obj.nextCursor === undefined ? null : obj.nextCursor;
  }

  return /** @type {SmeMetricsMeta} */ (meta);
}

/**
 * Assembles a full {@link SmeMetricsApiResponse} from its parts.
 *
 * This is a pure composition helper — it does not inspect or validate its
 * arguments beyond basic type safety.
 *
 * @param {SmeMetricsResponse} data      - Aggregated invoice counts.
 * @param {SmeMetricsMeta}     meta      - Response metadata block.
 * @param {Object|null}       [error]   - Optional error detail object.
 * @returns {SmeMetricsApiResponse} The complete top-level API response DTO.
 */
function toSmeMetricsApiResponse(data, meta, error = null) {
  return {
    data,
    meta,
    error,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persistence instrumentation — mapping functions
// ---------------------------------------------------------------------------

/**
 * Maps raw persistence-outcome arguments to a typed {@link PersistenceRecordParams} DTO.
 *
 * The `endpoint`, `cause`, and `statusCode` fields are expected to have already
 * been normalised by the caller (typically via the normalizers in
 * {@link module:metrics}).  This function validates the shape and provides safe
 * defaults for any missing fields.
 *
 * @param {Object} raw                          - Raw outcome data.
 * @param {string} raw.endpoint                 - Endpoint label (already normalised).
 * @param {number} raw.statusCode               - HTTP status code.
 * @param {number} raw.durationSeconds          - Wall-clock duration in seconds.
 * @param {string} [raw.cause='none']           - Error cause label (already normalised).
 * @param {import('express').Request} [raw.req] - Express request for scoped logging.
 * @returns {PersistenceRecordParams} Normalised DTO.
 */
function toPersistenceRecordParams(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  return {
    endpoint: String(obj.endpoint || 'unknown'),
    statusCode: Number(obj.statusCode) || 200,
    durationSeconds: Number(obj.durationSeconds) || 0,
    cause: /** @type {PersistenceCause} */ (String(obj.cause || 'none')),
    req: obj.req || undefined,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers (primarily for tests / guards)
// ---------------------------------------------------------------------------

/**
 * Checks whether a value is a conformant {@link SmeMetricsResponse} DTO.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} `true` when the value has the expected shape.
 */
function isValidSmeMetricsResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    typeof value.open === 'number' &&
    typeof value.funded === 'number' &&
    typeof value.settled === 'number' &&
    typeof value.defaulted === 'number'
  );
}

/**
 * Checks whether a value is a conformant {@link PersistenceRecordParams} DTO.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} `true` when the value has the expected shape.
 */
function isValidPersistenceRecordParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    typeof value.endpoint === 'string' &&
    typeof value.statusCode === 'number' &&
    typeof value.durationSeconds === 'number' &&
    typeof value.cause === 'string'
  );
}

module.exports = {
  // SME metrics mapping
  toSmeMetricsResponse,
  toSmeMetricsMeta,
  toSmeMetricsApiResponse,

  // Persistence instrumentation mapping
  toPersistenceRecordParams,

  // Validation helpers
  isValidSmeMetricsResponse,
  isValidPersistenceRecordParams,
};
