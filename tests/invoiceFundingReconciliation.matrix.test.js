'use strict';

/**
 * Table-driven invariant matrix. Keeping lifecycle combinations here makes
 * the financial state contract easy to review when a new invoice status is
 * introduced.
 */

const {
  REPORT_STATUS,
  VIOLATION_CODES,
  InMemoryInvoiceFundingSource,
  evaluateInvoiceFundingInvariants,
  runInvoiceFundingReconciliation,
} = require('../src/jobs/invoiceFundingReconciliation');

function makeInvoice(overrides = {}) {
  return {
    id: 'matrix-invoice',
    amount: '100.00',
    fundedAmount: '0.00',
    currency: 'USD',
    status: 'verified',
    fundingRecords: [],
    ...overrides,
  };
}

describe('lifecycle status matrix', () => {
  it.each([
    ['pending_verification', '0', [], false],
    ['verified', '0', [], false],
    ['partially_funded', '25', [{ id: 'p', amount: '25' }], false],
    ['funded', '100', [{ id: 'f', amount: '100' }], false],
    ['completed', '100', [{ id: 'c', amount: '100' }], false],
  ])('accepts consistent %s state', (status, fundedAmount, fundingRecords, invalid) => {
    const result = evaluateInvoiceFundingInvariants(makeInvoice({ status, fundedAmount, fundingRecords }));
    expect(result.length > 0).toBe(invalid);
  });

  it.each([
    ['pending_verification', '1', [{ id: 'a', amount: '1' }]],
    ['verified', '1', [{ id: 'b', amount: '1' }]],
    ['partially_funded', '0', []],
    ['partially_funded', '100', [{ id: 'd', amount: '100' }]],
    ['funded', '99.99', [{ id: 'e', amount: '99.99' }]],
    ['completed', '0', []],
  ])('rejects inconsistent %s with funded amount %s', (status, fundedAmount, fundingRecords) => {
    expect(evaluateInvoiceFundingInvariants(makeInvoice({ status, fundedAmount, fundingRecords }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: VIOLATION_CODES.FUNDING_STATUS_MISMATCH }),
    ]));
  });
});

describe('funding-record matrix', () => {
  it.each([
    [{ id: 'one', amount: '1.000000001' }, { id: 'two', amount: '98.999999999' }],
    [{ id: 'one', amount: '0.01' }, { id: 'two', amount: '99.99' }],
    [{ id: 'one', amount: '50' }, { id: 'two', amount: '50' }],
  ])('accepts exact record sums', (first, second) => {
    expect(evaluateInvoiceFundingInvariants(makeInvoice({
      status: 'funded', fundedAmount: '100', fundingRecords: [first, second],
    }))).toEqual([]);
  });

  it('detects a one-nanounit sum difference', () => {
    const result = evaluateInvoiceFundingInvariants(makeInvoice({
      status: 'partially_funded', fundedAmount: '1.000000001', fundingRecords: [{ id: 'nano', amount: '1' }],
    }));
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ code: VIOLATION_CODES.FUNDING_SUM_MISMATCH })]));
  });

  it.each([
    ['missing id', { amount: '1' }],
    ['empty id', { id: '', amount: '1' }],
    ['missing amount', { id: 'missing-amount' }],
    ['negative amount', { id: 'negative', amount: '-1' }],
    ['exponent amount', { id: 'exponent', amount: '1e2' }],
    ['over-precision amount', { id: 'precision', amount: '1.1234567890' }],
  ])('reports %s funding record as invalid', (_label, record) => {
    expect(evaluateInvoiceFundingInvariants(makeInvoice({
      status: 'partially_funded', fundedAmount: '1', fundingRecords: [record],
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: VIOLATION_CODES.INVALID_FUNDING_RECORD }),
    ]));
  });

  it('reports every repeated id rather than deduplicating silently', () => {
    const result = evaluateInvoiceFundingInvariants(makeInvoice({
      status: 'funded', fundedAmount: '100', fundingRecords: [
        { id: 'duplicate', amount: '25' }, { id: 'duplicate', amount: '25' },
        { id: 'duplicate', amount: '50' },
      ],
    }));
    expect(result.filter((item) => item.code === VIOLATION_CODES.DUPLICATE_FUNDING_RECORD)).toHaveLength(2);
  });

  it('does not report currency drift when currencies are intentionally omitted', () => {
    expect(evaluateInvoiceFundingInvariants(makeInvoice({
      status: 'funded', fundedAmount: '100', fundingRecords: [{ id: 'legacy', amount: '100' }],
    }))).toEqual([]);
  });
});

describe('report stability and bounds', () => {
  it('uses stable reason ordering and stable offending-id ordering', async () => {
    const records = [
      makeInvoice({ id: 'z', status: 'funded', fundedAmount: '98', fundingRecords: [{ id: 'z-f', amount: '98' }] }),
      makeInvoice({ id: 'a', status: 'funded', fundedAmount: '97', fundingRecords: [{ id: 'a-f', amount: '97' }] }),
    ];
    const first = await runInvoiceFundingReconciliation({ source: new InMemoryInvoiceFundingSource(records), runId: 'stable' });
    const second = await runInvoiceFundingReconciliation({ source: new InMemoryInvoiceFundingSource(records.slice().reverse()), runId: 'stable' });
    expect(first.offendingIds).toEqual(['a', 'z']);
    expect(first.violations.map((item) => `${item.invoiceId}:${item.code}`)).toEqual(second.violations.map((item) => `${item.invoiceId}:${item.code}`));
    expect(first.counts).toEqual(second.counts);
  });

  it('returns clean when an empty snapshot is scanned', async () => {
    const report = await runInvoiceFundingReconciliation({ source: new InMemoryInvoiceFundingSource([]), runId: 'empty' });
    expect(report).toMatchObject({ status: REPORT_STATUS.CLEAN, scanned: 0, batches: 1, complete: true, violationCount: 0 });
  });

  it('does not request a page larger than the remaining max-record budget', async () => {
    const source = new InMemoryInvoiceFundingSource(Array.from({ length: 10 }, (_, i) => makeInvoice({ id: `i-${i}` })));
    await runInvoiceFundingReconciliation({ source, pageSize: 100, maxRecords: 2 });
    expect(source.reads[0].limit).toBe(2);
  });

  it('retains the cursor for a caller-controlled continuation', async () => {
    const source = new InMemoryInvoiceFundingSource(Array.from({ length: 5 }, (_, i) => makeInvoice({ id: `i-${i}` })));
    const report = await runInvoiceFundingReconciliation({ source, pageSize: 2, maxRecords: 2 });
    expect(report).toMatchObject({ status: REPORT_STATUS.INCOMPLETE, complete: false, nextCursor: '2' });
  });
});
