'use strict';

/**
 * Optimistic concurrency primitives for invoice mutations.
 *
 * The HTTP layer may accept a version from a body or an If-Match header, but
 * it must normalize that value before calling the persistence service. This
 * module deliberately contains no database code: keeping parsing and error
 * construction pure makes the contract easy to exercise without a database.
 */

const VERSION_PATTERN = /^(?:W\/)?(?:"?)([1-9][0-9]{0,18})(?:"?)$/;
const MAX_VERSION = Number.MAX_SAFE_INTEGER;

class InvoiceVersionError extends Error {
  constructor(code, detail, status = 400, currentVersion = undefined) {
    super(detail);
    this.name = 'InvoiceVersionError';
    this.code = code;
    this.statusCode = status;
    this.currentVersion = currentVersion;
  }
}

class InvoiceVersionConflictError extends InvoiceVersionError {
  constructor(expectedVersion, currentVersion) {
    super(
      'VERSION_CONFLICT',
      `Invoice version ${expectedVersion} is stale; current version is ${currentVersion}.`,
      409,
      currentVersion,
    );
    this.expectedVersion = expectedVersion;
  }
}

/**
 * Parse a version supplied by an API client.
 *
 * `undefined`, null, empty strings, zero, decimals, signs, and unsafe integer
 * values are rejected instead of being silently coerced. A weak ETag is
 * accepted so clients can use the version returned by a cache-aware GET.
 *
 * @param {unknown} input
 * @returns {number}
 * @throws {InvoiceVersionError}
 */
function parseExpectedVersion(input) {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 1) {
      throw new InvoiceVersionError('INVALID_VERSION', 'version must be a positive safe integer.');
    }
    return input;
  }

  if (typeof input !== 'string' || input.trim() === '') {
    throw new InvoiceVersionError('VERSION_REQUIRED', 'version is required for invoice updates.');
  }

  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) {
    throw new InvoiceVersionError('INVALID_VERSION', 'version must be a positive integer or weak ETag.');
  }

  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version > MAX_VERSION) {
    throw new InvoiceVersionError('INVALID_VERSION', 'version exceeds the supported range.');
  }
  return version;
}

/**
 * Convert an invoice row to a stable public representation. Database drivers
 * can return numeric columns as strings; version must remain a JSON number.
 */
function normalizeInvoiceVersion(row) {
  if (!row || typeof row !== 'object') return row;
  const normalized = { ...row };
  const value = Number(normalized.version);
  if (Number.isSafeInteger(value) && value >= 1) normalized.version = value;
  return normalized;
}

/**
 * Validate a stored row before it participates in a compare-and-set update.
 * Bad legacy rows fail closed rather than allowing a non-versioned write.
 */
function requireStoredVersion(row) {
  if (!row || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1) {
    throw new InvoiceVersionError(
      'INVALID_STORED_VERSION',
      'Invoice has no valid concurrency version; migration is required.',
      500,
    );
  }
  return Number(row.version);
}

/**
 * Construct a conflict response payload without leaking SQL details.
 */
function conflictPayload(error) {
  if (!(error instanceof InvoiceVersionError)) throw error;
  return {
    error: error.code === 'VERSION_CONFLICT' ? 'version_conflict' : error.code.toLowerCase(),
    code: error.code,
    message: error.message,
    ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
  };
}

/**
 * Return the version value an update should use. This keeps the route's
 * precedence explicit: a body version wins, then If-Match, and no implicit
 * current-version read is permitted.
 */
function expectedVersionFromRequest(body, ifMatch) {
  const candidate = body && Object.prototype.hasOwnProperty.call(body, 'version')
    ? body.version
    : ifMatch;
  return parseExpectedVersion(candidate);
}

module.exports = {
  InvoiceVersionError,
  InvoiceVersionConflictError,
  parseExpectedVersion,
  normalizeInvoiceVersion,
  requireStoredVersion,
  conflictPayload,
  expectedVersionFromRequest,
  VERSION_PATTERN,
  MAX_VERSION,
};
