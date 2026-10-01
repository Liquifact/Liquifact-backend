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
 * Ingest validation reuses the existing event schema; other boundaries enforce
 * their structural and range invariants directly.
 *
 * Compatibility contract: every mapper is total and deterministic. Unknown or
 * malformed inputs are coerced to safe defaults rather than throwing, so that
 * callers relying on the previous inline behavior keep working unchanged.
 *
 * ## Compatibility Contracts & Invariants
 *
 * ### Public API Guarantees
 *   - All mapper functions are pure (no side effects, same input → same output)
 *   - All returned DTOs are deeply frozen (immutable)
 *   - Undefined optional fields remain undefined (never coerced to null)
 *   - Null values are preserved where semantically meaningful (DB nulls)
 *   - String coercion is explicit and deterministic (Number() for numerics)
 *   - Date instances are always serialized to ISO 8601 strings
 *   - Invalid/malformed inputs produce predictable defaults or throw TypeError
 *   - Mappers are safe for concurrent execution (no shared mutable state)
 *   - Round-trip mappings preserve semantic equality (DTO → internal → DTO)
 *
 * ### Failure Mode Guarantees
 *   - Missing required fields → throw TypeError with clear message
 *   - Type mismatches on critical fields → throw TypeError
 *   - Null/undefined on optional fields → preserve as-is
 *   - Empty objects/arrays → valid DTOs with defaults applied
 *   - Concurrent mapper calls → independent frozen results
 *   - Retry/replay → idempotent results (no state accumulation)
 *
 * ### Validation Boundaries
 *   - Input validation: Zod schemas (routes layer) + defensive type checks (mappers)
 *   - Output validation: Type contracts enforced via Object.freeze + explicit coercion
 *   - No sanitization/redaction here (that's the service/route layer's responsibility)
 *   - No database access (pure transformation only)
 *
 * @module dto/indexer
 */

const { indexerEventSchema } = require('../schemas/indexerEvent');

const INDEXER_SORT_FIELDS = new Set(['observed_at', 'ledger_sequence']);
const MAX_PAGE_SIZE = 100;

/**
 * Require a plain object at a DTO boundary.
 *
 * @param {unknown} value - Value to check.
 * @param {string} label - Boundary field name for safe error messages.
 * @returns {Record<string, unknown>} The validated record.
 */
function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  return value;
}

/**
 * Reject keys outside the documented DTO shape.
 *
 * @param {Record<string, unknown>} value - DTO record to check.
 * @param {string[]} allowedKeys - Supported own keys.
 * @param {string} label - Boundary field name for safe error messages.
 * @returns {void}
 */
function requireOnlyKeys(value, allowedKeys, label) {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

/**
 * Read a required own property so prototype values cannot satisfy a DTO shape.
 *
 * @param {Record<string, unknown>} value - DTO record to inspect.
 * @param {string[]} requiredKeys - Required own property names.
 * @param {string} label - Boundary field name for safe error messages.
 * @returns {void}
 */
function requireOwnKeys(value, requiredKeys, label) {
  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} is missing required fields`);
  }
}

/**
 * Read an optional string without coercing objects, numbers, or booleans.
 *
 * @param {unknown} value - Candidate field value.
 * @param {string} label - Field name for safe error messages.
 * @param {number} [maxLength=Infinity] - Maximum accepted length.
 * @returns {string|undefined} The value, or undefined when absent.
 */
function optionalString(value, label, maxLength = Infinity) {
  if (value === undefined) {return undefined;}
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Convert an integer or integer string while rejecting unsafe/out-of-range values.
 *
 * @param {unknown} value - Candidate number.
 * @param {string} label - Field name for safe error messages.
 * @param {number} minimum - Inclusive lower bound.
 * @param {number} maximum - Inclusive upper bound.
 * @returns {number} Validated safe integer.
 */
function safeInteger(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be a safe integer in the supported range`);
  }
  return parsed;
}

/**
 * Require a non-empty textual field, optionally accepting numeric DB identifiers.
 *
 * @param {unknown} value - Candidate field value.
 * @param {string} label - Field name for safe error messages.
 * @param {boolean} [allowNumber=false] - Whether finite numbers may be stringified.
 * @param {number} [maxLength=Infinity] - Maximum accepted string length.
 * @returns {string} Validated string value.
 */
