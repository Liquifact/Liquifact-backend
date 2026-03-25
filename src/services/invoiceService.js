/**
 * Invoice Service
 * Handles data retrieval for invoice listings with pagination.
 */

// Generate a larger set of mock invoices for meaningful pagination
const mockInvoices = Array.from({ length: 25 }, (_, i) => ({
  id: `inv_${i + 1}`,
  amount: Math.floor(Math.random() * 5000) + 500,
  clientName: `Client ${i + 1}`,
  status: i % 3 === 0 ? 'verified' : 'pending_verification',
  ownerId: `user_${(i % 5) + 1}`,
}));

/**
 * Get a paginated list of invoices.
 *
 * @param {Object} params - Pagination parameters.
 * @param {number} params.page - Current page number (1-indexed).
 * @param {number} params.limit - Maximum number of records per page.
 * @returns {Object} Paginated data and metadata.
 */
const getInvoices = ({ page = 1, limit = 10 }) => {
  // 1. Sanitize & Validate input
  const p = Math.max(1, parseInt(page, 10)) || 1;
  const l = Math.min(100, Math.max(1, parseInt(limit, 10))) || 10;

  // 2. Calculate indices
  const startIndex = (p - 1) * l;
  const endIndex = p * l;

  // 3. Slice the dataset
  const results = mockInvoices.slice(startIndex, endIndex);

  // 4. Calculate pagination metadata
  const total = mockInvoices.length;
  const totalPages = Math.ceil(total / l);

  return {
    invoices: results,
    meta: {
      total,
      page: p,
      limit: l,
      totalPages,
      hasNextPage: p < totalPages,
      hasPreviousPage: p > 1,
    },
  };
};

module.exports = {
  getInvoices,
  mockInvoices, // Exported for unit test assertions
};
