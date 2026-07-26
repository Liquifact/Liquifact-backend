'use strict';

/**
 * @fileoverview Typed DTO layer for the indexer boundary.
 *
 * Defines request/response DTOs and bi-directional mapping functions used at
 * every entry and exit point of the indexer subsystem:
 *
 *   - {@link IndexerEventsQueryDTO}  – parsed, validated query params (request side)
 *   - {@link EscrowEventRowDTO}      – a single row returned from `escrow_events` (response side)
 *   - {@link IndexerEventsMetaDTO}   – pagination metadata envelope (response side)
 *   - {@link IndexerEventsResponseDTO} – full service/route response envelope
 *   - {@link IndexerIngestEventDTO}  – inbound event shape fed to the indexer job
 *
 * Mappers follow a strict boundary pattern:
 *
 *   raw query params  → {@link mapQueryToDTO}     → IndexerEventsQueryDTO
 *   IndexerEventsQueryDTO → {@link mapDTOToServiceParams} → service options object
 *   DB row            → {@link mapRowToEscrowEventDTO} → EscrowEventRowDTO
 *   service result    → {@link mapServiceResultToResponseDTO} → IndexerEventsResponseDTO
 *   raw ingest event  → {@link mapRawToIngestDTO}  → IndexerIngestEventDTO
 *
 * No runtime dependencies are introduced — all types are plain objects with
 * JSDoc annotations; validation is done via existing Zod schemas.
 *
 * @module dto/indexer
 */

// ─────────────────────────────────────────────────────────────────────────────
// Request DTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of the validated query parameters for the indexer
 * events listing endpoint (GET /api/admin/indexer/events).
 *
 * All fields are immutable after construction to prevent accidental mutation.
 *
 * @typedef {object} IndexerEventsQueryDTO
 * @property {object}      filters
 * @property {string|undefined} filters.invoiceId  - Exact-match filter on invoice ID.
 * @property {string|undefined} filters.eventType  - Exact-match filter on event type.
 * @property {string|undefined} filters.contractId - Exact-match filter on contract ID.
 * @property {object}      sorting
 * @property {string}      sorting.sortBy   - Sort field ('observed_at' | 'ledger_sequence').
 * @property {string}      sorting.order    - Sort direction ('asc' | 'desc').
 * @property {object}      pagination
 * @property {string|undefined} pagination.cursor - Opaque HMAC-signed cursor.
 * @property {number|undefined} pagination.page   - 1-based page number (offset mode).
 * @property {number|undefined} pagination.limit  - Page size (1–100).
 */

/**
 * Constructs an {@link IndexerEventsQueryDTO} from the parsed `params` object
 * produced by `adminIndexer._parseQuery()`.
 *
 * The mapping is intentionally explicit so every field is traceable and type
 * errors surface at the boundary rather than deep inside the service.
 *
 * @param {object} params - Normalised params from `_parseQuery`.
 * @param {object} [params.filters={}]
 * @param {object} [params.sorting={}]
 * @param {object} [params.pagination={}]
 * @returns {IndexerEventsQueryDTO}
 */
function mapQueryToDTO(params) {
  const filters = params.filters || {};
  const sorting = params.sorting || {};
  const pagination = params.pagination || {};

  return Object.freeze({
    filters: Object.freeze({
      invoiceId: filters.invoiceId !== undefined ? String(filters.invoiceId) : undefined,
      eventType: filters.eventType !== undefined ? String(filters.eventType) : undefined,
      contractId: filters.contractId !== undefined ? String(filters.contractId) : undefined,
    }),
    sorting: Object.freeze({
      sortBy: sorting.sortBy !== undefined ? String(sorting.sortBy) : 'observed_at',
      order: sorting.order === 'asc' ? 'asc' : 'desc',
    }),
    pagination: Object.freeze({
      cursor: pagination.cursor !== undefined ? String(pagination.cursor) : undefined,
      page: pagination.page !== undefined ? Number(pagination.page) : undefined,
      limit: pagination.limit !== undefined ? Number(pagination.limit) : undefined,
    }),
  });
}

/**
 * Converts an {@link IndexerEventsQueryDTO} back into the plain options object
 * accepted by {@link module:services/indexerService.listIndexerEvents}.
 *
 * This is the second half of the request-side mapping.  The service receives
 * only what it needs: optional fields whose value is `undefined` are omitted
 * so the service's own defaults apply transparently.
 *
 * @param {IndexerEventsQueryDTO} dto
 * @returns {{ filters: object, sorting: object, pagination: object }}
 */
