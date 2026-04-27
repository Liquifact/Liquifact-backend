'use strict';

/**
 * Investor Commitment Service
 * Manages investor commitment data including claimNotBefore and effective yield
 * from the DB mirror (with stale flag for non-indexed data).
 *
 * @module services/investorCommitment
 */

const logger = require('../logger');

/**
 * Validates a Stellar/Soroban address (G... or C... prefix).
 *
 * @param {unknown} address - Address to validate.
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateAddress(address) {
  if (typeof address !== 'string' || address.trim() === '') {
    return { valid: false, reason: 'address must be a non-empty string' };
  }
  const trimmed = address.trim();
  if (!/^[GC][A-Z0-9]{55}$/.test(trimmed)) {
    return {
      valid: false,
      reason: 'invalid Stellar address format (expected G... or C... with 56 chars)',
    };
  }
  return { valid: true };
}

/**
 * @typedef {Object} InvestorLock
 * @property {string} funderAddress - Stellar address of the funder.
 * @property {string} claimNotBefore - ISO timestamp when claims become valid.
 * @property {number} investorEffectiveYieldBps - Effective yield in basis points.
 * @property {string} invoiceId - Associated invoice ID.
 * @property {boolean} stale - Whether data is from DB mirror (not live on-chain).
 */

/**
 * In-memory store for investor locks (DB mirror placeholder).
 * In production, this would be synced from on-chain events.
 *
 * @type {InvestorLock[]}
 */
const investorLocks = [];

/**
 * Adds or updates an investor lock record.
 *
 * @param {Object} params - Lock parameters.
 * @param {string} params.funderAddress - Stellar address of the funder.
 * @param {string} params.claimNotBefore - ISO timestamp for claim start.
 * @param {number} params.investorEffectiveYieldBps - Effective yield in bps.
 * @param {string} params.invoiceId - Associated invoice ID.
 * @returns {InvestorLock} The created/updated lock record.
 */
function setInvestorLock({ funderAddress, claimNotBefore, investorEffectiveYieldBps, invoiceId }) {
  const existingIndex = investorLocks.findIndex(
    (lock) => lock.funderAddress === funderAddress && lock.invoiceId === invoiceId
  );

  const lock = {
    funderAddress,
    claimNotBefore,
    investorEffectiveYieldBps,
    invoiceId,
    stale: true,
    updatedAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    investorLocks[existingIndex] = lock;
  } else {
    investorLocks.push(lock);
  }

  logger.info({ funderAddress, invoiceId }, 'Investor lock updated (stale=true)');

  return lock;
}

/**
 * Retrieves investor locks for a specific funder address.
 *
 * @param {string} funderAddress - Stellar address to query.
 * @param {Object} [options={}] - Query options.
 * @param {string} [options.invoiceId] - Optional filter by invoice ID.
 * @returns {InvestorLock[]} Array of matching lock records.
 */
function getInvestorLocksByAddress(funderAddress, options = {}) {
  const { invoiceId } = options;

  let locks = investorLocks.filter((lock) => lock.funderAddress === funderAddress);

  if (invoiceId) {
    locks = locks.filter((lock) => lock.invoiceId === invoiceId);
  }

  return locks;
}

/**
 * Retrieves all investor locks, optionally filtered by invoice.
 *
 * @param {Object} [options={}] - Query options.
 * @param {string} [options.invoiceId] - Optional filter by invoice ID.
 * @returns {InvestorLock[]} Array of lock records.
 */
function getAllInvestorLocks(options = {}) {
  const { invoiceId } = options;

  if (invoiceId) {
    return investorLocks.filter((lock) => lock.invoiceId === invoiceId);
  }

  return [...investorLocks];
}

/**
 * Retrieves an investor lock by invoice ID and funder.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {string} funderAddress - Funder Stellar address.
 * @returns {InvestorLock|undefined} The lock record if found.
 */
function getInvestorLock(invoiceId, funderAddress) {
  return investorLocks.find(
    (lock) => lock.invoiceId === invoiceId && lock.funderAddress === funderAddress
  );
}

/**
 * Clears all investor locks (for testing).
 *
 * @returns {void}
 */
function clearInvestorLocks() {
  investorLocks.length = 0;
}

/**
 * Populates sample data for testing/development.
 *
 * @returns {void}
 */
function seedInvestorLocks() {
  const samples = [
    {
      funderAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK',
      claimNotBefore: '2026-01-01T00:00:00Z',
      investorEffectiveYieldBps: 850,
      invoiceId: 'inv_7788',
    },
    {
      funderAddress: 'GDGQVOKHW4VEJRU2TETD8G6RWJ3TVM3VROMV7I3ESNITIBLL6QL6RAIL',
      claimNotBefore: '2026-02-01T00:00:00Z',
      investorEffectiveYieldBps: 700,
      invoiceId: 'inv_2244',
    },
  ];

  samples.forEach((sample) => {
    setInvestorLock(sample);
  });
}

module.exports = {
  validateAddress,
  setInvestorLock,
  getInvestorLocksByAddress,
  getAllInvestorLocks,
  getInvestorLock,
  clearInvestorLocks,
  seedInvestorLocks,
};