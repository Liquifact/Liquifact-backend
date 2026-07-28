'use strict';

/**
 * @fileoverview Indexer listing service — paginated reads from escrow_events.
 *
 * Exposes {@link listIndexerEvents} which returns a bounded, cursor-paginated
 * slice of rows from the `escrow_events` table.  The same keyset strategy
 * used by the marketplace is applied here, ensuring stable, scalable reads
 * even as the event log grows unboundedly.
 *
 * Sort fields
 * ───────────
 * | sortBy             | Column mapped         |
 * |--------------------|-----------------------|
 * | `observed_at`      | `observed_at`         |
 * | `ledger_sequence`  | `ledger_sequence`     |
 *
 * The default sort is `observed_at DESC` (newest events first), which matches
 * typical operator / monitoring use-cases.
 *
 * Security
 * ────────
 * - No tenant isolation is required here because escrow events are admin-level
 *   data that is not partitioned by tenant.  The calling route enforces admin
 *   auth via `adminStack`.
 * - Filter constraints (invoiceId, eventType) are applied to every query and
 *   cannot be bypassed via cursor content.
 * - Cursors are HMAC-signed; any tampering causes a {@link CursorError} which
 *   the route maps to HTTP 400.
 * - Sort-field mismatch between the cursor and the current request is detected
 *   and rejected before the query is built.
 *
 * @module services/indexerService
 */

const db = require('../db/knex');
const { encodeCursor, decodeCursor } = require('../utils/cursorPagination');

/**
 * Allowed sort fields for the indexer listing endpoint.
 * Changing this list must be accompanied by index changes.
 *
 * @type {readonly string[]}
 */
const INDEXER_SORT_FIELDS = Object.freeze(['observed_at', 'ledger_sequence']);

/**
 * Default sort field (newest events first).
 * @type {string}
 */
const DEFAULT_SORT_FIELD = 'observed_at';

/**
 * Default sort order.
 * @type {string}
 */
const DEFAULT_ORDER = 'desc';

/**
 * Maximum page size that a caller may request.
 * Clamped server-side regardless of the `limit` query param.
 * @type {number}
 */
const MAX_PAGE_SIZE = 100;

/**
 * Default page size when `limit` is not supplied.
 * @type {number}
 */
const DEFAULT_PAGE_SIZE = 20;

/**
 * Columns selected from `escrow_events`.
 * `event_body` is intentionally excluded from the list response to keep
 * payloads small; callers that need the body should fetch a specific event.
 *
 * @type {string[]}
 */
const SELECT_COLUMNS = [
  'event_id',
  'invoice_id',
  'event_type',
  'ledger_sequence',
  'paging_token',
  'contract_id',
  'tx_hash',
  'observed_at',
  'created_at',
];

/**
 * Applies optional filter predicates to a Knex query builder.
 * Extracted so the same conditions are used for both the count query and the
 * data query, preventing drift between the two.
 *
 * @param {import('knex').QueryBuilder} qb - Knex query builder (mutated in place).
 * @param {object} filters
 * @param {string} [filters.invoiceId]  - Exact-match filter on `invoice_id`.
 * @param {string} [filters.eventType]  - Exact-match filter on `event_type`.
 * @param {string} [filters.contractId] - Exact-match filter on `contract_id`.
 * @returns {import('knex').QueryBuilder}
 */
function _applyFilters(qb, filters) {
  if (filters.invoiceId) {
    qb.where('invoice_id', filters.invoiceId);
  }
  if (filters.eventType) {
    qb.where('event_type', filters.eventType);
  }
  if (filters.contractId) {
    qb.where('contract_id', filters.contractId);
  }
  return qb;
}

