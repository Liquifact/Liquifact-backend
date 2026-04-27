const {
  performReconciliation,
  reconcileInvoice,
  scheduleNightlyReconciliation,
  getReconciliationSummary,
  RECONCILE_STATUS,
} = require('../src/jobs/reconcileEscrow');

describe('Escrow Reconciliation Job', () => {
  beforeEach(() => {
    // Clear global state
    delete global.reconciliationSummary;
    jest.clearAllMocks();
  });

  describe('reconcileInvoice', () => {
    it('returns MATCH status when amounts match', async () => {
      const result = await reconcileInvoice('inv_1', 1000);
      expect(result).toEqual({
        invoiceId: 'inv_1',
        status: RECONCILE_STATUS.MATCH,
        dbFundedTotal: 1000,
        onChainAmount: 1000,
        reconciledAt: expect.any(String),
      });
    });

    it('returns MISMATCH status when amounts differ', async () => {
      const result = await reconcileInvoice('inv_2', 2000);
      expect(result).toEqual({
        invoiceId: 'inv_2',
        status: RECONCILE_STATUS.MISMATCH,
        dbFundedTotal: 2000,
        onChainAmount: 1990,
        reconciledAt: expect.any(String),
      });
    });

    it('returns ERROR status when on-chain call fails', async () => {
      // Mock the soroban service to throw
      const originalCallSorobanContract = require('../src/services/soroban').callSorobanContract;
      require('../src/services/soroban').callSorobanContract = jest.fn().mockRejectedValue(new Error('Network error'));

      const result = await reconcileInvoice('inv_1', 1000);
      expect(result).toEqual({
        invoiceId: 'inv_1',
        status: RECONCILE_STATUS.ERROR,
        dbFundedTotal: 1000,
        onChainAmount: null,
        error: 'Network error',
        reconciledAt: expect.any(String),
      });

      // Restore
      require('../src/services/soroban').callSorobanContract = originalCallSorobanContract;
    });
  });

  describe('performReconciliation', () => {
    it('reconciles all invoices and returns summary', async () => {
      const summary = await performReconciliation();

      expect(summary).toEqual({
        total: 3,
        matches: 2,
        mismatches: 1,
        errors: 0,
        reconciledAt: expect.any(String),
        results: expect.arrayContaining([
          expect.objectContaining({ invoiceId: 'inv_1', status: RECONCILE_STATUS.MATCH }),
          expect.objectContaining({ invoiceId: 'inv_2', status: RECONCILE_STATUS.MISMATCH }),
          expect.objectContaining({ invoiceId: 'inv_3', status: RECONCILE_STATUS.MATCH }),
        ]),
      });

      // Should store summary globally
      expect(global.reconciliationSummary).toEqual(summary);
    });

    it('handles errors in reconciliation', async () => {
      // Mock soroban to fail for all
      const originalCallSorobanContract = require('../src/services/soroban').callSorobanContract;
      require('../src/services/soroban').callSorobanContract = jest.fn().mockRejectedValue(new Error('RPC down'));

      const summary = await performReconciliation();

      expect(summary.total).toBe(3);
      expect(summary.errors).toBe(3);
      expect(summary.matches).toBe(0);
      expect(summary.mismatches).toBe(0);

      // Restore
      require('../src/services/soroban').callSorobanContract = originalCallSorobanContract;
    });
  });

  describe('scheduleNightlyReconciliation', () => {
    it('enqueues a reconciliation job', () => {
      const jobId = scheduleNightlyReconciliation();
      expect(jobId).toMatch(/^job-[a-f0-9]{16}$/);
    });
  });

  describe('getReconciliationSummary', () => {
    it('returns null when no reconciliation has been run', () => {
      expect(getReconciliationSummary()).toBeNull();
    });

    it('returns the stored summary after reconciliation', async () => {
      await performReconciliation();
      const summary = getReconciliationSummary();
      expect(summary).toHaveProperty('total', 3);
      expect(summary).toHaveProperty('matches', 2);
    });
  });
});