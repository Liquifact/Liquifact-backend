/**
 * Invoice Service
 * Handles data retrieval and business logic for invoices.
 * Includes KYC compliance tracking for funding operations.
 */

const logger = require('../logger');

// Placeholder mock database (this would normally be a real database like PostgreSQL)
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
  {
    id: 'inv_3',
    status: 'funded',
    amount: 5000,
    customer: 'Charlie Ltd',
    ownerId: 'user_2',
    smeId: 'sme_003',
    kycStatus: 'verified',
    kycRecordId: 'kyc_sme_003_001',
    kycStatusUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deletedAt: null,
  },
];

/**
 * Get a single invoice by its ID.
 * Performs authorization checks and includes KYC status.
 *
 * @param {string} id - The unique identifier of the invoice.
 * @param {string} tenantId - The tenant ID for isolation.
 * @returns {Object|null} The invoice data or null if not found.
 */
const getInvoiceById = async (id, tenantId) => {
  // 1. Basic validation
  if (!id || typeof id !== 'string') {
    throw new Error('Invalid invoice ID');
  }

  // 2. Fetch from DB with tenant isolation
  const invoice = await db('invoices')
    .where({ invoice_id: id, tenant_id: tenantId, deleted_at: null })
    .first();

  // 3. Not Found handling
  if (!invoice) {
    return null;
  }

  return invoice;
};

/**
 * Get all invoices for a tenant, with optional status filter.
 *
 * @param {string} tenantId - The tenant ID.
 * @param {string} [status] - Optional status filter.
 * @returns {Array} List of invoices.
 */
const getInvoices = async (tenantId, status) => {
  let query = db('invoices')
    .where({ tenant_id: tenantId, deleted_at: null })
    .orderBy('created_at', 'desc');

  if (status) {
    query = query.where({ status });
  }

  return await query;
};

/**
 * Create a new invoice.
 *
 * @param {Object} invoiceData - The invoice data.
 * @param {string} tenantId - The tenant ID.
 * @returns {Object} The created invoice.
 */
const createInvoice = async (invoiceData, tenantId) => {
  const { amount, customer, status = 'pending', metadata } = invoiceData;

  const invoiceId = `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  const [newInvoice] = await db('invoices')
    .insert({
      invoice_id: invoiceId,
      amount,
      customer,
      status,
      tenant_id: tenantId,
      metadata: metadata || null,
    })
    .returning('*');

  return newInvoice;
};

/**
 * Update invoice status.
 *
 * @param {string} id - Invoice ID.
 * @param {string} status - New status.
 * @param {string} tenantId - Tenant ID.
 * @returns {Object|null} Updated invoice or null.
 */
const updateInvoiceStatus = async (id, status, tenantId) => {
  const [updated] = await db('invoices')
    .where({ invoice_id: id, tenant_id: tenantId })
    .update({ status, updated_at: db.fn.now() })
    .returning('*');

  return updated || null;
};

/**
 * Get invoices with optional filtering by KYC status
 * 
 * @param {Object} options - Filter options
 * @param {string} options.userId - User ID for authorization
 * @param {string} options.kycStatus - Filter by KYC status (optional)
 * @returns {Array} Invoices matching criteria
 */
const getInvoicesByKycStatus = (userId, kycStatus) => {
  if (!userId) {
    throw new Error('User ID required');
  }

  let filtered = mockInvoices.filter((inv) => inv.ownerId === userId && !inv.deletedAt);

  if (kycStatus) {
    filtered = filtered.filter((inv) => inv.kycStatus === kycStatus);
  }

  return filtered;
};

/**
 * Update KYC status for an invoice
 * 
 * @param {string} invoiceId - Invoice ID
 * @param {string} newKycStatus - New KYC status
 * @param {string} kycRecordId - KYC record reference
 * @returns {Object} Updated invoice
 */
const updateInvoiceKycStatus = (invoiceId, newKycStatus, kycRecordId = null) => {
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
    'Invoice KYC status updated'
  );

  return invoice;
};

module.exports = {
  getInvoiceById,
  getInvoicesByKycStatus,
  updateInvoiceKycStatus,
  mockInvoices, // Exported for testing purposes
};
