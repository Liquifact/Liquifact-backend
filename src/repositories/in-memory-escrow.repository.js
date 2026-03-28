/**
 * In-memory escrow repository implementation.
 * @returns {Object} Escrow repository instance.
 */
const EscrowRepository = require('./escrow.repository');

/**
 * @fileoverview In-memory adapter for escrow data.
 * Useful for development and testing without blockchain dependencies.
 */

/**
 *
 */
class InMemoryEscrowRepository extends EscrowRepository {
  /**
   * Constructs an in-memory escrow repository instance.
   * @returns {InMemoryEscrowRepository}
   */
  constructor() {
    super();
    /**
     * Internal storage for escrows.
     * @type {Map<string, import('./escrow.repository').EscrowState>}
     */
    this.escrows = new Map();
  }

  /**
   * Get the current state of an escrow for a given invoice.
   * @param {string} invoiceId The invoice ID.
   * @returns {Promise<import('./escrow.repository').EscrowState>} Escrow state object.
   */
  async getEscrowState(invoiceId) {
    const existing = this.escrows.get(invoiceId);
    
    if (!existing) {
      return {
        invoiceId,
        status: 'not_found',
        fundedAmount: 0,
        lastUpdated: new Date().toISOString()
      };
    }
    
    return {
      ...existing,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Update or set the escrow state (for testing/mocking).
   * @param {string} invoiceId The invoice ID.
   * @param {Partial<import('./escrow.repository').EscrowState>} state The state to set.
   * @returns {Promise<void>} Resolves when the state is set.
   */
  async setEscrowState(invoiceId, state) {
    this.escrows.set(invoiceId, {
      invoiceId,
      status: state.status || 'not_found',
      fundedAmount: state.fundedAmount || 0,
      ...state
    });
  }

  /**
   * Clears all escrows from memory. (Only for testing purposes)
   * @returns {Promise<void>}
   */
  async clear() {
    this.escrows.clear();
  }
}

module.exports = InMemoryEscrowRepository;
