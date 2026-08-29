'use strict';

// jest.mock() calls must precede the require()s they target: this repo's
// Jest config has "transform": {} (no babel-jest), so jest.mock() calls are
// not hoisted above requires the way they would be under babel-jest. Placed
// after the requires (as this file previously was), each jest.mock() call
// registers too late — the real, unmocked module is already cached — and
// every mocked method silently stays a plain function instead of a
// jest.fn(), so .mockResolvedValue()/.mockReturnValue() throw "is not a
// function". Confirmed via git-diff-free reproduction against this exact
// file's previously-committed content: 10 of 12 tests already failed this
// way before this change touched anything.
jest.mock('./invoiceService');
jest.mock('./invoiceStateMachine');
jest.mock('./auditLog');

const invoiceStateService = require('./invoiceStateService');
const invoiceService = require('./invoiceService');
const invoiceStateMachine = require('./invoiceStateMachine');
const auditLog = require('./auditLog');

describe('invoiceStateService', () => {
  const tenantId = 'tenant-123';
  const invoiceId = 'inv-456';
  const context = {
    actor: 'user-789',
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    metadata: { method: 'POST', path: '/api/test' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getState', () => {
    it('should return state and allowed transitions', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved', 'rejected']);

      const result = await invoiceStateService.getState(invoiceId, tenantId);

      expect(invoiceService.resolveInvoiceForTenant).toHaveBeenCalledWith(invoiceId, tenantId);
      expect(invoiceStateMachine.getAllowedTransitions).toHaveBeenCalledWith('pending');
      expect(result).toEqual({
        invoiceId,
        currentState: 'pending',
        allowedTransitions: ['approved', 'rejected'],
        isTerminal: false,
        revision: 1,
      });
    });

    it('should mark terminal states correctly', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'rejected', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue([]);

      const result = await invoiceStateService.getState(invoiceId, tenantId);

      expect(result.isTerminal).toBe(true);
    });

    it('should throw if invoice not found', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue(null);

      await expect(invoiceStateService.getState(invoiceId, tenantId))
        .rejects.toThrow('Invoice not found');
    });
  });

  describe('transition', () => {
    it('should transition invoice state', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved']);
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.transition(invoiceId, tenantId, 'approved', 'looks good', context, 1);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'approved',
        tenantId,
        expect.objectContaining({
          actor: context.actor,
          reason: 'looks good',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: context.metadata,
          expectedRevision: 1,
        })
      );
      expect(result.auditLogId).toBe('audit-1');
      expect(result.previousState).toBe('pending');
    });

    it('should throw if target state is missing', async () => {
      await expect(invoiceStateService.transition(invoiceId, tenantId, null, 'reason', context))
        .rejects.toThrow('Target state is required');
    });
  });

  describe('revision and transition enforcement', () => {
    it('valid transition succeeds with the current revision', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved']);
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.transition(invoiceId, tenantId, 'approved', 'looks good', context, 1);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'approved',
        tenantId,
        expect.objectContaining({ expectedRevision: 1 })
      );
      expect(result.currentState).toBe('approved');
    });

    it('same transition is retried and rejected as an invalid transition', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'approved', revision: 2 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['linked_escrow']);

      await expect(invoiceStateService.transition(invoiceId, tenantId, 'approved', 'retry', context, 2))
        .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      expect(invoiceService.transitionInvoice).not.toHaveBeenCalled();
    });

    it('stale revision is rejected', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 2 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved']);
      invoiceService.transitionInvoice.mockRejectedValue(
        Object.assign(new Error('Revision conflict'), { code: 'STALE_REVISION' })
      );

      await expect(invoiceStateService.transition(invoiceId, tenantId, 'approved', 'looks good', context, 1))
        .rejects.toMatchObject({ code: 'STALE_REVISION' });
    });

    it('invalid backward transition is rejected', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'approved', revision: 2 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['linked_escrow']);

      await expect(invoiceStateService.transition(invoiceId, tenantId, 'pending', 'rewind', context, 2))
        .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      expect(invoiceService.transitionInvoice).not.toHaveBeenCalled();
    });

    it('two different transitions race; second caller loses with stale revision', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved', 'rejected']);

      invoiceService.transitionInvoice.mockResolvedValueOnce({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });
      invoiceService.transitionInvoice.mockRejectedValueOnce(
        Object.assign(new Error('Revision conflict'), { code: 'STALE_REVISION' })
      );

      const first = await invoiceStateService.transition(invoiceId, tenantId, 'approved', 'first', context, 1);
      expect(first.currentState).toBe('approved');

      await expect(invoiceStateService.transition(invoiceId, tenantId, 'rejected', 'second', context, 1))
        .rejects.toMatchObject({ code: 'STALE_REVISION' });
    });
  });

  describe('approve', () => {
    it('should approve invoice', async () => {
      invoiceStateMachine.INVOICE_STATES = { APPROVED: 'approved' };
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved']);
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.approve(invoiceId, tenantId, null, context, 1);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'approved',
        tenantId,
        expect.objectContaining({ reason: 'Invoice approved', expectedRevision: 1 })
      );
      expect(result.currentState).toBe('approved');
    });
  });

  describe('linkEscrow', () => {
    it('should link invoice to escrow', async () => {
      invoiceStateMachine.INVOICE_STATES = { LINKED_ESCROW: 'linked_escrow' };
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'approved', revision: 2 });
      invoiceStateMachine.canLinkToEscrow.mockReturnValue({ canLink: true });
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'approved',
        newState: 'linked_escrow',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.linkEscrow(invoiceId, tenantId, 'escrow-999', 'reason', context, 2);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'linked_escrow',
        tenantId,
        expect.objectContaining({ escrowId: 'escrow-999', expectedRevision: 2 })
      );
      expect(result.escrowId).toBe('escrow-999');
    });

    it('should throw if cannot link to escrow', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.canLinkToEscrow.mockReturnValue({ canLink: false, reason: 'Must be approved' });

      await expect(invoiceStateService.linkEscrow(invoiceId, tenantId, 'escrow-999', 'reason', context, 1))
        .rejects.toThrow('Must be approved');
    });
  });

  describe('reject', () => {
    it('should reject invoice', async () => {
      invoiceStateMachine.INVOICE_STATES = { REJECTED: 'rejected' };
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['rejected']);
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'rejected',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.reject(invoiceId, tenantId, 'bad data', context, 1);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'rejected',
        tenantId,
        expect.objectContaining({ reason: 'bad data', expectedRevision: 1 })
      );
      expect(result.currentState).toBe('rejected');
    });

    it('should throw if reason is missing', async () => {
      await expect(invoiceStateService.reject(invoiceId, tenantId, '  ', context))
        .rejects.toThrow('Reason is required for rejection');
    });
  });

  describe('getHistory', () => {
    it('should return transition history', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'approved', revision: 2 });
      invoiceStateMachine.getTransitionHistory.mockResolvedValue([{ from: 'pending', to: 'approved' }]);

      const result = await invoiceStateService.getHistory(invoiceId, tenantId);

      expect(invoiceStateMachine.getTransitionHistory).toHaveBeenCalledWith(invoiceId, auditLog.getAuditLogs);
      expect(result.transitions.length).toBe(1);
    });

    it('should throw if invoice not found', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue(null);

      await expect(invoiceStateService.getHistory(invoiceId, tenantId))
        .rejects.toThrow('Invoice not found');
    });
  });

  describe('processBulkOperations', () => {
    const baseContext = {
      actor: context.actor,
      correlationId: 'corr-1',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { method: 'POST', path: '/api/invoices/bulk' },
    };

    beforeEach(() => {
      invoiceStateMachine.INVOICE_STATES = {
        PENDING: 'pending',
        APPROVED: 'approved',
        REJECTED: 'rejected',
        LINKED_ESCROW: 'linked_escrow',
      };
    });

    it('rejects an empty batch without touching the service layer', async () => {
      await expect(invoiceStateService.processBulkOperations([], tenantId, baseContext))
        .rejects.toMatchObject({ code: 'EMPTY_BATCH', statusCode: 400 });
      expect(invoiceService.transitionInvoice).not.toHaveBeenCalled();
    });

    it('rejects a batch over the size cap without touching the service layer', async () => {
      const items = Array.from({ length: invoiceStateService.MAX_BULK_ITEMS + 1 }, (_, i) => ({
        invoiceId: `inv-${i}`,
        action: 'approve',
      }));

      await expect(invoiceStateService.processBulkOperations(items, tenantId, baseContext))
        .rejects.toMatchObject({ code: 'BATCH_OVER_CAP', statusCode: 400 });
      expect(invoiceService.transitionInvoice).not.toHaveBeenCalled();
    });

    it('accepts a batch exactly at the size cap', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending', revision: 1 });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved']);
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });
      const items = Array.from({ length: invoiceStateService.MAX_BULK_ITEMS }, (_, i) => ({
        invoiceId: `inv-${i}`,
        action: 'approve',
        revision: 1,
      }));

      const { summary } = await invoiceStateService.processBulkOperations(items, tenantId, baseContext);
      expect(summary).toEqual({ total: invoiceStateService.MAX_BULK_ITEMS, succeeded: invoiceStateService.MAX_BULK_ITEMS, failed: 0 });
    });

    it('reports a per-item error without aborting the rest of the batch', async () => {
      const items = [{ action: 'approve' }, { invoiceId: 'inv-1', action: 'unknown-action' }];

      const { results, summary } = await invoiceStateService.processBulkOperations(items, tenantId, baseContext);

      expect(results[0]).toMatchObject({ index: 0, success: false, code: 'MISSING_INVOICE_ID' });
      expect(results[1]).toMatchObject({ index: 1, success: false, code: 'INVALID_ACTION' });
      expect(summary).toEqual({ total: 2, succeeded: 0, failed: 2 });
      expect(invoiceService.transitionInvoice).not.toHaveBeenCalled();
    });

    it('rejects an item missing action', async () => {
      const { results } = await invoiceStateService.processBulkOperations(
        [{ invoiceId: 'inv-1' }],
        tenantId,
        baseContext
      );
      expect(results[0]).toMatchObject({ success: false, code: 'MISSING_ACTION' });
    });

    it('rejects a transition item missing targetState', async () => {
      const { results } = await invoiceStateService.processBulkOperations(
        [{ invoiceId: 'inv-1', action: 'transition' }],
        tenantId,
        baseContext
      );
      expect(results[0]).toMatchObject({ success: false, code: 'MISSING_TARGET_STATE' });
    });

    it('dispatches each action to its corresponding service function with a per-item context', async () => {
      invoiceStateMachine.canLinkToEscrow.mockReturnValue({ canLink: true });
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'approved', revision: 2 });
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'approved',
        newState: 'linked_escrow',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const items = [{ invoiceId: 'inv-1', action: 'link-escrow', escrowId: 'escrow-9', reason: 'go', revision: 2 }];
      const { results } = await invoiceStateService.processBulkOperations(items, tenantId, baseContext);

      expect(results[0]).toMatchObject({ index: 0, success: true, action: 'link-escrow' });
      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        'inv-1',
        'linked_escrow',
        tenantId,
        expect.objectContaining({ escrowId: 'escrow-9', reason: 'go', expectedRevision: 2 })
      );
    });inv-1',
        'linked_escrow',
        tenantId,
        expect.objectContaining({ escrowId: 'escrow-9' })
      );

      // Per-item metadata (action/bulkIndex) merged in without mutating baseContext.
      expect(baseContext.metadata).toEqual({ method: 'POST', path: '/api/invoices/bulk' });
    });

    it('produces an accurate summary for a mixed batch of successes and failures', async () => {
      invoiceService.transitionInvoice.mockResolvedValueOnce({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const items = [
        { invoiceId: 'inv-1', action: 'approve' },
        { invoiceId: 'inv-2', action: 'bogus' },
        { action: 'approve' },
      ];

      const { results, summary } = await invoiceStateService.processBulkOperations(items, tenantId, baseContext);

      expect(summary).toEqual({ total: 3, succeeded: 1, failed: 2 });
      expect(results.map((r) => r.success)).toEqual([true, false, false]);
    });
  });
});
