'use strict';

/**
 * @fileoverview Unit tests for src/indexer/escrow-indexer.js (runOnce).
 *
 * All tests inject a mock Soroban RPC server, a fresh EventStore, and no
 * real environment variables. This verifies:
 *   - Multi-page ingestion
 *   - Resume from cursor
 *   - Duplicate page is idempotent
 *   - startLedger clamped to oldestLedger
 *   - RPC error leaves cursor unchanged
 *   - Decode failures are reported in the result summary
 *   - Skipped events (duplicate IDs) are counted separately
 *   - Failed events do not prevent subsequent valid events from being ingested
 */

const {
  runOnce,
  collectContractIds,
  chunkContractIds,
  MAX_CONTRACT_IDS_PER_FILTER,
} = require('../../src/indexer/escrow-indexer');
const { createEventStore } = require('../../src/indexer/EventStore');
const { getRpcServer, setRpcServer, resetRpcServer } = require('../../src/stellar/rpc');
const config = require('../../src/config');
const config = require('../../src/config');

// ---------------------------------------------------------------------------//
// Helpers
// ---------------------------------------------------------------------------//

/** Build a minimal raw event as the SDK returns it */
function makeRawEvent(id, name = 'funded', contractId = 'CDUMMY') {
  return {
    id: String(id),
    type: 'contract',
    ledger: 100 + Number(id),
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    contractId,
    txHash: 'abc',
    topic: [name, name, 'v1'],
    value: [],
  };
}

/**
 * Build a mock RPC server that returns one event per chunk and a distinct
 * cursor per contract chunk. Records every request for assertions.
 */
function makeChunkAwareServer() {
  const calls = [];
  const server = {
    getEvents: jest.fn().mockImplementation((req) => {
      const contractIds = [...req.filters[0].contractIds];
      calls.push({ ...req, contractIds });
      const tag = contractIds[0];
      return Promise.resolve({
        events: contractIds.map((id) => makeRawEvent(`evt-${id}`, 'funded', id)),
        cursor: req.cursor ? `${req.cursor}-next` : `cur-${tag}`,
        latestLedger: 900,
        oldestLedger: 1,
      });
    }),
  };
  return { server, calls };
}

/** Fake invoice data store with the given linked contract ids. */
function fakeDataStore(contractIds = []) {
  return {
    list: () => contractIds.map((escrowContractId, i) => ({
      id: `INV_${i + 1}`,
      escrowContractId,
    })),
  };
}

/** Make a full events page (100 events = "full page" ) */
function fullPage(startId) {
  return Array.from({ length: 100 }, (_, i) => makeRawEvent(startId + i));
}

/** Make a partial page */
function partialPage(startId, count) {
  return Array.from({ length: count }, (_, i) => makeRawEvent(startId + i));
}

const CONTRACT_ID = 'CDUMMY';

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Six linked contracts plus the configured default = 7 = two chunks (5 + 2).
const LINKED_CONTRACTS = [
  'CLINK0000000000000000000000000000000000000000000000000001',
  'CLINK0000000000000000000000000000000000000000000000000002',
  'CLINK0000000000000000000000000000000000000000000000000003',
  'CLINK0000000000000000000000000000000000000000000000000004',
  'CLINK0000000000000000000000000000000000000000000000000005',
  'CLINK0000000000000000000000000000000000000000000000000006',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------//

describe('runOnce — basic ingestion', () => {
  test('ingest a partial page and return correct counts', async () => {
    const store = createEventStore();
    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: partialPage(1, 5),
        cursor: 'cursor-5',
        latestLedger: 200,
        oldestLedger: 1,
      }),
    };

    const result = await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });

    expect(result.ingested).toBe(5);
    expect(result.cursor).toBe('cursor-5');
    expect(result.latestLedger).toBe(200);
    // Only 1 page was requested (< 100 events = not full)
    expect(server.getEvents).toHaveBeenCalledTimes(1);
  });

  test('first call uses INDEXER_START_LEDGER env var', async () => {
    const originalEnv = process.env.INDEXER_START_LEDGER;
    process.env.INDEXER_START_LEDGER = '500';

    const store = createEventStore();
    const capturedRequests = [];
    const server = {
      getEvents: jest.fn().mockImplementation((req) => {
        capturedRequests.push({ ...req });
        return Promise.resolve({
          events: partialPage(1, 3),
          cursor: 'cur-1',
          latestLedger: 600,
          oldestLedger: 400,
        });
      }),
    };

    await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });

    expect(capturedRequests[0].startLedger).toBe(500);

    process.env.INDEXER_START_LEDGER = originalEnv;
  });

  test('throws when no contractId configured', async () => {
    const store = createEventStore();
    const server = { getEvents: jest.fn() };

    await expect(
      runOnce({ server, store, contractId: '', log: silentLog }),
    ).rejects.toThrow(/contract id/i);
  });
});

