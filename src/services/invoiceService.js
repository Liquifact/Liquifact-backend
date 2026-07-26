/*
 * Consolidated Invoice Service
 *
 * Provides tenant-isolated, database-backed invoice CRUD operations via Knex.
 * All queries enforce `tenant_id` on every read/write to prevent cross-tenant
 * data leakage.  Soft-deletes are implemented via the `deleted_at` column.
 *
 * Public API (DB-backed):
 *   listInvoices(tenantId, opts)          — list with soft-delete filter
 *   getInvoices(queryParams | tenantId)   — legacy dual-arity shim kept for
 *                                           backward-compat with existing routes
 *   getInvoiceById(id, tenantId)          — single record, tenant-scoped
 *   createInvoice(data, tenantId)         — insert with generated invoice_id
 *   updateInvoice(id, updates, tenantId)  — tenant-scoped UPDATE
 *   deleteInvoice(id, tenantId)           — soft-delete
 *   resolveInvoiceForTenant(id, tenantId) — tenant-scoped lookup for state routes
 *   transitionInvoice(id, target, tenantId, opts) — execute + persist transition
 *
 * KYC helpers (in-memory mockInvoices — retained for test compatibility):
 *   getInvoicesByKycStatus(userId, kycStatus)
 *   updateInvoiceKycStatus(invoiceId, newKycStatus, kycRecordId)
 *
 * @module services/invoiceService
 */

'use strict';

const db = require('../db/knex');
const { applyQueryOptions } = require('../utils/queryBuilder');
const { encodeCursor, decodeCursor, CursorError } = require('../utils/cursorPagination');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const { LOCKED_STATUSES } = require('../middleware/patchInvoice');
const { executeTransition, validateTransition } = require('./invoiceStateMachine');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVOICE_QUERY_CONFIG = {
  allowedFilters: ['status', 'smeId', 'buyerId', 'dateFrom', 'dateTo'],
  allowedSortFields: ['amount', 'date'],
  columnMap: {
    smeId: 'sme_id',
    buyerId: 'buyer_id',
    dateFrom: 'date',
    dateTo: 'date',
  },
};

