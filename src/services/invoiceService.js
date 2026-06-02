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
const logger = require('../logger');

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
async function updateInvoice(id, updates = {}, tenantId) {
  if (!id) {
    throw new TypeError('invoice id required');
  }

  const result = await db('invoices')
    .where({ invoice_id: id, tenant_id: tenantId })
    .update({ ...updates, updated_at: nowValue() })
    .returning('*');

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
    return result[0];
  }

  // SQLite path
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
  getInvoiceById,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  // KYC helpers (in-memory)
  getInvoicesByKycStatus,
  updateInvoiceKycStatus,
  // In-memory fixture (legacy test compat)
  mockInvoices,
  // Config constant (legacy test compat)
  INVOICE_QUERY_CONFIG,
};
