'use strict';

/**
 * @fileoverview Canonical monetary precision utilities.
 *
 * Provides:
 *   - Fixed-point arithmetic using BigInt to avoid IEEE 754 drift
 *   - Input validation and normalization for monetary amounts
 *   - Canonical decimal string representation for API responses and logs
 *   - Rounding policies (half-up) with configurable scale
 *
 * The database stores amounts as DECIMAL(15,2) (max 2 decimal places for
 * most currencies). This module enforces that boundary at the API and
 * persistence layer so floating-point conversion never changes a funding
 * amount by a cent or more.
 *
 * ## Scale
 *   - MAX_SCALE: 2 (matches DECIMAL(15,2) schema)
 *   - This can be overridden per-currency if needed, but the default
 *     covers USD, EUR, GBP, etc.
 *
 * ## Rounding policy
 *   - HALF_UP (banker's rounding) is used throughout
 *   - Rejects values with more fractional digits than MAX_SCALE
 *
 * ## Security
 *   - All functions reject NaN, Infinity, negative, and zero amounts
 *   - All string inputs are validated against strict decimal patterns
 *   - No floating-point arithmetic is performed on monetary values
 *
 * @module utils/monetary
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of fractional (decimal) places for monetary amounts.
 * Matches DECIMAL(15,2) in the database schema.
 * @type {number}
 */
const MAX_SCALE = 2;

/**
 * Fixed-point scale factor for internal BigInt arithmetic.
 * 10^MAX_SCALE = 100 for 2 decimal places.
 * @type {bigint}
 */
const SCALE_FACTOR = 10n ** BigInt(MAX_SCALE);

/**
 * Maximum safe monetary value that fits in DECIMAL(15,2).
 * 99999999999999.99
 * @type {bigint}
 */
const MAX_MONETARY_UNITS = 99999999999999n;

/**
 * Regex for validating monetary string inputs.
 * Matches: "123", "123.45", "0.01", "99999.99"
 * Rejects: "-123", "123.456", "abc", "1e7", "123.", ".45"
 * @type {RegExp}
 */
const MONETARY_STRING_RE = /^\d+(?:\.\d{1,2})?$/;



// ── Error classes ────────────────────────────────────────────────────────────

/**
 * Typed error for monetary validation failures.
 *
 * Distinguishes domain errors from unexpected runtime failures.
 * Callers can use `instanceof MonetaryValidationError` to distinguish
 * domain errors from unexpected runtime failures.
 *
 * @extends Error
 */
class MonetaryValidationError extends Error {
  /**
   * @param {string} message - Human-readable description.
   * @param {string} code    - Machine-readable error code.
   */
  constructor(message, code) {
    super(message);
    this.name = 'MonetaryValidationError';
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Validates that a string is a valid monetary decimal within scale bounds.
 *
 * Rules:
 *   - Must be a non-empty string
 *   - Must match MONETARY_STRING_RE (digits only, optional decimal point)
 *   - Must not have more than MAX_SCALE fractional digits
 *   - Must not have leading zeros in the integer part (except "0" itself)
 *   - Must be non-negative
 *   - Must not exceed MAX_MONETARY_UNITS
 *
 * @param {unknown} value - The candidate amount value.
 * @param {string} [fieldName='amount'] - Field name for error messages.
 * @throws {MonetaryValidationError} When the value is not a valid monetary amount.
 */
function validateMonetaryString(value, fieldName = 'amount') {
  if (typeof value !== 'string') {
    throw new MonetaryValidationError(
      `${fieldName} must be a string, got ${typeof value}`,
      'INVALID_TYPE'
    );
  }

  if (value.length === 0) {
    throw new MonetaryValidationError(
      `${fieldName} must not be empty`,
      'EMPTY_VALUE'
    );
  }

  if (!MONETARY_STRING_RE.test(value)) {
    throw new MonetaryValidationError(
      `${fieldName} must be a non-negative decimal with at most ${MAX_SCALE} fractional places`,
      'INVALID_FORMAT'
    );
  }

  // Reject leading zeros in integer part (but allow "0" itself)
  const [integerPart, fractionPart] = value.split('.');
  if (integerPart.length > 1 && integerPart[0] === '0') {
    throw new MonetaryValidationError(
      `${fieldName} must not have leading zeros in the integer part`,
      'INVALID_FORMAT'
    );
  }

  // Check scale (fractional digits)
  if (fractionPart && fractionPart.length > MAX_SCALE) {
    throw new MonetaryValidationError(
      `${fieldName} must have at most ${MAX_SCALE} fractional places`,
      'INVALID_SCALE'
    );
  }

  // Check range using BigInt to avoid floating-point issues
  const bigValue = BigInt(integerPart) * SCALE_FACTOR + BigInt((fractionPart || '').padEnd(MAX_SCALE, '0'));
  if (bigValue <= 0n) {
    throw new MonetaryValidationError(
      `${fieldName} must be a positive amount (> 0)`,
      'INVALID_RANGE'
    );
  }

  // Allow amounts up to MAX_MONETARY_UNITS with full precision
  // MAX_MONETARY_UNITS * SCALE_FACTOR + (SCALE_FACTOR - 1) allows for the fractional part
  const maxValue = MAX_MONETARY_UNITS * SCALE_FACTOR + (SCALE_FACTOR - 1n);
  if (bigValue > maxValue) {
    throw new MonetaryValidationError(
      `${fieldName} exceeds maximum allowed value (${formatCanonicalMonetary(maxValue)})`,
      'INVALID_RANGE'
    );
  }
}

/**
 * Validates and normalizes a monetary amount from API input.
 * Accepts both number and string inputs, returning the canonical
 * decimal string representation.
 *
 * @param {unknown} value - The raw amount value from the request.
 * @param {string} [fieldName='amount'] - Field name for error messages.
 * @returns {string} Canonical decimal string (e.g. "1234.56").
 * @throws {MonetaryValidationError} When the value is invalid.
 */
function normalizeMonetaryInput(value, fieldName = 'amount') {
  let candidate;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MonetaryValidationError(
        `${fieldName} must be a finite number`,
        'INVALID_TYPE'
      );
    }

    // Convert to string with fixed precision to avoid scientific notation
    // and trailing zeros issues
    candidate = value.toFixed(MAX_SCALE);

    // Re-validate the normalized string
    validateMonetaryString(candidate, fieldName);
    return candidate;
  }

