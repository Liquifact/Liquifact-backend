/**
 * In-memory invoice repository implementation.
 * @returns {Object} Invoice repository instance.
 */
const InvoiceRepository = require('./invoice.repository');

/**
 * @fileoverview In-memory adapter for invoice persistence.
 * Suitable for testing and prototyping before switching to a real database.
 */

/**
 *
 */
class InMemoryInvoiceRepository extends InvoiceRepository {
  /**
   * Constructs an in-memory invoice repository instance.
   * @returns {InMemoryInvoiceRepository}
   */
  constructor() {
    super();
    /**
     * Internal storage for invoices.
     * @type {Map<string, import('./invoice.repository').Invoice>}
     */
    this.invoices = new Map();
  }

  /**
   * Find all invoices.
   * @param {Object} [filter={}] Optional filters.
   * @param {boolean} [filter.includeDeleted=false] Whether to include soft-deleted invoices.
   * @returns {Promise<import('./invoice.repository').Invoice[]>} Array of invoices.
   */
  async findAll(filter = {}) {
    const includeDeleted = filter.includeDeleted || false;
    const all = Array.from(this.invoices.values());
    if (includeDeleted) {
      return all;
    }
    return all.filter(inv => !inv.deletedAt);
  }

  /**
   * Find an invoice by its unique ID.
   * @param {string} id The invoice ID.
   * @returns {Promise<import('./invoice.repository').Invoice|null>} Invoice or null if not found.
   */
  async findById(id) {
    const invoice = this.invoices.get(id);
    return invoice || null;
  }

  /**
   * Create a new invoice.
   * @param {Partial<import('./invoice.repository').Invoice>} invoiceData The invoice data to store.
   * @returns {Promise<import('./invoice.repository').Invoice>} The created invoice.
   */
  async create(invoiceData) {
    const id = invoiceData.id || `invoice-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();
    
    const newInvoice = {
      id,
      amount: invoiceData.amount || 0,
      currency: invoiceData.currency || 'XLM',
      status: invoiceData.status || 'pending_verification',
      description: invoiceData.description || '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...invoiceData,
    };
    
    this.invoices.set(id, newInvoice);
    return newInvoice;
  }

  /**
   * Update an existing invoice.
   * @param {string} id The invoice ID to update.
   * @param {Partial<import('./invoice.repository').Invoice>} updateData The data to update.
   * @returns {Promise<import('./invoice.repository').Invoice|null>} The updated invoice or null if not found.
   */
  async update(id, updateData) {
    const existing = this.invoices.get(id);
    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      ...updateData,
      id, // Preserve ID
      updatedAt: new Date().toISOString(),
    };

    this.invoices.set(id, updated);
    return updated;
  }

  /**
   * Soft delete an invoice by ID.
   * @param {string} id The invoice ID to soft delete.
   * @returns {Promise<import('./invoice.repository').Invoice|null>} The soft-deleted invoice or null if not found.
   */
  async softDelete(id) {
    const existing = this.invoices.get(id);
    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.invoices.set(id, updated);
    return updated;
  }

  /**
   * Restore a soft-deleted invoice by ID.
   * @param {string} id The invoice ID to restore.
   * @returns {Promise<import('./invoice.repository').Invoice|null>} The restored invoice or null if not found.
   */
  async restore(id) {
    const existing = this.invoices.get(id);
    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
    };

    this.invoices.set(id, updated);
    return updated;
  }

  /**
   * Delete an invoice by ID.
   * @param {string} id The invoice ID to delete.
   * @returns {Promise<boolean>} True if deleted, false if not found.
   */
  async delete(id) {
    if (!this.invoices.has(id)) {
      return false;
    }
    
    this.invoices.delete(id);
    return true;
  }

  /**
   * Clears all invoices from memory. (Only for testing purposes)
   * @returns {Promise<void>}
   */
  async clear() {
    this.invoices.clear();
  }
}

module.exports = InMemoryInvoiceRepository;
