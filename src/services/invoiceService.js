/**
 * Invoice Service
 * Handles data retrieval and business logic for invoices.
 */

// Placeholder mock database (this would normally be a real database like PostgreSQL)
const mockInvoices = [
  { id: 'inv_1', status: 'pending_verification', amount: 1000, clientName: 'Alice Corp', ownerId: 'user_1' },
  { id: 'inv_2', status: 'verified', amount: 2000, clientName: 'Bob Inc', ownerId: 'user_1' },
  { id: 'inv_3', status: 'funded', amount: 5000, clientName: 'Charlie Ltd', ownerId: 'user_2' },
];

/**
 * Get a single invoice by its ID.
 * Performs authorization checks.
 *
 * @param {string} id - The unique identifier of the invoice.
 * @param {string} userId - The unique identifier of the user (from auth middleware).
 * @returns {Object|null} The invoice data or null if not found.
 */
const getInvoiceById = (id, userId) => {
  // 1. Basic validation (should also be handled by route middleware)
  if (!id || typeof id !== 'string') {
    throw new Error('Invalid invoice ID');
  }

  // 2. Fetch from DB
  const invoice = mockInvoices.find((inv) => inv.id === id);

  // 3. Robust Not Found handling
  if (!invoice) {
    return null;
  }

  // 4. Secure Authorization handling
  // If the user is not the owner, deny access.
  if (invoice.ownerId !== userId) {
    const error = new Error('Forbidden');
    error.status = 403;
    throw error;
  }

  return invoice;
};

module.exports = {
  getInvoiceById,
  mockInvoices, // Exported for testing purposes
};
