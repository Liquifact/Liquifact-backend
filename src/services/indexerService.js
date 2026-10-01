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

/**
 * Error thrown when a cursor is malformed, tampered with, or does not match
 * the current request's sort field.  The route layer maps this to HTTP 400.
 */
class CursorError extends Error {}

const db = require('../db/knex');
const { get: getConfig } = require('../config');
const { encodeCursor, decodeCursor } = require('../utils/cursorPagination');
const { indexerEventSchema, parseValidationErrors } = require('../schemas/indexerEvent');
const { IndexerCache, indexerCache } = require('./indexerCache');

/**
 * Checks whether the indexer listing/caching path is enabled.
 * Reads `ESCROW_INDEXER_ENABLED` from the validated config.
 * Safe default when config is not yet validated (e.g. in tests): `false`
 * (disabled — matches the schema default and avoids unexpected cache writes).
 *
 * @returns {boolean} `true` when indexer listing + cache are enabled.
 */
function isIndexerEnabled() {
  try {
    const cfg = getConfig();
    return cfg.ESCROW_INDEXER_ENABLED === 'true';
  } catch (_e) {
    return false;
  }
}

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
 * Maximum number of events accepted in a single bulk ingestion request.
 * Protects against oversized payloads and unbounded write amplification.
 * @type {number}
 */
const MAX_BULK_BATCH_SIZE = 50;

/**
 * Maximum length of the `eventId` field accepted by the bulk ingestion path.
 * Mirrors {@link MAX_EVENT_ID_LENGTH} for the camelCase input shape.
 * @type {number}
 */
const MAX_EVENT_ID_LENGTH_INPUT = 128;

/**
 * Maximum length of the `event_id` field.
 * @type {number}
 */
const MAX_EVENT_ID_LENGTH = 128;

/**
 * Maximum length of the `invoiceId` field accepted by the bulk ingestion path.
 * Mirrors {@link MAX_INVOICE_ID_LENGTH} for the camelCase input shape.
 * @type {number}
 */
const MAX_INVOICE_ID_LENGTH_INPUT = 128;

/**
 * Maximum length of the `invoice_id` field.
 * @type {number}
 */
const MAX_INVOICE_ID_LENGTH = 128;

/**
 * Maximum length of the `eventType` field accepted by the bulk ingestion path.
 * Mirrors {@link MAX_EVENT_TYPE_LENGTH} for the camelCase input shape.
 * @type {number}
 */
const MAX_EVENT_TYPE_LENGTH_INPUT = 64;

/**
 * Maximum length of the `event_type` field.
 * @type {number}
 */
const MAX_EVENT_TYPE_LENGTH = 64;

/**
 * Maximum length of the `contractId` field accepted by the bulk ingestion path.
 * Mirrors {@link MAX_CONTRACT_ID_LENGTH} for the camelCase input shape.
 * @type {number}
 */
const MAX_CONTRACT_ID_LENGTH_INPUT = 128;

/**
 * Maximum length of the `contract_id` field.
 * @type {number}
 */
const MAX_CONTRACT_ID_LENGTH = 128;

/**
 * Maximum length of the `txHash` field accepted by the bulk ingestion path.
 * Mirrors {@link MAX_TX_HASH_LENGTH} for the camelCase input shape.
 * @type {number}
 */
const MAX_TX_HASH_LENGTH_INPUT = 128;

/**
 * Maximum length of the `tx_hash` field.
 * @type {number}
 */
const MAX_TX_HASH_LENGTH = 128;

/**
 * Maximum length of the `pagingToken` field accepted by the bulk ingestion path.
 * Mirrors {@link MAX_PAGING_TOKEN_LENGTH} for the camelCase input shape.
 * @type {number}
 */
const MAX_PAGING_TOKEN_LENGTH_INPUT = 256;

/**
 * Maximum length of the `paging_token` field.
 * @type {number}
 */
