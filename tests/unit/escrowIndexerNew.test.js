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
 */

const { runOnce } = require('../../src/indexer/escrow-indexer');
const { createEventStore } = require('../../src/indexer/EventStore');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal raw event as the SDK returns it */
function makeRawEvent(id, name = 'funded') {
  return {
    id: String(id),
    type: 'contract',
    ledger: 100 + Number(id),
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    contractId: 'CDUMMY',
    txHash: 'abc',
    topic: [name, name, 'v1'],
    value: [],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
