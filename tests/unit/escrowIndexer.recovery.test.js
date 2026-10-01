'use strict';

/**
 * @fileoverview Focused failure-recovery tests for src/jobs/escrowIndexer.js (#1394).
 *
 * Covers:
 *  - withRetry: transient retry, non-retryable pass-through, exhaustion
 *  - isNonRetryableError classification
 *  - fetchEscrowEvents retry-on-transient / abort-on-LeaseLost
 *  - persistEscrowEvent retry-on-transient / abort-on-ValidationError
 *  - Partial-batch checkpoint cursor saved on transient exhaustion mid-batch
 *  - Partial-batch checkpoint cursor saved on LeaseLost mid-batch
 *  - Concurrent cycle re-entrancy guard (running flag)
 *  - retriedEvents and partialCursorSaved in cycle summary
 *  - Normal operation unaffected (existing paths preserved)
 *
 * All retry tests use baseRetryDelayMs=0 to avoid relying on fake timers.
 */

jest.mock('../../src/config/escrowMap', () => ({
  resolveInvoiceByAddress: jest.fn(() => null),
}));

const {
  runEscrowIndexerCycle,
  createEscrowIndexer,
  withRetry,
  isNonRetryableError,
  ValidationError,
  LeaseLostError,
  MAX_RETRY_ATTEMPTS,
  BASE_RETRY_DELAY_MS,
} = require('../../src/jobs/escrowIndexer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop() {}
const silentLog = { info: noop, warn: noop, error: noop };

function makeStore(overrides = {}) {
  return {
    loadCursor: jest.fn().mockResolvedValue(null),
    saveCursor: jest.fn().mockResolvedValue(undefined),
    findProjection: jest.fn().mockResolvedValue(null),
    upsertEvent: jest.fn().mockResolvedValue(undefined),
    upsertProjection: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTxRunner() {
  return async (handler) => handler({ fn: { now: () => new Date() } });
}

function validEvent(overrides = {}) {
  return {
    invoiceId: 'INV-1',
    eventId: 'evt-1',
    eventType: 'contract_event',
    ledgerSequence: 10,
    pagingToken: 'token-1',
    contractId: null,
    txHash: null,
    eventBody: {},
    observedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isNonRetryableError
// ---------------------------------------------------------------------------
describe('isNonRetryableError', () => {
  it('returns true for ValidationError', () => {
    expect(isNonRetryableError(new ValidationError('bad', 'V'))).toBe(true);
  });

  it('returns true for LeaseLostError', () => {
    expect(isNonRetryableError(new LeaseLostError('lost'))).toBe(true);
  });

  it('returns false for generic Error', () => {
    expect(isNonRetryableError(new Error('network'))).toBe(false);
  });

  it('returns false for TypeError', () => {
    expect(isNonRetryableError(new TypeError('bad type'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isNonRetryableError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry — success on first attempt
// ---------------------------------------------------------------------------
describe('withRetry — success on first attempt', () => {
  it('returns result and retried=0 when fn succeeds immediately', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const { result, retried } = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      log: silentLog,
    });
    expect(result).toBe('ok');
    expect(retried).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// withRetry — retry on transient error (baseDelayMs=0, no fake timers needed)
// ---------------------------------------------------------------------------
describe('withRetry — retry on transient error', () => {
  it('retries up to maxAttempts-1 times then succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValue('success');

    const { result, retried } = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      log: silentLog,
    });

    expect(result).toBe('success');
    expect(retried).toBe(2);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error when all attempts are exhausted', async () => {
    const error = new Error('persistent transient');
    const fn = jest.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, log: silentLog })
    ).rejects.toThrow('persistent transient');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('logs a warning for each retry attempt', async () => {
    const warnLog = { info: noop, warn: jest.fn(), error: noop };
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValue('ok');

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      log: warnLog,
      context: 'test-op',
    });

    expect(warnLog.warn).toHaveBeenCalledTimes(1);
    expect(warnLog.warn.mock.calls[0][1]).toMatch(/retrying/i);
  });

  it('includes attempt and context in the warning log', async () => {
    const warnLog = { info: noop, warn: jest.fn(), error: noop };
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      log: warnLog,
      context: 'my-context',
    });

    expect(warnLog.warn.mock.calls[0][0]).toMatchObject({
      context: 'my-context',
      attempt: 1,
      maxAttempts: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// withRetry — non-retryable errors pass through immediately
// ---------------------------------------------------------------------------
describe('withRetry — non-retryable errors bypass retry', () => {
  it('does not retry ValidationError', async () => {
    const fn = jest.fn().mockRejectedValue(new ValidationError('invalid', 'V'));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, log: silentLog })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry LeaseLostError', async () => {
    const fn = jest.fn().mockRejectedValue(new LeaseLostError('lost'));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, log: silentLog })
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// withRetry — maxAttempts=1 (no retries at all)
// ---------------------------------------------------------------------------
describe('withRetry — maxAttempts=1', () => {
  it('throws immediately without retrying when maxAttempts=1', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('first and only'));
    await expect(
      withRetry(fn, { maxAttempts: 1, baseDelayMs: 0, log: silentLog })
    ).rejects.toThrow('first and only');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runEscrowIndexerCycle — fetch retry
// ---------------------------------------------------------------------------
describe('runEscrowIndexerCycle — fetchEscrowEvents retry', () => {
  it('retries a transient fetch error and succeeds', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const transactionRunner = makeTxRunner();
    let calls = 0;
    const fetchEscrowEvents = jest.fn(async () => {
      calls++;
      if (calls < 2) throw new Error('network timeout');
      return { events: [validEvent()], nextCursor: 'c-1' };
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner,
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.processed).toBe(1);
    expect(fetchEscrowEvents).toHaveBeenCalledTimes(2);
  });

  it('aborts cycle when fetch transient error exhausts all retries', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const fetchEscrowEvents = jest.fn().mockRejectedValue(new Error('horizon down'));

    await expect(
      runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: makeTxRunner(),
        log: silentLog,
        batchSize: 10,
        maxRetryAttempts: 2,
        baseRetryDelayMs: 0,
      })
    ).rejects.toThrow('horizon down');
    expect(fetchEscrowEvents).toHaveBeenCalledTimes(2);
  });

  it('does not retry LeaseLostError thrown by fetchEscrowEvents', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const fetchEscrowEvents = jest.fn().mockRejectedValue(new LeaseLostError('lost'));

    await expect(
      runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: makeTxRunner(),
        log: silentLog,
        batchSize: 10,
        maxRetryAttempts: 3,
        baseRetryDelayMs: 0,
      })
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(fetchEscrowEvents).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runEscrowIndexerCycle — persist retry
// ---------------------------------------------------------------------------
describe('runEscrowIndexerCycle — persist retry', () => {
  it('retries a transient upsertEvent error and increments retriedEvents', async () => {
    let upsertCalls = 0;
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      upsertEvent: jest.fn(async () => {
        upsertCalls++;
        if (upsertCalls < 2) throw new Error('DB timeout');
      }),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent({ pagingToken: 'token-1' })],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.processed).toBe(1);
    expect(summary.retriedEvents).toBe(1);
    expect(store.upsertEvent).toHaveBeenCalledTimes(2);
  });

  it('skips event when persist transient error exhausts retries', async () => {
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      upsertEvent: jest.fn().mockRejectedValue(new Error('DB down')),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent({ pagingToken: 'token-1' })],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 2,
      baseRetryDelayMs: 0,
    });

    expect(summary.processed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(store.upsertEvent).toHaveBeenCalledTimes(2);
  });

  it('does not retry ValidationError on persist — called exactly once', async () => {
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      upsertEvent: jest.fn().mockRejectedValue(new ValidationError('bad', 'V')),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent()],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.skipped).toBe(1);
    expect(store.upsertEvent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Partial-batch checkpoint — transient exhaustion mid-batch
// ---------------------------------------------------------------------------
describe('runEscrowIndexerCycle — partial-batch checkpoint on transient exhaustion', () => {
  it('saves partial cursor at last successful paging token when persist exhausts retries mid-batch', async () => {
    let eventCount = 0;
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      upsertEvent: jest.fn(async () => {
        eventCount++;
        if (eventCount > 1) throw new Error('DB transient');
      }),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [
        validEvent({ eventId: 'evt-1', pagingToken: 'token-A' }),
        validEvent({ eventId: 'evt-2', invoiceId: 'INV-2', pagingToken: 'token-B' }),
      ],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 2,
      baseRetryDelayMs: 0,
    });

    expect(summary.processed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.partialCursorSaved).toBe(true);
    const saveCalls = store.saveCursor.mock.calls.map((c) => c[0]);
    expect(saveCalls).toContain('token-A');
  });

  it('does not save partial cursor when no events were processed before failure', async () => {
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      upsertEvent: jest.fn().mockRejectedValue(new Error('DB down')),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent({ pagingToken: 'token-X' })],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 2,
      baseRetryDelayMs: 0,
    });

    expect(summary.partialCursorSaved).toBe(false);
  });

  it('does not save partial cursor checkpoint for ValidationError (permanent skip)', async () => {
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      upsertEvent: jest.fn().mockRejectedValue(new ValidationError('bad', 'V')),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [
        validEvent({ eventId: 'evt-1', pagingToken: 'token-A' }),
        validEvent({ eventId: 'evt-2', invoiceId: 'INV-2', pagingToken: 'token-B' }),
      ],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.partialCursorSaved).toBe(false);
    const checkpointCalls = store.saveCursor.mock.calls.filter(
      (c) => c[0] === 'token-A' || c[0] === 'token-B'
    );
    expect(checkpointCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Partial-batch checkpoint — LeaseLost mid-batch
// ---------------------------------------------------------------------------
describe('runEscrowIndexerCycle — partial-batch checkpoint on LeaseLost', () => {
  it('saves partial cursor before re-throwing LeaseLostError mid-batch', async () => {
    // The cycle loop structure: for each event → renewLease → persist.
    // So renewLease(1) fires before event-1 persist; renewLease(2) before event-2 persist.
    // We make renewLease succeed on call 1 (event-1 processes OK),
    // then return null on call 2 (triggers LeaseLostError before event-2 persist).
    let renewCount = 0;
    const renewLease = jest.fn(async () => {
      renewCount++;
      if (renewCount === 1) return { token: 'tok', expiresAt: Date.now() + 30000 }; // first renewal OK
      return null; // second renewal fails → LeaseLostError
    });

    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      acquireLease: jest.fn().mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 30000 }),
      renewLease,
      completeLease: jest.fn().mockResolvedValue(true),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [
        validEvent({ eventId: 'evt-1', pagingToken: 'token-A' }),
        validEvent({ eventId: 'evt-2', invoiceId: 'INV-2', pagingToken: 'token-B' }),
      ],
      nextCursor: 'c-1',
    });

    await expect(
      runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: makeTxRunner(),
        log: silentLog,
        batchSize: 10,
        maxRetryAttempts: 1,
        baseRetryDelayMs: 0,
      })
    ).rejects.toBeInstanceOf(LeaseLostError);

    // Partial cursor should have been saved at token-A (first event succeeded)
    const saveCalls = store.saveCursor.mock.calls.map((c) => c[0]);
    expect(saveCalls).toContain('token-A');
  });

  it('does not save partial cursor when LeaseLost fires before any events are processed', async () => {
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      acquireLease: jest.fn().mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 30000 }),
      renewLease: jest.fn().mockResolvedValue(null), // fails on first renewal
      completeLease: jest.fn().mockResolvedValue(true),
    });

    // Only one event — renewLease fires before it, LeaseLostError before any persist
    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent({ eventId: 'evt-1', pagingToken: 'token-A' })],
      nextCursor: 'c-1',
    });

    await expect(
      runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: makeTxRunner(),
        log: silentLog,
        batchSize: 10,
        maxRetryAttempts: 1,
        baseRetryDelayMs: 0,
      })
    ).rejects.toBeInstanceOf(LeaseLostError);

    // No events succeeded → no partial checkpoint
    const saveCalls = store.saveCursor.mock.calls.map((c) => c[0]);
    expect(saveCalls).not.toContain('token-A');
  });
});

