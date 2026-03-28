/**
 * @module repositories/invoiceRepository
 * @description
 * Tenant-scoped in-memory repository for invoices.
 *
 * **Every** method on this repository is keyed by `tenantId`.  Data written
 * by one tenant is never readable by another, regardless of invoice ID.
 *
 * ## Data layout
 * ```
 * Map<tenantId, Map<invoiceId, Invoice>>
 * ```
 * Using a nested Map means O(1) lookup for both tenant isolation and
 * individual invoice access, with no risk of one tenant's IDs colliding
 * with another's in a flat array.
 *
 * @security
 *   - All public methods require `tenantId` as the first argument.
 *   - Methods throw a TypeError if `tenantId` is falsy, making accidental
 *     unscoped access a loud runtime error rather than a silent data leak.
 *   - The `_store` and `_getStore` internals are intentionally unexported.
 */

'use strict';

/**
 * @typedef {Object} Invoice
 * @property {string}      id         - Unique invoice identifier.
 * @property {string}      tenantId   - Owning tenant.
 * @property {number}      amount     - Invoice amount.
 * @property {string}      customer   - Customer name / identifier.
 * @property {string}      status     - Current status.
 * @property {string}      createdAt  - ISO 8601 creation timestamp.
 * @property {string|null} deletedAt  - ISO 8601 soft-delete timestamp, or null.
 */

/** @type {Map<string, Map<string, Invoice>>} */
const _store = new Map();

/**
 * Return (or lazily create) the per-tenant bucket.
 *
 * @param {string} tenantId
 * @returns {Map<string, Invoice>}
 */
function _getStore(tenantId) {
  if (!_store.has(tenantId)) {
    _store.set(tenantId, new Map());
  }
  return _store.get(tenantId);
}

/**
 * Guard: throw if tenantId is falsy.
 *
 * @param {unknown} tenantId
 */
function _requireTenant(tenantId) {
  if (!tenantId) {
    throw new TypeError('tenantId is required for all repository operations.');
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List invoices for a tenant.
 *
 * @param {string}  tenantId        - Owning tenant.
 * @param {boolean} [includeDeleted=false] - Whether to include soft-deleted records.
 * @returns {Invoice[]}
 */
function listInvoices(tenantId, includeDeleted = false) {
  _requireTenant(tenantId);
  const bucket = _getStore(tenantId);
  const all = Array.from(bucket.values());
  return includeDeleted ? all : all.filter(inv => !inv.deletedAt);
}

/**
 * Find a single invoice by ID, scoped to the given tenant.
 * Returns `null` if the invoice does not exist **for this tenant**.
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @returns {Invoice|null}
 */
function findInvoice(tenantId, invoiceId) {
  _requireTenant(tenantId);
  return _getStore(tenantId).get(invoiceId) ?? null;
}

/**
 * Persist a new invoice under the given tenant.
 *
 * @param {string} tenantId
 * @param {{ amount: number, customer: string }} fields
 * @returns {Invoice} The created invoice.
 */
function createInvoice(tenantId, { amount, customer }) {
  _requireTenant(tenantId);
  /** @type {Invoice} */
  const invoice = {
    id: `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    tenantId,
    amount,
    customer,
    status: 'pending_verification',
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };
  _getStore(tenantId).set(invoice.id, invoice);
  return invoice;
}

/**
 * Soft-delete an invoice (set `deletedAt`).
 * Returns `null` if the invoice is not found for this tenant.
 * Returns `false` if the invoice is already deleted.
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @returns {Invoice|null|false}
 */
function softDeleteInvoice(tenantId, invoiceId) {
  _requireTenant(tenantId);
  const invoice = findInvoice(tenantId, invoiceId);
  if (!invoice) { return null; }
  if (invoice.deletedAt) {return false; }
  invoice.deletedAt = new Date().toISOString();
  return invoice;
}

/**
 * Restore a soft-deleted invoice (clear `deletedAt`).
 * Returns `null` if the invoice is not found for this tenant.
 * Returns `false` if the invoice is not currently deleted.
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @returns {Invoice|null|false}
 */
function restoreInvoice(tenantId, invoiceId) {
  _requireTenant(tenantId);
  const invoice = findInvoice(tenantId, invoiceId);
  if (!invoice) { return null; }
  if (!invoice.deletedAt) { return false; }
  invoice.deletedAt = null;
  return invoice;
}

/**
 * Wipe all data for a specific tenant.
 * Used in tests to reset state between cases.
 *
 * @param {string} tenantId
 * @returns {void}
 */
function clearTenant(tenantId) {
  _requireTenant(tenantId);
  _store.delete(tenantId);
}

/**
 * Wipe all data across ALL tenants.
 * **Test use only.**
 *
 * @returns {void}
 */
function clearAll() {
  _store.clear();
}

module.exports = {
  listInvoices,
  findInvoice,
  createInvoice,
  softDeleteInvoice,
  restoreInvoice,
  clearTenant,
  clearAll,
};