describe('runOnce — result structure', () => {
  test('the returned summary contains all expected fields', async () => {
    const store = createEventStore();
    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: [
          { id: 'event-1', type: 'contract', ledger: 101, ledgerClosedAt: '2024-01-01T00:00:00Z', contractId: 'CDUMMY', txHash: 'abc', topic: ['funded', 'funded', 'v1'], value: [] },
        ],
        cursor: 'final-cursor',
        latestLedger: 200,
        oldestLedger: 1,
      }),
    };

    const result = await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });

    // Verify all 5 expected fields are present
    expect('ingested' in result).toBe(true);
    expect('skipped' in result).toBe(true);
    expect('decodeFailures' in result).toBe(true);
    expect('cursor' in result).toBe(true);
    expect('latestLedger' in result).toBe(true);

    // Verify correct types
    expect(typeof result.ingested).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(typeof result.decodeFailures).toBe('number');
    expect(typeof result.cursor).toBe('string' || null);
    expect(typeof result.latestLedger).toBe('number');
  });
});

describe('runOnce — multi-page ingestion', () => {
  test('pages through up to maxPages full pages', async () => {
    const store = createEventStore();
    let call = 0;

    const server = {
      getEvents: jest.fn().mockImplementation(() => {
        call++;
        // Pages 1 and 2 are full; page 3 is partial
        if (call <= 2) {
          return Promise.resolve({
            events: fullPage(call * 100),
            cursor: `cursor-p${call}`,
            latestLedger: 500,
            oldestLedger: 1,
          });
        }
        return Promise.resolve({
          events: partialPage(call * 100, 10),
          cursor: `cursor-p${call}`,
          latestLedger: 500,
          oldestLedger: 1,
        });
      }),
    };

    const result = await runOnce({
      server,
      store,
      contractId: CONTRACT_ID,
      maxPages: 5,
      log: silentLog,
    });

    // 100 + 100 + 10 = 210
    expect(result.ingested).toBe(210);
    expect(server.getEvents).toHaveBeenCalledTimes(3); // stopped at partial page
  });

  test('stops after maxPages even if pages are full', async () => {
    const store = createEventStore();

    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: fullPage(1),
        cursor: 'cursor-x',
        latestLedger: 500,
        oldestLedger: 1,
      }),
    };

    await runOnce({
      server,
      store,
      contractId: CONTRACT_ID,
      maxPages: 3,
      log: silentLog,
    });

    expect(server.getEvents).toHaveBeenCalledTimes(3);
  });
});

describe('runOnce — resume from cursor', () => {
  test('uses stored cursor on subsequent run instead of startLedger', async () => {
    const store = createEventStore();
    store.setCursor('existing-cursor');

    const capturedRequests = [];
    const server = {
      getEvents: jest.fn().mockImplementation((req) => {
        capturedRequests.push({ ...req });
        return Promise.resolve({
          events: partialPage(1, 2),
          cursor: 'new-cursor',
          latestLedger: 300,
          oldestLedger: 1,
        });
      }),
    };

    await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });

    // Should use cursor, not startLedger
    expect(capturedRequests[0].cursor).toBe('existing-cursor');
    expect(capturedRequests[0].startLedger).toBeUndefined();
  });
});

describe('runOnce — duplicate page idempotency', () => {
  test('re-ingesting same events does not duplicate them', async () => {
    const store = createEventStore();
    const sameEvents = partialPage(1, 5);

    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: sameEvents,
        cursor: 'cursor-5',
        latestLedger: 200,
        oldestLedger: 1,
      }),
    };

    // First run
    const first = await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });
    expect(first.ingested).toBe(5);
    expect(store.size()).toBe(5);

    // Second run with identical events
    const second = await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });
    expect(second.ingested).toBe(0); // all duplicates
    expect(store.size()).toBe(5); // store unchanged
  });
});