const MAX_PAGING_TOKEN_LENGTH = 256;

/**
 * Maximum serialized size (in bytes) of an `eventBody` payload accepted by the
 * bulk ingestion path.  Mirrors {@link MAX_EVENT_BODY_BYTES} for the camelCase
 * input shape.
 * @type {number}
 */
const MAX_EVENT_BODY_BYTES_INPUT = 64 * 1024;

/**
 * Maximum serialized size (in bytes) of an `event_body` payload.
 * Prevents unbounded write amplification and oversized rows.
 * @type {number}
 */
const MAX_EVENT_BODY_BYTES = 64 * 1024;

/**
 * Maximum allowed `ledgerSequence` value accepted by the bulk ingestion path.
 * Mirrors {@link MAX_LEDGER_SEQUENCE} for the camelCase input shape.
 * @type {number}
 */
const MAX_LEDGER_SEQUENCE_INPUT = Number.MAX_SAFE_INTEGER;

/**
 * Maximum allowed `ledger_sequence` value (fits in a signed 64-bit integer).
 * @type {number}
 */
const MAX_LEDGER_SEQUENCE = Number.MAX_SAFE_INTEGER;

/**
 * Minimum allowed `ledgerSequence` value accepted by the bulk ingestion path.
 * Mirrors {@link MIN_LEDGER_SEQUENCE} for the camelCase input shape.
 * @type {number}
 */
const MIN_LEDGER_SEQUENCE_INPUT = 0;

/**
 * Minimum allowed `ledger_sequence` value.
 * @type {number}
 */
const MIN_LEDGER_SEQUENCE = 0;

/**
 * Validates the shape and boundaries of a single raw (camelCase) indexer event
 * as received from the bulk ingestion endpoint, before schema parsing and
 * normalization.  This is the first line of defense: it rejects malformed,
 * out-of-bounds, and duplicate-shaped inputs deterministically so that the
 * downstream schema/normalization/persistence layers only ever see well-formed
 * data.
 *
 * Invariants enforced here (must match {@link _validateNormalizedEvent}):
 * - `eventId`, `invoiceId`, `eventType` are non-empty strings within their
 *   respective length caps.
 * - `ledgerSequence` is a finite, integer value in
 *   `[MIN_LEDGER_SEQUENCE_INPUT, MAX_LEDGER_SEQUENCE_INPUT]`.
 * - Optional string fields (`pagingToken`, `contractId`, `txHash`) are either
 *   absent/null or strings within their length caps.
 * - `eventBody`, when present, serializes to at most
 *   {@link MAX_EVENT_BODY_BYTES_INPUT} bytes.
 *
 * @param {unknown} raw - Raw event payload from the request body.
 * @returns {{ ok: true } | { ok: false, code: string, details: object }}
 */
