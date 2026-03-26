/**
 * RBAC Policy Definitions
 * Maps specific operations to the roles allowed to perform them.
 * @module policies/rbacPolicy
 */

const ROLES = {
  ADMIN: 'admin',
  ISSUER: 'issuer',
  INVESTOR: 'investor',
};

const rbacPolicy = {
  CREATE_INVOICE: [ROLES.ADMIN, ROLES.ISSUER],
  VIEW_INVOICES: [ROLES.ADMIN, ROLES.ISSUER, ROLES.INVESTOR],
  ESCROW_READ: [ROLES.ADMIN, ROLES.INVESTOR],
  DELETE_INVOICE: [ROLES.ADMIN],
  RESTORE_INVOICE: [ROLES.ADMIN],
};

module.exports = {
  ROLES,
  rbacPolicy,
};