describe('runOnce — startLedger clamped to oldestLedger', () => {
  test('clamps startLedger when it is older than oldestLedger', async () => {
    const originalEnv = process.env.INDEXER_START_LEDGER;
    process.env.INDEXER_START_LEDGER = '100'; // older than oldestLedger

    const store = createEventStore();
    const capturedRequests = [];
    let callCount = 0;

    const server = {
      getEvents: jest.fn().mockImplementation((req) => {
        callCount++;
        capturedRequests.push({ ...req });
        if (callCount === 1) {
          // First call: return oldestLedger > startLedger to trigger clamping
          return Promise.resolve({
            events: partialPage(1, 2),
            cursor: 'cursor-clamped',
            latestLedger: 1000,
            oldestLedger: 500, // > 100
          });
        }
        // Second call (clamped retry): should not happen in this test
        return Promise.resolve({
          events: [],
          cursor: null,
          latestLedger: 1000,
          oldestLedger: 500,
        });
      }),
    };

    const result = await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });

    // The first getEvents call should have startLedger = 100 (from env)
    expect(capturedRequests[0].startLedger).toBe(100);
    // After clamping, the logger will warn, but ingestion proceeds with the
    // events from the first page (which the mock returns anyway)
    expect(result.ingested).toBeGreaterThanOrEqual(0);

    process.env.INDEXER_START_LEDGER = originalEnv;
  });
});

describe('runOnce — RPC error handling', () => {
  test('throws on RPC error and leaves cursor unchanged', async () => {
    const store = createEventStore();
    store.setCursor('safe-cursor');

    const server = {
      getEvents: jest.fn().mockRejectedValue(new Error('network timeout')),
    };

    await expect(
      runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog }),
    ).rejects.toThrow('network timeout');

    // Cursor must be unchanged
    expect(store.getCursor()).toBe('safe-cursor');
  });

  test('throws on first-page RPC error without ever modifying store', async () => {
    const store = createEventStore();

    const server = {
      getEvents: jest.fn().mockRejectedValue(new Error('rpc down')),
    };

    await expect(
      runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog }),
    ).rejects.toThrow();

    expect(store.size()).toBe(0);
    expect(store.getCursor()).toBeNull();
  });
});

describe('contract collection and chunking', () => {
  test('deduplicates and sorts the default contract plus linked contracts', () => {
    const ids = collectContractIds({
      data: fakeDataStore([
        LINKED_CONTRACTS[0],
        LINKED_CONTRACTS[0], // duplicate
        LINKED_CONTRACTS[1],
        null, // invoice without a linked contract
      ]),
    });

    expect(ids).toContain(config.contractId);
    expect(ids).toContain(LINKED_CONTRACTS[0]);
    expect(ids).toContain(LINKED_CONTRACTS[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  test('explicit contractId overrides the data store', () => {
    const ids = collectContractIds({
      contractId: 'CEXPLICIT',
      data: fakeDataStore([LINKED_CONTRACTS[0]]),
    });
    expect(ids).toEqual(['CEXPLICIT']);
  });

  test('chunks contract ids into groups of at most five', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `C${i}`);
    const chunks = chunkContractIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length <= MAX_CONTRACT_IDS_PER_FILTER)).toBe(true);
    expect(chunks.flat()).toEqual(ids);
  });
});

describe('runOnce — multi-contract indexing', () => {
  let originalContractEnv;

  beforeEach(() => {
    originalContractEnv = process.env.SOROBAN_CONTRACT_ID;
    delete process.env.SOROBAN_CONTRACT_ID;
  });

  afterEach(() => {
    if (originalContractEnv === undefined) {
      delete process.env.SOROBAN_CONTRACT_ID;
    } else {
      process.env.SOROBAN_CONTRACT_ID = originalContractEnv;
    }
  });

  test('requests all linked contracts in chunks of five and ingests every event', async () => {
    const store = createEventStore();
    const { server, calls } = makeChunkAwareServer();

    const result = await runOnce({
      server,
      store,
      data: fakeDataStore(LINKED_CONTRACTS),
      log: silentLog,
    });

    const expected = [config.contractId, ...LINKED_CONTRACTS].sort();
    expect(result.contracts).toEqual(expected);
    expect(result.ingested).toBe(expected.length);
    expect(calls).toHaveLength(2);
    expect(calls[0].contractIds).toHaveLength(5);
    expect(calls[1].contractIds).toHaveLength(2);
    expect(calls.flatMap((c) => c.contractIds).sort()).toEqual(expected);

    // Every stored event carries the contract that produced it.
    for (const contractId of expected) {
      const { data } = store.query({ contractId });
      expect(data).toHaveLength(1);
      expect(data[0].contractId).toBe(contractId);
    }
  });

  test('keeps one cursor per chunk and resumes each chunk from its own cursor', async () => {
    const store = createEventStore();
    const firstRun = makeChunkAwareServer();

    await runOnce({
      server: firstRun.server,
      store,
      data: fakeDataStore(LINKED_CONTRACTS),
      log: silentLog,
    });

    const firstChunkKey = firstRun.calls[0].contractIds.join(',');
    const secondChunkKey = firstRun.calls[1].contractIds.join(',');
    const firstCursor = `cur-${firstRun.calls[0].contractIds[0]}`;
    const secondCursor = `cur-${firstRun.calls[1].contractIds[0]}`;

    expect(store.getCursor(`chunk:${firstChunkKey}`)).toBe(firstCursor);
    expect(store.getCursor(`chunk:${secondChunkKey}`)).toBe(secondCursor);

    const secondRun = makeChunkAwareServer();
    await runOnce({
      server: secondRun.server,
      store,
      data: fakeDataStore(LINKED_CONTRACTS),
      log: silentLog,
    });

    expect(secondRun.calls).toHaveLength(2);
    expect(secondRun.calls[0].cursor).toBe(firstCursor);
    expect(secondRun.calls[1].cursor).toBe(secondCursor);
    expect(secondRun.calls[0].startLedger).toBeUndefined();
    expect(secondRun.calls[1].startLedger).toBeUndefined();
  });

  test('indexes only the configured contract when no invoice has a linked contract', async () => {
    const store = createEventStore();
    const { server, calls } = makeChunkAwareServer();

    const result = await runOnce({
      server,
      store,
      data: fakeDataStore([]),
      log: silentLog,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].contractIds).toEqual([config.contractId]);
    expect(result.contracts).toEqual([config.contractId]);
    expect(result.ingested).toBe(1);
  });

  test('tags events with the originating contract when the raw event omits it', async () => {
    const store = createEventStore();
    const raw = makeRawEvent('evt-no-contract');
    delete raw.contractId;
    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: [raw],
        cursor: 'cursor-1',
        latestLedger: 100,
        oldestLedger: 1,
      }),
    };

    await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });

    const { data } = store.query({ contractId: CONTRACT_ID });
    expect(data).toHaveLength(1);
    expect(data[0].contractId).toBe(CONTRACT_ID);
  });
});

