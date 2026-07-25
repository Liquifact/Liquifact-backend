'use strict';

const ADMIN_ROLES = new Set(['admin', 'owner']);
const FUNDER_ADDRESS_CLAIMS = [
  'funderAddress',
  'walletAddress',
  'stellarAddress',
  'investorAddress',
];

/**
 * Returns true when the authenticated principal may inspect locks for any
 * funder in the tenant.
 *
 * @param {object|null|undefined} user - Decoded JWT principal.
 * @returns {boolean} Whether the principal is an investor-lock admin.
 */
function isInvestorLockAdmin(user) {
  const role = typeof user?.role === 'string' ? user.role.toLowerCase() : '';
  if (ADMIN_ROLES.has(role)) {
    return true;
  }

  if (Array.isArray(user?.permissions)) {
    return user.permissions.includes('investor:locks:read:any');
  }

  return false;
}

/**
 * Resolves the funder address bound to the authenticated principal.
 *
 * @param {object|null|undefined} user - Decoded JWT principal.
 * @returns {string|null} Bound funder address, or null when absent.
 */
function getBoundFunderAddress(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }

  for (const claim of FUNDER_ADDRESS_CLAIMS) {
    const value = user[claim];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

/**
 * Builds a stable scope segment for cache keys that store investor lock data.
 *
 * @param {import('express').Request} req - Express request.
 * @returns {string} Principal scope segment.
 */
function getInvestorLockPrincipalScope(req) {
  if (isInvestorLockAdmin(req.user)) {
    const role = typeof req.user?.role === 'string' ? req.user.role.toLowerCase() : 'permission';
    return `admin:${role}`;
  }

  return `funder:${getBoundFunderAddress(req.user) || 'unbound'}`;
}

module.exports = {
  getBoundFunderAddress,
  getInvestorLockPrincipalScope,
  isInvestorLockAdmin,
};
