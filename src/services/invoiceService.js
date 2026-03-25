/**
 * Invoice Service
 * 
 * Business logic layer for invoice operations.
 * Handles creation, retrieval, updates, and list operations.
 * 
 * This service:
 * - Validates input data
 * - Interacts with the storage layer
 * - Provides consistent error handling
 * - Maintains business rule enforcement
 */

const storage = require('../db/storage');
const { createInvoiceFromRequest } = require('../models/invoice');

/**
 * Create a new invoice from request data
 * 
 * @param {Object} requestData - Invoice data from HTTP request
 * @returns {Promise<Object>} { success: boolean, invoice?: Object, error?: string }
 * 
 * @example
 * const result = await invoiceService.create({
 *   invoiceNumber: 'INV-001',
 *   sellerName: 'Acme Corp',
 *   buyerName: 'Tech LLC',
 *   amount: 5000,
 *   currency: 'USD',
 *   dueDate: '2026-12-31T23:59:59Z',
 *   description: 'Services rendered in Q1 2026'
 * });
 */
async function create(requestData) {
  try {
    const creationResult = createInvoiceFromRequest(requestData);

    if (!creationResult.success) {
      return {
        success: false,
        error: 'Validation failed',
        errors: creationResult.errors,
      };
    }

    const invoice = storage.createInvoice(creationResult.invoice);

    return {
      success: true,
      invoice,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to create invoice: ${error.message}`,
    };
  }
}

/**
 * Get a single invoice by ID
 * 
 * @param {string} invoiceId - Invoice ID
 * @returns {Promise<Object>} { success: boolean, invoice?: Object, error?: string }
 */
async function getById(invoiceId) {
  try {
    if (!invoiceId || typeof invoiceId !== 'string') {
      return {
        success: false,
        error: 'Invalid invoice ID',
      };
    }

    const invoice = storage.getInvoice(invoiceId);

    if (!invoice) {
      return {
        success: false,
        error: `Invoice not found: ${invoiceId}`,
      };
    }

    return {
      success: true,
      invoice,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to fetch invoice: ${error.message}`,
    };
  }
}

/**
 * Get all invoices with optional filtering
 * 
 * @param {Object} options - Filter options
 * @param {string} [options.status] - Filter by status
 * @returns {Promise<Object>} { success: boolean, invoices: Array, count: number, error?: string }
 * 
 * @example
 * const result = await invoiceService.list({ status: 'verified' });
 */
async function list(options = {}) {
  try {
    const invoices = storage.getAllInvoices(options);

    return {
      success: true,
      invoices: invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      count: invoices.length,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to list invoices: ${error.message}`,
      invoices: [],
      count: 0,
    };
  }
}

/**
 * Update an invoice's status
 * 
 * @param {string} invoiceId - Invoice ID
 * @param {string} newStatus - New status (must be valid)
 * @returns {Promise<Object>} { success: boolean, invoice?: Object, error?: string }
 */
async function updateStatus(invoiceId, newStatus) {
  try {
    const validStatuses = [
      'pending_verification',
      'verified',
      'active',
      'funded',
      'completed',
      'cancelled',
    ];

    if (!validStatuses.includes(newStatus)) {
      return {
        success: false,
        error: `Invalid status: ${newStatus}`,
      };
    }

    const invoice = storage.getInvoice(invoiceId);
    if (!invoice) {
      return {
        success: false,
        error: `Invoice not found: ${invoiceId}`,
      };
    }

    const updated = storage.updateInvoice(invoiceId, { status: newStatus });

    return {
      success: true,
      invoice: updated,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to update invoice: ${error.message}`,
    };
  }
}

/**
 * Delete an invoice
 * 
 * @param {string} invoiceId - Invoice ID
 * @returns {Promise<Object>} { success: boolean, error?: string }
 */
async function delete_(invoiceId) {
  try {
    if (!invoiceId || typeof invoiceId !== 'string') {
      return {
        success: false,
        error: 'Invalid invoice ID',
      };
    }

    const deleted = storage.deleteInvoice(invoiceId);

    if (!deleted) {
      return {
        success: false,
        error: `Invoice not found: ${invoiceId}`,
      };
    }

    return {
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to delete invoice: ${error.message}`,
    };
  }
}

module.exports = {
  create,
  getById,
  list,
  updateStatus,
  delete: delete_,
};
