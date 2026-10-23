'use strict';

/**
 * Strict ISO calendar-date helpers for dueDate validation.
 *
 * Maturity convention
 * -------------------
 * On-chain, "maturity" is a Unix timestamp in seconds. We define maturity as
 * 00:00:00 UTC **of dueDate itself** (start of that UTC day). Rationale:
 *
 *   • The Soroban escrow contract seed for INV_0001 (dueDate "2027-01-17")
 *     stores an on-chain maturity of 1800132005.
 *   • 00:00:00 UTC of 2027-01-17 = 1800144000  →  delta = +11 995 s ≈ 3.3 h.
 *   • 00:00:00 UTC of 2027-01-18 (next-day) = 1800230400 → delta = +98 395 s ≈ 27 h.
 *   • The start-of-day convention keeps our value within the ±1-day tolerance
 *     stated in issue #1531, while next-day midnight falls outside that window.
 *
 * If you need end-of-day semantics, use unixSeconds + 86399 at call sites.
 */

/** Regex: exactly YYYY-MM-DD, nothing more. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a strict ISO calendar date string.
 *
 * Accepts only strings matching /^\d{4}-\d{2}-\d{2}$/ that represent a real
 * calendar date (i.e. components round-trip through UTC without rolling over).
 * "2027-02-30" is rejected because Date.UTC rolls it to March 2.
 *
 * @param {string} str  The candidate date string.
 * @returns {{ date: Date, unixSeconds: number } | null}
 *   Parsed result where `date` is 00:00:00 UTC of that day and `unixSeconds`
 *   is the on-chain maturity (also 00:00:00 UTC of that day), or `null` on failure.
 */
function parseIsoDate(str) {
  if (typeof str !== 'string' || !ISO_DATE_RE.test(str)) {
    return null;
  }

  const [year, month, day] = str.split('-').map(Number);

  // Date.UTC accepts out-of-range values by rolling over (e.g. Feb 30 → Mar 2).
  // Build the timestamp and verify the component round-trip to detect roll-overs.
  const tsMs = Date.UTC(year, month - 1, day);
  const d = new Date(tsMs);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }

  // Maturity = 00:00:00 UTC of dueDate itself.
  const unixSeconds = Math.floor(tsMs / 1000);

  return { date: d, unixSeconds };
}

module.exports = { parseIsoDate };