/**
 * Retrieves a paginated list of escrow events with optional filtering.
 *
 * Supports two pagination modes:
 *
 * **Cursor mode (recommended)**: supply `pagination.cursor` from a previous
 * response's `nextCursor` field.  The cursor encodes the keyset anchor and is
 * HMAC-signed to prevent tampering.
 *
 * **Offset mode (legacy)**: supply `pagination.page` and `pagination.limit`
 * without `pagination.cursor`.  Less stable under inserts but backward-
 * compatible.
 *
 * @param {object}  options
 * @param {object}  [options.filters={}]
 * @param {string}  [options.filters.invoiceId]  - Filter by invoice ID.
 * @param {string}  [options.filters.eventType]  - Filter by event type.
 * @param {string}  [options.filters.contractId] - Filter by contract ID.
 * @param {object}  [options.sorting={}]
 * @param {string}  [options.sorting.sortBy='observed_at']  - Sort field.
 * @param {string}  [options.sorting.order='desc']          - Sort order.
 * @param {object}  [options.pagination={}]
 * @param {string}  [options.pagination.cursor]  - Opaque cursor (cursor mode).
 * @param {number}  [options.pagination.page=1]  - 1-based page number (offset mode).
 * @param {number}  [options.pagination.limit=20] - Page size (1–100).
 * @param {import('knex').Knex} [options.dbClient] - Injectable Knex client (for tests).
 * @param {string} [options.correlationId] - Correlation ID for tracing across layers.
 *
 * @returns {Promise<{ data: object[], meta: object, correlationId?: string }>}
 *   `meta` always contains `{ total, limit, hasMore, nextCursor }`.
 *   In offset mode it also contains `{ page, totalPages }`.
 *
 * @throws {CursorError} When the cursor is malformed or tampered (route maps to HTTP 400).
 * @throws {Error}       On unexpected database errors.
 */
async function listIndexerEvents({
  filters = {},
  sorting = {},
  pagination = {},
  dbClient,
  correlationId,
} = {}) {
  const knex = dbClient || db;

  // ── Resolve validated query parameters ───────────────────────────────────
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, parseInt(pagination.limit) || DEFAULT_PAGE_SIZE));

  const sortField = INDEXER_SORT_FIELDS.includes(sorting.sortBy)
    ? sorting.sortBy
    : DEFAULT_SORT_FIELD;

  const order = sorting.order === 'asc' ? 'asc' : DEFAULT_ORDER;

  // ── Base query factory ────────────────────────────────────────────────────
  const baseQuery = () => knex('escrow_events');

  // ── Total count (filter-aware, always offset-independent) ─────────────────
  const countQ = baseQuery();
  _applyFilters(countQ, filters);
  const countRow = await countQ.count('* as total').first();
  const total = parseInt(countRow.total ?? countRow['count(*)'] ?? 0, 10);

  const useCursor = Boolean(pagination.cursor);

  // ── Cursor-based keyset pagination ────────────────────────────────────────
  if (useCursor) {
    // decodeCursor validates HMAC and sort-field match; throws CursorError on
    // failure.  The route layer catches CursorError and maps it to HTTP 400.
    const decoded = decodeCursor(pagination.cursor, sortField);
    const { sortValue, id: lastId } = decoded;

    const dataQ = baseQuery().select(SELECT_COLUMNS);
    _applyFilters(dataQ, filters);

    // Keyset predicate:
    //   ASC:  (sortField > lastValue) OR (sortField = lastValue AND event_id > lastId)
    //   DESC: (sortField < lastValue) OR (sortField = lastValue AND event_id < lastId)
    const cmpOp = order === 'asc' ? '>' : '<';
    dataQ.where(function () {
      this.where(sortField, cmpOp, sortValue)
        .orWhere(function () {
          this.where(sortField, '=', sortValue).where('event_id', cmpOp, lastId);
        });
    });

    // Primary sort on sortField, secondary tiebreaker on event_id
    dataQ.orderBy(sortField, order).orderBy('event_id', order);

    // Fetch one extra to determine hasMore without a second COUNT query
    const rows = await dataQ.limit(limit + 1);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor({
        sortField,
        sortValue: lastRow[sortField],
        id: String(lastRow.event_id),
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
      correlationId,
    };
  }

  // ── Offset-based pagination (legacy, backward-compatible) ─────────────────
  const page = Math.max(1, parseInt(pagination.page) || 1);
  const offset = (page - 1) * limit;

  const dataQ = baseQuery().select(SELECT_COLUMNS);
  _applyFilters(dataQ, filters);
  dataQ.orderBy(sortField, order).orderBy('event_id', order);

  const pagedRows = await dataQ.limit(limit + 1).offset(offset);
  const pagedHasMore = pagedRows.length > limit;
  const pagedData = pagedHasMore ? pagedRows.slice(0, limit) : pagedRows;

  let pagedNextCursor = null;
  if (pagedHasMore && pagedData.length > 0) {
    const lastRow = pagedData[pagedData.length - 1];
    pagedNextCursor = encodeCursor({
      sortField,
      sortValue: lastRow[sortField],
      id: String(lastRow.event_id),
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
    correlationId,
  };
}

module.exports = {
  listIndexerEvents,
  INDEXER_SORT_FIELDS,
  DEFAULT_SORT_FIELD,
  DEFAULT_ORDER,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
};
