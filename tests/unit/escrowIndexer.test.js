'use strict';

jest.mock('../../src/config/escrowMap', () => ({
  resolveInvoiceByAddress: jest.fn(() => null),
}));

const { resolveInvoiceByAddress } = require('../../src/config/escrowMap');

const {
  deriveInvoiceId,
  normalizeEvent,
  persistEscrowEvent,
  runEscrowIndexerCycle,
  shouldReplaceProjection,
  fetchEscrowEventsFromHorizon,
  createEscrowIndexer,
} = require('../../src/jobs/escrowIndexer');

function createInMemoryStore(initial = {}) {
  const state = {
    cursor: initial.cursor || null,
    eventsById: new Map(),
    projectionByInvoiceId: new Map(),
    saveCursorCalls: [],
  };

  return {
    _state: state,

    async loadCursor() {
      return state.cursor;
    },

    async saveCursor(cursor) {
      state.cursor = cursor;
      state.saveCursorCalls.push(cursor);
    },

    async findProjection(invoiceId) {
      return state.projectionByInvoiceId.get(invoiceId) || null;
    },

    async upsertEvent(_trx, event) {
      if (!state.eventsById.has(event.eventId)) {
        state.eventsById.set(event.eventId, event);
      }
    },

    async upsertProjection(_trx, event) {
      state.projectionByInvoiceId.set(event.invoiceId, {
        invoice_id: event.invoiceId,
        latest_event_id: event.eventId,
        latest_event_type: event.eventType,
        latest_ledger_sequence: event.ledgerSequence,
        latest_paging_token: event.pagingToken || null,
        latest_event_body: JSON.stringify(event.eventBody || {}),
        latest_observed_at: event.observedAt,
      });
    },
  };
}

function createTransactionRunner() {
  return async (handler) => handler({ fn: { now: () => new Date() } });
}

