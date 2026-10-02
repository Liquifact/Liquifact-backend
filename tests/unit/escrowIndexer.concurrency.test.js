'use strict';

/**
 * @fileoverview Focused regression tests for concurrent execution of the
 * escrow indexer.
 *
 * These tests pin the invariants that make repeated / overlapping / racing
 * execution safe:
 *
 *   1. Cross-worker exclusion via the store lease (only one worker indexes).
 *   2. Fail-closed cursor semantics: only structurally invalid events may be
 *      skipped; transient persistence failures abort the cycle with the cursor
 *      unchanged so the batch is retried instead of silently dropped.
 *   3. Lease loss aborts before the cursor advances.
 *   4. Retries are idempotent (event_id upsert, no projection churn).
 *   5. Fenced cursor writes assert the lease inside the write transaction so an
 *      expired worker cannot regress the checkpoint (TOCTOU-safe).
 */

// The global setup shim mock omits the escrow-indexer metrics; restore the real
// registry so cycle success/abort paths (which emit metrics) can run.
jest.unmock('../../src/metrics');

jest.mock('../../src/config/escrowMap', () => ({
  resolveInvoiceByAddress: jest.fn(() => null),
}));

const {
  createEscrowIndexer,
  createKnexEscrowEventStore,
  isSkippableEventError,
  runEscrowIndexerCycle,
  ValidationError,
  LeaseLostError,
} = require('../../src/jobs/escrowIndexer');

const { escrowIndexerCycleFailuresTotal } = require('../../src/metrics');

const CURSOR = 'cursor-0';
const NEXT_CURSOR = 'cursor-1';

