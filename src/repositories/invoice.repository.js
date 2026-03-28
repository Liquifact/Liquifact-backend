/**
 * @fileoverview Base interface for invoice data access.
 * This class should be extended by specific persistence adapters.
 */

/**
 * @typedef {Object} Invoice
 * @property {string} id Unique identifier for the invoice.
 * @property {number} amount Amount for the invoice.
 * @property {string} currency Currency code (e.g., XLM, USDC).
 * @property {string} status Current status of the invoice.
 * @property {string} [description] Optional description.
 * @property {string} createdAt ISO timestamp of creation.
 * @property {string} updatedAt ISO timestamp of last update.
 */

/**
 * Base Repository for Invoice Data Access.
 * Defines the contract that all concrete implementations must follow.
 * 
 * @abstract
 */
class InvoiceRepository {
  /**
   * Find all invoices.
   * @param {Object} [filter={}] Optional filters.
   * @param {boolean} [filter.includeDeleted=false] Whether to include soft-deleted invoices.
   * @returns {Promise<Invoice[]>}
   */
  async findAll(filter = {}) {
    throw new Error('Method not implemented' + JSON.stringify(filter));
  }

  /**
   * Find an invoice by its unique ID.
   * @param {string} id The invoice ID.
   * @returns {Promise<Invoice|null>}
   */
  async findById(id) {
    throw new Error('Method not implemented' + id);
  }

  /**
   * Create a new invoice.
   * @param {Partial<Invoice>} invoiceData The invoice data to store.
   * @returns {Promise<Invoice>} The created invoice.
   */
  async create(invoiceData) {
    throw new Error('Method not implemented' + JSON.stringify(invoiceData));
  }

  /**
   * Update an existing invoice.
   * @param {string} id The invoice ID to update.
   * @param {Partial<Invoice>} updateData The data to update.
   * @returns {Promise<Invoice|null>} The updated invoice or null if not found.
   */
  async update(id, updateData) {
    throw new Error('Method not implemented' + id + JSON.stringify(updateData));
  }

  /**
   * Soft delete an invoice by ID.
   * @param {string} id The invoice ID to soft delete.
   * @returns {Promise<Invoice|null>} The soft-deleted invoice or null if not found.
   */
  async softDelete(id) {
    throw new Error('Method not implemented' + id);
  }

  /**
   * Restore a soft-deleted invoice by ID.
   * @param {string} id The invoice ID to restore.
   * @returns {Promise<Invoice|null>} The restored invoice or null if not found.
   */
  async restore(id) {
    throw new Error('Method not implemented' + id);
  }

  /**
   * Permanent delete an invoice by ID.
   * @param {string} id The invoice ID to delete.
   * @returns {Promise<boolean>} True if deleted, false if not found.
   */
  async delete(id) {
    throw new Error('Method not implemented' + id);
  }
}

module.exports = InvoiceRepository;