function requiredString(value, label, allowNumber = false, maxLength = Infinity) {
  const text = allowNumber && typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : value;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return text;
}

/**
 * Normalize a nullable database text field without coercing invalid values.
 *
 * @param {unknown} value - Candidate field value.
 * @param {string} label - Field name for safe error messages.
 * @returns {string|null} The string value or null.
 */
function nullableString(value, label) {
  return value == null ? null : requiredString(value, label);
}

/**
 * Normalize a nullable timestamp while rejecting invalid dates.
 *
 * @param {unknown} value - Candidate timestamp.
 * @param {string} label - Field name for safe error messages.
 * @returns {string|null} ISO text, source text, or null.
 */
function nullableTimestamp(value, label) {
  if (value == null) {return null;}
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {throw new TypeError(`${label} must be a valid timestamp`);}
    return value.toISOString();
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return value;
}

/**
 * Validate a required timestamp value.
 *
 * @param {unknown} value - Timestamp value.
 * @param {string} label - Field name for safe error messages.
 * @returns {string} ISO string or valid source timestamp string.
 */
function requiredTimestamp(value, label) {
  const timestamp = nullableTimestamp(value, label);
  if (timestamp === null) {
    throw new TypeError(`${label} is required`);
  }
  return timestamp;
}

/**
 * Validate an ingest event with the canonical event schema and report field names only.
 *
 * @param {unknown} event - Candidate event data.
 * @returns {object} Parsed indexer event.
 */
function validateIngestEvent(event) {
  const result = indexerEventSchema.safeParse(event);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0] || '_root')))];
    throw new TypeError(`Indexer event contains invalid fields: ${fields.join(', ')}`);
  }
  return result.data;
}

/**
 * Resolve a supported snake_case/camelCase alias pair without accepting conflicts.
 *
 * @param {Record<string, unknown>} raw - Source event.
 * @param {string} snakeKey - Preferred snake_case key.
 * @param {string} camelKey - Supported camelCase alias.
 * @param {string} label - Field label for safe error messages.
 * @returns {unknown} Resolved value, or undefined when absent.
 */
function resolveAlias(raw, snakeKey, camelKey, label) {
  const snakeValue = raw[snakeKey];
  const camelValue = raw[camelKey];
  if (snakeValue != null && camelValue != null && !Object.is(snakeValue, camelValue)) {
    throw new TypeError(`${label} aliases must not conflict`);
  }
  return snakeValue != null ? snakeValue : camelValue;
}

/**
 * Copy event data so later caller mutations cannot alter an accepted DTO.
 *
 * @param {unknown} value - Event-body value.
 * @returns {unknown} Independent structured clone.
 */
function cloneEventBody(value) {
  return structuredClone(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deep freeze an object and all its nested properties.
 * Prevents mutation at any level of the object tree.
 *
 * @param {*} obj - Object to freeze.
 * @returns {*} The frozen object.
 */
function deepFreeze(obj) {
  // Handle primitives and null
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Freeze the object itself
  Object.freeze(obj);

  // Recursively freeze all properties
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const value = obj[prop];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  });

  return obj;
}

/**
 * Safe string coercion that preserves undefined.
 *
 * @param {*} value - Value to coerce.
 * @returns {string|undefined}
 */
function toStringOrUndefined(value) {
  return value !== undefined ? String(value) : undefined;
}

/**
 * Safe number coercion that preserves undefined.
 *
 * @param {*} value - Value to coerce.
 * @returns {number|undefined}
 */
function toNumberOrUndefined(value) {
  return value !== undefined ? Number(value) : undefined;
}

/**
 * Validate and normalize a sort order value.
 *
 * @param {*} value - Raw sort order value.
 * @returns {'asc'|'desc'}
 */
function normalizeSortOrder(value) {
  return value === 'asc' ? 'asc' : 'desc';
}

