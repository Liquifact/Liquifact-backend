'use strict';

const invoiceStateService = require('./invoiceStateService');
const invoiceService = require('./invoiceService');
const invoiceStateMachine = require('./invoiceStateMachine');
const auditLog = require('./auditLog');

jest.mock('./invoiceService');
jest.mock('./invoiceStateMachine');
jest.mock('./auditLog');

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
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending' });
      invoiceStateMachine.getAllowedTransitions.mockReturnValue(['approved', 'rejected']);

      const result = await invoiceStateService.getState(invoiceId, tenantId);

      expect(invoiceService.resolveInvoiceForTenant).toHaveBeenCalledWith(invoiceId, tenantId);
      expect(invoiceStateMachine.getAllowedTransitions).toHaveBeenCalledWith('pending');
      expect(result).toEqual({
        invoiceId,
        currentState: 'pending',
        allowedTransitions: ['approved', 'rejected'],
        isTerminal: false,
      });
    });

    it('should mark terminal states correctly', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'rejected' });
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
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.transition(invoiceId, tenantId, 'approved', 'looks good', context);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'approved',
        tenantId,
        {
          actor: context.actor,
          reason: 'looks good',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: context.metadata,
        }
      );
      expect(result.auditLogId).toBe('audit-1');
      expect(result.previousState).toBe('pending');
    });

    it('should throw if target state is missing', async () => {
      await expect(invoiceStateService.transition(invoiceId, tenantId, null, 'reason', context))
        .rejects.toThrow('Target state is required');
    });
  });

  describe('approve', () => {
    it('should approve invoice', async () => {
      invoiceStateMachine.INVOICE_STATES = { APPROVED: 'approved' };
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'approved',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.approve(invoiceId, tenantId, null, context);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'approved',
        tenantId,
        expect.objectContaining({ reason: 'Invoice approved' })
      );
      expect(result.currentState).toBe('approved');
    });
  });

  describe('linkEscrow', () => {
    it('should link invoice to escrow', async () => {
      invoiceStateMachine.INVOICE_STATES = { LINKED_ESCROW: 'linked_escrow' };
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'approved' });
      invoiceStateMachine.canLinkToEscrow.mockReturnValue({ canLink: true });
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'approved',
        newState: 'linked_escrow',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.linkEscrow(invoiceId, tenantId, 'escrow-999', 'reason', context);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'linked_escrow',
        tenantId,
        expect.objectContaining({ escrowId: 'escrow-999' })
      );
      expect(result.escrowId).toBe('escrow-999');
    });

    it('should throw if cannot link to escrow', async () => {
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'pending' });
      invoiceStateMachine.canLinkToEscrow.mockReturnValue({ canLink: false, reason: 'Must be approved' });

      await expect(invoiceStateService.linkEscrow(invoiceId, tenantId, 'escrow-999', 'reason', context))
        .rejects.toThrow('Must be approved');
    });
  });

  describe('reject', () => {
    it('should reject invoice', async () => {
      invoiceStateMachine.INVOICE_STATES = { REJECTED: 'rejected' };
      invoiceService.transitionInvoice.mockResolvedValue({
        previousState: 'pending',
        newState: 'rejected',
        transitionedAt: '2023-01-01T00:00:00Z',
        transitionedBy: 'user-789',
        auditLog: { id: 'audit-1' },
      });

      const result = await invoiceStateService.reject(invoiceId, tenantId, 'bad data', context);

      expect(invoiceService.transitionInvoice).toHaveBeenCalledWith(
        invoiceId,
        'rejected',
        tenantId,
        expect.objectContaining({ reason: 'bad data' })
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
      invoiceService.resolveInvoiceForTenant.mockResolvedValue({ status: 'approved' });
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
});