function _validateRawEvent(raw) {
  const details = {};

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { _root: 'Event must be a non-null object.' },
    };
  }

  if (typeof raw.eventId !== 'string' || raw.eventId.length === 0) {
    details.eventId = 'eventId must be a non-empty string.';
  } else if (raw.eventId.length > MAX_EVENT_ID_LENGTH_INPUT) {
    details.eventId = `eventId must be at most ${MAX_EVENT_ID_LENGTH_INPUT} characters.`;
  }

  if (typeof raw.invoiceId !== 'string' || raw.invoiceId.length === 0) {
    details.invoiceId = 'invoiceId must be a non-empty string.';
  } else if (raw.invoiceId.length > MAX_INVOICE_ID_LENGTH_INPUT) {
    details.invoiceId = `invoiceId must be at most ${MAX_INVOICE_ID_LENGTH_INPUT} characters.`;
  }

  if (typeof raw.eventType !== 'string' || raw.eventType.length === 0) {
    details.eventType = 'eventType must be a non-empty string.';
  } else if (raw.eventType.length > MAX_EVENT_TYPE_LENGTH_INPUT) {
    details.eventType = `eventType must be at most ${MAX_EVENT_TYPE_LENGTH_INPUT} characters.`;
  }

  if (
    typeof raw.ledgerSequence !== 'number' ||
    !Number.isFinite(raw.ledgerSequence) ||
    !Number.isInteger(raw.ledgerSequence) ||
    raw.ledgerSequence < MIN_LEDGER_SEQUENCE_INPUT ||
    raw.ledgerSequence > MAX_LEDGER_SEQUENCE_INPUT
  ) {
    details.ledgerSequence = `ledgerSequence must be an integer between ${MIN_LEDGER_SEQUENCE_INPUT} and ${MAX_LEDGER_SEQUENCE_INPUT}.`;
  }

  if (raw.pagingToken !== null && raw.pagingToken !== undefined) {
    if (typeof raw.pagingToken !== 'string' || raw.pagingToken.length > MAX_PAGING_TOKEN_LENGTH_INPUT) {
      details.pagingToken = `pagingToken must be a string of at most ${MAX_PAGING_TOKEN_LENGTH_INPUT} characters.`;
    }
  }

  if (raw.contractId !== null && raw.contractId !== undefined) {
    if (typeof raw.contractId !== 'string' || raw.contractId.length > MAX_CONTRACT_ID_LENGTH_INPUT) {
      details.contractId = `contractId must be a string of at most ${MAX_CONTRACT_ID_LENGTH_INPUT} characters.`;
    }
  }

  if (raw.txHash !== null && raw.txHash !== undefined) {
    if (typeof raw.txHash !== 'string' || raw.txHash.length > MAX_TX_HASH_LENGTH_INPUT) {
      details.txHash = `txHash must be a string of at most ${MAX_TX_HASH_LENGTH_INPUT} characters.`;
    }
  }

  if (raw.eventBody !== null && raw.eventBody !== undefined) {
    let serialized;
    try {
      serialized = JSON.stringify(raw.eventBody);
    } catch (_e) {
      details.eventBody = 'eventBody must be JSON-serializable.';
    }
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BODY_BYTES_INPUT) {
      details.eventBody = `eventBody must be at most ${MAX_EVENT_BODY_BYTES_INPUT} bytes when serialized.`;
    }
  }

  if (Object.keys(details).length > 0) {
    return { ok: false, code: 'VALIDATION_ERROR', details };
  }
  return { ok: true };
}

/**
 * Validates the shape and boundaries of a single normalized indexer event
 * immediately before persistence.  This is a defense-in-depth check that runs
 * after schema validation and normalization, ensuring that no out-of-bounds
 * value can reach the database even if the schema is later relaxed.
 *
 * @param {object} normalized - Normalized event row (snake_case columns).
 * @returns {{ ok: true } | { ok: false, code: string, details: object }}
 */
