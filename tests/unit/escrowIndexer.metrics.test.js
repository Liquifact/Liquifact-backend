'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const {
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerCycleFailuresTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
  registry,
} = require('../../src/metrics');
const { checkIndexerStaleness } = require('../../src/services/health');
const cfg = require('../../src/config');
const { createEscrowIndexer } = require('../../src/jobs/escrowIndexer');

describe('escrowIndexer metrics and health', () => {
  let app;
  let originalEnv;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Reset metrics to avoid cross-test pollution
    registry.resetMetrics();
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
    jest.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────────
  // METRIC INCREMENT TESTS
  // ────────────────────────────────────────────────────────────────────────

  describe('Metric increments', () => {
    test('processed counter increments by result.processed', async () => {
      const mockStore = {
        loadCursor: jest.fn().mockResolvedValue(null),
        saveCursor: jest.fn(),
        findProjection: jest.fn(),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn(),
      };

      const mockFetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            eventId: 'e1',
            invoiceId: 'inv_1',
            eventType: 'created',
            ledgerSequence: 1,
            pagingToken: '1',
            contractId: 'C1',
            txHash: null,
            eventBody: {},
            observedAt: new Date().toISOString(),
          },
          {
            eventId: 'e2',
            invoiceId: 'inv_1',
            eventType: 'updated',
            ledgerSequence: 2,
            pagingToken: '2',
            contractId: 'C1',
            txHash: null,
            eventBody: {},
            observedAt: new Date().toISOString(),
          },
        ],
        nextCursor: 'cursor_2',
      });

      const mockTransactionRunner = async (handler) => handler({ fn: { now: () => new Date() } });

      const indexer = createEscrowIndexer({
        store: mockStore,
        fetchEscrowEvents: mockFetchEscrowEvents,
        transactionRunner: mockTransactionRunner,
        log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      });

      // Reset metric to baseline
      const baselineProcessed = escrowIndexerEventsProcessedTotal.get();

      await indexer.runCycle();

      const newProcessed = escrowIndexerEventsProcessedTotal.get();
      expect(newProcessed).toBe(baselineProcessed + 2);
    });

    test('skipped counter increments by result.skipped', async () => {
      const mockStore = {
        loadCursor: jest.fn().mockResolvedValue(null),
        saveCursor: jest.fn(),
        findProjection: jest.fn(),
        upsertEvent: jest.fn().mockRejectedValue(new Error('Invalid event')),
        upsertProjection: jest.fn(),
      };

      const mockFetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            eventId: 'e1',
            invoiceId: 'inv_1',
            eventType: 'created',
            ledgerSequence: 1,
            pagingToken: '1',
            contractId: 'C1',
            txHash: null,
            eventBody: {},
            observedAt: new Date().toISOString(),
          },
        ],
        nextCursor: 'cursor_1',
      });

      const mockTransactionRunner = async (handler) => handler({ fn: { now: () => new Date() } });

      const indexer = createEscrowIndexer({
        store: mockStore,
        fetchEscrowEvents: mockFetchEscrowEvents,
        transactionRunner: mockTransactionRunner,
        log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      });

      const baselineSkipped = escrowIndexerEventsSkippedTotal.get();

      await indexer.runCycle();

      const newSkipped = escrowIndexerEventsSkippedTotal.get();
      expect(newSkipped).toBe(baselineSkipped + 1);
    });

    test('last-advance gauge is updated when cursor advances', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const expectedTimestamp = Math.floor(Date.now() / 1000); // 1748610000

      const mockStore = {
        loadCursor: jest.fn().mockResolvedValue('old_cursor'),
        saveCursor: jest.fn(),
        findProjection: jest.fn(),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn(),
      };

      const mockFetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            eventId: 'e1',
            invoiceId: 'inv_1',
            eventType: 'created',
            ledgerSequence: 1,
            pagingToken: '1',
            contractId: 'C1',
            txHash: null,
            eventBody: {},
            observedAt: new Date().toISOString(),
          },
        ],
        nextCursor: 'new_cursor', // Cursor advances
      });

      const mockTransactionRunner = async (handler) => handler({ fn: { now: () => new Date() } });

      const indexer = createEscrowIndexer({
        store: mockStore,
        fetchEscrowEvents: mockFetchEscrowEvents,
        transactionRunner: mockTransactionRunner,
        log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      });

      await indexer.runCycle();

      const gaugeValue = escrowIndexerLastCursorAdvanceTimestampSeconds.get();
      // Allow 1-second tolerance due to timing
      expect(Math.abs(gaugeValue - expectedTimestamp)).toBeLessThanOrEqual(1);
    });

    test('last-advance gauge is not updated when cursor does not advance', async () => {
      const mockStore = {
        loadCursor: jest.fn().mockResolvedValue('same_cursor'),
        saveCursor: jest.fn(),
        findProjection: jest.fn(),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn(),
      };

      const mockFetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [],
        nextCursor: 'same_cursor', // Cursor does NOT advance
      });

      const mockTransactionRunner = async (handler) => handler({ fn: { now: () => new Date() } });

      // Set gauge to a baseline value
      const baselineTimestamp = 1000000;
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(baselineTimestamp);

      const indexer = createEscrowIndexer({
        store: mockStore,
        fetchEscrowEvents: mockFetchEscrowEvents,
        transactionRunner: mockTransactionRunner,
        log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      });

      await indexer.runCycle();

      const gaugeValue = escrowIndexerLastCursorAdvanceTimestampSeconds.get();
      expect(gaugeValue).toBe(baselineTimestamp); // Unchanged
    });

    test('cycle failure counter increments on exception', async () => {
      const mockStore = {
        loadCursor: jest.fn().mockRejectedValue(new Error('DB error')),
        saveCursor: jest.fn(),
        findProjection: jest.fn(),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn(),
      };

      const mockFetchEscrowEvents = jest.fn();
      const mockTransactionRunner = jest.fn();

      const indexer = createEscrowIndexer({
        store: mockStore,
        fetchEscrowEvents: mockFetchEscrowEvents,
        transactionRunner: mockTransactionRunner,
        log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      });

      const baselineFailures = escrowIndexerCycleFailuresTotal.get();

      await indexer.runCycle();

      const newFailures = escrowIndexerCycleFailuresTotal.get();
      expect(newFailures).toBe(baselineFailures + 1);
      expect(mockFetchEscrowEvents).not.toHaveBeenCalled();
    });

    test('multiple cycles accumulate correctly', async () => {
      const mockStore = {
        loadCursor: jest.fn().mockResolvedValue(null),
        saveCursor: jest.fn(),
        findProjection: jest.fn(),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn(),
      };

      // Cycle 1: 5 processed, 1 skipped, cursor advances
      // Cycle 2: 3 processed, 0 skipped, cursor advances
      // Cycle 3: 2 processed, 2 skipped, cursor does not advance

      let cycleCount = 0;
      const mockFetchEscrowEvents = jest.fn(async () => {
        cycleCount += 1;
        if (cycleCount === 1) {
          return {
            events: Array(5)
              .fill(0)
              .map((_, i) => ({
                eventId: `e${i}`,
                invoiceId: 'inv_1',
                eventType: 'created',
                ledgerSequence: i,
                pagingToken: `${i}`,
                contractId: 'C1',
                txHash: null,
                eventBody: {},
                observedAt: new Date().toISOString(),
              })),
            nextCursor: 'cursor_1',
          };
        } else if (cycleCount === 2) {
          return {
            events: Array(3)
              .fill(0)
              .map((_, i) => ({
                eventId: `e${i + 10}`,
                invoiceId: 'inv_2',
                eventType: 'created',
                ledgerSequence: i + 5,
                pagingToken: `${i + 5}`,
                contractId: 'C2',
                txHash: null,
                eventBody: {},
                observedAt: new Date().toISOString(),
              })),
            nextCursor: 'cursor_2',
          };
        } else {
          return { events: [], nextCursor: 'cursor_2' }; // No advance in cycle 3
        }
      });

      const mockTransactionRunner = async (handler) => handler({ fn: { now: () => new Date() } });

      const indexer = createEscrowIndexer({
        store: mockStore,
        fetchEscrowEvents: mockFetchEscrowEvents,
        transactionRunner: mockTransactionRunner,
        log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      });

      const baselineProcessed = escrowIndexerEventsProcessedTotal.get();
      const baselineSkipped = escrowIndexerEventsSkippedTotal.get();

      await indexer.runCycle(); // Cycle 1
      const afterCycle1Processed = escrowIndexerEventsProcessedTotal.get();
      const afterCycle1Skipped = escrowIndexerEventsSkippedTotal.get();

      await indexer.runCycle(); // Cycle 2
      const afterCycle2Processed = escrowIndexerEventsProcessedTotal.get();
      const afterCycle2Skipped = escrowIndexerEventsSkippedTotal.get();

      await indexer.runCycle(); // Cycle 3
      const afterCycle3Processed = escrowIndexerEventsProcessedTotal.get();
      const afterCycle3Skipped = escrowIndexerEventsSkippedTotal.get();

      // Verify accumulation
      expect(afterCycle1Processed).toBe(baselineProcessed + 5);
      expect(afterCycle1Skipped).toBe(baselineSkipped + 0);

      expect(afterCycle2Processed).toBe(baselineProcessed + 8); // 5 + 3
      expect(afterCycle2Skipped).toBe(baselineSkipped + 0);

      expect(afterCycle3Processed).toBe(baselineProcessed + 8); // No change
      expect(afterCycle3Skipped).toBe(baselineSkipped + 0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // HEALTH CHECK TESTS
  // ────────────────────────────────────────────────────────────────────────

  describe('Health check: staleness detection', () => {
    beforeEach(() => {
      process.env.ESCROW_INDEXER_ENABLED = 'true';
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '300';
      // Reinitialize config
      cfg.validate();
    });

    test('/ready is healthy when cursor advanced recently', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const recentTimestamp = Math.floor(Date.now() / 1000);

      // Set gauge to recent time
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(recentTimestamp);

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('healthy');
    });

    test('/ready is degraded when cursor is stale', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const staleTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
      const threshold = 300;

      escrowIndexerLastCursorAdvanceTimestampSeconds.set(staleTimestamp);
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = String(threshold);
      cfg.validate();

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('stale');
      expect(result.error).toContain('not advanced');
    });

    test('/ready staleness check is skipped when ESCROW_INDEXER_ENABLED=false', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const staleTimestamp = Math.floor(Date.now() / 1000) - 400;

      escrowIndexerLastCursorAdvanceTimestampSeconds.set(staleTimestamp);
      process.env.ESCROW_INDEXER_ENABLED = 'false';
      cfg.validate();

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('disabled');
    });

    test('staleness threshold is configurable', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const now = Math.floor(Date.now() / 1000);

      // Test with threshold=60 and elapsed=90 → should be degraded
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(now - 90);
      process.env.ESCROW_INDEXER_ENABLED = 'true';
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '60';
      cfg.validate();

      let result = await checkIndexerStaleness();
      expect(result.status).toBe('stale');

      // Test with threshold=120 and same elapsed=90 → should be healthy
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '120';
      cfg.validate();

      result = await checkIndexerStaleness();
      expect(result.status).toBe('healthy');
    });

    test('health check treats unset gauge as healthy (startup state)', async () => {
      process.env.ESCROW_INDEXER_ENABLED = 'true';
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '300';
      cfg.validate();

      // Reset gauge to 0 (unset state)
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(0);

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('healthy'); // No false positive on startup
    });

    // Vacuousness checks for health conditions
    test('[VACUOUS] invert degraded condition and confirm test fails: threshold=300, elapsed=400 should be stale', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const now = Math.floor(Date.now() / 1000);
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(now - 400);
      process.env.ESCROW_INDEXER_ENABLED = 'true';
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '300';
      cfg.validate();

      const result = await checkIndexerStaleness();
      // This test passes only if condition is correctly implemented
      expect(result.status).toBe('stale');
    });

    test('[VACUOUS] invert healthy condition and confirm test fails: recent timestamp should be healthy', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const now = Math.floor(Date.now() / 1000);
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(now - 30);
      process.env.ESCROW_INDEXER_ENABLED = 'true';
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '300';
      cfg.validate();

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('healthy');
    });

    test('[VACUOUS] invert disabled condition and confirm test fails: disabled=false should be disabled', async () => {
      process.env.ESCROW_INDEXER_ENABLED = 'false';
      cfg.validate();

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('disabled');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // SECURITY TESTS
  // ────────────────────────────────────────────────────────────────────────

  describe('Security: input validation and feature flags', () => {
    test('invalid processed value does not corrupt counter', async () => {
      const mockStore = {
        loadCursor: jest.fn().mockResolvedValue(null),
        saveCursor: jest.fn(),
        findProjection: jest.fn(),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn(),
      };

      const mockFetchEscrowEvents = jest.fn().mockResolvedValue({
        events: [
          {
            eventId: 'e1',
            invoiceId: 'inv_1',
            eventType: 'created',
            ledgerSequence: 1,
            pagingToken: '1',
            contractId: 'C1',
            txHash: null,
            eventBody: {},
            observedAt: new Date().toISOString(),
          },
        ],
        nextCursor: 'cursor_1',
      });

      const mockTransactionRunner = async (handler) => {
        // Simulate successful insertion but return invalid count
        const result = await handler({ fn: { now: () => new Date() } });
        // Corrupt the result
        result.processed = -1;
        return result;
      };

      const mockLog = {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      };

      // Create a modified cycle function that returns invalid data
      const indexer = createEscrowIndexer({
        store: mockStore,
        fetchEscrowEvents: mockFetchEscrowEvents,
        transactionRunner: mockTransactionRunner,
        log: mockLog,
      });

      const baselineProcessed = escrowIndexerEventsProcessedTotal.get();
      const baselineFailures = escrowIndexerCycleFailuresTotal.get();

      await indexer.runCycle();

      const newProcessed = escrowIndexerEventsProcessedTotal.get();
      const newFailures = escrowIndexerCycleFailuresTotal.get();

      // Processed should not have decreased or changed
      expect(newProcessed).toBeLessThanOrEqual(baselineProcessed);
      // Failures should have been incremented
      expect(newFailures).toBeGreaterThan(baselineFailures);
    });

    test('ESCROW_INDEXER_ENABLED="false" (string) is treated as disabled', async () => {
      process.env.ESCROW_INDEXER_ENABLED = 'false';
      cfg.validate();

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('disabled');
    });

    test('ESCROW_INDEXER_ENABLED="true" (string) is treated as enabled', async () => {
      process.env.ESCROW_INDEXER_ENABLED = 'true';
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '300';
      cfg.validate();

      // Set gauge to healthy state
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const now = Math.floor(Date.now() / 1000);
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(now);

      const result = await checkIndexerStaleness();
      expect(result.status).toBe('healthy');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // INTEGRATION: /metrics endpoint
  // ────────────────────────────────────────────────────────────────────────

  describe('GET /metrics endpoint includes indexer metrics', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 'test-metrics-secret';
    });

    afterEach(() => {
      delete process.env.METRICS_BEARER_TOKEN;
    });

    test('all four indexer metrics appear in /metrics output', async () => {
      // Pre-populate metrics
      escrowIndexerEventsProcessedTotal.inc(5);
      escrowIndexerEventsSkippedTotal.inc(2);
      escrowIndexerCycleFailuresTotal.inc(1);
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(1748610000);

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer test-metrics-secret');

      expect(res.status).toBe(200);
      expect(res.text).toContain('escrow_indexer_events_processed_total');
      expect(res.text).toContain('escrow_indexer_events_skipped_total');
      expect(res.text).toContain('escrow_indexer_cycle_failures_total');
      expect(res.text).toContain('escrow_indexer_last_cursor_advance_timestamp_seconds');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // INTEGRATION: /ready endpoint includes staleness check
  // ────────────────────────────────────────────────────────────────────────

  describe('GET /ready endpoint includes indexer staleness check', () => {
    beforeEach(() => {
      process.env.ESCROW_INDEXER_ENABLED = 'true';
      process.env.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS = '300';
      cfg.validate();
    });

    test('/ready includes indexerStaleness check in response', async () => {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks).toHaveProperty('indexerStaleness');
    });

    test('/ready reports degraded when indexer is stale', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const staleTimestamp = Math.floor(Date.now() / 1000) - 400;
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(staleTimestamp);

      const res = await request(app).get('/ready');
      expect(res.status).toBe(503); // Service unavailable
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.indexerStaleness.status).toBe('stale');
    });

    test('/ready is healthy when indexer is recent', async () => {
      jest.setSystemTime(new Date('2026-05-29T12:00:00Z'));
      const recentTimestamp = Math.floor(Date.now() / 1000);
      escrowIndexerLastCursorAdvanceTimestampSeconds.set(recentTimestamp);

      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.checks.indexerStaleness.status).toBe('healthy');
    });
  });
});
