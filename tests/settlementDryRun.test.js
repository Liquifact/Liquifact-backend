'use strict';

const {
  DRY_RUN_MODE,
  DEFAULT_MAX_PROPOSALS,
  MAX_MAX_PROPOSALS,
  REPORT_STATUS,
  SettlementDryRunError,
  deriveSettlementItem,
  normalizeSettlementOptions,
  runSettlementDryRun,
} = require('../src/jobs/settlementDryRun');
const {
  VIOLATION_CODES,
  InMemoryInvoiceFundingSource,
} = require('../src/jobs/invoiceFundingReconciliation');

function invoice(overrides = {}) {
  return {
    id: 'inv-1', amount: '100.00', fundedAmount: '100.00', currency: 'USD', status: 'funded',
    fundingRecords: [{ id: 'fund-1', amount: '60.00', currency: 'USD' }, { id: 'fund-2', amount: '40.00', currency: 'USD' }],
    ...overrides,
  };
}

describe('normalizeSettlementOptions', () => {
  it('accepts the literal dry-run mode with default maxProposals', () => {
    expect(normalizeSettlementOptions({ mode: DRY_RUN_MODE })).toEqual({ mode: 'dry-run', maxProposals: DEFAULT_MAX_PROPOSALS });
  });

  it.each([undefined, null, '', 'apply', 'Dry-Run', 'DRY_RUN', 'dryrun', 0, false, {}])(
    'rejects malformed mode value %p',
    (mode) => {
      expect(() => normalizeSettlementOptions({ mode })).toThrow(SettlementDryRunError);
      try {
        normalizeSettlementOptions({ mode });
      } catch (error) {
        expect(error.code).toBe('INVALID_MODE');
      }
    },
  );

  it('rejects out-of-range maxProposals', () => {
    expect(() => normalizeSettlementOptions({ mode: DRY_RUN_MODE, maxProposals: 0 })).toThrow(SettlementDryRunError);
    expect(() => normalizeSettlementOptions({ mode: DRY_RUN_MODE, maxProposals: MAX_MAX_PROPOSALS + 1 })).toThrow(SettlementDryRunError);
    expect(() => normalizeSettlementOptions({ mode: DRY_RUN_MODE, maxProposals: 1.5 })).toThrow(SettlementDryRunError);
  });
});

describe('deriveSettlementItem', () => {
  it('proposes a fundedAmount correction for a funding sum mismatch', () => {
    const item = deriveSettlementItem({
      invoiceId: 'inv-1',
      code: VIOLATION_CODES.FUNDING_SUM_MISMATCH,
      message: 'Funding records do not sum to fundedAmount',
      details: { recordSum: '100', fundedAmount: '99' },
    });
    expect(item).toEqual({
      invoiceId: 'inv-1',
      code: VIOLATION_CODES.FUNDING_SUM_MISMATCH,
      kind: 'proposed_change',
      field: 'fundedAmount',
      fromValue: '99',
      toValue: '100',
      reason: expect.stringContaining('funding-record ledger'),
    });
  });

  it.each([
    VIOLATION_CODES.OVERFUNDED,
    VIOLATION_CODES.FUNDING_STATUS_MISMATCH,
    VIOLATION_CODES.DUPLICATE_FUNDING_RECORD,
    VIOLATION_CODES.CURRENCY_MISMATCH,
    VIOLATION_CODES.INVALID_FUNDING_RECORD,
    VIOLATION_CODES.INVALID_AMOUNT,
    VIOLATION_CODES.INVALID_INVOICE,
  ])('routes %s to manual review without proposing a value', (code) => {
    const item = deriveSettlementItem({ invoiceId: 'inv-1', code, message: 'some message', details: { a: 1 } });
    expect(item).toEqual({
      invoiceId: 'inv-1', code, kind: 'manual_review', reason: 'some message', details: { a: 1 },
    });
    expect(item).not.toHaveProperty('fromValue');
    expect(item).not.toHaveProperty('toValue');
  });
});