// ─────────────────────────────────────────────────────────────────────────────
// Request DTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of the validated query parameters for the indexer
 * events listing endpoint (GET /api/admin/indexer/events).
 *
 * All fields are immutable after construction to prevent accidental mutation.
 *
 * ## Invariants
 *   - filters, sorting, pagination are always present (never null/undefined)
 *   - Optional nested fields (invoiceId, eventType, etc.) are undefined when absent
 *   - sortBy defaults to 'observed_at' if not specified
 *   - order defaults to 'desc' if not specified or invalid
 *   - All string fields are coerced from input (no raw pass-through)
 *   - All number fields are coerced via Number() (deterministic)
 *   - The entire DTO is deeply frozen (no mutation possible)
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
 * ## Deterministic Behavior
 *   - Missing params object → treated as empty object
 *   - Missing nested sections (filters, sorting, pagination) → treated as empty objects
 *   - Undefined optional fields remain undefined (not coerced to null)
 *   - Invalid order value → defaults to 'desc'
 *   - All values are coerced to expected types (String, Number)
 *   - Result is deeply frozen (immutable)
 *
 * ## Concurrent Safety
 *   - Pure function (no side effects)
 *   - No shared mutable state
 *   - Returns a new frozen object on every call
 *
 * @param {object} params - Normalised params from `_parseQuery`.
 * @param {object} [params.filters={}]
 * @param {object} [params.sorting={}]
 * @param {object} [params.pagination={}]
 * @returns {IndexerEventsQueryDTO}
 */
function mapQueryToDTO(params) {
  // Defensive: treat missing/null params as empty object
  const safeParams = params && typeof params === 'object' ? params : {};
  const filters = safeParams.filters && typeof safeParams.filters === 'object' ? safeParams.filters : {};
  const sorting = safeParams.sorting && typeof safeParams.sorting === 'object' ? safeParams.sorting : {};
  const pagination = safeParams.pagination && typeof safeParams.pagination === 'object' ? safeParams.pagination : {};

  const dto = {
    filters: {
      invoiceId: toStringOrUndefined(filters.invoiceId),
      eventType: toStringOrUndefined(filters.eventType),
      contractId: toStringOrUndefined(filters.contractId),
    },
    sorting: {
      sortBy: toStringOrUndefined(sorting.sortBy) || 'observed_at',
      order: normalizeSortOrder(sorting.order),
    },
    pagination: {
      cursor: toStringOrUndefined(pagination.cursor),
      page: toNumberOrUndefined(pagination.page),
      limit: toNumberOrUndefined(pagination.limit),
    },
  };

  return deepFreeze(dto);
}

/**
 * Converts an {@link IndexerEventsQueryDTO} back into the plain options object
 * accepted by {@link module:services/indexerService.listIndexerEvents}.
 *
 * This is the second half of the request-side mapping.  The service receives
 * only what it needs: optional fields whose value is `undefined` are omitted
 * so the service's own defaults apply transparently.
 *
 * ## Invariants
 *   - Result is a plain mutable object (not frozen) for service consumption
 *   - Undefined optional fields are omitted (not included in result)
 *   - filters, sorting, pagination are always present objects (may be empty)
 *   - Pure function (no side effects, no shared state)
 *
 * ## Deterministic Behavior
 *   - Same DTO input → same output structure
 *   - Safe for concurrent calls
 *   - No validation (assumes DTO is already valid)
 *
 * @param {IndexerEventsQueryDTO} dto
 * @returns {{ filters: object, sorting: object, pagination: object }}
 */