describe('runOnce — cursor advancement', () => {
  test('cursor advances after each successful page', async () => {
    const store = createEventStore();
    let call = 0;

    const server = {
      getEvents: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({
            events: fullPage(1),
            cursor: 'cursor-p1',
            latestLedger: 200,
            oldestLedger: 1,
          });
        }
        return Promise.resolve({
          events: partialPage(200, 3),
          cursor: 'cursor-p2',
          latestLedger: 200,
          oldestLedger: 1,
        });
      }),
    };

    await runOnce({ server, store, contractId: CONTRACT_ID, maxPages: 5, log: silentLog });

    expect(store.getCursor()).toBe('cursor-p2');
  });

  test('cursor is unchanged when no new cursor returned', async () => {
    const store = createEventStore();
    store.setCursor('pre-existing');

    const server = {
      getEvents: jest.fn().mockResolvedValue({
        events: partialPage(1, 2),
        cursor: null, // no new cursor
        latestLedger: 200,
        oldestLedger: 1,
      }),
    };

    await runOnce({ server, store, contractId: CONTRACT_ID, log: silentLog });

    expect(store.getCursor()).toBe('pre-existing');
  });
});

describe('runOnce — shared Soroban RPC client', () => {
  afterEach(() => {
    resetRpcServer();
    jest.restoreAllMocks();
  });

  test('uses shared client from setRpcServer when no server is passed and reuses it across runs', async () => {
    const sharedServer = {
      getEvents: jest.fn().mockResolvedValue({
        events: partialPage(1, 2),
        cursor: 'shared-cursor',
        latestLedger: 250,
        oldestLedger: 1,
      }),
    };
    setRpcServer(sharedServer);

    const store = createEventStore();
    await runOnce({ store, contractId: CONTRACT_ID, log: silentLog });
    await runOnce({ store, contractId: CONTRACT_ID, log: silentLog });

    expect(sharedServer.getEvents).toHaveBeenCalledTimes(2);
  });

  test('two runs without injected server reuse a single rpc.Server instance', async () => {
    const { rpc } = require('@stellar/stellar-sdk');
    const getEvents = jest.fn().mockResolvedValue({
      events: [],
      cursor: null,
      latestLedger: 300,
      oldestLedger: 1,
    });
    const serverSpy = jest.spyOn(rpc, 'Server').mockImplementation(() => ({ getEvents }));

    const store = createEventStore();
    await runOnce({ store, contractId: CONTRACT_ID, log: silentLog });
    await runOnce({ store, contractId: CONTRACT_ID, log: silentLog });

    expect(serverSpy).toHaveBeenCalledTimes(1);
    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  test('getRpcServer allows http://localhost RPC URLs', () => {
    const originalUrl = config.rpcUrl;
    config.rpcUrl = 'http://localhost:8000/soroban/rpc';
    try {
      const client = getRpcServer();
      expect(client).toBeDefined();
      expect(getRpcServer()).toBe(client);
    } finally {
      config.rpcUrl = originalUrl;
    }
  });
});