describe('escrowIndexer ordering and idempotency', () => {
  describe('normalizeEvent validation', () => {
    test('rejects non-object payload', () => {
      expect(() => normalizeEvent(null)).toThrow(/payload/i);
    });

    test('rejects invalid invoiceId', () => {
      expect(() =>
        normalizeEvent({ eventId: 'e1', invoiceId: '!!!', eventType: 'x', ledgerSequence: 1 })
      ).toThrow(/invoiceId/i);
    });

    test('rejects missing eventId/eventType', () => {
      expect(() =>
        normalizeEvent({ invoiceId: 'inv_1', eventType: 'x', ledgerSequence: 1 })
      ).toThrow(/eventId/i);
      expect(() =>
        normalizeEvent({ eventId: 'e1', invoiceId: 'inv_1', ledgerSequence: 1 })
      ).toThrow(/eventType/i);
    });

    test('rejects when invoiceId is missing/empty', () => {
      expect(() =>
        normalizeEvent({ eventId: 'e1', eventType: 'x', ledgerSequence: 1 })
      ).toThrow(/invoiceId/i);
    });

    test('keeps optional chain pointers when present', () => {
      const event = normalizeEvent({
        eventId: 'e1',
        invoiceId: 'inv_1',
        eventType: 'escrow_created',
        ledgerSequence: 1,
        pagingToken: '1',
        contractId: 'CABCDE',
        txHash: 'TXHASH',
        observedAt: '2026-01-01T00:00:00Z',
        eventBody: { hello: 'world' },
      });

      expect(event.contractId).toBe('CABCDE');
      expect(event.txHash).toBe('TXHASH');
      expect(event.eventBody).toEqual({ hello: 'world' });
    });
  });

  describe('deriveInvoiceId', () => {
    test('returns null for non-object input', () => {
      expect(deriveInvoiceId(null)).toBeNull();
      expect(deriveInvoiceId('x')).toBeNull();
    });

    test('prefers explicit invoice_id / invoiceId field', () => {
      expect(deriveInvoiceId({ invoice_id: 'inv_explicit' })).toBe('inv_explicit');
      expect(deriveInvoiceId({ invoiceId: 'inv_camel' })).toBe('inv_camel');
    });

    test('derives from event value body', () => {
      expect(deriveInvoiceId({ value: { invoice_id: 'inv_body' } })).toBe('inv_body');
      expect(deriveInvoiceId({ value: { invoiceId: 'inv_body2' } })).toBe('inv_body2');
    });

    test('derives from topics labelled with an invoice field', () => {
      expect(deriveInvoiceId({ topics: [{ sym: 'escrow_funded' }, { invoice_id: 'inv_topic' }] })).toBe('inv_topic');
      expect(deriveInvoiceId({ topic: [{ invoiceId: 'inv_t2' }] })).toBe('inv_t2');
    });

    test('ignores event-name symbols and unlabelled topic scalars', () => {
      // First topic is the event-name symbol, not the invoice id.
      expect(deriveInvoiceId({ topics: [{ sym: 'escrow_funded' }] })).toBeNull();
      expect(deriveInvoiceId({ topics: ['escrow_funded', 'GSOMETHING'] })).toBeNull();
    });

    test('falls back to reverse lookup by contract address', () => {
      const reverse = jest.fn((addr) => (addr === 'CABC' ? 'inv_mapped' : null));
      expect(deriveInvoiceId({ contract_id: 'CABC' }, reverse)).toBe('inv_mapped');
      expect(reverse).toHaveBeenCalledWith('CABC');
    });

    test('returns null when only a bare contract address is present (no mis-keying)', () => {
      const reverse = jest.fn(() => null);
      expect(deriveInvoiceId({ contract_id: 'CABCDEF' }, reverse)).toBeNull();
    });

    test('rejects values that do not match the invoice id format', () => {
      const reverse = jest.fn(() => 'bad invoice id');
      expect(deriveInvoiceId({ contract_id: 'CABC' }, reverse)).toBeNull();
      expect(deriveInvoiceId({ invoice_id: 'has space' })).toBeNull();
    });
  });

  describe('shouldReplaceProjection', () => {
    test('returns true when no current projection exists', () => {
      expect(shouldReplaceProjection(null, { ledgerSequence: 10, pagingToken: '1' })).toBe(true);
    });

    test('newer ledger replaces older projection', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 101, pagingToken: '0' })).toBe(true);
    });

    test('older ledger is ignored', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 99, pagingToken: '999' })).toBe(false);
    });

    test('equal ledger uses paging-token tiebreaker: greater token replaces', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 100, pagingToken: '11' })).toBe(true);
    });

    test('equal ledger uses paging-token tiebreaker: equal/smaller token does not replace', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 100, pagingToken: '10' })).toBe(false);
      expect(shouldReplaceProjection(current, { ledgerSequence: 100, pagingToken: '09' })).toBe(false);
    });

    test('handles null projection fields safely', () => {
      const current = { latest_ledger_sequence: null, latest_paging_token: null };
      expect(shouldReplaceProjection(current, { ledgerSequence: 1, pagingToken: '1' })).toBe(true);
      expect(shouldReplaceProjection(current, { ledgerSequence: 0, pagingToken: '1' })).toBe(true);
    });

    test('treats missing pagingToken as empty string for tiebreak', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 100 })).toBe(false);
    });
  });

  describe('persistEscrowEvent', () => {
    test('upserts projection when event is newer', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-1',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 10,
          pagingToken: '10',
          eventBody: { ok: true },
          observedAt: '2026-01-01T00:00:00Z',
        }
      );

      const projection = await store.findProjection('inv_1');
      expect(projection).toBeTruthy();
      expect(projection.latest_event_id).toBe('evt-1');
      expect(store._state.eventsById.has('evt-1')).toBe(true);
    });

    test('older event does not replace projection (but is still idempotently recorded)', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-new',
          invoiceId: 'inv_1',
          eventType: 'escrow_updated',
          ledgerSequence: 20,
          pagingToken: '20',
        }
      );

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-old',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 19,
          pagingToken: '999',
        }
      );

      const projection = await store.findProjection('inv_1');
      expect(projection.latest_event_id).toBe('evt-new');
      expect(store._state.eventsById.has('evt-old')).toBe(true);
    });

    test('duplicate event_id is idempotent (no projection churn)', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-dup',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 10,
          pagingToken: '10',
        }
      );

      const firstProjection = await store.findProjection('inv_1');

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-dup',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 10,
          pagingToken: '10',
        }
      );

      const secondProjection = await store.findProjection('inv_1');
      expect(secondProjection.latest_event_id).toBe('evt-dup');
      expect(store._state.eventsById.size).toBe(1);
      expect(secondProjection).toEqual(firstProjection);
    });

    test('throws on invalid event payload (normalizeEvent)', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await expect(
        persistEscrowEvent(
          { store, transactionRunner },
          { eventId: 'evt-bad', invoiceId: 'inv_1', eventType: 'x', ledgerSequence: 0 }
        )
      ).rejects.toThrow(/ledgerSequence/i);
    });
  });

  describe('runEscrowIndexerCycle', () => {
    test('counts processed vs skipped; invalid events do not abort cycle', async () => {
      const store = createInMemoryStore({ cursor: 'cur-0' });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({
        events: [
          // valid
          { eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' },
          // invalid invoiceId format
          { eventId: 'evt-2', invoiceId: '!!!', eventType: 'escrow_created', ledgerSequence: 2, pagingToken: '2' },
          // valid
          { eventId: 'evt-3', invoiceId: 'inv_2', eventType: 'escrow_updated', ledgerSequence: 3, pagingToken: '3' },
        ],
        nextCursor: 'cur-1',
      });

      const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
        log,
        batchSize: 100,
      });

      expect(summary.processed).toBe(2);
      expect(summary.skipped).toBe(1);
      expect(log.warn).toHaveBeenCalled();
      expect(store._state.saveCursorCalls).toEqual(['cur-1']);
    });

    test('cursor only advances when changed', async () => {
      const store = createInMemoryStore({ cursor: 'cur-0' });
      const transactionRunner = createTransactionRunner();

      const fetchEscrowEventsSameCursor = async () => ({
        events: [{ eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' }],
        nextCursor: 'cur-0',
      });

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents: fetchEscrowEventsSameCursor,
        transactionRunner,
        log: { warn: jest.fn() },
        batchSize: 100,
      });

      expect(summary.cursorBefore).toBe('cur-0');
      expect(summary.cursorAfter).toBe('cur-0');
      expect(store._state.saveCursorCalls).toEqual([]);
    });

    test('does not save cursor when nextCursor is null/unchanged', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({
        events: [],
        nextCursor: null,
      });

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
        log: { warn: jest.fn() },
        batchSize: 100,
      });

      expect(summary.processed).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.cursorBefore).toBeNull();
      expect(summary.cursorAfter).toBeNull();
      expect(store._state.saveCursorCalls).toEqual([]);
    });

    test('uses default logger + batchSize when not provided', async () => {
      const store = createInMemoryStore({ cursor: 'cur-0' });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async ({ cursor, limit }) => {
        expect(cursor).toBe('cur-0');
        expect(limit).toBe(100);
        return {
          events: [{ eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' }],
          nextCursor: 'cur-1',
        };
      };

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
      });

      expect(summary.processed).toBe(1);
      expect(store._state.saveCursorCalls).toEqual(['cur-1']);
    });
  });

  describe('createEscrowIndexer (DI hooks)', () => {
    test('runCycle is re-entrant safe (skips overlapping cycles)', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({
        events: [{ eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' }],
        nextCursor: 'cur-1',
      });

      let resolveBlocker;
      const blocker = new Promise((r) => { resolveBlocker = r; });

      const slowFetch = async (params) => {
        await blocker;
        return fetchEscrowEvents(params);
      };

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents: slowFetch,
        transactionRunner,
        pollIntervalMs: 10,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      const p1 = indexer.runCycle();
      const p2 = indexer.runCycle();
      resolveBlocker();

      const first = await p1;
      const second = await p2;
      expect(first).toBeTruthy();
      expect(second).toBeNull();
    });

    test('start/stop are idempotent', async () => {
      jest.useFakeTimers();
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({ events: [], nextCursor: null });

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
        pollIntervalMs: 10,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      indexer.start();
      indexer.start();
      jest.advanceTimersByTime(25);
      indexer.stop();
      indexer.stop();
      jest.useRealTimers();
    });

    test('runCycle logs error and returns null on failure', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => {
        throw new Error('horizon down');
      };

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
        pollIntervalMs: 10,
      });

      const result = await indexer.runCycle();
      expect(result).toBeNull();
    });

    test('runCycle success path works without custom logger', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({ events: [], nextCursor: null });

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
      });

      const result = await indexer.runCycle();
      expect(result).toMatchObject({ processed: 0, skipped: 0 });
    });
  });

  describe('createKnexEscrowEventStore', () => {
    const { createKnexEscrowEventStore } = require('../../src/jobs/escrowIndexer');

    function fakeKnex() {
      const calls = { inserts: [], merges: [], wheres: [], conflicts: [] };
      const builder = {
        where(arg) { calls.wheres.push(arg); return this; },
        first: jest.fn(async () => ({ value: 'cursor-x', invoice_id: 'inv_1' })),
        insert(arg) { calls.inserts.push(arg); return this; },
        onConflict(arg) { calls.conflicts.push(arg); return this; },
        merge(arg) { calls.merges.push(arg); return Promise.resolve(); },
        ignore: jest.fn(async () => {}),
      };
      const knex = jest.fn(() => builder);
      knex.fn = { now: () => 'NOW()' };
      knex._calls = calls;
      knex._builder = builder;
      return knex;
    }

    test('loadCursor returns stored value and null when missing', async () => {
      const knex = fakeKnex();
      const store = createKnexEscrowEventStore(knex);
      expect(await store.loadCursor()).toBe('cursor-x');
      knex._builder.first.mockResolvedValueOnce(undefined);
      expect(await store.loadCursor()).toBeNull();
    });

    test('saveCursor upserts on key', async () => {
      const knex = fakeKnex();
      const store = createKnexEscrowEventStore(knex);
      await store.saveCursor('new-cursor');
      expect(knex._calls.conflicts).toContain('key');
      expect(knex._calls.merges[0].value).toBe('new-cursor');
    });

    test('findProjection queries by invoice_id', async () => {
      const knex = fakeKnex();
      const store = createKnexEscrowEventStore(knex);
      const row = await store.findProjection('inv_1');
      expect(row.invoice_id).toBe('inv_1');
      expect(knex._calls.wheres).toContainEqual({ invoice_id: 'inv_1' });
    });

    test('upsertEvent ignores on event_id conflict', async () => {
      const knex = fakeKnex();
      const store = createKnexEscrowEventStore(knex);
      await store.upsertEvent(knex, {
        eventId: 'evt_1', invoiceId: 'inv_1', eventType: 't',
        ledgerSequence: 1, pagingToken: null, contractId: 'C', txHash: null,
        eventBody: {}, observedAt: 'now',
      });
      expect(knex._calls.conflicts).toContain('event_id');
      expect(knex._builder.ignore).toHaveBeenCalled();
      expect(knex._calls.inserts[0].invoice_id).toBe('inv_1');
    });

    test('upsertProjection merges on invoice_id conflict', async () => {
      const knex = fakeKnex();
      const store = createKnexEscrowEventStore(knex);
      await store.upsertProjection(knex, {
        eventId: 'evt_1', invoiceId: 'inv_1', eventType: 't',
        ledgerSequence: 5, pagingToken: '5-1', eventBody: {}, observedAt: 'now',
      });
      expect(knex._calls.conflicts).toContain('invoice_id');
      expect(knex._calls.merges[0].latest_event_id).toBe('evt_1');
    });
  });

  describe('createEscrowIndexer lifecycle', () => {
    const { createEscrowIndexer } = require('../../src/jobs/escrowIndexer');
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const baseStore = () => ({
      loadCursor: jest.fn(async () => null),
      saveCursor: jest.fn(async () => {}),
      upsertEvent: jest.fn(async () => {}),
      findProjection: jest.fn(async () => null),
      upsertProjection: jest.fn(async () => {}),
    });

    test('runCycle returns a summary and is re-entrancy guarded', async () => {
      const indexer = createEscrowIndexer({
        store: baseStore(),
        transactionRunner: async (h) => h({}),
        fetchEscrowEvents: async () => ({ events: [], nextCursor: null }),
        log,
      });
      const summary = await indexer.runCycle();
      expect(summary).toMatchObject({ processed: 0, skipped: 0 });
    });

    test('runCycle returns null and logs on failure', async () => {
      const indexer = createEscrowIndexer({
        store: baseStore(),
        transactionRunner: async (h) => h({}),
        fetchEscrowEvents: async () => { throw new Error('boom'); },
        log,
      });
      expect(await indexer.runCycle()).toBeNull();
      expect(log.error).toHaveBeenCalled();
    });

    test('start/stop manage the poll timer', async () => {
      jest.useFakeTimers();
      const fetchEscrowEvents = jest.fn(async () => ({ events: [], nextCursor: null }));
      const indexer = createEscrowIndexer({
        store: baseStore(),
        transactionRunner: async (h) => h({}),
        fetchEscrowEvents,
        pollIntervalMs: 1000,
        log,
      });
      indexer.start();
      indexer.start(); // idempotent
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      indexer.stop();
      indexer.stop(); // idempotent
      jest.useRealTimers();
      expect(fetchEscrowEvents).toHaveBeenCalled();
    });
  });

  describe('fetchEscrowEventsFromHorizon invoice/contract mapping', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
      resolveInvoiceByAddress.mockReset();
      resolveInvoiceByAddress.mockReturnValue(null);
    });

    function mockHorizon(records) {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ _embedded: { records } }),
      }));
    }

    test('keys events under the resolved invoice_id, keeping contractId separate', async () => {
      mockHorizon([
        {
          id: 'evt_a',
          contract_id: 'CCONTRACTADDR',
          type: 'contract',
          ledger: 500,
          paging_token: '500-1',
          tx_hash: 'tx1',
          value: { invoice_id: 'inv_500' },
        },
      ]);

      const { events, nextCursor } = await fetchEscrowEventsFromHorizon({
        baseUrl: 'https://horizon.example',
        cursor: null,
        limit: 10,
      });

      expect(events).toHaveLength(1);
      expect(events[0].invoiceId).toBe('inv_500');
      expect(events[0].contractId).toBe('CCONTRACTADDR');
      expect(nextCursor).toBe('500-1');
    });

    test('skips contract-only events with no resolvable invoice but still advances cursor', async () => {
      mockHorizon([
        {
          id: 'evt_resolvable',
          contract_id: 'CADDR1',
          ledger: 600,
          paging_token: '600-1',
          topics: [{ invoice_id: 'inv_600' }],
        },
        {
          id: 'evt_unresolvable',
          contract_id: 'CADDR2',
          ledger: 601,
          paging_token: '601-9',
        },
      ]);

      const { events, nextCursor } = await fetchEscrowEventsFromHorizon({
        baseUrl: 'https://horizon.example',
        cursor: '599-1',
        limit: 10,
      });

      expect(events).toHaveLength(1);
      expect(events[0].invoiceId).toBe('inv_600');
      // cursor advances past the last record, including the skipped one
      expect(nextCursor).toBe('601-9');
    });

    test('resolves invoice via escrowMap reverse lookup when payload lacks it', async () => {
      resolveInvoiceByAddress.mockImplementation((addr) =>
        addr === 'CMAPPED' ? 'inv_from_map' : null
      );
      mockHorizon([
        {
          id: 'evt_map',
          contract_id: 'CMAPPED',
          ledger: 700,
          paging_token: '700-1',
        },
      ]);

      const { events } = await fetchEscrowEventsFromHorizon({
        baseUrl: 'https://horizon.example',
        cursor: null,
        limit: 10,
      });

      expect(events).toHaveLength(1);
      expect(events[0].invoiceId).toBe('inv_from_map');
      expect(events[0].contractId).toBe('CMAPPED');
    });

    test('returns existing cursor when Horizon yields no records', async () => {
      mockHorizon([]);
      const { events, nextCursor } = await fetchEscrowEventsFromHorizon({
        baseUrl: 'https://horizon.example',
        cursor: 'keep-me',
        limit: 10,
      });
      expect(events).toEqual([]);
      expect(nextCursor).toBe('keep-me');
    });

    test('throws on non-ok Horizon response', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      }));
      await expect(
        fetchEscrowEventsFromHorizon({ baseUrl: 'https://horizon.example', cursor: null, limit: 5 })
      ).rejects.toThrow('Horizon events request failed (503)');
    });
  });
});
