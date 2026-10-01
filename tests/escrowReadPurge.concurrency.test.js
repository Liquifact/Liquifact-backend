'use strict';

/**
 * @fileoverview Concurrency tests for the escrow-read retention-purge job
 * (issue #1400).
 *
 * The purge is a select-then-delete sweep over `escrow_event_projection`.
 * Running two sweeps at once makes them fight over the same tombstoned rows,
 * double-count metrics and double-invalidate caches. These tests pin the
 * single-flight contract that prevents that:
 *   - a concurrent invocation coalesces into the in-flight sweep (no second
 *     service call);
 *   - the coalesced caller is told it joined (`coalesced: true`);
 *   - the guard is released after success AND failure (including a synchronous
 *     throw), so the schedule never wedges.
 */

process.env.NODE_ENV = 'test';

// The shared test setup (`tests/mocks/setup.js`) replaces `src/metrics` with a
// stub that lacks the registry/counters this job needs, and Jest lets that
// setup mock win over a local `jest.mock`. Unmock it so the job can build its
// real prom-client counters and register the queue/worker as usual.
jest.unmock('../src/metrics');

jest.mock('../src/services/escrowReadSoftDelete', () => ({
  purgeExpiredSoftDeletes: jest.fn(),
  getRetentionDays: () => 30,
  getPurgeBatchSize: () => 500,
  getPurgeMaxBatches: () => 100,
}));

const service = require('../src/services/escrowReadSoftDelete');
const { runEscrowReadPurge, isPurgeRunning } = require('../src/jobs/escrowReadPurge');

const SUMMARY = {
  purged: 7,
  batches: 2,
  cutoff: '2026-07-01T00:00:00.000Z',
  retentionDays: 30,
  maxBatchesReached: false,
  invoiceIds: ['a', 'b'],
};

/** Deferred promise helper so a sweep can be held mid-flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('runs a single sweep when nothing else is in flight', async () => {
  service.purgeExpiredSoftDeletes.mockResolvedValue(SUMMARY);

  const result = await runEscrowReadPurge({ id: 'job-1' });

  expect(result).toMatchObject({ success: true, coalesced: false, purged: 7 });
  expect(service.purgeExpiredSoftDeletes).toHaveBeenCalledTimes(1);
});

test('coalesces a concurrent invocation into the in-flight sweep', async () => {
  const gate = deferred();
  service.purgeExpiredSoftDeletes.mockImplementation(() => gate.promise.then(() => SUMMARY));

  const first = runEscrowReadPurge({ id: 'job-1' });
  const second = runEscrowReadPurge({ id: 'job-2' });

  gate.resolve();

  const [r1, r2] = await Promise.all([first, second]);

  // Only one service call — the second invocation joined the first.
  expect(service.purgeExpiredSoftDeletes).toHaveBeenCalledTimes(1);
  expect(r1).toMatchObject({ success: true, coalesced: false, purged: 7 });
  expect(r2).toMatchObject({ success: true, coalesced: true, purged: 7 });
});

test('reports isPurgeRunning() true while in flight and false afterwards', async () => {
  const gate = deferred();
  service.purgeExpiredSoftDeletes.mockImplementation(() => gate.promise.then(() => SUMMARY));

  const inFlight = runEscrowReadPurge({ id: 'job-1' });
  expect(isPurgeRunning()).toBe(true);

  gate.resolve();
  await inFlight;

  expect(isPurgeRunning()).toBe(false);
});

test('starts a fresh sweep once the previous one has settled', async () => {
  service.purgeExpiredSoftDeletes.mockResolvedValue(SUMMARY);

  await runEscrowReadPurge({ id: 'job-1' });
  await runEscrowReadPurge({ id: 'job-2' });

  expect(service.purgeExpiredSoftDeletes).toHaveBeenCalledTimes(2);
  expect(isPurgeRunning()).toBe(false);
});

test('rejects coalesced callers when the sweep fails and releases the guard', async () => {
  service.purgeExpiredSoftDeletes.mockImplementation(() =>
    Promise.reject(new Error('db offline'))
  );

  const first = runEscrowReadPurge({ id: 'job-1' });
  const second = runEscrowReadPurge({ id: 'job-2' });

  const results = await Promise.allSettled([first, second]);

  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  expect(results[0].reason.message).toBe('db offline');
  expect(service.purgeExpiredSoftDeletes).toHaveBeenCalledTimes(1);
  expect(isPurgeRunning()).toBe(false);
});

test('releases the guard even when the service throws synchronously', async () => {
  service.purgeExpiredSoftDeletes.mockImplementation(() => {
    throw new Error('sync boom');
  });

  await expect(runEscrowReadPurge({ id: 'job-1' })).rejects.toThrow('sync boom');
  expect(isPurgeRunning()).toBe(false);

  // A subsequent run must still be able to start.
  service.purgeExpiredSoftDeletes.mockResolvedValue(SUMMARY);
  await expect(runEscrowReadPurge({ id: 'job-2' })).resolves.toMatchObject({ purged: 7 });
});