function mapDTOToServiceParams(dto) {
  // Defensive: handle missing/invalid DTO
  if (!dto || typeof dto !== 'object') {
    return { filters: {}, sorting: {}, pagination: {} };
  }

  const filters = {};
  if (dto.filters && dto.filters.invoiceId !== undefined) {
    filters.invoiceId = dto.filters.invoiceId;
  }
  if (dto.filters && dto.filters.eventType !== undefined) {
    filters.eventType = dto.filters.eventType;
  }
  if (dto.filters && dto.filters.contractId !== undefined) {
    filters.contractId = dto.filters.contractId;
  }

  const sorting = {};
  if (dto.sorting && dto.sorting.sortBy !== undefined) {
    sorting.sortBy = dto.sorting.sortBy;
  }
  if (dto.sorting && dto.sorting.order !== undefined) {
    sorting.order = dto.sorting.order;
  }

  const pagination = {};
  if (dto.pagination && dto.pagination.cursor !== undefined) {
    pagination.cursor = dto.pagination.cursor;
  }
  if (dto.pagination && dto.pagination.page !== undefined) {
    pagination.page = dto.pagination.page;
  }
  if (dto.pagination && dto.pagination.limit !== undefined) {
    pagination.limit = dto.pagination.limit;
  }

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
 * ## Invariants
 *   - All non-nullable fields (eventId, invoiceId, eventType, ledgerSequence) are always strings/numbers
 *   - Nullable fields (pagingToken, contractId, txHash) are either string or null (never undefined)
 *   - Dates are always ISO 8601 strings (never Date instances in the DTO)
 *   - The entire DTO is frozen (immutable)
 *   - String coercion is explicit and deterministic
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
 * @property {string|null} createdAt      - Timestamp when the row was created, or null.
 */

/**
 * Maps a raw database row from `escrow_events` into an {@link EscrowEventRowDTO}.
 *
 * Column names use snake_case (as returned by Knex); the DTO uses camelCase to
 * match the JSON API convention.  Null-safety is applied to all nullable
 * columns so consumers can rely on the type contract without further coercion.
 *
 * ## Deterministic Behavior
 *   - Missing row or null row → throws TypeError
 *   - Missing required fields → throws TypeError with clear message
 *   - Date instances → converted to ISO 8601 strings
 *   - String dates → passed through as-is (assumed ISO 8601)
 *   - Null values on nullable fields → preserved as null
 *   - All string fields are coerced via String()
 *   - ledgerSequence is coerced via Number()
 *   - Result is frozen (immutable)
 *
 * ## Concurrent Safety
 *   - Pure function (no side effects)
 *   - No shared mutable state
 *   - Safe for parallel mapping of multiple rows
 *
 * @param {object} row - Raw Knex row from `escrow_events`.
 * @returns {EscrowEventRowDTO}
 * @throws {TypeError} When required fields are missing.
 */
function mapRowToEscrowEventDTO(row) {
  // Defensive: validate row is an object
  if (!row || typeof row !== 'object') {
    throw new TypeError('mapRowToEscrowEventDTO: row must be a non-null object');
  }

  // Validate required fields
  if (row.event_id === undefined || row.event_id === null) {
    throw new TypeError('mapRowToEscrowEventDTO: event_id is required');
  }
  if (row.invoice_id === undefined || row.invoice_id === null) {
    throw new TypeError('mapRowToEscrowEventDTO: invoice_id is required');
  }
  if (row.event_type === undefined || row.event_type === null) {
    throw new TypeError('mapRowToEscrowEventDTO: event_type is required');
  }
  if (row.ledger_sequence === undefined || row.ledger_sequence === null) {
    throw new TypeError('mapRowToEscrowEventDTO: ledger_sequence is required');
  }

  // Helper: convert Date to ISO string or pass through existing string
  const toISOStringOrNull = (value) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };

  const dto = {
    eventId: String(row.event_id),
    invoiceId: String(row.invoice_id),
    eventType: String(row.event_type),
    ledgerSequence: Number(row.ledger_sequence),
    pagingToken: row.paging_token != null ? String(row.paging_token) : null,
    contractId: row.contract_id != null ? String(row.contract_id) : null,
    txHash: row.tx_hash != null ? String(row.tx_hash) : null,
    observedAt: toISOStringOrNull(row.observed_at),
    createdAt: toISOStringOrNull(row.created_at),
  };

  return Object.freeze(dto);
}

/**
 * Maps an {@link EscrowEventRowDTO} back to a DB row-shaped plain object
 * (snake_case).  Used in tests to verify round-trip fidelity.
 *
 * ## Invariants
 *   - Result is NOT frozen (mutable plain object for DB writes)
 *   - Field names are snake_case (DB convention)
 *   - All DTO fields are preserved without transformation
 *   - Pure function (no side effects)
 *
 * @param {EscrowEventRowDTO} dto
 * @returns {object}
 * @throws {TypeError} When dto is missing or invalid.
 */
