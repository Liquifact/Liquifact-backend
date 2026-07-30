'use strict';

const db = require('../db/knex');
const { encodeCursor, decodeCursor, CursorError } = require('../utils/cursorPagination');
const { INVESTABLE_STATUSES } = require('./invoiceStateMachine');

/**
 * Marketplace Service
 *
 * Handles database operations for the marketplace, allowing search and sorting
 * of invoices by yield, maturity, and funded ratio.
 *
 * Pagination modes
 * ─────────────────
 * 1. Cursor-based (preferred): supply `pagination.cursor`.  The service decodes
 *    the opaque cursor, validates its HMAC signature, and converts it into a
 *    keyset WHERE clause (`(sortField, id) > (lastValue, lastId)` for ASC, or
 *    the reverse for DESC).  This is stable under inserts/deletes and scales to
 *    arbitrarily large tables without the drift that OFFSET causes.
 *
 * 2. Offset-based (legacy / backward-compatible): supply `pagination.page` and
 *    `pagination.limit` without `pagination.cursor`.  Returns the same response
 *    shape as before so existing clients are unaffected.  `nextCursor` and
 *    `hasMore` are still included in the meta block.
 *
 * Security
 * ────────
 * - Tenant scoping (`WHERE tenant_id = ?`) is always applied server-side and
 *   cannot be altered by cursor content.
 * - Filter constraints are re-applied on every request; a cursor cannot be used
 *   to retrieve rows that would otherwise be excluded by the caller's filters.
 * - Cursors are HMAC-signed; any structural change causes a CursorError which
 *   the route layer maps to HTTP 400.
 * - Sort-field mismatch between the cursor and the current request is detected
 *   and rejected before the query is built.
 *
 * @module services/marketplaceService
 */

/**
 * Configuration for marketplace query options.
 */
const MARKETPLACE_QUERY_CONFIG = {
  allowedFilters: [
    'status',
    'yieldBpsMin', 'yieldBpsMax',
    'maturityDateFrom', 'maturityDateTo',
    'fundedRatioMin', 'fundedRatioMax',
  ],
  allowedSortFields: ['yield_bps', 'maturity_date', 'funded_ratio', 'amount', 'created_at'],
  columnMap: {
    yieldBpsMin: 'yield_bps',
    yieldBpsMax: 'yield_bps',
    maturityDateFrom: 'maturity_date',
    maturityDateTo: 'maturity_date',
    fundedRatioMin: 'funded_ratio',
    fundedRatioMax: 'funded_ratio',
    yieldBps: 'yield_bps',
    maturityDate: 'maturity_date',
    fundedRatio: 'funded_ratio',
  },
};

/**
 * Public investable invoice statuses — derived from the authoritative
 * {@link INVESTABLE_STATUSES} constant in `invoiceStateMachine`.
 *
 * Only invoices in one of these states are surfaced through the marketplace
 * and invest endpoints.  All other states are tenant-private.
 *
 * **Do not add values here.**  To expand or change the investable set, update
 * `INVESTABLE_STATUSES` in `src/services/invoiceStateMachine.js`.  This alias
 * exists solely for backward-compatible named exports consumed by routes and
 * other services.
 *
 * @type {readonly string[]}
 */
const PUBLIC_INVESTABLE_INVOICE_STATUSES = INVESTABLE_STATUSES;

/**
 * Applies shared filter conditions to a Knex query builder.
 * Extracted so the same logic is used for both the data query and the count
 * query, avoiding accidental drift between the two.
 *
 * @param {import('knex').QueryBuilder} query
 * @param {Object} filters - Validated filter params from `validateMarketplaceQueryParams`.
 * @returns {import('knex').QueryBuilder} The same query builder (mutated in place).
 */
function _applyFilters(query, filters) {
  if (filters.yieldBpsMin !== undefined) { query.where('yield_bps', '>=', filters.yieldBpsMin); }
  if (filters.yieldBpsMax !== undefined) { query.where('yield_bps', '<=', filters.yieldBpsMax); }
  if (filters.maturityDateFrom) { query.where('maturity_date', '>=', filters.maturityDateFrom); }
  if (filters.maturityDateTo)   { query.where('maturity_date', '<=', filters.maturityDateTo);   }
  if (filters.fundedRatioMin !== undefined) { query.where('funded_ratio', '>=', filters.fundedRatioMin); }
  if (filters.fundedRatioMax !== undefined) { query.where('funded_ratio', '<=', filters.fundedRatioMax); }
  if (filters.status) { query.where('status', filters.status); }
  return query;
}

