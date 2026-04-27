/**
 * @fileoverview Funding close snapshot DTO tests.
 *
 * Covers:
 *  - fetchFundingCloseSnapshot returns proper DTO when snapshot exists (Some)
 *  - fetchFundingCloseSnapshot returns null when snapshot doesn't exist (None)
 *  - readEscrowStateWithSnapshot includes funding snapshot in response
 *  - error handling: RPC failures, invalid response formats
 *  - input validation for invoiceId
 *  - proper camelCase mapping from snake_case on-chain fields
 *
 * All on-chain calls are stubbed via adapter injection.
 */

'use strict';

process.env.NODE_ENV = 'test';

// Mock the logger to avoid dependency issues
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const {
  fetchFundingCloseSnapshot,
  readEscrowStateWithSnapshot,
  validateInvoiceId
} = require('../src/services/escrowRead');

// ── unit: escrowRead funding close snapshot service ──────────────────────────────

describe('escrowRead funding close snapshot service', () => {
  describe('fetchFundingCloseSnapshot', () => {
    it('returns proper DTO when snapshot exists (Some case)', async () => {
      const mockAdapter = jest.fn().mockResolvedValue({
        Some: {
          total_principal: '1000000000',
          funding_target: '2000000000',
          closed_at_ledger: 123456,
          closed_at_seq: 789
        }
      });

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toEqual({
        totalPrincipal: '1000000000',
        fundingTarget: '2000000000',
        closedAtLedger: 123456,
        closedAtSeq: 789
      });
      expect(mockAdapter).toHaveBeenCalledWith('inv_123');
    });

    it('returns null when snapshot does not exist (None case)', async () => {
      const mockAdapter = jest.fn().mockResolvedValue('None');

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toBeNull();
    });

    it('returns null when result is null', async () => {
      const mockAdapter = jest.fn().mockResolvedValue(null);

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toBeNull();
    });

    it('returns null when result is undefined', async () => {
      const mockAdapter = jest.fn().mockResolvedValue(undefined);

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toBeNull();
    });

    it('handles raw object response format', async () => {
      const mockAdapter = jest.fn().mockResolvedValue({
        total_principal: '500000000',
        funding_target: '1000000000',
        closed_at_ledger: 654321,
        closed_at_seq: 123
      });

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toEqual({
        totalPrincipal: '500000000',
        fundingTarget: '1000000000',
        closedAtLedger: 654321,
        closedAtSeq: 123
      });
    });

    it('returns null and logs warning for unexpected response format', async () => {
      const mockAdapter = jest.fn().mockResolvedValue({ invalid: 'format' });
      const logger = require('../src/logger');

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        { invoiceId: 'inv_123', result: { invalid: 'format' } },
        'escrowRead: get_funding_close_snapshot returned unexpected format'
      );
    });

    it('returns null and logs warning on RPC failure', async () => {
      const mockAdapter = jest.fn().mockRejectedValue(new Error('RPC timeout'));
      const logger = require('../src/logger');

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        { invoiceId: 'inv_123', errCode: undefined },
        'escrowRead: get_funding_close_snapshot call failed — returning null'
      );
    });

    it('preserves numeric precision for large values', async () => {
      const largePrincipal = '1000000000000000000';
      const largeTarget = '2000000000000000000';
      
      const mockAdapter = jest.fn().mockResolvedValue({
        Some: {
          total_principal: largePrincipal,
          funding_target: largeTarget,
          closed_at_ledger: 123456,
          closed_at_seq: 789
        }
      });

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result.totalPrincipal).toBe(largePrincipal);
      expect(result.fundingTarget).toBe(largeTarget);
      expect(typeof result.totalPrincipal).toBe('string');
      expect(typeof result.fundingTarget).toBe('string');
    });
  });

  describe('readEscrowStateWithSnapshot', () => {
    it('includes funding snapshot in enriched escrow state', async () => {
      const mockSnapshotAdapter = jest.fn().mockResolvedValue({
        Some: {
          total_principal: '1000000000',
          funding_target: '2000000000',
          closed_at_ledger: 123456,
          closed_at_seq: 789
        }
      });

      const mockEscrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1500000000
      });

      const mockLegalHoldAdapter = jest.fn().mockResolvedValue(false);
      const mockAttestationAdapter = jest.fn().mockResolvedValue([]);

      const result = await readEscrowStateWithSnapshot('inv_123', {
        snapshotAdapter: mockSnapshotAdapter,
        escrowAdapter: mockEscrowAdapter,
        legalHoldAdapter: mockLegalHoldAdapter,
        attestationAdapter: mockAttestationAdapter
      });

      expect(result).toEqual({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1500000000,
        legal_hold: false,
        attestations: [],
        fundingCloseSnapshot: {
          totalPrincipal: '1000000000',
          fundingTarget: '2000000000',
          closedAtLedger: 123456,
          closedAtSeq: 789
        }
      });
    });

    it('includes null snapshot when snapshot does not exist', async () => {
      const mockSnapshotAdapter = jest.fn().mockResolvedValue(null);
      const mockEscrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1500000000
      });

      const mockLegalHoldAdapter = jest.fn().mockResolvedValue(false);
      const mockAttestationAdapter = jest.fn().mockResolvedValue([]);

      const result = await readEscrowStateWithSnapshot('inv_123', {
        snapshotAdapter: mockSnapshotAdapter,
        escrowAdapter: mockEscrowAdapter,
        legalHoldAdapter: mockLegalHoldAdapter,
        attestationAdapter: mockAttestationAdapter
      });

      expect(result).toEqual({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1500000000,
        legal_hold: false,
        attestations: [],
        fundingCloseSnapshot: null
      });
    });

    it('throws validation error for invalid invoiceId', async () => {
      await expect(readEscrowStateWithSnapshot('')).rejects.toMatchObject({
        code: 'INVALID_INVOICE_ID',
        status: 400
      });

      await expect(readEscrowStateWithSnapshot('inv@123')).rejects.toMatchObject({
        code: 'INVALID_INVOICE_ID',
        status: 400
      });
    });
  });

  describe('validateInvoiceId', () => {
    it('validates correct invoice IDs', () => {
      expect(validateInvoiceId('inv_123')).toEqual({ valid: true });
      expect(validateInvoiceId('INV-456')).toEqual({ valid: true });
      expect(validateInvoiceId('invoice-789')).toEqual({ valid: true });
    });

    it('rejects invalid invoice IDs', () => {
      expect(validateInvoiceId('')).toEqual({
        valid: false,
        reason: 'invoiceId must be a non-empty string'
      });

      expect(validateInvoiceId('inv@123')).toEqual({
        valid: false,
        reason: 'invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ -)'
      });

      expect(validateInvoiceId(123)).toEqual({
        valid: false,
        reason: 'invoiceId must be a non-empty string'
      });
    });
  });

  describe('edge cases', () => {
    it('handles very large numeric values without mutation', async () => {
      const hugePrincipal = '1000000000000000000000000';
      const hugeTarget = '2000000000000000000000000';
      
      const mockAdapter = jest.fn().mockResolvedValue({
        Some: {
          total_principal: hugePrincipal,
          funding_target: hugeTarget,
          closed_at_ledger: 123456,
          closed_at_seq: 789
        }
      });

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result.totalPrincipal).toBe(hugePrincipal);
      expect(result.fundingTarget).toBe(hugeTarget);
      // Ensure no numeric conversion occurred
      expect(result.totalPrincipal).not.toBe(1e24);
      expect(result.fundingTarget).not.toBe(2e24);
    });

    it('handles mixed string/number values from contract', async () => {
      const mockAdapter = jest.fn().mockResolvedValue({
        Some: {
          total_principal: '1000000000', // string
          funding_target: 2000000000,   // number
          closed_at_ledger: 123456,     // number
          closed_at_seq: '789'          // string
        }
      });

      const result = await fetchFundingCloseSnapshot('inv_123', mockAdapter);

      expect(result).toEqual({
        totalPrincipal: '1000000000',
        fundingTarget: 2000000000,
        closedAtLedger: 123456,
        closedAtSeq: '789'
      });
    });
  });
});