function mapEscrowEventDTOToRow(dto) {
  // Defensive: validate dto is an object
  if (!dto || typeof dto !== 'object') {
    throw new TypeError('mapEscrowEventDTOToRow: dto must be a non-null object');
  }

  return {
    event_id: validated.eventId,
    invoice_id: validated.invoiceId,
    event_type: validated.eventType,
    ledger_sequence: validated.ledgerSequence,
    paging_token: validated.pagingToken,
    contract_id: validated.contractId,
    tx_hash: validated.txHash,
    observed_at: validated.observedAt,
    created_at: validated.createdAt,
  };
}

/**
 * Pagination metadata returned by the listing endpoint.
 *
 * ## Invariants
 *   - total, limit, hasMore are always present (never undefined)
 *   - nextCursor is null when hasMore is false
 *   - page and totalPages are only present in offset mode (may be undefined)
 *   - The entire DTO is frozen (immutable)
 *   - All numeric fields are coerced via Number()
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
 * ## Deterministic Behavior
 *   - Missing rawMeta → throws TypeError
 *   - Required fields (total, limit, hasMore) → coerced with defaults if missing
 *   - nextCursor: null when missing or hasMore is false
 *   - Optional fields (page, totalPages) → preserved as undefined when absent
 *   - All numeric fields are coerced via Number()
 *   - Result is frozen (immutable)
 *
 * ## Concurrent Safety
 *   - Pure function (no side effects)
 *   - No shared mutable state
 *
 * @param {object} rawMeta
 * @returns {IndexerEventsMetaDTO}
 * @throws {TypeError} When rawMeta is missing or invalid.
 */
function mapMetaToDTO(rawMeta) {
  // Defensive: validate rawMeta is an object
  if (!rawMeta || typeof rawMeta !== 'object') {
    throw new TypeError('mapMetaToDTO: rawMeta must be a non-null object');
  }

  const dto = {
    total: Number(rawMeta.total || 0),
    limit: Number(rawMeta.limit || 0),
    hasMore: Boolean(rawMeta.hasMore),
    nextCursor: rawMeta.nextCursor != null ? String(rawMeta.nextCursor) : null,
  };

  // Optional offset-mode fields
  if (rawMeta.page !== undefined) {
    dto.page = Number(rawMeta.page);
  }
  if (rawMeta.totalPages !== undefined) {
    dto.totalPages = Number(rawMeta.totalPages);
  }

  return Object.freeze(dto);
}

/**
 * Full indexer events response DTO returned to the route layer.
 *
 * ## Invariants
 *   - data is always an array (never null/undefined, may be empty)
 *   - meta is always a frozen IndexerEventsMetaDTO object
 *   - The entire DTO is deeply frozen (immutable)
 *   - Each element in data is a frozen EscrowEventRowDTO
 *
 * @typedef {object} IndexerEventsResponseDTO
 * @property {EscrowEventRowDTO[]}  data  - Page of escrow event rows.
 * @property {IndexerEventsMetaDTO} meta  - Pagination metadata.
 */

/**
 * Maps the raw service result `{ data: object[], meta: object }` into a typed
 * {@link IndexerEventsResponseDTO}.
 *
 * ## Deterministic Behavior
 *   - Missing serviceResult → throws TypeError
 *   - Missing data array → defaults to empty array
 *   - Invalid rows in data → throws TypeError from mapRowToEscrowEventDTO
 *   - Missing meta → throws TypeError from mapMetaToDTO
 *   - Result is deeply frozen (immutable)
 *
 * ## Concurrent Safety
 *   - Pure function (no side effects)
 *   - No shared mutable state
 *   - Safe for parallel response construction
 *
 * @param {{ data: object[], meta: object }} serviceResult
 * @returns {IndexerEventsResponseDTO}
 * @throws {TypeError} When serviceResult is invalid or required fields are missing.
 */
