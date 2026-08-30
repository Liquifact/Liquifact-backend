'use strict';

const { encodeCursor, decodeCursor } = require('./cursorPagination');

/** Maximum number of invoices returned by one request. */
const MAX_INVOICE_PAGE_SIZE = 100;
/** Default number of invoices returned when `limit` is omitted or unusable. */
const DEFAULT_INVOICE_PAGE_SIZE = 10;

/**
 * Public invoice sort aliases and their database columns.
 * The id column is always appended by the service as a unique tiebreaker.
 */
const INVOICE_SORT_COLUMNS = Object.freeze({
  amount: 'amount',
  date: 'date',
  created_at: 'created_at',
});

/**
 * Normalize an invoice page size at the service boundary.
 *
 * Route validation clamps valid positive values. This second normalization is
 * intentional: services are also called by jobs, scripts, and tests, and no
 * caller should be able to bypass the maximum database page size.
 *
 * @param {unknown} value - User or service supplied limit.
 * @returns {number} An integer in the inclusive range 1..100.
 */
function normalizeInvoicePageSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_INVOICE_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_INVOICE_PAGE_SIZE);
}

/**
 * Resolve a public sort alias and direction.
 *
 * @param {string|undefined} sortBy - Public query alias.
 * @param {string|undefined} order - Requested direction.
 * @returns {{ alias: string, column: string, order: 'asc'|'desc' }}
 */
function resolveInvoiceSort(sortBy, order) {
  const alias = Object.prototype.hasOwnProperty.call(INVOICE_SORT_COLUMNS, sortBy)
    ? sortBy
    : 'created_at';
  return {
    alias,
    column: INVOICE_SORT_COLUMNS[alias],
    order: order === 'asc' ? 'asc' : 'desc',
  };
}

/**
 * Build the signed opaque cursor position from a returned invoice row.
 *
 * @param {object} row - Database row containing the selected sort column/id.
 * @param {string} sortField - Public sort alias.
 * @returns {string} Signed cursor.
 */
function encodeInvoiceCursor(row, sortField) {
  if (!row || row.id === undefined || row.id === null) {
    throw new TypeError('Invoice cursor rows require a unique id tiebreaker');
  }
  const sort = resolveInvoiceSort(sortField);
  return encodeCursor({
    sortField: sort.alias,
    sortValue: row[sort.column],
    id: String(row.id),
  });
}

/**
 * Decode a cursor for the invoice list and enforce the requested sort alias.
 *
 * @param {string} cursor - Opaque signed cursor.
 * @param {string} sortBy - Current public sort alias.
 * @returns {{ sortField: string, sortValue: unknown, id: string, iat: number }}
 */
function decodeInvoiceCursor(cursor, sortBy) {
  const sort = resolveInvoiceSort(sortBy);
  return decodeCursor(cursor, sort.alias);
}

/**
 * Compare two invoice ids without turning numeric database ids into strings.
 * PostgreSQL/SQLite sort integer ids numerically; the cursor transports them
 * as strings, so the in-memory contract must preserve that ordering too.
 *
 * @param {unknown} left - Candidate id.
 * @param {unknown} right - Cursor id.
 * @returns {number} Negative, zero, or positive comparison result.
 */
function compareInvoiceIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right));
}

/**
 * Compare a row with a cursor position using the exact ordering used by the
 * SQL keyset predicate. This is exported for deterministic contract tests and
 * for adapters that need to reproduce invoice ordering in memory.
 *
 * @param {object} row - Candidate invoice row.
 * @param {{ sortValue: unknown, id: string }} cursor - Decoded position.
 * @param {string} sortBy - Public sort alias.
 * @param {'asc'|'desc'} order - Sort direction.
 * @returns {boolean} Whether the row belongs after the cursor.
 */
function isAfterInvoiceCursor(row, cursor, sortBy, order) {
  const sort = resolveInvoiceSort(sortBy, order);
  const rowValue = row[sort.column];
  if (rowValue === cursor.sortValue) {
    return sort.order === 'asc'
      ? compareInvoiceIds(row.id, cursor.id) > 0
      : compareInvoiceIds(row.id, cursor.id) < 0;
  }

  return sort.order === 'asc'
    ? rowValue > cursor.sortValue
    : rowValue < cursor.sortValue;
}

module.exports = {
  DEFAULT_INVOICE_PAGE_SIZE,
  MAX_INVOICE_PAGE_SIZE,
  INVOICE_SORT_COLUMNS,
  normalizeInvoicePageSize,
  resolveInvoiceSort,
  encodeInvoiceCursor,
  decodeInvoiceCursor,
  isAfterInvoiceCursor,
};
