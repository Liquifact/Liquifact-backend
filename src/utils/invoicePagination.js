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
 * Version tag for the scope fingerprint. Bump it whenever the shape of what a
 * cursor is bound to changes, so cursors minted under the old shape are
 * rejected outright instead of being compared against the wrong thing.
 */
const INVOICE_CURSOR_SCOPE_VERSION = 'v1';

/**
 * Canonicalize a filter set so that equal queries fingerprint equally.
 *
 * Keys are ordered and empty values dropped. Values are deliberately left
 * verbatim — lower-casing or trimming an identifier could collapse two
 * genuinely different filters onto one fingerprint, which would reintroduce
 * exactly the cross-filter cursor reuse this closes.
 *
 * @param {Object} [filters={}] - Resolved filter values.
 * @returns {Object<string, string>} Stable, order-independent filter map.
 */
function normalizeInvoiceQuery(filters = {}) {
  const normalized = {};
  for (const key of Object.keys(filters).sort()) {
    const value = filters[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    normalized[key] = value instanceof Date ? value.toISOString() : String(value);
  }
  return normalized;
}

/**
 * Build the request fingerprint a cursor position is only valid for.
 *
 * A keyset position is a statement about one ordered result set. The same table
 * read under a different tenant or a different filter is a different result
 * set, so a position carried across them silently skips or repeats rows — and,
 * read across tenants, discloses where another tenant's data sits in the order.
 * Binding the scope makes that transport explicit and checkable.
 *
 * `limit` and `page` are intentionally excluded: they do not change which rows
 * the ordering describes, so changing page size mid-scan must stay legal.
 *
 * @param {Object} options
 * @param {string} [options.tenantId] - Owning tenant, when the read is scoped.
 * @param {Object} [options.filters={}] - Effective, normalized filters.
 * @param {string} [options.sortBy] - Public sort alias.
 * @param {'asc'|'desc'} [options.order] - Sort direction.
 * @param {string} [options.source='invoices'] - Endpoint/result-set discriminator.
 * @returns {string} Opaque fingerprint to sign into the cursor.
 */
function buildInvoiceCursorScope(options = {}) {
  const { tenantId, filters = {}, sortBy, order, source = 'invoices' } = options;
  const sort = resolveInvoiceSort(sortBy, order);

  return JSON.stringify([
    INVOICE_CURSOR_SCOPE_VERSION,
    String(source),
    tenantId === undefined || tenantId === null || tenantId === '' ? null : String(tenantId),
    sort.alias,
    sort.order,
    normalizeInvoiceQuery(filters),
  ]);
}

/**
 * Require an explicit scope, so no caller can mint or accept an unbound
 * invoice cursor by omitting the argument.
 *
 * @param {string} scope - Candidate scope.
 * @returns {string} The validated scope.
 * @throws {TypeError} When the scope is missing or not a non-empty string.
 */
function requireInvoiceCursorScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new TypeError(
      'Invoice cursors must be bound to a query scope (see buildInvoiceCursorScope)'
    );
  }
  return scope;
}

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
 * The scope is signed alongside the position, which is what lets the next
 * request prove the position belongs to its own tenant and filter set.
 *
 * @param {object} row - Database row containing the selected sort column/id.
 * @param {string} sortField - Public sort alias.
 * @param {string} scope - Fingerprint from {@link buildInvoiceCursorScope}.
 * @returns {string} Signed cursor.
 * @throws {TypeError} When the row has no id tiebreaker or the scope is missing.
 */
function encodeInvoiceCursor(row, sortField, scope) {
  if (!row || row.id === undefined || row.id === null) {
    throw new TypeError('Invoice cursor rows require a unique id tiebreaker');
  }
  const sort = resolveInvoiceSort(sortField);
  return encodeCursor({
    sortField: sort.alias,
    sortValue: row[sort.column],
    id: String(row.id),
    scope: requireInvoiceCursorScope(scope),
  });
}

/**
 * Decode a cursor for the invoice list, enforcing both the requested sort alias
 * and the request scope it was minted for.
 *
 * @param {string} cursor - Opaque signed cursor.
 * @param {string} sortBy - Current public sort alias.
 * @param {string} scope - Fingerprint from {@link buildInvoiceCursorScope}.
 * @returns {{ sortField: string, sortValue: unknown, id: string, iat: number, scope: string }}
 * @throws {CursorError} On a malformed, tampered, expired, or mismatched cursor.
 * @throws {TypeError} When the scope is missing.
 */
function decodeInvoiceCursor(cursor, sortBy, scope) {
  const sort = resolveInvoiceSort(sortBy);
  return decodeCursor(cursor, sort.alias, requireInvoiceCursorScope(scope));
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
  INVOICE_CURSOR_SCOPE_VERSION,
  normalizeInvoicePageSize,
  normalizeInvoiceQuery,
  buildInvoiceCursorScope,
  requireInvoiceCursorScope,
  resolveInvoiceSort,
  encodeInvoiceCursor,
  decodeInvoiceCursor,
  isAfterInvoiceCursor,
};