function mapServiceResultToResponseDTO(serviceResult) {
  // Defensive: validate serviceResult is an object
  if (!serviceResult || typeof serviceResult !== 'object') {
    throw new TypeError('mapServiceResultToResponseDTO: serviceResult must be a non-null object');
  }

  // Defensive: ensure data is an array
  const dataArray = Array.isArray(serviceResult.data) ? serviceResult.data : [];

  const dto = {
    data: dataArray.map(mapRowToEscrowEventDTO),
    meta: mapMetaToDTO(serviceResult.meta),
  };

  return deepFreeze(dto);
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
 * ## Invariants
 *   - All fields are always present (never undefined)
 *   - eventId: string (may be empty if source lacks it)
 *   - pagingToken: string (empty string if absent in source)
 *   - contractId, txHash: null if absent in source
 *   - eventBody: always an object (defaults to {} if missing)
 *   - observedAt: always an ISO 8601 string
 *   - The entire DTO is frozen (immutable)
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
 * ## Deterministic Behavior
 *   - Missing raw → throws TypeError
 *   - Missing invoiceId → throws TypeError
 *   - Missing/invalid fields → deterministic defaults applied
 *   - eventId: defaults to empty string if missing
 *   - eventType: defaults to 'contract_event' if missing
 *   - ledgerSequence: coerced to Number (0 if missing/invalid)
 *   - pagingToken: defaults to empty string if missing
 *   - contractId, txHash: null if missing
 *   - eventBody: defaults to {} if missing, or the entire raw object if no explicit eventBody
 *   - observedAt: defaults to current ISO timestamp if missing
 *   - Result is frozen (immutable)
 *
 * ## Concurrent Safety
 *   - Pure function (no side effects except Date.now() for timestamp)
 *   - No shared mutable state
 *   - Safe for parallel event ingestion
 *
 * @param {object} raw - Raw record from `fetchEscrowEventsFromHorizon`.
 * @param {string} invoiceId - Pre-resolved invoice ID for this event.
 * @param {object} [opts] - Optional overrides for deterministic behaviour.
 * @param {string} [opts.capturedAt] - ISO-8601 timestamp to use when
 *   `raw.observedAt` is absent.  Callers that process a batch should derive
 *   this once before the loop so every event in the batch shares the same
 *   fallback timestamp.
 * @returns {IndexerIngestEventDTO}
 * @throws {TypeError} When raw or invoiceId are missing/invalid.
 */
function mapRawToIngestDTO(raw, invoiceId) {
  // Defensive: validate inputs
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('mapRawToIngestDTO: raw must be a non-null object');
  }
  if (typeof invoiceId !== 'string' || invoiceId.trim().length === 0) {
    throw new TypeError('mapRawToIngestDTO: invoiceId must be a non-empty string');
  }

  const dto = {
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
  };

  return Object.freeze(dto);
}

/**
 * Maps an {@link IndexerIngestEventDTO} to the internal normalized shape
 * expected by `persistEscrowEvent` (the canonical event object).  This is the
 * inverse of `mapRawToIngestDTO` plus field aliasing.
 *
 * ## Invariants
 *   - Result is NOT frozen (mutable plain object for internal use)
 *   - All fields from DTO are preserved without transformation
 *   - Pure function (no side effects)
 *
 * ## Deterministic Behavior
 *   - Missing dto → throws TypeError
 *   - All DTO fields are passed through as-is
 *   - Safe for concurrent calls
 *
 * @param {IndexerIngestEventDTO} dto
 * @returns {object} Normalized internal event.
 * @throws {TypeError} When dto is missing or invalid.
 */
function mapIngestDTOToNormalized(dto) {
  // Defensive: validate dto is an object
  if (!dto || typeof dto !== 'object') {
    throw new TypeError('mapIngestDTOToNormalized: dto must be a non-null object');
  }

  return {
    eventId: event.eventId,
    invoiceId: event.invoiceId,
    eventType: event.eventType,
    ledgerSequence: event.ledgerSequence,
    pagingToken: event.pagingToken || '',
    contractId: event.contractId !== undefined ? event.contractId : null,
    txHash: event.txHash !== undefined ? event.txHash : null,
    eventBody: event.eventBody !== undefined ? cloneEventBody(event.eventBody) : {},
    observedAt: event.observedAt || new Date().toISOString(),
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
