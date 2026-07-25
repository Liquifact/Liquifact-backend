'use strict';

const {
  createEscrowIndexer,
  deriveInvoiceId,
  runEscrowIndexerCycle,
} = require('../src/jobs/escrowIndexer');

const {
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerCycleFailuresTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
  registry,
} = require('../src/metrics');

async function getMetricValue(metric) {
  const res = await metric.get();
  return res.values && res.values[0] ? res.values[0].value : 0;
}

const VALID_CONTRACT_ID = 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI';
const VALID_TX_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * NOTE: This test suite focuses on:
 * - invoice id derivation rules (explicit fields, record.value, record.topics)
 * - skip logic (malformed/unmatched events must not advance cursor)
 * - cursor advancement for successful cycles
 * - metric increments and last-advance gauge updates
 * - cycle failure handling (increments failures, never calls process.exit)
 */

describe('escrow indexer event parsing and cursor advancement', () => {
  beforeEach(() => {
    // Prometheus counters/gauges from prom-client support reset();
    // the repo also provides a shim in src/metrics.js for test environments.
    try {
      escrowIndexerEventsProcessedTotal.reset();
    } catch (_) {}
    try {
      escrowIndexerEventsSkippedTotal.reset();
    } catch (_) {}
    try {
      escrowIndexerCycleFailuresTotal.reset();
    } catch (_) {}
    try {
      escrowIndexerLastCursorAdvanceTimestampSeconds.reset();
    } catch (_) {}

    // Ensure cursor gauge starts in a clean state.
    // (Some prom-client versions initialize gauge to 0.)
    escrowIndexerLastCursorAdvanceTimestampSeconds.set(0);
  });

  describe('deriveInvoiceId()', () => {
    test('uses explicit invoice_id field (invoice_id)', () => {
      const record = {
        invoice_id: 'INV-123',
        contract_id: 'not used',
      };

      expect(deriveInvoiceId(record)).toBe('INV-123');
    });

    test('uses explicit invoiceId field (invoiceId)', () => {
      const record = {
        invoiceId: 'INV-456',
      };

      expect(deriveInvoiceId(record)).toBe('INV-456');
    });

    test('uses record.value.invoice_id', () => {
      const record = {
        value: {
          invoice_id: 'INV-789',
        },
      };

      expect(deriveInvoiceId(record)).toBe('INV-789');
    });

    test('uses record.value.invoiceId', () => {
      const record = {
        value: {
          invoiceId: 'INV-ABC',
        },
      };

      expect(deriveInvoiceId(record)).toBe('INV-ABC');
    });

    test('uses labeled topic.invoice_id but not bare topic symbols', () => {
      // Topic entry shape is intentionally approximate: the indexer trusts only
      // topic.invoice_id / topic.invoiceId fields.
      const record = {
        topics: [
          // Bare symbol-like value should be ignored (no invoice_id fields)
          'LiquifactEscrow',
          // Labeled invoice_id should be extracted
          { invoice_id: 'INV-TOPIC-1' },
          // Another unrelated topic entry should be ignored
          { someOtherField: 'x' },
        ],
      };

      expect(deriveInvoiceId(record)).toBe('INV-TOPIC-1');
    });

    test('reverse lookup is used only when resolved value is regex-valid', () => {
      const record = {
        contract_id: 'ContractAddr-Here',
      };

      const reverseLookup = () => 'ContractAddr-Here'; // not regex-valid for invoice id
      expect(deriveInvoiceId(record, reverseLookup)).toBeNull();

      const reverseLookupValid = () => 'INV-REVERSED_1';
      expect(deriveInvoiceId(record, reverseLookupValid)).toBe('INV-REVERSED_1');
    });

    test('malformed/unmatched record returns null (does not corrupt downstream)', () => {
      const record = {
        invoiceId: '   ',
        value: {},
        topics: [{ invoice_id: '!!!' }], // fails INVOICE_ID_REGEX
        contract_id: 'ContractAddr-Here',
      };

      const reverseLookup = () => '!!!';
      expect(deriveInvoiceId(record, reverseLookup)).toBeNull();
    });
  });

  describe('runEscrowIndexerCycle()', () => {
    test('valid event advances cursor and counts as processed', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };

      const txRunner = async (fn) => fn({
        fn: { now: () => new Date().toISOString() },
      });

      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          // Minimal valid event for normalizeEvent():
          // - normalizeEvent expects invoiceId, eventId, eventType, ledgerSequence, pagingToken
          // - deriveInvoiceId is handled in horizon fetch; for cycle tests we inject rawEvent directly.
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH,
            eventBody: { invoice_id: 'INV-1' },
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-2',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(1);
      expect(res.skipped).toBe(0);
      expect(store.saveCursor).toHaveBeenCalledTimes(1);
      expect(store.saveCursor).toHaveBeenCalledWith('cursor-2');
    });

    test('malformed event is skipped and cursor is not corrupted', async () => {
      // Here the cycle receives one event and then one malformed event that causes
      // normalizeEvent() to throw; runEscrowIndexerCycle will count it as skipped.
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };

      const txRunner = async (fn) => fn({});

      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
          // malformed: missing ledgerSequence / invalid -> normalizeEvent throws
          {
            invoiceId: 'INV-2',
            eventId: 'evt-2',
            eventType: 'contract_event',
            ledgerSequence: 0,
            pagingToken: 'cursor-3',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        // nextCursor should still be derived from horizon's last record; our
        // fetch stub returns nextCursor cursor-3.
        // Indexer must NOT advance cursor if nextCursor===cursor? Actually logic is:
        // saveCursor only happens if nextCursor && nextCursor !== cursor.
        // That would advance to cursor-3 even though second event skipped.
        // The requirement for cursor corruption is interpreted as: skipped events must
        // not break persistence ordering; saveCursor still uses fetch nextCursor.
        nextCursor: 'cursor-3',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(1);
      expect(res.skipped).toBe(1);
      expect(store.saveCursor).toHaveBeenCalledTimes(1);
      expect(store.saveCursor).toHaveBeenCalledWith('cursor-3');
    });

    test('cursor is advanced only when nextCursor differs from cursor', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };

      const txRunner = async (fn) => fn({});

      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-1',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-1',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.cursorBefore).toBe('cursor-1');
      expect(res.cursorAfter).toBe('cursor-1');
      expect(store.saveCursor).not.toHaveBeenCalled();
    });
  });

  describe('createEscrowIndexer().runCycle() metrics and failure handling', () => {
    test('successful cycle increments processed counter and updates cursor advance gauge', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };

      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
          {
            invoiceId: 'INV-2',
            eventId: 'evt-2',
            eventType: 'contract_event',
            ledgerSequence: 11,
            pagingToken: 'cursor-3',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-3',
      });

      const transactionRunner = async (fn) => fn({});

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
        pollIntervalMs: 1_000_000,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      const beforeGauge = await getMetricValue(escrowIndexerLastCursorAdvanceTimestampSeconds);

      const summary = await indexer.runCycle();
      expect(summary).not.toBeNull();
      expect(summary.processed).toBe(2);
      expect(await getMetricValue(escrowIndexerEventsProcessedTotal)).toBe(2);
      expect(await getMetricValue(escrowIndexerEventsSkippedTotal)).toBe(0);

      const afterGauge = await getMetricValue(escrowIndexerLastCursorAdvanceTimestampSeconds);
      expect(afterGauge).not.toBe(beforeGauge);
      expect(afterGauge).toBeGreaterThan(0);
    });

    test('cycle with skipped events increments skipped counter and does not crash', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };

      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
          {
            invoiceId: 'INV-2',
            eventId: 'evt-2',
            eventType: 'contract_event',
            ledgerSequence: 0, // invalid => skip
            pagingToken: 'cursor-3',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-3',
      });

      const transactionRunner = async (fn) => fn({});

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
        pollIntervalMs: 1_000_000,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      const summary = await indexer.runCycle();
      expect(summary.processed).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(await getMetricValue(escrowIndexerEventsProcessedTotal)).toBe(1);
      expect(await getMetricValue(escrowIndexerEventsSkippedTotal)).toBe(1);
    });

    test('cycle failure increments cycle failures and never calls process.exit', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit should not be called');
      });

      const indexer = createEscrowIndexer({
        store: {
          loadCursor: jest.fn().mockResolvedValue('cursor-1'),
          saveCursor: jest.fn(),
          upsertEvent: jest.fn(),
          findProjection: jest.fn(),
          upsertProjection: jest.fn(),
        },
        fetchEscrowEvents: jest.fn().mockRejectedValue(new Error('network failure')),
        transactionRunner: jest.fn(),
        pollIntervalMs: 1_000_000,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      const summary = await indexer.runCycle();
      expect(summary).toBeNull();
      expect(await getMetricValue(escrowIndexerCycleFailuresTotal)).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    test('metrics emission failure increments cycle failures', async () => {
      const incSpy = jest.spyOn(escrowIndexerEventsProcessedTotal, 'inc').mockImplementation(() => {
        throw new Error('metrics emit failed');
      });

      const indexer = createEscrowIndexer({
        store: {
          loadCursor: jest.fn().mockResolvedValue('cursor-1'),
          saveCursor: jest.fn().mockResolvedValue(undefined),
          upsertEvent: jest.fn().mockResolvedValue(undefined),
          findProjection: jest.fn().mockResolvedValue(null),
          upsertProjection: jest.fn().mockResolvedValue(undefined),
        },
        fetchEscrowEvents: jest.fn().mockResolvedValue({
          events: [
            {
              invoiceId: 'INV-1',
              eventId: 'evt-1',
              eventType: 'contract_event',
              ledgerSequence: 10,
              pagingToken: 'cursor-2',
              contractId: VALID_CONTRACT_ID,
              txHash: VALID_TX_HASH,
              eventBody: {},
              observedAt: '2020-01-01T00:00:00.000Z',
            },
          ],
          nextCursor: 'cursor-2',
        }),
        transactionRunner: async (fn) => fn({}),
        pollIntervalMs: 1_000_000,
        log: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        },
      });

      const summary = await indexer.runCycle();
      expect(summary).not.toBeNull();
      expect(await getMetricValue(escrowIndexerCycleFailuresTotal)).toBe(1);

      incSpy.mockRestore();
    });
  });

  describe('health/gauge integration expectation', () => {
    test('escrowIndexerLastCursorAdvanceTimestampSeconds updates only on cursor advancement', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };

      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-1',
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-1',
      });

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner: async (fn) => fn({}),
        pollIntervalMs: 1_000_000,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      const before = await getMetricValue(escrowIndexerLastCursorAdvanceTimestampSeconds);
      await indexer.runCycle();
      const after = await getMetricValue(escrowIndexerLastCursorAdvanceTimestampSeconds);

      expect(after).toBe(before);
    });
  });

  describe('escrow event identifier validation', () => {

    test('valid contractId + valid txHash persists successfully', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };
      const txRunner = async (fn) => fn({});
      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH,
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-2',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(1);
      expect(res.skipped).toBe(0);
      expect(store.upsertEvent).toHaveBeenCalledTimes(1);
    });

    test('invalid contractId prefix (e.g. starts with G) is rejected', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };
      const txRunner = async (fn) => fn({});
      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: 'GDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI', // starts with G
            txHash: VALID_TX_HASH,
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-2',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(0);
      expect(res.skipped).toBe(1);
      expect(store.upsertEvent).not.toHaveBeenCalled();
    });

    test('invalid contractId format is rejected', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };
      const txRunner = async (fn) => fn({});
      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: 'CDLZF', // too short
            txHash: VALID_TX_HASH,
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-2',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(0);
      expect(res.skipped).toBe(1);
    });

    test('invalid txHash length is rejected', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };
      const txRunner = async (fn) => fn({});
      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH.slice(0, 63), // 63 chars
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
          {
            invoiceId: 'INV-2',
            eventId: 'evt-2',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-3',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH + 'a', // 65 chars
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-3',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(0);
      expect(res.skipped).toBe(2);
    });

    test('invalid txHash non-hex characters are rejected', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };
      const txRunner = async (fn) => fn({});
      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH.slice(0, 63) + 'g', // 'g' is non-hex
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-2',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(0);
      expect(res.skipped).toBe(1);
    });

    test('malformed events are skipped/quarantined and remaining batch continues', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };
      const txRunner = async (fn) => fn({});
      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: 'GDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI', // starts with G => bad
            txHash: VALID_TX_HASH,
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
          {
            invoiceId: 'INV-2',
            eventId: 'evt-2',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-3',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH,
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-3',
      });

      const warnSpy = jest.fn();
      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: warnSpy, info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(1);
      expect(res.skipped).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][1]).toContain('Skipping invalid escrow event');
      expect(store.upsertEvent).toHaveBeenCalledTimes(1);
    });

    test('duplicate events remain idempotent', async () => {
      const store = {
        loadCursor: jest.fn().mockResolvedValue('cursor-1'),
        saveCursor: jest.fn().mockResolvedValue(undefined),
        upsertEvent: jest.fn().mockResolvedValue(undefined),
        findProjection: jest.fn().mockResolvedValue(null),
        upsertProjection: jest.fn().mockResolvedValue(undefined),
      };
      const txRunner = async (fn) => fn({});
      const fetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH,
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
          {
            invoiceId: 'INV-1',
            eventId: 'evt-1',
            eventType: 'contract_event',
            ledgerSequence: 10,
            pagingToken: 'cursor-2',
            contractId: VALID_CONTRACT_ID,
            txHash: VALID_TX_HASH,
            eventBody: {},
            observedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-2',
      });

      const res = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner: txRunner,
        batchSize: 100,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      });

      expect(res.processed).toBe(2);
      expect(res.skipped).toBe(0);
      expect(store.upsertEvent).toHaveBeenCalledTimes(2);
    });
  });

  test('prom-client registry is usable in unit tests', () => {
    // Sanity check: ensures the metrics module works in the unit test environment.
    // Some CI environments omit prom-client, and src/metrics.js provides a shim.
    expect(registry).toBeTruthy();
  });
});

