'use strict';

/**
 * Clock helper for injectable "now" in tests.
 *
 * Default implementation returns current UTC date as YYYY-MM-DD string.
 * Tests can override this by calling setTestClock with a fixed date.
 */

let testClock = null;

/**
 * Returns current UTC date as YYYY-MM-DD string.
 *
 * @returns {string} date in YYYY-MM-DD format
 */
function todayAsIso() {
  if (testClock !== null) {
    return testClock;
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sets a fixed date for testing (e.g., '2026-11-24').
 *
 * @param {string|null} date ISO date string (YYYY-MM-DD) or null to reset
 */
function setTestClock(date) {
  testClock = date;
}

/**
 * Resets the test clock to use real time.
 */
function resetTestClock() {
  testClock = null;
}

module.exports = { todayAsIso, setTestClock, resetTestClock };