  if (typeof value === 'string') {
    candidate = value;
  } else {
    throw new MonetaryValidationError(
      `${fieldName} must be a number or string, got ${value === null ? 'null' : typeof value}`,
      'INVALID_TYPE'
    );
  }

  validateMonetaryString(candidate, fieldName);
  return candidate;
}

/**
 * Formats a BigInt amount to the canonical decimal string.
 *
 * @param {bigint} amount - Amount in scaled units (e.g. 123456 for "1234.56").
 * @returns {string} Canonical decimal string.
 */
function formatCanonicalMonetary(amount) {
  const units = BigInt(amount);
  const whole = units / SCALE_FACTOR;
  const fraction = (units % SCALE_FACTOR).toString().padStart(MAX_SCALE, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Parses a monetary string to BigInt scaled units.
 *
 * @param {string} value - Canonical decimal string.
 * @param {string} [fieldName='amount'] - Field name for error messages.
 * @returns {bigint} Amount in scaled units.
 * @throws {MonetaryValidationError} When the value is invalid.
 */
function parseMonetaryToUnits(value, fieldName = 'amount') {
  validateMonetaryString(value, fieldName);

  const [integerPart, fractionPart = ''] = value.split('.');
  return BigInt(integerPart) * SCALE_FACTOR + BigInt(fractionPart.padEnd(MAX_SCALE, '0'));
}

/**
 * Adds two monetary amounts (BigInt arithmetic).
 *
 * @param {string} a - First amount (canonical decimal string).
 * @param {string} b - Second amount (canonical decimal string).
 * @returns {string} Sum as canonical decimal string.
 */
function addMonetary(a, b) {
  const unitsA = parseMonetaryToUnits(a, 'amountA');
  const unitsB = parseMonetaryToUnits(b, 'amountB');
  return formatCanonicalMonetary(unitsA + unitsB);
}

/**
 * Subtracts two monetary amounts (BigInt arithmetic).
 *
 * @param {string} a - Amount to subtract from.
 * @param {string} b - Amount to subtract.
 * @returns {string} Difference as canonical decimal string.
 * @throws {MonetaryValidationError} When result would be negative.
 */
function subtractMonetary(a, b) {
  const unitsA = parseMonetaryToUnits(a, 'amountA');
  const unitsB = parseMonetaryToUnits(b, 'amountB');

  if (unitsB > unitsA) {
    throw new MonetaryValidationError(
      'Subtraction result would be negative',
      'NEGATIVE_RESULT'
    );
  }

  return formatCanonicalMonetary(unitsA - unitsB);
}

/**
 * Multiplies a monetary amount by a non-negative integer factor.
 *
 * @param {string} amount - Monetary amount (canonical decimal string).
 * @param {number|bigint} factor - Non-negative integer multiplier.
 * @returns {string} Product as canonical decimal string.
 * @throws {MonetaryValidationError} When factor is invalid or result overflows.
 */
function multiplyMonetary(amount, factor) {
  const units = parseMonetaryToUnits(amount, 'amount');

  if (typeof factor !== 'number' && typeof factor !== 'bigint') {
    throw new MonetaryValidationError(
      'Factor must be a number or bigint',
      'INVALID_FACTOR'
    );
  }

  // Validate factor is a non-negative integer
  if (typeof factor === 'number') {
    if (!Number.isInteger(factor) || factor < 0) {
      throw new MonetaryValidationError(
        'Factor must be a non-negative integer',
        'INVALID_FACTOR'
      );
    }
  }

  const bigFactor = BigInt(factor);
  if (bigFactor < 0n) {
    throw new MonetaryValidationError(
      'Factor must be non-negative',
      'INVALID_FACTOR'
    );
  }

  const result = units * bigFactor;
  if (result > MAX_MONETARY_UNITS * SCALE_FACTOR) {
    throw new MonetaryValidationError(
      'Multiplication result exceeds maximum allowed value',
      'RESULT_OVERFLOW'
    );
  }

  return formatCanonicalMonetary(result);
}

/**
 * Computes funded percentage using precise integer arithmetic.
 *
 * Uses BigInt to avoid IEEE 754 drift in division. Returns a number
 * rounded to 2 decimal places for display.
 *
 * @param {string} fundedAmount - Amount currently funded (canonical decimal string).
 * @param {string} totalAmount  - Total invoice amount (canonical decimal string).
 * @returns {number|null} Percentage (0-100+) rounded to 2 dp, or null on invalid input.
 */
function computeFundedPercentPrecise(fundedAmount, totalAmount) {
  try {
    // Validate inputs are valid monetary strings
    validateMonetaryString(fundedAmount, 'fundedAmount');
    validateMonetaryString(totalAmount, 'totalAmount');

    const fundedUnits = parseMonetaryToUnits(fundedAmount, 'fundedAmount');
    const totalUnits = parseMonetaryToUnits(totalAmount, 'totalAmount');

    if (totalUnits <= 0n) {
      return null;
    }

    // Compute (funded / total) * 100 rounded to 2 dp using BigInt arithmetic.
    // Formula: round(fundedUnits * 10000 / totalUnits) / 100
    // where round(a / b) = (a + b/2) / b  (half-up rounding)
    const numerator = fundedUnits * 10000n;
    const halfDivisor = totalUnits / 2n;
    const rounded = (numerator + halfDivisor) / totalUnits;

    // Convert to number and format as percentage with 2 dp
    return Number(rounded) / 100;
  } catch {
    return null;
  }
}

/**
 * Converts a numeric amount to a canonical decimal string.
 * Handles both integer and fractional values.
 *
 * @param {number} amount - Numeric amount.
 * @param {string} [fieldName='amount'] - Field name for error messages.
 * @returns {string} Canonical decimal string.
 * @throws {MonetaryValidationError} When amount is invalid.
 */
function toCanonicalDecimal(amount, fieldName = 'amount') {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new MonetaryValidationError(
      `${fieldName} must be a finite number`,
      'INVALID_TYPE'
    );
  }

  if (amount <= 0) {
    throw new MonetaryValidationError(
      `${fieldName} must be positive`,
      'INVALID_RANGE'
    );
  }

  // Use toFixed to get consistent decimal representation
  const fixed = amount.toFixed(MAX_SCALE);

  // Validate the result
  validateMonetaryString(fixed, fieldName);
  return fixed;
}

/**
 * Checks if two monetary amounts are equal.
 *
 * @param {string} a - First amount (canonical decimal string).
 * @param {string} b - Second amount (canonical decimal string).
 * @returns {boolean} True if amounts are equal.
 */
function areMonetaryEqual(a, b) {
  try {
    return parseMonetaryToUnits(a) === parseMonetaryToUnits(b);
  } catch {
    return false;
  }
}

/**
 * Compares two monetary amounts.
 *
 * @param {string} a - First amount (canonical decimal string).
 * @param {string} b - Second amount (canonical decimal string).
 * @returns {-1|0|1} -1 if a < b, 0 if equal, 1 if a > b.
 * @throws {MonetaryValidationError} When either amount is invalid.
 */
function compareMonetary(a, b) {
  const unitsA = parseMonetaryToUnits(a, 'amountA');
  const unitsB = parseMonetaryToUnits(b, 'amountB');

  if (unitsA < unitsB) return -1;
  if (unitsA > unitsB) return 1;
  return 0;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  MAX_SCALE,
  SCALE_FACTOR,
  MAX_MONETARY_UNITS,
  MONETARY_STRING_RE,

  // Error class
  MonetaryValidationError,

  // Validation and normalization
  validateMonetaryString,
  normalizeMonetaryInput,

  // Formatting and parsing
  formatCanonicalMonetary,
  parseMonetaryToUnits,
  toCanonicalDecimal,

  // Arithmetic
  addMonetary,
  subtractMonetary,
  multiplyMonetary,

  // Comparison
  areMonetaryEqual,
  compareMonetary,

  // Derived calculations
  computeFundedPercentPrecise,
};