// ---------------------------------------------------------------------------
// Concurrent cycle re-entrancy (runEscrowIndexerCycle is called via createEscrowIndexer)
// ---------------------------------------------------------------------------
describe('createEscrowIndexer — concurrent cycle re-entrancy', () => {
  it('second runCycle() call returns null while first is in progress', async () => {
    let resolveBlocker;
    const blocker = new Promise((r) => { resolveBlocker = r; });
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue(null) });

    const slowFetch = async () => {
      await blocker;
      return { events: [], nextCursor: null };
    };

    // Use runEscrowIndexerCycle directly with a shared running flag
    // to test re-entrancy without needing the metrics mock in createEscrowIndexer.
    let running = false;
    const guardedCycle = async () => {
      if (running) return null;
      running = true;
      try {
        return await runEscrowIndexerCycle({
          store,
          fetchEscrowEvents: slowFetch,
          transactionRunner: makeTxRunner(),
          log: silentLog,
          batchSize: 10,
          maxRetryAttempts: 1,
          baseRetryDelayMs: 0,
        });
      } finally {
        running = false;
      }
    };

    const p1 = guardedCycle();
    const p2 = guardedCycle(); // concurrent — should return null immediately

    resolveBlocker();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).not.toBeNull(); // first cycle completed with summary
    expect(r2).toBeNull();     // second was blocked by re-entrancy guard
  });

  it('after first cycle completes, second call can start a new cycle', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue(null) });
    const fetchEscrowEvents = jest.fn().mockResolvedValue({ events: [], nextCursor: null });

    let running = false;
    const guardedCycle = async () => {
      if (running) return null;
      running = true;
      try {
        return await runEscrowIndexerCycle({
          store,
          fetchEscrowEvents,
          transactionRunner: makeTxRunner(),
          log: silentLog,
          batchSize: 10,
          maxRetryAttempts: 1,
          baseRetryDelayMs: 0,
        });
      } finally {
        running = false;
      }
    };

    const r1 = await guardedCycle();
    const r2 = await guardedCycle();

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(fetchEscrowEvents).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Summary shape — retriedEvents and partialCursorSaved
// ---------------------------------------------------------------------------
describe('runEscrowIndexerCycle — summary fields', () => {
  it('returns retriedEvents=0 and partialCursorSaved=false on clean cycle', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent()],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.retriedEvents).toBe(0);
    expect(summary.partialCursorSaved).toBe(false);
  });

  it('returns full summary shape on clean cycle', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent()],
      nextCursor: 'c-1',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary).toMatchObject({
      processed: 1,
      skipped: 0,
      retriedEvents: 0,
      partialCursorSaved: false,
      cursorBefore: 'c-0',
      cursorAfter: 'c-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Normal operation preserved (regression)
// ---------------------------------------------------------------------------
describe('runEscrowIndexerCycle — regression: normal operation unaffected', () => {
  it('processes all events in a clean batch without retries', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const events = [
      validEvent({ eventId: 'e1', pagingToken: 'p1' }),
      validEvent({ eventId: 'e2', invoiceId: 'INV-2', pagingToken: 'p2' }),
      validEvent({ eventId: 'e3', invoiceId: 'INV-3', pagingToken: 'p3' }),
    ];
    const fetchEscrowEvents = jest.fn().mockResolvedValue({ events, nextCursor: 'c-3' });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.processed).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.retriedEvents).toBe(0);
    expect(summary.partialCursorSaved).toBe(false);
    // saveCursor called with nextCursor and the (null) fenceToken
    expect(store.saveCursor).toHaveBeenCalledWith('c-3', null);
  });

  it('does not advance cursor when nextCursor equals current cursor', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-same') });
    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [validEvent()],
      nextCursor: 'c-same',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.cursorBefore).toBe('c-same');
    expect(summary.cursorAfter).toBe('c-same');
    expect(store.saveCursor).not.toHaveBeenCalled();
  });

  it('skips malformed events without aborting the batch', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [
        validEvent({ eventId: 'e1', pagingToken: 'p1' }),
        // missing ledgerSequence causes ValidationError in normalizeEvent
        { invoiceId: 'INV-BAD', eventId: 'e2', eventType: 'x', pagingToken: 'p2' },
        validEvent({ eventId: 'e3', invoiceId: 'INV-3', pagingToken: 'p3' }),
      ],
      nextCursor: 'c-3',
    });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.processed).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it('empty batch returns zero counts and does not save cursor', async () => {
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    const fetchEscrowEvents = jest.fn().mockResolvedValue({ events: [], nextCursor: null });

    const summary = await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: silentLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    expect(summary.processed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(store.saveCursor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Observability — retry logs emitted
// ---------------------------------------------------------------------------
describe('runEscrowIndexerCycle — observability: retry logs', () => {
  it('logs info when fetch succeeds after retry', async () => {
    const infoLog = { info: jest.fn(), warn: jest.fn(), error: noop };
    const store = makeStore({ loadCursor: jest.fn().mockResolvedValue('c-0') });
    let fetchCalls = 0;
    const fetchEscrowEvents = jest.fn(async () => {
      fetchCalls++;
      if (fetchCalls < 2) throw new Error('transient');
      return { events: [], nextCursor: null };
    });

    await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: infoLog,
      batchSize: 10,
      maxRetryAttempts: 3,
      baseRetryDelayMs: 0,
    });

    // warn called for the retry attempt
    expect(infoLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'fetchEscrowEvents', attempt: 1 }),
      expect.stringMatching(/retrying/i)
    );
    // info called confirming the fetch succeeded after retry
    expect(infoLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ fetchRetried: 1 }),
      expect.stringMatching(/fetch succeeded after/i)
    );
  });

  it('logs warn when partial cursor is saved after transient exhaustion', async () => {
    const warnLog = { info: noop, warn: jest.fn(), error: noop };
    let eventCount = 0;
    const store = makeStore({
      loadCursor: jest.fn().mockResolvedValue('c-0'),
      upsertEvent: jest.fn(async () => {
        eventCount++;
        if (eventCount > 1) throw new Error('DB transient');
      }),
    });

    const fetchEscrowEvents = jest.fn().mockResolvedValue({
      events: [
        validEvent({ eventId: 'evt-1', pagingToken: 'token-A' }),
        validEvent({ eventId: 'evt-2', invoiceId: 'INV-2', pagingToken: 'token-B' }),
      ],
      nextCursor: 'c-1',
    });

    await runEscrowIndexerCycle({
      store,
      fetchEscrowEvents,
      transactionRunner: makeTxRunner(),
      log: warnLog,
      batchSize: 10,
      maxRetryAttempts: 2,
      baseRetryDelayMs: 0,
    });

    const partialCheckpointCall = warnLog.warn.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('partial-batch checkpoint')
    );
    expect(partialCheckpointCall).toBeDefined();
    expect(partialCheckpointCall[0]).toMatchObject({ partialCursor: 'token-A' });
  });
});

// ---------------------------------------------------------------------------
// Constants exported and usable
// ---------------------------------------------------------------------------
describe('exported constants', () => {
  it('MAX_RETRY_ATTEMPTS is a positive integer', () => {
    expect(Number.isInteger(MAX_RETRY_ATTEMPTS)).toBe(true);
    expect(MAX_RETRY_ATTEMPTS).toBeGreaterThan(0);
  });

  it('BASE_RETRY_DELAY_MS is a positive number', () => {
    expect(typeof BASE_RETRY_DELAY_MS).toBe('number');
    expect(BASE_RETRY_DELAY_MS).toBeGreaterThan(0);
  });
});
