'use strict';

const {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  InMemoryInvoiceFundingSource,
  REPORT_STATUS,
  VIOLATION_CODES,
  evaluateInvoiceFundingInvariants,
  amountText,
  normalizeOptions,
  parseAmount,
  runInvoiceFundingReconciliation,
} = require('../src/jobs/invoiceFundingReconciliation');

function invoice(overrides = {}) {
  return {
    id: 'inv-1', amount: '100.00', fundedAmount: '100.00', currency: 'USD', status: 'funded',
    fundingRecords: [{ id: 'fund-1', amount: '60.00', currency: 'USD' }, { id: 'fund-2', amount: '40.00', currency: 'USD' }],
    ...overrides,
  };
}

describe('fixed-point amount helpers', () => {
  it.each([
    ['0', '0'], ['1', '1'], ['1.2', '1.2'], ['1.000000001', '1.000000001'],
  ])('parses and formats %s exactly', (value, expected) => expect(amountText(parseAmount(value, 'amount'))).toBe(expected));

  it('rejects floating notation and negative inputs', () => {
    for (const value of ['-1', '+1', '1e2', '.5', '1.1234567890']) {
      expect(() => parseAmount(value, 'amount')).toThrow();
    }
  });
});

describe('invoice funding invariants', () => {
  it('reports no violations for a consistent fully funded invoice', () => {
    expect(evaluateInvoiceFundingInvariants(invoice())).toEqual([]);
  });

  it('reports a funding sum imbalance with both amounts', () => {
    const result = evaluateInvoiceFundingInvariants(invoice({ fundedAmount: '99.00' }));
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({
      code: VIOLATION_CODES.FUNDING_SUM_MISMATCH,
      details: { recordSum: '100', fundedAmount: '99' },
    })]));
  });

  it('reports overfunding independently from sum mismatch', () => {
    const result = evaluateInvoiceFundingInvariants(invoice({ fundedAmount: '110.00' }));
    expect(result.map((item) => item.code)).toEqual(expect.arrayContaining([
      VIOLATION_CODES.OVERFUNDED,
      VIOLATION_CODES.FUNDING_SUM_MISMATCH,
    ]));
  });

  it('reports an inconsistent partially funded status', () => {
    const result = evaluateInvoiceFundingInvariants(invoice({ status: 'partially_funded' }));
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ code: VIOLATION_CODES.FUNDING_STATUS_MISMATCH })]));
  });

  it('reports an inconsistent pre-funding status', () => {
    const result = evaluateInvoiceFundingInvariants(invoice({ status: 'verified', fundedAmount: '0', fundingRecords: [] }));
    expect(result).toEqual([]);
    expect(evaluateInvoiceFundingInvariants(invoice({ status: 'verified', fundedAmount: '1.00', fundingRecords: [{ id: 'f', amount: '1.00' }] }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: VIOLATION_CODES.FUNDING_STATUS_MISMATCH }),
    ]));
  });

  it('reports duplicate record ids', () => {
    const result = evaluateInvoiceFundingInvariants(invoice({ fundingRecords: [
      { id: 'same', amount: '50.00' }, { id: 'same', amount: '50.00' },
    ] }));
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ code: VIOLATION_CODES.DUPLICATE_FUNDING_RECORD })]));
  });

  it('reports currency drift', () => {
    const result = evaluateInvoiceFundingInvariants(invoice({ fundingRecords: [
      { id: 'f-1', amount: '100.00', currency: 'EUR' },
    ] }));
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ code: VIOLATION_CODES.CURRENCY_MISMATCH })]));
  });

  it('reports invalid records and invalid invoice ids without throwing', () => {
    expect(evaluateInvoiceFundingInvariants({ id: 'bad', amount: 'NaN', fundedAmount: '0' })[0].code).toBe(VIOLATION_CODES.INVALID_AMOUNT);
    expect(evaluateInvoiceFundingInvariants({ amount: '1', fundedAmount: '0' })[0].code).toBe(VIOLATION_CODES.INVALID_INVOICE);
    expect(evaluateInvoiceFundingInvariants(invoice({ fundingRecords: [{ id: '', amount: '1' }] }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: VIOLATION_CODES.INVALID_FUNDING_RECORD }),
    ]));
  });
});