function validEvent(eventId, overrides = {}) {
  return {
    eventId,
    invoiceId: 'inv_1',
    eventType: 'escrow_created',
    ledgerSequence: 10,
    pagingToken: '10-1',
    observedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createTransactionRunner() {
  return async (handler) => handler({ fn: { now: () => new Date().toISOString() } });
}

async function metricValue(metric) {
  const res = await metric.get();
  return res.values && res.values[0] ? res.values[0].value : 0;
}

/**
 * In-memory store that also models the DB lease so cross-worker exclusion can
 * be exercised deterministically without a database.
 */
function createLeasingStore() {
  const state = {
    cursor: CURSOR,
    events: new Map(),
    projections: new Map(),
    saveCursorCalls: [],
    acquireCalls: [],
    completeLeaseCalls: [],
    lease: null,
    leaseCounter: 0,
    failEventIds: new Set(),
  };

  return {
    _state: state,

    async acquireLease({ leaseDurationMs } = {}) {
      state.acquireCalls.push(leaseDurationMs);
      const now = Date.now();
      if (state.lease && state.lease.expiresAt > now) {
        return null;
      }
      state.leaseCounter += 1;
      state.lease = {
        token: `lease-${state.leaseCounter}`,
        expiresAt: now + (leaseDurationMs || 30_000),
      };
      return { ...state.lease };
    },

    async renewLease(token, leaseDurationMs = 30_000) {
      if (!state.lease || state.lease.token !== token || state.lease.expiresAt <= Date.now()) {
        return null;
      }
      state.lease.expiresAt = Date.now() + leaseDurationMs;
      return { ...state.lease };
    },

    async completeLease(token) {
      state.completeLeaseCalls.push(token);
      if (state.lease && state.lease.token === token) {
        state.lease = null;
        return true;
      }
      return false;
    },

    async loadCursor() {
      return state.cursor;
    },

    async saveCursor(cursor) {
      state.cursor = cursor;
      state.saveCursorCalls.push(cursor);
    },

    async findProjection(invoiceId) {
      return state.projections.get(invoiceId) || null;
    },

    async upsertEvent(_trx, event) {
      if (state.failEventIds.has(event.eventId)) {
        const err = new Error('transient write failure');
        err.name = 'DatabaseError';
        throw err;
      }
      if (!state.events.has(event.eventId)) {
        state.events.set(event.eventId, event);
      }
    },

    async upsertProjection(_trx, event) {
      state.projections.set(event.invoiceId, {
        invoice_id: event.invoiceId,
        latest_event_id: event.eventId,
        latest_event_type: event.eventType,
        latest_ledger_sequence: event.ledgerSequence,
        latest_paging_token: event.pagingToken || null,
      });
    },
  };
}

const silentLog = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('escrowIndexer concurrent execution hardening', () => {
  beforeEach(() => {
    try {
      escrowIndexerCycleFailuresTotal.reset();
    } catch (_) {
      // shim may not expose reset
    }
  });

  describe('fail-closed cursor semantics', () => {
    test('transient persistence failure aborts the cycle and does not advance the cursor', async () => {
      const store = createLeasingStore();
      store._state.failEventIds.add('evt-transient');
      const log = silentLog();

      const fetchEscrowEvents = async () => ({
        events: [validEvent('evt-1'), validEvent('evt-transient'), validEvent('evt-3')],
        nextCursor: NEXT_CURSOR,
      });

      await expect(
        runEscrowIndexerCycle({
          store,
          fetchEscrowEvents,
          transactionRunner: createTransactionRunner(),
          log,
        }),
      ).rejects.toThrow(/transient write failure/);

      // Cursor must stay put so the batch is retried, not skipped.
      expect(store._state.saveCursorCalls).toEqual([]);
      expect(store._state.cursor).toBe(CURSOR);
      // The event before the failure was persisted; the failing one was not.
      expect(store._state.events.has('evt-1')).toBe(true);
      expect(store._state.events.has('evt-transient')).toBe(false);
      // Lease is released even on abort.
      expect(store._state.lease).toBeNull();
      expect(log.error).toHaveBeenCalled();
    });

    test('validation failure is skipped and the cursor advances past it', async () => {
      const store = createLeasingStore();

      const fetchEscrowEvents = async () => ({
        events: [validEvent('evt-1'), validEvent('evt-invalid', { ledgerSequence: 0 })],
        nextCursor: NEXT_CURSOR,
      });

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      expect(summary.processed).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(store._state.saveCursorCalls).toEqual([NEXT_CURSOR]);
    });

    test('isSkippableEventError treats only structured validation errors as permanent', () => {
      expect(isSkippableEventError(new ValidationError('bad', 'VALIDATION_ERROR'))).toBe(true);
      expect(isSkippableEventError(Object.assign(new Error('x'), { name: 'ValidationError' }))).toBe(true);
      expect(isSkippableEventError(new Error('db down'))).toBe(false);
      expect(isSkippableEventError(Object.assign(new Error('x'), { name: 'DatabaseError' }))).toBe(false);
      expect(isSkippableEventError(null)).toBe(false);
    });

    test('runCycle records a transient abort as a cycle failure and returns null', async () => {
      const store = createLeasingStore();
      store._state.failEventIds.add('evt-1');

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents: async () => ({ events: [validEvent('evt-1')], nextCursor: NEXT_CURSOR }),
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      const result = await indexer.runCycle();
      expect(result).toBeNull();
      expect(await metricValue(escrowIndexerCycleFailuresTotal)).toBe(1);
      expect(store._state.saveCursorCalls).toEqual([]);
    });
  });

  describe('cross-worker exclusion', () => {
    test('a cycle is a no-op while another worker holds the lease', async () => {
      const store = createLeasingStore();
      // Simulate a different worker holding the lease.
      await store.acquireLease({ leaseDurationMs: 60_000 });
      const upsertEvent = jest.spyOn(store, 'upsertEvent');

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents: async () => ({ events: [validEvent('evt-1')], nextCursor: NEXT_CURSOR }),
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      expect(summary).toBeNull();
      expect(upsertEvent).not.toHaveBeenCalled();
      expect(store._state.saveCursorCalls).toEqual([]);
    });

    test('runCycle does not count a lease-held skip as a failure or dereference a null summary', async () => {
      const store = createLeasingStore();
      await store.acquireLease({ leaseDurationMs: 60_000 });

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents: async () => ({ events: [validEvent('evt-1')], nextCursor: NEXT_CURSOR }),
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      const result = await indexer.runCycle();
      expect(result).toBeNull();
      expect(await metricValue(escrowIndexerCycleFailuresTotal)).toBe(0);
    });

    test('leaseDurationMs is forwarded to lease acquisition', async () => {
      const store = createLeasingStore();

      const indexer = createEscrowIndexer({
        store,
        leaseDurationMs: 4_321,
        fetchEscrowEvents: async () => ({ events: [], nextCursor: null }),
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      await indexer.runCycle();
      expect(store._state.acquireCalls).toContain(4_321);
    });
  });

  describe('idempotent retries and lease loss', () => {
    test('a batch aborted by a transient failure is safely retried and fully persisted', async () => {
      const store = createLeasingStore();
      store._state.failEventIds.add('evt-2');
      const fetchEscrowEvents = async () => ({
        events: [validEvent('evt-1'), validEvent('evt-2', { ledgerSequence: 11 })],
        nextCursor: NEXT_CURSOR,
      });

      // First attempt: aborts on evt-2, cursor unchanged.
      await expect(
        runEscrowIndexerCycle({
          store,
          fetchEscrowEvents,
          transactionRunner: createTransactionRunner(),
          log: silentLog(),
        }),
      ).rejects.toThrow(/transient write failure/);
      expect(store._state.saveCursorCalls).toEqual([]);
      expect(store._state.events.has('evt-1')).toBe(true);

      // Recovery: same batch is replayed; evt-1 is idempotent, evt-2 persists.
      store._state.failEventIds.delete('evt-2');
      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      expect(summary.processed).toBe(2);
      expect(store._state.events.size).toBe(2);
      expect(store._state.saveCursorCalls).toEqual([NEXT_CURSOR]);
      expect(store._state.projections.get('inv_1').latest_event_id).toBe('evt-2');
    });

    test('replaying a duplicate event is idempotent (no duplicate event or projection churn)', async () => {
      const store = createLeasingStore();
      const fetchEscrowEvents = async () => ({
        events: [validEvent('evt-dup')],
        nextCursor: NEXT_CURSOR,
      });

      await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });
      const firstProjection = { ...store._state.projections.get('inv_1') };

      // Second cycle replays the same event from the same cursor.
      store._state.cursor = CURSOR;
      await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      expect(store._state.events.size).toBe(1);
      expect(store._state.projections.get('inv_1')).toEqual(firstProjection);
    });

    test('lease loss mid-batch aborts without advancing the cursor', async () => {
      const store = createLeasingStore();
      store.renewLease = jest.fn(async () => null);

      await expect(
        runEscrowIndexerCycle({
          store,
          fetchEscrowEvents: async () => ({
            events: [validEvent('evt-1'), validEvent('evt-2', { ledgerSequence: 11 })],
            nextCursor: NEXT_CURSOR,
          }),
          transactionRunner: createTransactionRunner(),
          log: silentLog(),
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);

      expect(store._state.saveCursorCalls).toEqual([]);
    });

    test('re-entrancy guard rejects overlapping runCycle calls', async () => {
      const store = createLeasingStore();
      let release;
      const blocker = new Promise((r) => {
        release = r;
      });

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents: async () => {
          await blocker;
          return { events: [], nextCursor: null };
        },
        transactionRunner: createTransactionRunner(),
        log: silentLog(),
      });

      const first = indexer.runCycle();
      const second = indexer.runCycle();
      release();

      const [a, b] = await Promise.all([first, second]);
      expect(a).not.toBeNull();
      expect(b).toBeNull();
    });
  });

  describe('fenced cursor writes (createKnexEscrowEventStore)', () => {
    function fakeKnexWithTransaction(leaseRow) {
      const order = [];
      const builder = {
        where() {
          return this;
        },
        whereRaw() {
          order.push('assert');
          return this;
        },
        first: jest.fn(async () => leaseRow),
        insert() {
          return this;
        },
        onConflict() {
          return this;
        },
        merge() {
          order.push('merge');
          return Promise.resolve();
        },
      };
      const knex = jest.fn(() => builder);
      knex.fn = { now: () => 'NOW()' };
      knex.transaction = jest.fn(async (handler) => handler(knex));
      knex._order = order;
      return knex;
    }

    const validLeaseRow = {
      value: JSON.stringify({ token: 'lease-token', expiresAt: Date.now() + 60_000 }),
    };

    test('asserts the lease inside the write transaction, before the upsert', async () => {
      const knex = fakeKnexWithTransaction(validLeaseRow);
      const store = createKnexEscrowEventStore(knex);

      await store.saveCursor('cursor-1', 'lease-token');

      expect(knex.transaction).toHaveBeenCalledTimes(1);
      // Lease assertion is evaluated before the write commits.
      expect(knex._order).toEqual(['assert', 'assert', 'merge']);
    });

    test('a stale fence token prevents the cursor write entirely', async () => {
      const knex = fakeKnexWithTransaction(undefined);
      const store = createKnexEscrowEventStore(knex);

      await expect(store.saveCursor('cursor-1', 'stale-token')).rejects.toBeInstanceOf(LeaseLostError);
      expect(knex._order).toEqual(['assert', 'assert']);
      expect(knex._order).not.toContain('merge');
    });

    test('an unfenced cursor write does not open a transaction', async () => {
      const knex = fakeKnexWithTransaction(validLeaseRow);
      const store = createKnexEscrowEventStore(knex);

      await store.saveCursor('cursor-1');

      expect(knex.transaction).not.toHaveBeenCalled();
      expect(knex._order).toEqual(['merge']);
    });
  });
});