// In-memory fixture kept for KYC helpers and legacy test suites that import
// `mockInvoices` directly.
const mockInvoices = [
  {
    id: 'inv_1',
    status: 'pending_verification',
    amount: 1000,
    customer: 'Alice Corp',
    ownerId: 'user_1',
    smeId: 'sme_001',
    kycStatus: 'pending',
    kycRecordId: null,
    kycStatusUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deletedAt: null,
  },
  {
    id: 'inv_2',
    status: 'verified',
    amount: 2000,
    customer: 'Bob Inc',
    ownerId: 'user_1',
    smeId: 'sme_002',
    kycStatus: 'verified',
    kycRecordId: 'kyc_sme_002_001',
    kycStatusUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deletedAt: null,
  },
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Returns the current timestamp as a value that works in both SQLite and PG.
 * Uses `db.fn.now()` when available (Knex ≥ 0.95), otherwise falls back to
 * an ISO string so tests that mock the db instance don't blow up.
 *
 * @returns {string|Function} timestamp-compatible value
 */
function nowValue() {
  return db && db.fn && typeof db.fn.now === 'function'
    ? db.fn.now()
    : new Date().toISOString();
}

// ---------------------------------------------------------------------------
// DB-backed methods
// ---------------------------------------------------------------------------

/**
 * Lists invoices for a specific tenant with optional soft-delete inclusion.
 *
 * This is the canonical method used by the v1 route layer.
 *
 * @param {string} tenantId - Tenant identifier (required).
 * @param {object} [opts={}] - Options.
 * @param {boolean} [opts.includeDeleted=false] - When true, include soft-deleted records.
 * @param {string}  [opts.status]               - Optional status filter.
 * @returns {Promise<object[]>} Array of invoice rows ordered by created_at DESC.
 * @throws {TypeError} When tenantId is missing.
 */
async function listInvoices(tenantId, opts = {}) {
  if (!tenantId) {
    throw new TypeError('tenantId is required');
  }

  const { includeDeleted = false, status } = opts;

  let query = db('invoices').where({ tenant_id: tenantId }).orderBy('created_at', 'desc');

  if (!includeDeleted) {
    query = query.whereNull('deleted_at');
  }

  if (status) {
    query = query.where({ status });
  }

  return query;
}

/**
 * Dual-arity shim kept for backward compatibility with existing callers and
 * tests that use either call form:
 *
 *   getInvoices(queryParams)          — object arg (legacy /api/invoices route)
 *   getInvoices(tenantId, status)     — positional args (older service callers)
 *
 * @param {object|string} arg1 - Either a query-params object or a tenant ID string.
 * @param {string} [arg2]      - Optional status filter (only when arg1 is a tenant ID).
 * @returns {Promise<object[]>} Invoice rows.
 */
async function getInvoices(arg1 = {}, arg2) {
  if (arg1 && typeof arg1 === 'object') {
    // Query-params style — used by old /api/invoices GET handler
    try {
      let query = db('invoices').select('*');
      query = applyQueryOptions(query, arg1, INVOICE_QUERY_CONFIG);
      return await query;
    } catch (err) {
      logger.error({ err }, 'Error fetching invoices');
      throw new Error('Database error while fetching invoices');
    }
  }

  // Positional args style — (tenantId, status)
  const tenantId = arg1;
  if (!tenantId) {
    throw new TypeError('tenantId is required');
  }

  return listInvoices(tenantId, { status: arg2 });
}

// ── Column map for cursor pagination (aligns with INVOICE_QUERY_CONFIG) ────

const INVOICE_PAGINATION_COLUMN_MAP = {
  amount: 'amount',
  date: 'date',
  created_at: 'created_at',
};

/**
 * Applies invoice-list filters to a Knex query (shared by data + count queries).
 *
 * @param {import('knex').QueryBuilder} query
 * @param {Object} filters - Validated filter params.
 * @returns {import('knex').QueryBuilder}
 */
function _applyInvoiceFilters(query, filters) {
  if (filters.status) { query.where('status', filters.status); }
  if (filters.smeId)  { query.where('sme_id', filters.smeId); }
  if (filters.buyerId) { query.where('buyer_id', filters.buyerId); }
  if (filters.dateFrom) { query.where('date', '>=', filters.dateFrom); }
  if (filters.dateTo)   { query.where('date', '<=', filters.dateTo); }
  return query;
}

/**
 * Paginated invoice listing with cursor-based (preferred) and offset-based
 * (legacy) pagination modes.
 *
 * Cursor mode uses keyset pagination over `(sortField, id)`, returning a stable
 * `nextCursor` that works correctly under concurrent inserts.  The cursor is
 * opaque and HMAC-signed — tampering yields a {@link CursorError}.
 *
 * Offset mode accepts `page` (1-based) and `limit` for backward compat.
 * Both modes return the same `{ data, meta }` shape.
 *
 * @param {Object}  options
 * @param {Object}  [options.filters={}]     - Validated filters (status, smeId, buyerId, dateFrom, dateTo).
 * @param {Object}  [options.sorting={}]     - Sorting config ({ sortBy, order }).
 * @param {Object}  [options.pagination={}]  - Pagination config ({ cursor, page, limit }).
 * @returns {Promise<{ data: Array, meta: Object }>}
 * @throws {CursorError} When the cursor is malformed, tampered, or has a sort-field mismatch.
 */
async function getInvoicesWithPagination({ filters = {}, sorting = {}, pagination = {} } = {}) {
  const limit = Math.max(1, Math.min(100, parseInt(pagination.limit, 10) || 10));
  const sortField = (sorting.sortBy && INVOICE_PAGINATION_COLUMN_MAP[sorting.sortBy])
    ? sorting.sortBy
    : 'created_at';
  const order = (sorting.order === 'asc') ? 'asc' : 'desc';

  // ── Base query (exclude soft-deleted records) ─────────────────────────────
  const baseQuery = () => db('invoices').whereNull('deleted_at');

  // ── Total count (filter-aware, offset-independent) ────────────────────────
  let countQ = baseQuery();
  _applyInvoiceFilters(countQ, filters);
  const countRow = await countQ.count('* as total').first();
  const total = parseInt(countRow.total ?? countRow['count(*)'] ?? 0, 10);

  const useCursor = Boolean(pagination.cursor);

  // ── Cursor-based keyset pagination ────────────────────────────────────────
  if (useCursor) {
    const decoded = decodeCursor(pagination.cursor, sortField);
    const { sortValue, id: lastId } = decoded;

    let dataQ = baseQuery().select('*');
    _applyInvoiceFilters(dataQ, filters);

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

    dataQ.orderBy(sortField, order).orderBy('id', order);

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

    return { data, meta: { total, limit, hasMore, nextCursor } };
  }

  // ── Offset-based pagination (legacy, backward-compatible) ─────────────────
  const page = Math.max(1, parseInt(pagination.page, 10) || 1);
  const offset = (page - 1) * limit;

  let dataQ = baseQuery().select('*');
  _applyInvoiceFilters(dataQ, filters);
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

/**
 * Retrieves a single invoice by its public invoice_id, scoped to a tenant.
 * Returns null when the invoice does not exist or belongs to a different tenant.
 *
 * @param {string} id        - The invoice_id (e.g. "inv_123").
 * @param {string} tenantId  - Tenant identifier.
 * @returns {Promise<object|null>}
 * @throws {TypeError} When id is not a non-empty string.
 */
async function getInvoiceById(id, tenantId) {
  if (!id || typeof id !== 'string') {
    throw new TypeError('Invalid invoice ID');
  }

  const invoice = await db('invoices')
    .where({ invoice_id: id, tenant_id: tenantId })
    .whereNull('deleted_at')
    .first();

  return invoice || null;
}

/**
 * Creates a new invoice row in the database for the given tenant.
 *
 * Generates a unique `invoice_id` using the current timestamp + random suffix.
 * All callers are expected to validate the payload **before** calling this
 * function; no re-validation is performed here.
 *
 * @param {object} invoiceData              - Validated invoice fields.
 * @param {number} invoiceData.amount       - Positive invoice amount.
 * @param {string} invoiceData.customer     - Customer / buyer name.
 * @param {string} [invoiceData.currency]   - ISO 4217 currency code.
 * @param {string} [invoiceData.dueDate]    - Due date (YYYY-MM-DD).
 * @param {string} [invoiceData.description] - Optional description.
 * @param {string} [invoiceData.invoiceNumber] - Optional invoice number.
 * @param {object} [invoiceData.metadata]   - Additional metadata.
 * @param {string} tenantId                 - Tenant identifier.
 * @returns {Promise<object>} The newly created invoice row.
 * @throws {TypeError} When tenantId is missing.
 */
async function createInvoice(invoiceData, tenantId) {
  if (!tenantId) {
    throw new TypeError('tenantId is required');
  }

  const {
    amount,
    customer,
    status = 'pending',
    currency,
    dueDate,
    description,
    invoiceNumber,
    metadata,
  } = invoiceData || {};

  const invoiceId =
    invoiceNumber ||
    `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  const row = {
    invoice_id: invoiceId,
    amount,
    customer,
    status,
    tenant_id: tenantId,
    ...(currency !== undefined && { currency }),
    ...(dueDate !== undefined && { due_date: dueDate }),
    ...(description !== undefined && { description }),
    ...(metadata !== undefined && { metadata: metadata ? JSON.stringify(metadata) : null }),
  };

  // SQLite returns an array of primary-key integers from insert(); PostgreSQL
  // returns full rows when `.returning('*')` is chained. We normalise both.
  const result = await db('invoices').insert(row).returning('*');

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
    // PostgreSQL path — full row returned
    return result[0];
  }

  // SQLite path — result is an array of inserted PKs; refetch by invoice_id
  const inserted = await db('invoices').where({ invoice_id: invoiceId }).first();
  return inserted;
}

/**
 * Applies partial updates to an invoice, scoped to the owning tenant.
 * Automatically refreshes `updated_at`.
 *
 * @param {string} id          - The invoice_id to update.
 * @param {object} updates     - Column-value pairs to update.
 * @param {string} tenantId    - Tenant identifier.
 * @returns {Promise<object|null>} Updated row, or null if not found.
 * @throws {TypeError} When id is missing.
 */
/**
 * Updates an invoice row for a tenant.
 *
 * When `options.expectedStatus` is set, the UPDATE is compare-and-swap (CAS):
 * it only applies if the row's current `status` still matches. A concurrent
 * writer that already flipped the status causes this call to return `null`
 * instead of overwriting (lost-update prevention for state transitions).
 *
 * @param {string} id - Public invoice_id.
 * @param {object} [updates={}] - Column updates to apply.
 * @param {string} tenantId - Tenant identifier.
 * @param {object} [options={}] - Update options.
 * @param {string} [options.expectedStatus] - Required current status for CAS.
 * @returns {Promise<object|null>} Updated row, or null when missing / CAS miss.
 */
async function updateInvoice(id, updates = {}, tenantId, options = {}) {
  if (!id) {
    throw new TypeError('invoice id required');
  }
  const { expectedStatus } = options;

  // Ensure invoice exists and belongs to tenant
  const existing = await db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
  if (!existing) {
    return null;
  }

  // CAS pre-check (still enforced atomically in the UPDATE below)
  if (expectedStatus !== undefined && existing.status !== expectedStatus) {
    return null;
  }

  // Reject updates when invoice is in a locked status
  if (existing && LOCKED_STATUSES.has(existing.status)) {
    throw new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 422,
      detail: `Invoice in status '${existing.status}' cannot be modified.`,
      code: 'LOCKED_STATUS',
    });
  }

  const where = { invoice_id: id, tenant_id: tenantId };
  if (expectedStatus !== undefined) {
    where.status = expectedStatus;
  }

  const result = await db('invoices')
    .where(where)
    .update({ ...updates, updated_at: nowValue() })
    .returning('*');

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
    return result[0];
  }

  // SQLite / drivers that return affected-row count instead of returning(*)
  if (typeof result === 'number') {
    if (result === 0) {
      return null;
    }
    return db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
  }

  if (expectedStatus !== undefined) {
    // Empty returning array ⇒ CAS miss under Postgres
    return null;
  }

  // SQLite path (non-CAS)
  return db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
}

/**
 * Soft-deletes an invoice by setting `deleted_at` to the current timestamp.
 *
 * @param {string} id        - The invoice_id to delete.
 * @param {string} tenantId  - Tenant identifier.
 * @returns {Promise<object|null>} The updated row, or null if not found.
 * @throws {TypeError} When id is missing.
 */
async function deleteInvoice(id, tenantId) {
  if (!id) {
    throw new TypeError('invoice id required');
  }

  // Ensure invoice exists and belongs to tenant
  const existing = await db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
  if (!existing) {
    return null;
  }

  // Reject deletes when invoice is in a locked status
  if (existing && LOCKED_STATUSES.has(existing.status)) {
    throw new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 422,
      detail: `Invoice in status '${existing.status}' cannot be deleted.`,
      code: 'LOCKED_STATUS',
    });
  }

  const ts = nowValue();

  const result = await db('invoices')
    .where({ invoice_id: id, tenant_id: tenantId })
    .update({ deleted_at: ts })
    .returning('*');

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
    return result[0];
  }

  // SQLite path — refetch after update
  return db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
}

/**
 * Parses invoice metadata from a DB row (JSON string or object) into a plain object.
 *
 * @param {string|object|null|undefined} raw - Raw metadata column value.
 * @returns {object} Parsed metadata object (empty when absent or invalid).
 */
function parseInvoiceMetadata(raw) {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'object') {
    return { ...raw };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolves an invoice for the authenticated tenant.
 * Returns null when the invoice does not exist, is soft-deleted, or belongs to
 * another tenant — callers should respond with 404 without leaking existence.
 *
 * @param {string} invoiceId - Public invoice_id (e.g. "inv-001").
 * @param {string} tenantId  - Tenant identifier from extractTenant middleware.
 * @returns {Promise<object|null>} Invoice row or null.
 * @throws {TypeError} When tenantId is missing.
 */
async function resolveInvoiceForTenant(invoiceId, tenantId) {
  if (!tenantId) {
    throw new TypeError('tenantId is required');
  }
  return module.exports.getInvoiceById(invoiceId, tenantId);
}

/**
 * Executes a validated state transition via the invoice state machine and
 * persists the resulting status to the database. Status is always derived from
 * the state machine result — client-supplied status fields are never written.
 *
 * Optionally merges `escrowId` into the invoice metadata when linking escrow.
 *
 * @param {string} invoiceId   - Public invoice_id.
 * @param {string} targetState - Desired lifecycle state from the state machine.
 * @param {string} tenantId    - Tenant identifier.
 * @param {object} [options={}] - Transition context.
 * @param {string} options.actor - Actor performing the transition.
 * @param {string} [options.reason] - Human-readable reason (required for terminal targets).
 * @param {string} [options.ipAddress] - Request source IP.
 * @param {string} [options.userAgent] - Request user agent.
 * @param {object} [options.metadata] - Additional audit metadata.
 * @param {string|null|undefined} [options.escrowId] - Escrow contract ID to persist in metadata.
 * @returns {Promise<object>} State-machine transition result (previousState, newState, auditLog, …).
 * @throws {Error} With `.code` / `.allowedTransitions` when validation fails.
 * @throws {Error} With `.code = 'INVOICE_NOT_FOUND'` and `.statusCode = 404` when not found.
 */
async function transitionInvoice(invoiceId, targetState, tenantId, options = {}) {
  const invoice = await module.exports.resolveInvoiceForTenant(invoiceId, tenantId);
  if (!invoice) {
    const err = new Error('Invoice not found');
    err.code = 'INVOICE_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const {
    actor,
    reason,
    ipAddress = 'unknown',
    userAgent = 'unknown',
    metadata = {},
    escrowId,
  } = options;

  // Validate before any side effects so concurrent losers do not emit phantom audits.
  const validation = validateTransition({
    invoiceId,
    currentState: invoice.status,
    targetState,
    actor,
    reason,
  });
  if (!validation.isValid) {
    const error = new Error(validation.error);
    error.code = validation.code;
    error.allowedTransitions = validation.allowedTransitions;
    throw error;
  }

  const updates = { status: targetState };

  if (escrowId !== undefined) {
    const meta = parseInvoiceMetadata(invoice.metadata);
    if (escrowId) {
      meta.escrowId = escrowId;
    }
    updates.metadata = JSON.stringify(meta);
  }

  // Optimistic CAS: only persist when status is still the state we validated against.
  const persisted = await module.exports.updateInvoice(invoiceId, updates, tenantId, {
    expectedStatus: invoice.status,
  });

  if (!persisted) {
    const latest = await module.exports.resolveInvoiceForTenant(invoiceId, tenantId);
    if (!latest) {
      const err = new Error('Invoice not found');
      err.code = 'INVOICE_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    const retryValidation = validateTransition({
      invoiceId,
      currentState: latest.status,
      targetState,
      actor,
      reason,
    });
    if (!retryValidation.isValid) {
      const error = new Error(retryValidation.error);
      error.code = retryValidation.code;
      error.allowedTransitions = retryValidation.allowedTransitions;
      throw error;
    }

    const err = new Error(
      `Concurrent modification of invoice ${invoiceId}; transition from ${invoice.status} to ${targetState} aborted`,
    );
    err.code = 'TRANSITION_CONFLICT';
    err.statusCode = 409;
    throw err;
  }

  // Persist succeeded — emit audit trail for the winning transition only.
  return executeTransition({
    invoiceId,
    currentState: invoice.status,
    targetState,
    actor,
    reason,
    ipAddress,
    userAgent,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// SME Dashboard Metrics
// ---------------------------------------------------------------------------

/**
 * Status-to-category mapping for SME dashboard metrics.
 *
 * Each invoice status maps to exactly one dashboard category:
 * - **open** — invoices awaiting verification or verified but not yet funded.
 * - **funded** — invoices that have been funded but not yet settled.
 * - **settled** — invoices that are fully settled or paid.
 * - **defaulted** — invoices that have entered default.
 *
 * Statuses **not** listed here (e.g. `withdrawn`) are intentionally excluded
 * from every category so they do not inflate any bucket.
 *
 * @constant {Record<string, string>}
 */
const STATUS_CATEGORY_MAP = {
  pending_verification: 'open',
  verified: 'open',
  funded: 'funded',
  settled: 'settled',
  paid: 'settled',
  defaulted: 'defaulted',
};

/**
 * Pre-computed grouping of statuses by dashboard category, derived once
 * from {@link STATUS_CATEGORY_MAP} at module load.
 *
 * E.g.: `{ open: ['pending_verification', 'verified'], funded: ['funded'], … }`
 *
 * @constant {Record<string, string[]>}
 */
const CATEGORY_STATUSES = (() => {
  /** @type {Record<string, string[]>} */
  const groups = {};
  for (const [status, category] of Object.entries(STATUS_CATEGORY_MAP)) {
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(status);
  }
  return groups;
})();

/**
 * Ordered list of category names derived from {@link CATEGORY_STATUSES}.
 * Guarantees a deterministic SELECT clause order across invocations.
 *
 * @constant {string[]}
 */
const CATEGORY_NAMES = Object.keys(CATEGORY_STATUSES);

/**
 * Returns aggregated invoice counts grouped by SME dashboard category,
 * scoped to a single tenant and SME owner.
 *
 * The query produces a single database row with one integer column per
 * category defined in {@link STATUS_CATEGORY_MAP} (`open`, `funded`,
 * `settled`, `defaulted`).  The `SUM(CASE …)` clauses are built
 * **programmatically** from {@link STATUS_CATEGORY_MAP} so the constant
 * is the single source of truth — adding or removing a status mapping
 * automatically updates the aggregation without touching the SQL.
 *
 * Statuses not listed in the map (e.g. `withdrawn`) are excluded from
 * every category.  Soft-deleted invoices (`deleted_at IS NOT NULL`) are
 * always excluded.
 *
 * @param {string} tenantId - Tenant identifier (required, from `extractTenant` middleware).
 * @param {string} userId   - SME owner identifier (required, matches `sme_id` column).
 * @returns {Promise<{open: number, funded: number, settled: number, defaulted: number}>}
 *   Always returns an object with all four keys; missing categories default to `0`.
 * @throws {TypeError} When tenantId or userId is missing or not a non-empty string.
 *
 * @security
 *   - Scoped to `tenant_id` and `sme_id` on every query — no cross-tenant or
 *     cross-owner data leakage.
 *   - Uses positional (parameterised) bindings via Knex `.where()`.
 */
async function getSmeInvoiceCounts(tenantId, userId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('tenantId is required');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('userId is required');
  }

  // Build one SUM(CASE WHEN status IN (...) THEN 1 ELSE 0 END) AS <category>
  // per category using the pre-computed grouping so there is zero duplication
  // between STATUS_CATEGORY_MAP and the SQL.
  const selectClauses = CATEGORY_NAMES.map((category) => {
    const statuses = CATEGORY_STATUSES[category];
    // Status values come from the hardcoded STATUS_CATEGORY_MAP constant,
    // so string interpolation is safe here — no user input reaches this path.
    const inClause = statuses.map((s) => `'${s}'`).join(', ');
    return db.raw(
      `SUM(CASE WHEN status IN (${inClause}) THEN 1 ELSE 0 END) AS ??`,
      [category],
    );
  });

  const row = await db('invoices')
    .where({ tenant_id: tenantId, sme_id: userId })
    .whereNull('deleted_at')
    .select(...selectClauses)
    .first();

  // When no rows match, the aggregate still returns one row with NULL
  // values in SQLite; coerce every column to a safe integer.
  /** @type {{open: number, funded: number, settled: number, defaulted: number}} */
  const result = {};
  for (const category of CATEGORY_NAMES) {
    result[category] = Number(row?.[category]) || 0;
  }
  return result;
}

/**
 * Retrieves a cursor-paginated list of invoices for the SME dashboard,
 * scoped to a single tenant and SME owner.
 *
 * Uses keyset pagination with `created_at DESC, id DESC` so the ordering
 * is stable under concurrent inserts.  The cursor is opaque and HMAC-signed;
 * malformed or tampered cursors throw {@link CursorError}.
 *
 * When no cursor is supplied the first page is returned.
 * The caller controls page size via `limit` (1–100, default 20).
 *
 * @param {string} tenantId - Tenant identifier (required).
 * @param {string} userId   - SME owner identifier (required).
 * @param {object} [options={}]
 * @param {string} [options.cursor] - Opaque cursor from a prior page.
 * @param {number} [options.limit=20] - Max rows per page (clamped to 1–100).
 * @returns {Promise<{invoices: object[], meta: {total: number, limit: number, hasMore: boolean, nextCursor: string|null}}>}
 * @throws {TypeError}  When tenantId or userId is missing.
 * @throws {CursorError} When the cursor is malformed, tampered, or expired.
 */
async function getSmeInvoiceList(tenantId, userId, { cursor, limit = 20 } = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('tenantId is required');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('userId is required');
  }

  const MAX_LIMIT = 100;
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit, 10) || 20));

  const baseQuery = () =>
    db('invoices')
      .where({ tenant_id: tenantId, sme_id: userId })
      .whereNull('deleted_at');

  const countRow = await baseQuery().count('* as total').first();
  const total = parseInt(countRow?.total ?? countRow?.['count(*)'] ?? 0, 10);

  let cursorData = null;
  if (cursor) {
    try {
      cursorData = decodeCursor(cursor, 'created_at');
    } catch (err) {
      if (err instanceof CursorError) {
        throw err;
      }
      throw new CursorError('Invalid cursor');
    }
  }

  let dataQuery = baseQuery()
    .select('*')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(safeLimit + 1);

  if (cursorData) {
    dataQuery = dataQuery.where(function () {
      this.where('created_at', '<', cursorData.sortValue)
        .orWhere(function () {
          this.where('created_at', cursorData.sortValue)
            .andWhere('id', '<', parseInt(String(cursorData.id), 10) || 0);
        });
    });
  }

  const rows = await dataQuery;

  const hasMore = rows.length > safeLimit;
  const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;

  let nextCursor = null;
  if (hasMore && pageRows.length > 0) {
    const lastRow = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      sortField: 'created_at',
      sortValue: lastRow.created_at,
      id: String(lastRow.id),
    });
  }

  return {
    invoices: pageRows,
    meta: { total, limit: safeLimit, hasMore, nextCursor },
  };
}

// ---------------------------------------------------------------------------
// KYC helpers (in-memory — retained for backward compat with existing tests)
// ---------------------------------------------------------------------------

/**
 * Filters `mockInvoices` by owner and optional KYC status.
 *
 * @param {string} userId    - Owner user ID.
 * @param {string} [kycStatus] - Optional KYC status filter.
 * @returns {object[]}
 */
function getInvoicesByKycStatus(userId, kycStatus) {
  if (!userId) {
    throw new TypeError('User ID required');
  }
  let filtered = mockInvoices.filter((inv) => inv.ownerId === userId && !inv.deletedAt);
  if (kycStatus) {
    filtered = filtered.filter((inv) => inv.kycStatus === kycStatus);
  }
  return filtered;
}

/**
 * Updates the KYC status of an invoice in the in-memory fixture.
 *
 * @param {string} invoiceId     - Invoice ID.
 * @param {string} newKycStatus  - New KYC status value.
 * @param {string|null} [kycRecordId] - Associated KYC record ID.
 * @returns {object} Updated invoice.
 * @throws {Error} When the invoice is not found or the status is invalid.
 */
function updateInvoiceKycStatus(invoiceId, newKycStatus, kycRecordId = null) {
  const invoice = mockInvoices.find((inv) => inv.id === invoiceId);
  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  const validStatuses = ['pending', 'verified', 'rejected', 'exempted'];
  if (!validStatuses.includes(newKycStatus)) {
    throw new Error(`Invalid KYC status: ${newKycStatus}`);
  }

  const previousStatus = invoice.kycStatus;
  invoice.kycStatus = newKycStatus;
  invoice.kycRecordId = kycRecordId;
  invoice.kycStatusUpdatedAt = new Date().toISOString();

  logger.info(
    { invoiceId, previousStatus, newStatus: newKycStatus },
    'Invoice KYC status updated',
  );

  return invoice;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Primary DB-backed API
  listInvoices,
  getInvoices,
  getInvoicesWithPagination,
  getInvoiceById,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  resolveInvoiceForTenant,
  transitionInvoice,
  parseInvoiceMetadata,
  // SME dashboard metrics
  getSmeInvoiceCounts,
  getSmeInvoiceList,
  STATUS_CATEGORY_MAP,
  // KYC helpers (in-memory)
  getInvoicesByKycStatus,
  updateInvoiceKycStatus,
  // In-memory fixture (legacy test compat)
  mockInvoices,
  // Config constant (legacy test compat)
  INVOICE_QUERY_CONFIG,
  // Cursor pagination utility (re-exported for tests)
  CursorError,
  INVOICE_PAGINATION_COLUMN_MAP,
};