function mapDTOToServiceParams(dto) {
  const filters = {};
  if (dto.filters.invoiceId !== undefined) filters.invoiceId = dto.filters.invoiceId;
  if (dto.filters.eventType !== undefined) filters.eventType = dto.filters.eventType;
  if (dto.filters.contractId !== undefined) filters.contractId = dto.filters.contractId;

  const sorting = {};
  if (dto.sorting.sortBy !== undefined) sorting.sortBy = dto.sorting.sortBy;
  if (dto.sorting.order !== undefined) sorting.order = dto.sorting.order;

  const pagination = {};
  if (dto.pagination.cursor !== undefined) pagination.cursor = dto.pagination.cursor;
  if (dto.pagination.page !== undefined) pagination.page = dto.pagination.page;
  if (dto.pagination.limit !== undefined) pagination.limit = dto.pagination.limit;

  return { filters, sorting, pagination };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of a single row from the `escrow_events` table as
 * returned by the listing endpoint.
 *
 * `event_body` is not included because it is intentionally excluded from list
 * responses; callers that need it should fetch a specific event by ID.
 *
 * @typedef {object} EscrowEventRowDTO
 * @property {string}      eventId        - Primary key (UUID / paging-token-derived).
 * @property {string}      invoiceId      - Associated invoice identifier.
 * @property {string}      eventType      - Event name (e.g. `'escrow_created'`).
 * @property {number}      ledgerSequence - Stellar ledger sequence number.
 * @property {string|null} pagingToken    - Horizon paging token, or null.
 * @property {string|null} contractId     - Stellar contract address, or null.
 * @property {string|null} txHash         - Transaction hash, or null.
 * @property {string}      observedAt     - ISO-8601 timestamp when the event was indexed.
 * @property {string}      createdAt      - ISO-8601 timestamp when the row was created.
 */

/**
 * Maps a raw database row from `escrow_events` into an {@link EscrowEventRowDTO}.
 *
 * Column names use snake_case (as returned by Knex); the DTO uses camelCase to
 * match the JSON API convention.  Null-safety is applied to all nullable
 * columns so consumers can rely on the type contract without further coercion.
 *
 * @param {object} row - Raw Knex row from `escrow_events`.
 * @returns {EscrowEventRowDTO}
 */
function mapRowToEscrowEventDTO(row) {
  return Object.freeze({
    eventId: String(row.event_id),
    invoiceId: String(row.invoice_id),
    eventType: String(row.event_type),
    ledgerSequence: Number(row.ledger_sequence),
    pagingToken: row.paging_token != null ? String(row.paging_token) : null,
    contractId: row.contract_id != null ? String(row.contract_id) : null,
    txHash: row.tx_hash != null ? String(row.tx_hash) : null,
    observedAt: row.observed_at instanceof Date
      ? row.observed_at.toISOString()
      : row.observed_at != null ? String(row.observed_at) : null,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at != null ? String(row.created_at) : null,
  });
}

/**
 * Maps an {@link EscrowEventRowDTO} back to a DB row-shaped plain object
 * (snake_case).  Used in tests to verify round-trip fidelity.
 *
 * @param {EscrowEventRowDTO} dto
 * @returns {object}
 */
function mapEscrowEventDTOToRow(dto) {
  return {
    event_id: dto.eventId,
    invoice_id: dto.invoiceId,
    event_type: dto.eventType,
    ledger_sequence: dto.ledgerSequence,
    paging_token: dto.pagingToken,
    contract_id: dto.contractId,
    tx_hash: dto.txHash,
    observed_at: dto.observedAt,
    created_at: dto.createdAt,
  };
}

/**
 * Pagination metadata returned by the listing endpoint.
 *
 * @typedef {object} IndexerEventsMetaDTO
 * @property {number}      total       - Total matching rows across all pages.
 * @property {number}      limit       - Page size used for this response.
 * @property {boolean}     hasMore     - Whether additional pages exist.
 * @property {string|null} nextCursor  - Opaque cursor for the next page, or null.
 * @property {number|undefined} page       - Current page (offset mode only).
 * @property {number|undefined} totalPages - Total number of pages (offset mode only).
 */

/**
 * Maps the raw `meta` object returned by {@link listIndexerEvents} into an
 * {@link IndexerEventsMetaDTO}.
 *
 * @param {object} rawMeta
 * @returns {IndexerEventsMetaDTO}
 */
function mapMetaToDTO(rawMeta) {
  const dto = {
    total: Number(rawMeta.total),
    limit: Number(rawMeta.limit),
    hasMore: Boolean(rawMeta.hasMore),
    nextCursor: rawMeta.nextCursor != null ? String(rawMeta.nextCursor) : null,
  };
  if (rawMeta.page !== undefined) dto.page = Number(rawMeta.page);
  if (rawMeta.totalPages !== undefined) dto.totalPages = Number(rawMeta.totalPages);
  return Object.freeze(dto);
}

/**
 * Full indexer events response DTO returned to the route layer.
 *
 * @typedef {object} IndexerEventsResponseDTO
 * @property {EscrowEventRowDTO[]}  data  - Page of escrow event rows.
 * @property {IndexerEventsMetaDTO} meta  - Pagination metadata.
 */

/**
 * Maps the raw service result `{ data: object[], meta: object }` into a typed
 * {@link IndexerEventsResponseDTO}.
 *
 * @param {{ data: object[], meta: object }} serviceResult
 * @returns {IndexerEventsResponseDTO}
 */
function mapServiceResultToResponseDTO(serviceResult) {
  return Object.freeze({
    data: serviceResult.data.map(mapRowToEscrowEventDTO),
    meta: mapMetaToDTO(serviceResult.meta),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest / job DTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of a raw escrow event as it enters the indexer job
 * boundary (i.e. what `normalizeEvent` + `persistEscrowEvent` consume).
 *
 * This is the inbound shape before it is written to the database, not the
 * outbound/read shape.
 *
 * @typedef {object} IndexerIngestEventDTO
 * @property {string}      eventId        - Unique event identifier.
 * @property {string}      invoiceId      - Associated invoice identifier.
 * @property {string}      eventType      - Event name.
 * @property {number}      ledgerSequence - Stellar ledger sequence number.
 * @property {string}      pagingToken    - Horizon paging token (empty string if absent).
 * @property {string|null} contractId     - Stellar contract address, or null.
 * @property {string|null} txHash         - Transaction hash, or null.
 * @property {object}      eventBody      - Full raw event payload.
 * @property {string}      observedAt     - ISO-8601 indexed-at timestamp.
 */

/**
 * Maps a raw Horizon record (as produced by `fetchEscrowEventsFromHorizon`)
 * into an {@link IndexerIngestEventDTO}.
 *
 * The mapper applies the same coercions used inline in the indexer job so that
 * the shape contract is expressed once in this module rather than scattered
 * across the job.
 *
 * @param {object} raw - Raw record from `fetchEscrowEventsFromHorizon`.
 * @param {string} invoiceId - Pre-resolved invoice ID for this event.
 * @returns {IndexerIngestEventDTO}
 */
function mapRawToIngestDTO(raw, invoiceId) {
  return Object.freeze({
    eventId: String(raw.id || raw.eventId || ''),
    invoiceId: String(invoiceId),
    eventType: String(raw.type || raw.eventType || 'contract_event'),
    ledgerSequence: Number(raw.ledger || raw.ledgerSequence || 0),
    pagingToken: String(raw.paging_token || raw.pagingToken || ''),
    contractId: (raw.contract_id || raw.contractId) != null
      ? String(raw.contract_id || raw.contractId)
      : null,
    txHash: (raw.tx_hash || raw.txHash) != null
      ? String(raw.tx_hash || raw.txHash)
      : null,
    eventBody: (raw.eventBody !== undefined ? raw.eventBody : raw) || {},
    observedAt: raw.observedAt || new Date().toISOString(),
  });
}

/**
 * Maps an {@link IndexerIngestEventDTO} to the internal normalized shape
 * expected by `persistEscrowEvent` (the canonical event object).  This is the
 * inverse of `mapRawToIngestDTO` plus field aliasing.
 *
 * @param {IndexerIngestEventDTO} dto
 * @returns {object} Normalized internal event.
 */
function mapIngestDTOToNormalized(dto) {
  return {
    eventId: dto.eventId,
    invoiceId: dto.invoiceId,
    eventType: dto.eventType,
    ledgerSequence: dto.ledgerSequence,
    pagingToken: dto.pagingToken,
    contractId: dto.contractId,
    txHash: dto.txHash,
    eventBody: dto.eventBody,
    observedAt: dto.observedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Request-side mappers
  mapQueryToDTO,
  mapDTOToServiceParams,
  // Response-side mappers
  mapRowToEscrowEventDTO,
  mapEscrowEventDTOToRow,
  mapMetaToDTO,
  mapServiceResultToResponseDTO,
  // Ingest / job mappers
  mapRawToIngestDTO,
  mapIngestDTOToNormalized,
};
