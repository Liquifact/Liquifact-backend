'use strict';

/**
 * @fileoverview Tests for the invoice-state retention-purge job wrapper
 * (issue #866). Mirrors the structure used for `escrowReadPurge`.
 *
 * The service is mocked at module scope so that `jest.spyOn` mutates the same
 * function reference that the job module imported; without `jest.mock` the
 * spy is invisible to the import inside the job.
 */

process.env.NODE_ENV = 'test';

jest.mock('../src/services/invoiceStateSoftDelete', () => {
  const actual = jest.requireActual('../src/services/invoiceStateSoftDelete');
  return {
    ...actual,
    purgeExpiredInvoiceStateSoftDeletes: jest.fn(),
    getRetentionDays: actual.getRetentionDays,
    getPurgeBatchSize: actual.getPurgeBatchSize,
    getPurgeMaxBatches: actual.getPurgeMaxBatches,
  };
});

const service = require('../src/services/invoiceStateSoftDelete');
const purge = require('../src/jobs/invoiceStatePurge');

const { runInvoiceStatePurge, getIntervalMs } = purge;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.INVOICE_STATE_PURGE_INTERVAL_MS;
});

describe('purge job configuration', () => {
  test('getIntervalMs defaults to 6 hours', () => {
    expect(getIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });

  test('getIntervalMs honours a valid override', () => {
    process.env.INVOICE_STATE_PURGE_INTERVAL_MS = '120000';
    expect(getIntervalMs()).toBe(120000);
  });

  test.each(['0', '-1', 'abc', ''])(
    'getIntervalMs falls back to the default for invalid value %p',
    (value) => {
      process.env.INVOICE_STATE_PURGE_INTERVAL_MS = value;
      expect(getIntervalMs()).toBe(6 * 60 * 60 * 1000);
    }
  );
});

describe('runInvoiceStatePurge', () => {
  test('returns success with the underlying summary on a clean run', async () => {
    const summary = {
      purged: 7,
      batches: 2,
      cutoff: '2026-07-01T00:00:00.000Z',
      retentionDays: 30,
      maxBatchesReached: false,
      invoiceIds: ['a', 'b', 'c'],
    };
    service.purgeExpiredInvoiceStateSoftDeletes.mockResolvedValue(summary);

    const result = await runInvoiceStatePurge({ id: 'job-1' });

    expect(result).toMatchObject({ success: true, ...summary });
    expect(service.purgeExpiredInvoiceStateSoftDeletes).toHaveBeenCalledWith({});
  });

  test('forwards injected options to the service (dbClient, now, batchSize, maxBatches)', async () => {
    const fakeDb = { __tag: 'db' };
    service.purgeExpiredInvoiceStateSoftDeletes.mockResolvedValue({
      purged: 0,
      batches: 0,
      cutoff: '2026-07-01T00:00:00.000Z',
      retentionDays: 30,
      maxBatchesReached: false,
      invoiceIds: [],
    });

    await runInvoiceStatePurge(
      { id: 'job-2' },
      { dbClient: fakeDb, now: 1234, batchSize: 5, maxBatches: 2 }
    );

    expect(service.purgeExpiredInvoiceStateSoftDeletes).toHaveBeenCalledWith({
      dbClient: fakeDb,
      now: 1234,
      batchSize: 5,
      maxBatches: 2,
    });
  });

  test('re-throws on service failure so the worker applies its retry policy', async () => {
    service.purgeExpiredInvoiceStateSoftDeletes.mockRejectedValue(new Error('db offline'));

    await expect(runInvoiceStatePurge({ id: 'job-3' })).rejects.toThrow('db offline');
  });
});

describe('schedulePurge / triggerPurge', () => {
  test('schedulePurge enqueues a job with the configured interval', () => {
    process.env.INVOICE_STATE_PURGE_INTERVAL_MS = '60000';
    const enqueueSpy = jest
      .spyOn(purge.purgeQueue, 'enqueue')
      .mockReturnValue('job-xyz');

    const id = purge.schedulePurge();
    expect(id).toBe('job-xyz');
    expect(enqueueSpy).toHaveBeenCalledWith(
      purge.JOB_TYPE,
      {},
      { delayMs: 60000 }
    );
  });

  test('triggerPurge enqueues with no delay', () => {
    const enqueueSpy = jest
      .spyOn(purge.purgeQueue, 'enqueue')
      .mockReturnValue('job-now');

    const id = purge.triggerPurge();
    expect(id).toBe('job-now');
    expect(enqueueSpy).toHaveBeenCalledWith(purge.JOB_TYPE, {}, { delayMs: 0 });
  });

  test('schedulePurge honours an explicit delayMs override', () => {
    const enqueueSpy = jest
      .spyOn(purge.purgeQueue, 'enqueue')
      .mockReturnValue('job-override');

    purge.schedulePurge({ delayMs: 250 });
    expect(enqueueSpy).toHaveBeenCalledWith(purge.JOB_TYPE, {}, { delayMs: 250 });
  });
});

describe('getStats', () => {
  test('returns worker/queue/config snapshot', () => {
    const stats = purge.getStats();
    expect(stats).toHaveProperty('worker');
    expect(stats).toHaveProperty('queue');
    expect(stats).toHaveProperty('config');
    expect(stats.config).toEqual(
      expect.objectContaining({
        retentionDays: expect.any(Number),
        batchSize: expect.any(Number),
        maxBatches: expect.any(Number),
        intervalMs: expect.any(Number),
      })
    );
  });
});
