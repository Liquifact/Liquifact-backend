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
const { executeTransition } = require('./invoiceStateMachine');

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
 * @param {Object}  options
 * @param {Object}  [options.filters={}]     - Validated filters.
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

  const baseQuery = () => db('invoices').whereNull('deleted_at');

  let countQ = baseQuery();
  _applyInvoiceFilters(countQ, filters);
  const countRow = await countQ.count('* as total').first();
  const total = parseInt(countRow.total ?? countRow['count(*)'] ?? 0, 10);

  const useCursor = Boolean(pagination.cursor);

  if (useCursor) {
    const decoded = decodeCursor(pagination.cursor, sortField);
    const { sortValue, id: lastId } = decoded;

    let dataQ = baseQuery().select('*');
    _applyInvoiceFilters(dataQ, filters);

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
 * @param {object} invoiceData              - Validated invoice fields.
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

  const result = await db('invoices').insert(row).returning('*');

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
    return result[0];
  }

  const inserted = await db('invoices').where({ invoice_id: invoiceId }).first();
  return inserted;
}

/**
 * Applies partial updates to an invoice, scoped to the owning tenant.
 *
 * @param {string} id          - The invoice_id to update.
 * @param {object} updates     - Column-value pairs to update.
 * @param {string} tenantId    - Tenant identifier.
 * @returns {Promise<object|null>} Updated row, or null if not found.
 * @throws {TypeError} When id is missing.
 */
async function updateInvoice(id, updates = {}, tenantId) {
  if (!id) {
    throw new TypeError('invoice id required');
  }
  const existing = await db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
  if (!existing) {
    return null;
  }

  if (existing && LOCKED_STATUSES.has(existing.status)) {
    throw new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 422,
      detail: `Invoice in status '${existing.status}' cannot be modified.`,
      code: 'LOCKED_STATUS',
    });
  }
  const result = await db('invoices')
    .where({ invoice_id: id, tenant_id: tenantId })
    .update({ ...updates, updated_at: nowValue() })
    .returning('*');

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
    return result[0];
  }

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

  const existing = await db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
  if (!existing) {
    return null;
  }

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
 * persists the resulting status to the database.
 *
 * @param {string} invoiceId   - Public invoice_id.
 * @param {string} targetState - Desired lifecycle state from the state machine.
 * @param {string} tenantId    - Tenant identifier.
 * @param {object} [options={}] - Transition context.
 * @returns {Promise<object>} State-machine transition result.
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

  const result = await executeTransition({
    invoiceId,
    currentState: invoice.status,
    targetState,
    actor,
    reason,
    ipAddress,
    userAgent,
    metadata,
  });

  const updates = { status: result.newState };

  if (escrowId !== undefined) {
    const meta = parseInvoiceMetadata(invoice.metadata);
    if (escrowId) {
      meta.escrowId = escrowId;
    }
    updates.metadata = JSON.stringify(meta);
  }

  await module.exports.updateInvoice(invoiceId, updates, tenantId);

  return result;
}

// ---------------------------------------------------------------------------
// SME Dashboard Metrics
// ---------------------------------------------------------------------------

const STATUS_CATEGORY_MAP = {
  pending_verification: 'open',
  verified: 'open',
  funded: 'funded',
  settled: 'settled',
  paid: 'settled',
  defaulted: 'defaulted',
};

const CATEGORY_STATUSES = (() => {
  const groups = {};
  for (const [status, category] of Object.entries(STATUS_CATEGORY_MAP)) {
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(status);
  }
  return groups;
})();

const CATEGORY_NAMES = Object.keys(CATEGORY_STATUSES);

/**
 * Returns aggregated invoice counts grouped by SME dashboard category.
 *
 * @param {string} tenantId - Tenant identifier.
 * @param {string} userId   - SME owner identifier.
 * @returns {Promise<{open: number, funded: number, settled: number, defaulted: number}>}
 */
async function getSmeInvoiceCounts(tenantId, userId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('tenantId is required');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('userId is required');
  }

  const selectClauses = CATEGORY_NAMES.map((category) => {
    const statuses = CATEGORY_STATUSES[category];
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

  const result = {};
  for (const category of CATEGORY_NAMES) {
    result[category] = Number(row?.[category]) || 0;
  }
  return result;
}

/**
 * Retrieves a cursor-paginated list of invoices for the SME dashboard.
 *
 * @param {string} tenantId - Tenant identifier (required).
 * @param {string} userId   - SME owner identifier (required).
 * @param {object} [options={}]
 * @param {string} [options.cursor] - Opaque cursor from a prior page.
 * @param {number} [options.limit=20] - Max rows per page (clamped to 1–100).
 * @returns {Promise<{invoices: object[], meta: object}>}
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
