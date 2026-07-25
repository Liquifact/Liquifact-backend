'use strict';

/**
 * @fileoverview Pure computation functions for escrow derived display fields.
 *
 * Three fields are derived server-side so the UI receives ready-to-render values:
 *   apyPercent      — Annual yield rate rounded to 2 dp.
 *   fundedPercent   — Portion of invoice face value currently in escrow (0–100+).
 *   daysToMaturity  — Whole days until maturity; negative means overdue.
 *
 * ## Time-source precedence
 *
 * `daysToMaturity` (and therefore the APY-feeds display) is computed against
 * the **Stellar ledger close time** when available, falling back to the server
 * wall clock only when ledger time is absent.  This prevents a clock-skewed
 * host from mislabelling an invoice as overdue or not-yet-mature.
 *
 * Precedence (highest → lowest):
 *   1. `opts.ledgerCloseTime` — Unix epoch seconds (number) OR a `Date` object
 *      sourced from the Soroban response's `ledgerCloseTime` field.
 *   2. `opts.now`             — A `Date` override; used in tests.
 *   3. `new Date()`           — Server wall clock; last-resort fallback.
 *      **Caveat:** wall-clock time may diverge from ledger time by up to
 *      several seconds on a clock-skewed host; day-level precision is
 *      unaffected in practice but callers should supply `ledgerCloseTime`
 *      wherever the escrow read path returns one.
 *
 * ## APY assumption
 * `annualRatePercent` is treated as a simple annual rate (no compounding).
 * Invoice-discounting products use simple interest conventions.
 *
 * ## Rounding
 * All percent values use `Math.round(x * 100) / 100` (round-half-up at 2 dp)
 * to avoid IEEE 754 drift in UI rendering.
 *
 * ## Validation
 * `ledgerCloseTime` unit is validated by magnitude: milliseconds are detected
 * by comparing against a threshold (100 billion) and rejected/flagged. Absurd
 * maturity dates (> 50 years future, or > 1 year in past) are logged and
 * treated as invalid (return null for daysToMaturity).
 *
 * @module services/escrowDerived
 */