/**
 * Retrieves invoices for the marketplace with filtering, sorting, and
 * cursor-based (or offset) pagination.
 *
 * @param {Object}  options
 * @param {string}  options.tenantId    - The resolved tenant identifier (server-side).
 * @param {Object}  options.queryParams - Validated query parameters from the validator.
 * @param {Object}  [options.queryParams.filters={}]
 * @param {Object}  [options.queryParams.sorting={}]
 * @param {Object}  [options.queryParams.pagination={}]
 *   - `cursor`  {string}  — opaque cursor for keyset pagination
 *   - `page`    {number}  — 1-based page number (offset mode, ignored when cursor present)
 *   - `limit`   {number}  — page size (1–100, default 10)
 *
 * @returns {Promise<{data: Array, meta: Object}>}
 *   `meta` always contains `{ total, limit, nextCursor, hasMore }`.
 *   In offset mode it also contains `{ page, totalPages }`.
 *
 * @throws {CursorError} When the cursor is malformed or tampered (route maps to 400).
 * @throws {Error}       On unexpected database errors.
 */
async function getMarketplaceInvoices({ tenantId, queryParams }) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Missing tenant context');
  }

  const {
    filters = {},
    sorting = {},
    pagination = {},
  } = queryParams;

  const limit = Math.max(1, Math.min(100, parseInt(pagination.limit) || 10));
  const sortField = (sorting.sortBy && MARKETPLACE_QUERY_CONFIG.allowedSortFields.includes(sorting.sortBy))
    ? sorting.sortBy
    : 'created_at';
  const order = (sorting.order === 'asc') ? 'asc' : 'desc';

  // ── Base query factory (tenant-scoped, visibility-filtered) ─────────────
  const baseQuery = () =>
    db('invoices')
      .whereNull('deleted_at')
      .where('tenant_id', tenantId)
      .whereIn('status', PUBLIC_INVESTABLE_INVOICE_STATUSES);

  // ── Total count (filter-aware, always offset-independent) ────────────────
  let countQ = baseQuery();
  _applyFilters(countQ, filters);
  const countRow = await countQ.count('* as total').first();
  const total = parseInt(countRow.total ?? countRow['count(*)'] ?? 0);

  const useCursor = Boolean(pagination.cursor);

  // ── Cursor-based keyset pagination ────────────────────────────────────────
  if (useCursor) {
    // decodeCursor validates HMAC and sort-field match; throws CursorError on failure.
    const decoded = decodeCursor(pagination.cursor, sortField);
    const { sortValue, id: lastId } = decoded;

    let dataQ = baseQuery().select('*');
    _applyFilters(dataQ, filters);

    // Keyset predicate:
    //   ASC:  (sortField > lastValue) OR (sortField = lastValue AND id > lastId)
    //   DESC: (sortField < lastValue) OR (sortField = lastValue AND id < lastId)
    const gtOp = order === 'asc' ? '>' : '<';
    dataQ.where(function () {
      this.where(sortField, gtOp, sortValue)
        .orWhere(function () {
          this.where(sortField, '=', sortValue).where('id', gtOp, lastId);
        });
    });

    // Primary sort on sortField, secondary tiebreaker on id
    dataQ.orderBy(sortField, order).orderBy('id', order);

    // Fetch one extra row to determine hasMore without a second COUNT query
    const rows = await dataQ.limit(limit + 1);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor({
        sortField,
        sortValue: lastRow[sortField],
        id: lastRow.id,
      });
    }

    return {
      data,
      meta: {
        total,
        limit,
        hasMore,
        nextCursor,
      },
    };
  }

  // ── Offset-based pagination (legacy, backward-compatible) ─────────────────
  const page = Math.max(1, parseInt(pagination.page) || 1);
  const offset = (page - 1) * limit;

  let dataQ = baseQuery().select('*');
  _applyFilters(dataQ, filters);
  dataQ.orderBy(sortField, order).orderBy('id', order);

  const pagedRows = await dataQ.limit(limit + 1).offset(offset);
  const pagedHasMore = pagedRows.length > limit;
  const pagedData = pagedHasMore ? pagedRows.slice(0, limit) : pagedRows;

  let pagedNextCursor = null;
  if (pagedHasMore && pagedData.length > 0) {
    const lastRow = pagedData[pagedData.length - 1];
    pagedNextCursor = encodeCursor({
      sortField,
      sortValue: lastRow[sortField],
      id: lastRow.id,
    });
  }

  return {
    data: pagedData,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: pagedHasMore,
      nextCursor: pagedNextCursor,
    },
  };
}

module.exports = {
  getMarketplaceInvoices,
  MARKETPLACE_QUERY_CONFIG,
  PUBLIC_INVESTABLE_INVOICE_STATUSES,
};