function _validateNormalizedEvent(normalized) {
  const details = {};

  if (typeof normalized.event_id !== 'string' || normalized.event_id.length === 0) {
    details.event_id = 'event_id must be a non-empty string.';
  } else if (normalized.event_id.length > MAX_EVENT_ID_LENGTH) {
    details.event_id = `event_id must be at most ${MAX_EVENT_ID_LENGTH} characters.`;
  }

  if (typeof normalized.invoice_id !== 'string' || normalized.invoice_id.length === 0) {
    details.invoice_id = 'invoice_id must be a non-empty string.';
  } else if (normalized.invoice_id.length > MAX_INVOICE_ID_LENGTH) {
    details.invoice_id = `invoice_id must be at most ${MAX_INVOICE_ID_LENGTH} characters.`;
  }

  if (typeof normalized.event_type !== 'string' || normalized.event_type.length === 0) {
    details.event_type = 'event_type must be a non-empty string.';
  } else if (normalized.event_type.length > MAX_EVENT_TYPE_LENGTH) {
    details.event_type = `event_type must be at most ${MAX_EVENT_TYPE_LENGTH} characters.`;
  }

  if (
    typeof normalized.ledger_sequence !== 'number' ||
    !Number.isFinite(normalized.ledger_sequence) ||
    !Number.isInteger(normalized.ledger_sequence) ||
    normalized.ledger_sequence < MIN_LEDGER_SEQUENCE ||
    normalized.ledger_sequence > MAX_LEDGER_SEQUENCE
  ) {
    details.ledger_sequence = `ledger_sequence must be an integer between ${MIN_LEDGER_SEQUENCE} and ${MAX_LEDGER_SEQUENCE}.`;
  }

  if (normalized.paging_token !== null && normalized.paging_token !== undefined) {
    if (typeof normalized.paging_token !== 'string' || normalized.paging_token.length > MAX_PAGING_TOKEN_LENGTH) {
      details.paging_token = `paging_token must be a string of at most ${MAX_PAGING_TOKEN_LENGTH} characters.`;
    }
  }

  if (normalized.contract_id !== null && normalized.contract_id !== undefined) {
    if (typeof normalized.contract_id !== 'string' || normalized.contract_id.length > MAX_CONTRACT_ID_LENGTH) {
      details.contract_id = `contract_id must be a string of at most ${MAX_CONTRACT_ID_LENGTH} characters.`;
    }
  }

  if (normalized.tx_hash !== null && normalized.tx_hash !== undefined) {
    if (typeof normalized.tx_hash !== 'string' || normalized.tx_hash.length > MAX_TX_HASH_LENGTH) {
      details.tx_hash = `tx_hash must be a string of at most ${MAX_TX_HASH_LENGTH} characters.`;
    }
  }

  if (normalized.event_body !== null && normalized.event_body !== undefined) {
    if (typeof normalized.event_body !== 'string') {
      details.event_body = 'event_body must be a serialized string.';
    } else if (Buffer.byteLength(normalized.event_body, 'utf8') > MAX_EVENT_BODY_BYTES) {
      details.event_body = `event_body must be at most ${MAX_EVENT_BODY_BYTES} bytes when serialized.`;
    }
  }

  if (Object.keys(details).length > 0) {
    return { ok: false, code: 'VALIDATION_ERROR', details };
  }
  return { ok: true };
}

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
  const useCache = !dbClient && isIndexerEnabled();

  // ── Cache lookup ────────────────────────────────────────────────────────
  if (useCache) {
    const cacheKey = IndexerCache.buildKey({ filters, sorting, pagination });
    const cached = indexerCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }

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

    const cursorResult = {
      data,
      meta: {
        total,
        limit,
        hasMore,
        nextCursor,
      },
      correlationId,
    };

    if (useCache) {
      const cacheKey = IndexerCache.buildKey({ filters, sorting, pagination });
      indexerCache.set(cacheKey, cursorResult);
    }

    return cursorResult;
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

  const offsetResult = {
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

  if (useCache) {
    const cacheKey = IndexerCache.buildKey({ filters, sorting, pagination });
    indexerCache.set(cacheKey, offsetResult);
  }

  return offsetResult;
}

/**
 * Validates the shape of the incoming batch payload before item-level
 * processing begins.  Rejects non-arrays, arrays exceeding the cap, and
 * arrays containing non-object entries early.
 *
 * @param {unknown} body - Parsed JSON request body.
 * @returns {{ ok: boolean, events?: object[], error?: object }} When `ok` is
 *   false the `error` field contains the response envelope to send.
 */