const logger = require('../logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Validation constants ──────────────────────────────────────────────────────

// Threshold to detect milliseconds vs seconds by magnitude.
// Epoch seconds in year 5138 would be ~100 billion; any ledger time claim
// above this is almost certainly milliseconds mistakenly passed as seconds.
const EPOCH_SECONDS_THRESHOLD = 100_000_000_000;

// Maximum maturity date: 50 years in future.
const MAX_FUTURE_DAYS = 50 * 365;

// Maximum overdue grace: 1 year in past (invoices shouldn't be stale longer).
const MAX_OVERDUE_DAYS = 365;

/**
 * Emit a structured warning for escrow-derived validation anomalies.
 *
 * @param {string} reason Stable machine-readable warning reason.
 * @param {string} message Human-readable warning message.
 * @param {Record<string, number|string|null>} fields Bounded structured fields.
 * @returns {void}
 */
function logEscrowDerivedWarning(reason, message, fields) {
  logger.warn(
    {
      component: 'escrowDerived',
      reason,
      ...fields,
    },
    message
  );
}

// ── Public validation helper ──────────────────────────────────────────────────

/**
 * Validates and detects the unit of a ledgerCloseTime value.
 *
 * Checks for:
 *   - Unit mismatch (milliseconds passed instead of seconds) via magnitude check
 *   - Non-numeric or malformed input
 *   - Invalid or null-like values (≤ 0)
 *
 * If the value exceeds the seconds threshold, it is presumed to be milliseconds
 * and returns null (rejected). Logs a warning for debugging.
 *
 * @param {number|Date|null|undefined} value - Claimed ledgerCloseTime in epoch seconds
 * @returns {number|Date|null} Valid epoch seconds (number) as passed, null if rejected
 */
function validateLedgerCloseTimeUnit(value) {
  // Dates are passthrough-valid (already in the right format)
  if (value instanceof Date) {
    return value;
  }

  // Null, undefined, or zero → treat as absent (not an error)
  if (value == null || value === 0) {
    return null;
  }

  // Coerce to number and validate
  const num = Number(value);

  // Non-numeric, negative, or NaN → invalid
  if (!isFinite(num) || num < 0) {
    logEscrowDerivedWarning(
      'invalid_ledger_close_time',
      '[escrowDerived] ledgerCloseTime is non-numeric or negative',
      {
        ledgerCloseTime: Number.isFinite(num) ? num : null,
        valueType: typeof value,
      }
    );
    return null;
  }

  // Magnitude check: values at or above the threshold are not epoch seconds.
  if (num >= EPOCH_SECONDS_THRESHOLD) {
    logEscrowDerivedWarning(
      'ledger_close_time_unit_mismatch',
      '[escrowDerived] ledgerCloseTime ' + num + ' exceeds threshold ' + EPOCH_SECONDS_THRESHOLD + '; unit mismatch suspected (milliseconds passed as seconds?). Rejecting.',
      {
        ledgerCloseTime: num,
        threshold: EPOCH_SECONDS_THRESHOLD,
      }
    );
    return null;
  }

  // Valid epoch seconds
  return num;
}

/**
 * Validates maturity date for plausible bounds.
 *
 * Checks:
 *   - Not more than 50 years in the future
 *   - Not more than 1 year in the past (beyond grace period for stale invoices)
 *
 * Returns true if valid; logs a warning and returns false otherwise.
 *
 * @param {Date} maturityDate
 * @param {Date} referenceTime
 * @returns {boolean}
 */
function validateMaturityDateBounds(maturityDate, referenceTime) {
  const daysDiff = Math.floor(
    (maturityDate.getTime() - referenceTime.getTime()) / MS_PER_DAY
  );

  if (daysDiff > MAX_FUTURE_DAYS) {
    logEscrowDerivedWarning(
      'maturity_date_too_far_future',
      '[escrowDerived] maturityDate is ' + daysDiff + ' days in future (> ' + MAX_FUTURE_DAYS + ' day max); absurd value flagged. Treating as invalid.',
      {
        daysDiff,
        maxFutureDays: MAX_FUTURE_DAYS,
      }
    );
    return false;
  }

  if (daysDiff < -MAX_OVERDUE_DAYS) {
    logEscrowDerivedWarning(
      'maturity_date_too_far_past',
      '[escrowDerived] maturityDate is ' + daysDiff + ' days in past (> ' + MAX_OVERDUE_DAYS + ' day grace); stale or malformed. Treating as invalid.',
      {
        daysDiff,
        maxOverdueDays: MAX_OVERDUE_DAYS,
      }
    );
    return false;
  }

  return true;
}

// ── Core functions (updated) ──────────────────────────────────────────────────

/**
 * Resolves the effective reference `Date` from caller options.
 *
 * Precedence: `ledgerCloseTime` > `now` > server wall clock.
 *
 * Validates ledgerCloseTime unit (seconds vs milliseconds) and rejects values
 * that exceed the magnitude threshold.
 *
 * @param {object} [opts={}]
 * @param {number|Date|null|undefined} [opts.ledgerCloseTime] - Stellar ledger
 *   close time as Unix epoch **seconds** (number) or a `Date`.  Values ≤ 0
 *   are treated as absent. If > EPOCH_SECONDS_THRESHOLD, presumed to be
 *   milliseconds (unit mismatch) and rejected.
 * @param {Date|null|undefined} [opts.now] - Explicit override for tests.
 * @returns {Date} The resolved reference time.
 */
function resolveReferenceTime(opts = {}) {
  const { ledgerCloseTime, now } = opts;

  // 1. Ledger close time (preferred)
  if (ledgerCloseTime != null) {
    // Validate unit and detect milliseconds masquerading as seconds
    const validated = validateLedgerCloseTimeUnit(ledgerCloseTime);

    if (validated != null) {
      const ledgerDate =
        validated instanceof Date
          ? validated
          : new Date(Number(validated) * 1000); // epoch seconds → ms

      if (!isNaN(ledgerDate.getTime()) && ledgerDate.getTime() > 0) {
        return ledgerDate;
      }
    }
    // If validation failed or date parse failed, fall through to fallback
  }

  // 2. Explicit `now` override (tests)
  if (now instanceof Date && !isNaN(now.getTime())) {
    return now;
  }

  // 3. Server wall clock (fallback — see caveat in module JSDoc)
  return new Date();
}

/**
 * Computes APY from a simple annual rate.
 *
 * @param {unknown} annualRatePercent - e.g. 8.5 for 8.5 %.
 * @returns {number|null} Rounded to 2 dp, or null on bad input.
 */
function computeApyPercent(annualRatePercent) {
  if (
    typeof annualRatePercent !== 'number' ||
    !isFinite(annualRatePercent) ||
    annualRatePercent < 0
  ) {
    return null;
  }
  return Math.round(annualRatePercent * 100) / 100;
}

/**
 * Computes funded percent: (fundedAmount / totalAmount) * 100, rounded to 2 dp.
 * Returns null when totalAmount is zero/negative or either value is non-numeric.
 *
 * @param {unknown} fundedAmount - Amount currently held in escrow.
 * @param {unknown} totalAmount  - Invoice face value (denominator).
 * @returns {number|null}
 */
function computeFundedPercent(fundedAmount, totalAmount) {
  if (
    typeof fundedAmount !== 'number' ||
    !isFinite(fundedAmount) ||
    typeof totalAmount !== 'number' ||
    !isFinite(totalAmount) ||
    totalAmount <= 0
  ) {
    return null;
  }
  return Math.round((fundedAmount / totalAmount) * 10000) / 100;
}

/**
 * Computes whole days from the reference time to `maturityDate`.
 * Uses `Math.floor` so a maturity later the same day returns 0.
 * Negative values indicate overdue.
 *
 * The reference time is resolved via {@link resolveReferenceTime}:
 * ledger close time is used when supplied; falls back to `opts.now` then the
 * server wall clock.
 *
 * Maturity date is validated against plausible bounds (≤ 50 years future,
 * ≥ 1 year overdue grace). Absurd dates return null.
 *
 * @param {Date|string|number|null|undefined} maturityDate
 * @param {Date|Object} [opts] - A `Date` reference time **or** an options
 *   object with `ledgerCloseTime` / `now` fields.  When a `Date` is passed it
 *   is used directly.  When an object is passed, time is resolved via
 *   {@link resolveReferenceTime} with `ledgerCloseTime` taking precedence
 *   over `now`.
 * @param {number|Date|null|undefined} [opts.ledgerCloseTime] - Stellar
 *   ledger close time in Unix epoch **seconds**.  Takes precedence.
 * @param {Date|null|undefined} [opts.now] - Explicit reference time.
 * @returns {number|null} Null when maturityDate is absent, unparseable, or out of bounds.
 */
function computeDaysToMaturity(maturityDate, opts = {}) {
  if (maturityDate == null) {
    return null;
  }

  const maturity = maturityDate instanceof Date ? maturityDate : new Date(maturityDate);
  if (isNaN(maturity.getTime())) {
    return null;
  }

  // Backwards-compat: callers may pass a Date as the second argument.
  const options = opts instanceof Date ? { now: opts } : opts || {};

  const reference = resolveReferenceTime(options);

  // Validate maturity date bounds against the reference time
  if (!validateMaturityDateBounds(maturity, reference)) {
    return null;
  }

  return Math.floor((maturity.getTime() - reference.getTime()) / MS_PER_DAY);
}

/**
 * Derives display fields from a raw escrow state object.
 *
 * Source fields consumed from `state`:
 *   fundedAmount      {number}             — Amount currently held.
 *   totalAmount       {number}             — Invoice face value.
 *   annualRatePercent {number}             — Simple annual yield in % (e.g. 8.5).
 *   maturityDate      {Date|string|number} — Maturity timestamp.
 *   maturityTimestamp {Date|string|number} — Alias for maturityDate; ignored when
 *                                            maturityDate is present.
 *
 * All output fields default to null when their source data is absent or invalid.
 *
 * ## Time-source precedence for daysToMaturity
 *   1. `opts.ledgerCloseTime` — Unix epoch seconds from the Soroban response.
 *   2. `opts.now`             — Explicit override (tests).
 *   3. `new Date()`           — Server wall clock (fallback; see module caveat).
 *
 * ## Validation
 * `ledgerCloseTime` unit is validated (milliseconds detected and rejected).
 * Maturity date bounds are checked; absurd values return null for daysToMaturity.
 *
 * @param {object} state - Raw escrow state.
 * @param {object} [opts={}]
 * @param {number|Date|null|undefined} [opts.ledgerCloseTime] - Stellar ledger
 *   close time in Unix epoch **seconds** (or a `Date`).  Preferred time source
 *   for `daysToMaturity`.  Sourced from the Soroban `ledgerCloseTime` field
 *   returned by {@link module:services/escrowRead.readEscrowState}.
 *   Unit validation detects and rejects milliseconds.
 * @param {Date|null|undefined} [opts.now] - Fallback reference time (tests).
 * @returns {{ apyPercent: number|null, fundedPercent: number|null, daysToMaturity: number|null }}
 */
function computeEscrowDerivedFields(state, opts = {}) {
  const { fundedAmount, totalAmount, annualRatePercent, maturityDate, maturityTimestamp } =
    state;

  const maturity =
    maturityDate != null ? maturityDate : maturityTimestamp != null ? maturityTimestamp : null;

  return {
    apyPercent: computeApyPercent(annualRatePercent),
    fundedPercent: computeFundedPercent(fundedAmount, totalAmount),
    daysToMaturity: computeDaysToMaturity(maturity, opts),
  };
}

module.exports = {
  computeApyPercent,
  computeFundedPercent,
  computeDaysToMaturity,
  computeEscrowDerivedFields,
  resolveReferenceTime,
  validateLedgerCloseTimeUnit,
  validateMaturityDateBounds,
};
