/**
 * @fileoverview Interface for escrow data access (Soroban or future blockchain).
 */

/**
 * @typedef {Object} EscrowState
 * @property {string} invoiceId The associated invoice ID.
 * @property {string} status The current state (e.g., 'funded', 'not_found', 'completed').
 * @property {number} fundedAmount The amount currently in escrow.
 * @property {string} [lastUpdated] Optional ISO timestamp.
 */

/**
 * Base Repository for Escrow Data Access.
 * Abstract class for blockchain-backed escrow logic.
 * 
 * @abstract
 */
class EscrowRepository {
  /**
   * Get the current state of an escrow for a given invoice.
   * @param {string} invoiceId The invoice ID.
   * @returns {Promise<EscrowState>}
   */
  async getEscrowState(invoiceId) {
    throw new Error('Method not implemented' + invoiceId);
  }
}

module.exports = EscrowRepository;