function validateBulkPayload(body) {
  if (!Array.isArray(body)) {
    return {
      ok: false,
      error: { status: 400, message: 'Request body must be a JSON array of event objects.', code: 'VALIDATION_ERROR', details: { _root: 'Expected an array.' } },
    };
  }

  if (body.length === 0) {
    return {
      ok: false,
      error: { status: 400, message: 'Batch must contain at least one event.', code: 'VALIDATION_ERROR', details: { _root: 'Array must not be empty.' } },
    };
  }

  if (body.length > MAX_BULK_BATCH_SIZE) {
    return {
      ok: false,
      error: { status: 413, message: `Batch exceeds maximum size of ${MAX_BULK_BATCH_SIZE} events.`, code: 'BATCH_TOO_LARGE', details: { maxBatchSize: MAX_BULK_BATCH_SIZE, received: body.length } },
    };
  }

  for (let i = 0; i < body.length; i++) {
    if (body[i] === null || typeof body[i] !== 'object') {
      return {
        ok: false,
        error: { status: 400, message: `Item at index ${i} must be a non-null object.`, code: 'VALIDATION_ERROR', details: { [`items[${i}]`]: 'Expected a non-null object.' } },
      };
    }
  }

  return { ok: true, events: body };
}

/**
 * Accepts a bounded array of raw indexer events, validates each one
 * individually, persists valid events, and returns per-item results.
 *
 * Failures on one item never abort the rest of the batch — callers always
 * receive a result entry for every input item.
 *
 * @param {object} options
 * @param {object[]} options.events - Raw event payloads to ingest.
 * @param {import('knex').Knex} [options.dbClient] - Injectable Knex client.
 * @returns {Promise<{ data: object[], meta: object }>}
 *   `data` is an array of per-item result objects. `meta` contains
 *   `succeeded`, `failed`, and `total` counts.
 */
async function bulkIndexerEvents({ events, dbClient } = {}) {
  const knex = dbClient || db;
  const results = [];

  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    try {
      const rawCheck = _validateRawEvent(raw);
      if (!rawCheck.ok) {
        results.push({
          index: i,
          success: false,
          error: { code: rawCheck.code, details: rawCheck.details },
        });
        continue;
      }

      const parsed = indexerEventSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({ index: i, success: false, error: { code: 'VALIDATION_ERROR', details: parseValidationErrors(parsed.error) } });
        continue;
      }

      const d = parsed.data;
      const normalized = {
        event_id: d.eventId,
        invoice_id: d.invoiceId,
        event_type: d.eventType,
        ledger_sequence: d.ledgerSequence,
        paging_token: d.pagingToken || null,
        contract_id: d.contractId !== undefined ? d.contractId : null,
        tx_hash: d.txHash !== undefined ? d.txHash : null,
        event_body: d.eventBody !== undefined ? JSON.stringify(d.eventBody) : null,
        observed_at: d.observedAt || new Date().toISOString(),
      };

      const boundaryCheck = _validateNormalizedEvent(normalized);
      if (!boundaryCheck.ok) {
        results.push({
          index: i,
          success: false,
          error: { code: boundaryCheck.code, details: boundaryCheck.details },
        });
        continue;
      }

      await knex('escrow_events')
        .insert(normalized)
        .onConflict('event_id')
        .merge();

      results.push({ index: i, success: true, eventId: normalized.event_id });
    } catch (err) {
      results.push({ index: i, success: false, error: { code: 'PERSIST_ERROR', message: err.message || 'Unexpected error.' } });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  return {
    data: results,
    meta: { succeeded, failed, total: results.length },
  };
}

module.exports = {
  listIndexerEvents,
  bulkIndexerEvents,
  validateBulkPayload,
  isIndexerEnabled,
  INDEXER_SORT_FIELDS,
  DEFAULT_SORT_FIELD,
  DEFAULT_ORDER,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_BULK_BATCH_SIZE,
  MAX_EVENT_ID_LENGTH,
  MAX_INVOICE_ID_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  MAX_CONTRACT_ID_LENGTH,
  MAX_TX_HASH_LENGTH,
  MAX_PAGING_TOKEN_LENGTH,
  MAX_EVENT_BODY_BYTES,
  MAX_LEDGER_SEQUENCE,
  MIN_LEDGER_SEQUENCE,
  CursorError,
  _validateRawEvent,
  _validateNormalizedEvent,
};
