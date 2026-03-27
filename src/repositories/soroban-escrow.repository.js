const EscrowRepository = require('./escrow.repository');
const { callSorobanContract } = require('../services/soroban');

/**
 * @fileoverview Concrete implementation of EscrowRepository using Soroban contracts.
 */

/**
 *
 */
class SorobanEscrowRepository extends EscrowRepository {
  /**
   * Get the current state of an escrow for a given invoice via Soroban.
   * @param {string} invoiceId The invoice ID.
   * @returns {Promise<import('./escrow.repository').EscrowState>}
   */
  async getEscrowState(invoiceId) {
    try {
      // Simulate/Execute a remote contract call logic via the robust Soroban service wrapper.
      // In a real scenario, this function would involve invoking a specific contract method.
      const data = await callSorobanContract(async () => {
        // Mocked response for now (this reflects the existing logic in app.js).
        return { invoiceId, status: 'not_found', fundedAmount: 0 };
      });
      
      return {
        ...data,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Escrow fetch failed: ${error.message}`);
    }
  }
}

module.exports = SorobanEscrowRepository;
