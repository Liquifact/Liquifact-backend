'use strict';

/**
 * Unit tests for src/services/metricsService.js
 */

const metricsService = require('../../src/services/metricsService');
const invoiceService = require('../../src/services/invoiceService');
const { CursorError } = require('../../src/utils/cursorPagination');

jest.mock('../../src/services/invoiceService');

describe('metricsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSmeMetrics', () => {
    test('throws TypeError when tenantId is missing', async () => {
      await expect(metricsService.getSmeMetrics('', 'user-1')).rejects.toThrow(TypeError);
      await expect(metricsService.getSmeMetrics(null, 'user-1')).rejects.toThrow(TypeError);
      await expect(metricsService.getSmeMetrics(undefined, 'user-1')).rejects.toThrow(TypeError);
    });

    test('throws TypeError when userId is missing', async () => {
      await expect(metricsService.getSmeMetrics('tenant-1', '')).rejects.toThrow(TypeError);
      await expect(metricsService.getSmeMetrics('tenant-1', null)).rejects.toThrow(TypeError);
      await expect(metricsService.getSmeMetrics('tenant-1', undefined)).rejects.toThrow(TypeError);
    });

    test('returns aggregated counts without pagination when neither cursor nor limit is supplied', async () => {
      const mockCounts = { open: 2, funded: 1, settled: 3, defaulted: 0 };
      invoiceService.getSmeInvoiceCounts.mockResolvedValueOnce(mockCounts);

      const result = await metricsService.getSmeMetrics('tenant-1', 'user-1');

      expect(invoiceService.getSmeInvoiceCounts).toHaveBeenCalledWith('tenant-1', 'user-1');
      expect(invoiceService.getSmeInvoiceList).not.toHaveBeenCalled();
      expect(result.data).toEqual(mockCounts);
      expect(result.meta.timestamp).toBeDefined();
      expect(result.meta.version).toBe('0.1.0');
      expect(result.meta.invoices).toBeUndefined();
    });

    test('returns aggregated counts and paginated invoice list when limit is supplied', async () => {
      const mockCounts = { open: 1, funded: 0, settled: 0, defaulted: 0 };
      const mockListResult = {
        invoices: [{ invoice_id: 'inv-1', status: 'verified' }],
        meta: {
          total: 1,
          limit: 10,
          hasMore: false,
          nextCursor: null,
        },
      };

      invoiceService.getSmeInvoiceCounts.mockResolvedValueOnce(mockCounts);
      invoiceService.getSmeInvoiceList.mockResolvedValueOnce(mockListResult);

      const result = await metricsService.getSmeMetrics('tenant-1', 'user-1', { limit: 10 });

      expect(invoiceService.getSmeInvoiceCounts).toHaveBeenCalledWith('tenant-1', 'user-1');
      expect(invoiceService.getSmeInvoiceList).toHaveBeenCalledWith('tenant-1', 'user-1', { cursor: undefined, limit: 10 });
      expect(result.data).toEqual(mockCounts);
      expect(result.meta.invoices).toEqual(mockListResult.invoices);
      expect(result.meta.total).toBe(1);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
      expect(result.meta.version).toBe('0.1.0');
    });

    test('returns aggregated counts and paginated invoice list when cursor is supplied', async () => {
      const mockCounts = { open: 2, funded: 0, settled: 0, defaulted: 0 };
      const mockListResult = {
        invoices: [{ invoice_id: 'inv-2', status: 'verified' }],
        meta: {
          total: 2,
          limit: 1,
          hasMore: true,
          nextCursor: 'valid-cursor',
        },
      };

      invoiceService.getSmeInvoiceCounts.mockResolvedValueOnce(mockCounts);
      invoiceService.getSmeInvoiceList.mockResolvedValueOnce(mockListResult);

      const result = await metricsService.getSmeMetrics('tenant-1', 'user-1', { cursor: 'some-cursor', limit: 1 });

      expect(invoiceService.getSmeInvoiceList).toHaveBeenCalledWith('tenant-1', 'user-1', { cursor: 'some-cursor', limit: 1 });
      expect(result.meta.nextCursor).toBe('valid-cursor');
      expect(result.meta.hasMore).toBe(true);
    });

    test('propagates CursorError from invoiceService.getSmeInvoiceList', async () => {
      invoiceService.getSmeInvoiceCounts.mockResolvedValueOnce({ open: 1, funded: 0, settled: 0, defaulted: 0 });
      invoiceService.getSmeInvoiceList.mockRejectedValueOnce(new CursorError('Invalid cursor signature'));

      await expect(
        metricsService.getSmeMetrics('tenant-1', 'user-1', { cursor: 'tampered' })
      ).rejects.toThrow(CursorError);
    });

    test('propagates unexpected errors from invoiceService', async () => {
      invoiceService.getSmeInvoiceCounts.mockRejectedValueOnce(new Error('DB failure'));

      await expect(
        metricsService.getSmeMetrics('tenant-1', 'user-1')
      ).rejects.toThrow('DB failure');
    });
  });
});