describe('runSettlementDryRun — mode enforcement', () => {
  it('rejects a missing mode before scanning the source', async () => {
    const source = { readBatch: jest.fn() };
    await expect(runSettlementDryRun({ source })).rejects.toMatchObject({ code: 'INVALID_MODE' });
    expect(source.readBatch).not.toHaveBeenCalled();
  });

  it('rejects mode: "apply" before scanning the source (no apply path exists)', async () => {
    const source = { readBatch: jest.fn() };
    await expect(runSettlementDryRun({ source, mode: 'apply' })).rejects.toMatchObject({ code: 'INVALID_MODE' });
    expect(source.readBatch).not.toHaveBeenCalled();
  });

  it('never calls any method on source other than readBatch', async () => {
    const source = new InMemoryInvoiceFundingSource([invoice()]);
    const writeSpy = jest.fn();
    source.write = writeSpy;
    source.delete = writeSpy;
    await runSettlementDryRun({ source, mode: DRY_RUN_MODE });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('runSettlementDryRun — edge cases', () => {
  it('dry run with no differences: clean report, empty proposals', async () => {
    const source = new InMemoryInvoiceFundingSource([invoice(), invoice({ id: 'inv-2' })]);
    const report = await runSettlementDryRun({ source, mode: DRY_RUN_MODE, runId: 'run-clean' });
    expect(report).toMatchObject({
      runId: 'run-clean',
      mode: DRY_RUN_MODE,
      status: REPORT_STATUS.CLEAN,
      scanned: 2,
      proposedChangeCount: 0,
      manualReviewCount: 0,
      truncated: false,
      omittedCount: 0,
      proposedChanges: [],
      manualReview: [],
    });
  });

  it('dry run with many differences: classifies each violation and stays bounded', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => invoice({
      id: `inv-${String(index).padStart(2, '0')}`,
      fundedAmount: '50.00', // funding sum mismatch against 100.00 total on every row
    }));
    const source = new InMemoryInvoiceFundingSource(rows);
    const report = await runSettlementDryRun({ source, mode: DRY_RUN_MODE, maxProposals: 25 });

    expect(report.status).toBe(REPORT_STATUS.DRIFT);
    // Each row produces 2 violations (sum mismatch + status mismatch) = 60 total, capped at 25.
    expect(report.proposedChangeCount + report.manualReviewCount).toBe(25);
    expect(report.truncated).toBe(true);
    expect(report.omittedCount).toBe(60 - 25);
    expect(report.proposedChanges.every((item) => item.code === VIOLATION_CODES.FUNDING_SUM_MISMATCH)).toBe(true);
    expect(report.manualReview.every((item) => item.code === VIOLATION_CODES.FUNDING_STATUS_MISMATCH)).toBe(true);
  });

  it('dry run repeated: identical output and no mutation of the source snapshot', async () => {
    const source = new InMemoryInvoiceFundingSource([
      invoice({ id: 'inv-b', fundedAmount: '98.00' }),
      invoice({ id: 'inv-a', fundedAmount: '97.00' }),
    ]);
    const before = JSON.stringify(source.invoices);

    const first = await runSettlementDryRun({ source, mode: DRY_RUN_MODE, runId: 'repeat' });
    const second = await runSettlementDryRun({ source, mode: DRY_RUN_MODE, runId: 'repeat' });

    // startedAt/completedAt are wall-clock timestamps and legitimately differ
    // between calls; every other field must be byte-for-byte identical.
    const strip = ({ startedAt, completedAt, ...rest }) => rest;
    expect(strip(first)).toEqual(strip(second));
    expect(JSON.stringify(source.invoices)).toBe(before);
  });

  it('propagates the underlying job typed error for an unreadable source', async () => {
    const source = { readBatch: jest.fn().mockRejectedValue(new Error('connection refused')) };
    await expect(runSettlementDryRun({ source, mode: DRY_RUN_MODE })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('marks the report incomplete (not drift/clean) when the scan is bounded by maxRecords', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => invoice({ id: `inv-${index}` }));
    const source = new InMemoryInvoiceFundingSource(rows);
    const report = await runSettlementDryRun({ source, mode: DRY_RUN_MODE, maxRecords: 2 });
    expect(report.complete).toBe(false);
    expect(report.status).toBe(REPORT_STATUS.INCOMPLETE);
    expect(report.nextCursor).not.toBeNull();
  });
});
