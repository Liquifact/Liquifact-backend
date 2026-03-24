/**
 * Role-Based Access Control Policy
 * Defines which roles are authorized for specific operations.
 */
const RBAC_POLICY = {
  CREATE_INVOICE: ['admin', 'operator'],
  VIEW_INVOICES: ['admin', 'operator', 'user'],
  ESCROW_READ: ['admin', 'operator'],
  APPROVE_INVOICE: ['admin', 'operator'],
  ESCROW_SETTLE: ['admin'],
};

module.exports = RBAC_POLICY;