describe('bounded reconciliation job', () => {
  it('returns a clean deterministic report for consistent data', async () => {
    const source = new InMemoryInvoiceFundingSource([invoice(), invoice({ id: 'inv-2' })]);
    const report = await runInvoiceFundingReconciliation({ source, runId: 'run-1', pageSize: 1 });
    expect(report).toMatchObject({ runId: 'run-1', status: REPORT_STATUS.CLEAN, scanned: 2, batches: 2, complete: true, violationCount: 0, offendingIds: [] });
    expect(source.reads).toEqual([{ cursor: null, limit: 1 }, { cursor: '1', limit: 1 }]);
  });

  it('collects offending ids and reason counts without mutating input', async () => {
    const source = new InMemoryInvoiceFundingSource([
      invoice({ id: 'z-invoice', fundedAmount: '99.00' }),
      invoice({ id: 'a-invoice', status: 'partially_funded' }),
    ]);
    const before = JSON.stringify(source.invoices);
    const report = await runInvoiceFundingReconciliation({ source, runId: 'run-2' });
    expect(report.status).toBe(REPORT_STATUS.DRIFT);
    expect(report.offendingIds).toEqual(['a-invoice', 'z-invoice']);
    expect(report.counts[VIOLATION_CODES.FUNDING_SUM_MISMATCH]).toBe(1);
    expect(report.counts[VIOLATION_CODES.FUNDING_STATUS_MISMATCH]).toBe(2);
    expect(JSON.stringify(source.invoices)).toBe(before);
  });

  it('is bounded by page size and max records', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => invoice({ id: `inv-${String(index).padStart(2, '0')}` }));
    const source = new InMemoryInvoiceFundingSource(rows);
    const report = await runInvoiceFundingReconciliation({ source, pageSize: 3, maxRecords: 7 });
    expect(report).toMatchObject({ scanned: 7, batches: 3, complete: false, nextCursor: '7', status: REPORT_STATUS.INCOMPLETE });
    expect(source.reads).toEqual([
      { cursor: null, limit: 3 }, { cursor: '3', limit: 3 }, { cursor: '6', limit: 1 },
    ]);
  });

  it('sorts violations regardless of source order', async () => {
    const source = new InMemoryInvoiceFundingSource([
      invoice({ id: 'invoice-b', fundedAmount: '98' }),
      invoice({ id: 'invoice-a', fundedAmount: '97' }),
    ]);
    const report = await runInvoiceFundingReconciliation({ source });
    expect(report.violations.map((item) => item.invoiceId)).toEqual(['invoice-a', 'invoice-a', 'invoice-b', 'invoice-b']);
    expect(report.violations.map((item) => item.code)).toEqual([
      VIOLATION_CODES.FUNDING_STATUS_MISMATCH, VIOLATION_CODES.FUNDING_SUM_MISMATCH,
      VIOLATION_CODES.FUNDING_STATUS_MISMATCH, VIOLATION_CODES.FUNDING_SUM_MISMATCH,
    ]);
  });

  it('converts source failures to a stable typed error', async () => {
    const source = { readBatch: jest.fn().mockRejectedValue(new Error('database credentials')) };
    await expect(runInvoiceFundingReconciliation({ source })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('rejects invalid options and malformed oversized batches', async () => {
    expect(() => normalizeOptions({ pageSize: 0 })).toThrow();
    expect(() => normalizeOptions({ pageSize: MAX_PAGE_SIZE + 1 })).toThrow();
    expect(() => normalizeOptions({ maxRecords: 0 })).toThrow();
    const source = { readBatch: jest.fn().mockResolvedValue({ records: [invoice(), invoice()], nextCursor: null }) };
    await expect(runInvoiceFundingReconciliation({ source, pageSize: 1 })).rejects.toMatchObject({ code: 'INVALID_SOURCE_BATCH' });
  });

  it('uses safe defaults for a simple source', async () => {
    const source = new InMemoryInvoiceFundingSource([invoice()]);
    const report = await runInvoiceFundingReconciliation({ source });
    expect(report).toMatchObject({ scanned: 1, complete: true });
    expect(source.reads[0].limit).toBe(DEFAULT_PAGE_SIZE);
  });
});
