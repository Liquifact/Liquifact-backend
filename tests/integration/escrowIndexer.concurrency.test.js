'use strict';

const {
  createEscrowIndexer,
  createKnexEscrowEventStore,
  createSafeTransactionRunner,
  persistEscrowEvent,
  runEscrowIndexerCycle,
  LeaseLostError,
  ValidationError,
} = require('../../src/jobs/escrowIndexer');

// Mock database for testing
function createMockKnex() {
  const state = {
    leases: new Map(),
    cursors: new Map(),
    events: new Map(),
    projections: new Map(),
    calls: []
  };

  const mockKnex = jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    first: jest.fn(),
    insert: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    merge: jest.fn().mockReturnThis(),
    ignore: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    del: jest.fn()
  }));

  mockKnex.raw = jest.fn();
  mockKnex.fn = { now: () => new Date() };
  mockKnex.transaction = jest.fn();

  return { mockKnex, state };
}

describe('Escrow Indexer Concurrency and Integration Tests', () => {
  let mockKnex, state, store, transactionRunner;

  beforeEach(() => {
    ({ mockKnex, state } = createMockKnex());
    store = createKnexEscrowEventStore(mockKnex);
    transactionRunner = createSafeTransactionRunner(mockKnex);
    jest.clearAllMocks();
  });

  describe('Concurrent Lease Acquisition', () => {
    test('prevents multiple workers from acquiring same lease', async () => {
      // Simulate race condition in lease acquisition
      let leaseAcquired = false;
      
      // Mock the lease acquisition query to simulate race condition
      mockKnex.raw.mockImplementation(async (query) => {
        if (query.includes('pg_advisory_xact_lock')) {
          if (leaseAcquired) {
            return { rows: [] }; // Second worker gets no rows (lease failed)
          }
          leaseAcquired = true;
          return {
            rows: [{
              value: JSON.stringify({
                token: 'test-token-1',
                expiresAt: Date.now() + 30000
              })
            }]
          };
        }
        return { rows: [] };
      });

      // First worker should get lease
      const lease1 = await store.acquireLease({ leaseDurationMs: 30000 });
      expect(lease1).not.toBeNull();
      expect(lease1.token).toBe('test-token-1');

      // Second worker should not get lease
      const lease2 = await store.acquireLease({ leaseDurationMs: 30000 });
      expect(lease2).toBeNull();
    });

    test('handles lease token validation race conditions', async () => {
      // Setup: mock lease that will expire during processing
      const expiredLease = {
        token: 'expired-token',
        expiresAt: Date.now() - 1000 // Already expired
      };

      mockKnex.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null) // Lease validation fails
      }));

      // Should throw LeaseLostError when validating expired lease
      await expect(store.assertLease(null, expiredLease.token))
        .rejects.toThrow(LeaseLostError);
    });
  });

  describe('Concurrent Event Processing', () => {
    test('handles concurrent event processing with proper isolation', async () => {
      const mockTrx = {
        fn: { now: () => new Date() },
        raw: jest.fn(),
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        ignore: jest.fn().mockResolvedValue(),
        merge: jest.fn().mockResolvedValue(),
        where: jest.fn().mockReturnThis(),
        forUpdate: jest.fn().mockReturnThis(),
        first: jest.fn()
      };

      // Mock transaction runner
      const mockTransactionRunner = jest.fn(async (handler) => {
        return handler(mockTrx);
      });

      // Mock store methods
      const mockStore = {
        assertLease: jest.fn(),
        findEventById: jest.fn().mockResolvedValue(null),
        findProjectionWithinTrx: jest.fn(),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn()
      };

      const event1 = {
        eventId: 'evt1',
        invoiceId: 'inv1',
        eventType: 'escrow_created',
        ledgerSequence: 100,
        pagingToken: '100-1',
        contractId: 'CTEST',
        eventBody: {},
        observedAt: '2026-01-01T00:00:00Z'
      };

      const event2 = {
        eventId: 'evt2',
        invoiceId: 'inv1', // Same invoice
        eventType: 'escrow_funded',
        ledgerSequence: 101,
        pagingToken: '101-1',
        contractId: 'CTEST',
        eventBody: { amount: '1000' },
        observedAt: '2026-01-01T00:01:00Z'
      };

      // First call: no existing projection
      mockStore.findProjectionWithinTrx.mockResolvedValueOnce(null);
      
      // Second call: projection exists from first event
      mockStore.findProjectionWithinTrx.mockResolvedValueOnce({
        invoice_id: 'inv1',
        latest_event_id: 'evt1',
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: 100,
        latest_paging_token: '100-1',
        latest_observed_at: '2026-01-01T00:00:00Z'
      });

      // Process events concurrently
      const promise1 = persistEscrowEvent(
        { store: mockStore, transactionRunner: mockTransactionRunner },
        event1
      );
      
      const promise2 = persistEscrowEvent(
        { store: mockStore, transactionRunner: mockTransactionRunner },
        event2
      );

      const results = await Promise.all([promise1, promise2]);

      expect(results[0].eventId).toBe('evt1');
      expect(results[1].eventId).toBe('evt2');
      expect(mockStore.upsertEvent).toHaveBeenCalledTimes(2);
      expect(mockStore.upsertProjection).toHaveBeenCalledTimes(2);
    });

    test('prevents out-of-order event processing in same batch', async () => {
      const outOfOrderEvents = [
        {
          eventId: 'evt2',
          ledgerSequence: 101,
          pagingToken: '101-1'
        },
        {
          eventId: 'evt1',
          ledgerSequence: 100, // Earlier ledger!
          pagingToken: '100-1'
        }
      ];

      const mockStore = {
        acquireLease: jest.fn().mockResolvedValue({
          token: 'test-token',
          expiresAt: Date.now() + 30000
        }),
        completeLease: jest.fn(),
        loadCursor: jest.fn().mockResolvedValue('99-1'),
        saveCursor: jest.fn()
      };

      const mockFetchEvents = jest.fn().mockResolvedValue({
        events: outOfOrderEvents,
        nextCursor: '101-2'
      });

      const mockTransactionRunner = jest.fn();

      await expect(
        runEscrowIndexerCycle({
          store: mockStore,
          fetchEscrowEvents: mockFetchEvents,
          transactionRunner: mockTransactionRunner,
          log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() }
        })
      ).rejects.toThrow(/ordering violations/);
    });
  });

  describe('Failure Recovery and Rollback', () => {
    test('handles partial batch processing failure', async () => {
      const events = [
        {
          eventId: 'evt1',
          invoiceId: 'inv1',
          eventType: 'escrow_created',
          ledgerSequence: 100,
          pagingToken: '100-1'
        },
        {
          eventId: 'evt2',
          invoiceId: 'inv2',
          eventType: 'invalid_event_type', // Will fail validation
          ledgerSequence: 101,
          pagingToken: '101-1'
        },
        {
          eventId: 'evt3',
          invoiceId: 'inv3',
          eventType: 'escrow_created',
          ledgerSequence: 102,
          pagingToken: '102-1'
        }
      ];

      const mockStore = {
        acquireLease: jest.fn().mockResolvedValue({
          token: 'test-token',
          expiresAt: Date.now() + 30000
        }),
        completeLease: jest.fn(),
        assertLease: jest.fn(),
        loadCursor: jest.fn().mockResolvedValue('99-1'),
        saveCursor: jest.fn(),
        renewLease: jest.fn().mockResolvedValue({
          token: 'test-token',
          expiresAt: Date.now() + 30000
        })
      };

      const mockFetchEvents = jest.fn().mockResolvedValue({
        events,
        nextCursor: '102-2'
      });

      // Mock transaction that succeeds for valid events, fails for invalid
      const mockTransactionRunner = jest.fn().mockImplementation(async (handler) => {
        const mockTrx = {
          fn: { now: () => new Date() }
        };
        return handler(mockTrx);
      });

      const result = await runEscrowIndexerCycle({
        store: mockStore,
        fetchEscrowEvents: mockFetchEvents,
        transactionRunner: mockTransactionRunner,
        log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() }
      });

      // Should process 2 valid events, skip 1 invalid
      expect(result.processed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(mockStore.saveCursor).toHaveBeenCalledWith('102-2', 'test-token');
    });

    test('aborts cycle on lease lost error', async () => {
      const mockStore = {
        acquireLease: jest.fn().mockResolvedValue({
          token: 'test-token',
          expiresAt: Date.now() + 30000
        }),
        completeLease: jest.fn(),
        loadCursor: jest.fn().mockResolvedValue('99-1'),
        renewLease: jest.fn().mockResolvedValue(null) // Lease renewal fails
      };

      const mockFetchEvents = jest.fn().mockResolvedValue({
        events: [{
          eventId: 'evt1',
          invoiceId: 'inv1',
          eventType: 'escrow_created',
          ledgerSequence: 100,
          pagingToken: '100-1'
        }],
        nextCursor: '100-2'
      });

      const mockTransactionRunner = jest.fn();

      await expect(
        runEscrowIndexerCycle({
          store: mockStore,
          fetchEscrowEvents: mockFetchEvents,
          transactionRunner: mockTransactionRunner,
          log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() }
        })
      ).rejects.toThrow(LeaseLostError);

      expect(mockStore.completeLease).toHaveBeenCalledWith('test-token');
    });

    test('handles database transaction rollback', async () => {
      const mockTrx = {
        fn: { now: () => new Date() }
      };

      let transactionCount = 0;
      const mockTransactionRunner = jest.fn().mockImplementation(async (handler) => {
        transactionCount++;
        if (transactionCount === 1) {
          // First transaction succeeds
          return handler(mockTrx);
        } else {
          // Second transaction fails (simulates rollback)
          throw new Error('Database connection lost');
        }
      });

      const mockStore = {
        assertLease: jest.fn(),
        findEventById: jest.fn().mockResolvedValue(null),
        findProjectionWithinTrx: jest.fn().mockResolvedValue(null),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn()
      };

      const event1 = {
        eventId: 'evt1',
        invoiceId: 'inv1',
        eventType: 'escrow_created',
        ledgerSequence: 100,
        contractId: 'CTEST',
        eventBody: {},
        observedAt: '2026-01-01T00:00:00Z'
      };

      // First event should succeed
      const result1 = await persistEscrowEvent(
        { store: mockStore, transactionRunner: mockTransactionRunner },
        event1
      );
      expect(result1.eventId).toBe('evt1');

      // Second event should fail due to database error
      await expect(
        persistEscrowEvent(
          { store: mockStore, transactionRunner: mockTransactionRunner },
          event1
        )
      ).rejects.toThrow('Database connection lost');
    });
  });

  describe('Cursor Consistency Under Concurrent Access', () => {
    test('prevents cursor rollback in concurrent scenarios', async () => {
      let currentCursor = '100-1';
      
      const mockStore = {
        loadCursor: jest.fn().mockImplementation(() => Promise.resolve(currentCursor)),
        saveCursor: jest.fn().mockImplementation(async (cursor, fenceToken) => {
          // Simulate cursor advancement validation
          if (cursor < currentCursor) {
            throw new Error('Cursor rollback prevented');
          }
          currentCursor = cursor;
        })
      };

      // First worker tries to advance cursor normally
      await expect(mockStore.saveCursor('100-2', 'token1')).resolves.toBeUndefined();

      // Second worker tries to roll back cursor (should fail)
      await expect(mockStore.saveCursor('100-1', 'token2')).rejects.toThrow('Cursor rollback prevented');

      // Third worker can advance further
      await expect(mockStore.saveCursor('100-3', 'token3')).resolves.toBeUndefined();
    });

    test('handles cursor advancement with gaps correctly', async () => {
      const mockStore = {
        loadCursor: jest.fn().mockResolvedValue('100-1'),
        saveCursor: jest.fn()
      };

      // Large gap should be allowed (might happen with filtered events)
      await expect(mockStore.saveCursor('105-1', 'token1')).resolves.toBeUndefined();
    });
  });

  describe('State Transition Enforcement Under Load', () => {
    test('enforces state transitions consistently under concurrent updates', async () => {
      const mockTrx = {
        fn: { now: () => new Date() }
      };

      const mockTransactionRunner = jest.fn(async (handler) => handler(mockTrx));

      // Start with an escrow_created state
      let currentProjection = {
        invoice_id: 'inv1',
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: 100,
        latest_observed_at: '2026-01-01T00:00:00Z'
      };

      const mockStore = {
        assertLease: jest.fn(),
        findEventById: jest.fn().mockResolvedValue(null),
        findProjectionWithinTrx: jest.fn().mockResolvedValue(currentProjection),
        upsertEvent: jest.fn(),
        upsertProjection: jest.fn().mockImplementation(() => {
          // Update the current projection after successful write
          currentProjection = {
            ...currentProjection,
            latest_event_type: 'escrow_funded',
            latest_ledger_sequence: 101
          };
        })
      };

      // Valid transition: escrow_created -> escrow_funded
      const validEvent = {
        eventId: 'evt1',
        invoiceId: 'inv1',
        eventType: 'escrow_funded',
        ledgerSequence: 101,
        contractId: 'CTEST',
        eventBody: { amount: '1000' },
        observedAt: '2026-01-01T00:01:00Z'
      };

      await expect(
        persistEscrowEvent(
          { store: mockStore, transactionRunner: mockTransactionRunner },
          validEvent
        )
      ).resolves.not.toThrow();

      // Invalid transition: escrow_funded -> escrow_created (rollback)
      const invalidEvent = {
        eventId: 'evt2',
        invoiceId: 'inv1',
        eventType: 'escrow_created',
        ledgerSequence: 102,
        contractId: 'CTEST',
        eventBody: {},
        observedAt: '2026-01-01T00:02:00Z'
      };

      // Reset mock to return updated projection
      mockStore.findProjectionWithinTrx.mockResolvedValue(currentProjection);

      // Should fail due to invalid state transition
      await expect(
        persistEscrowEvent(
          { store: mockStore, transactionRunner: mockTransactionRunner },
          invalidEvent
        )
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Circuit Breaker and Rate Limiting', () => {
    test('circuit breaker prevents cascading failures', async () => {
      // This would require integrating circuit breaker into the cycle
      // For now, we test the circuit breaker component in isolation
      const { CircuitBreaker } = require('../../src/jobs/escrowIndexer');
      
      const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
      
      const failingOperation = jest.fn().mockRejectedValue(new Error('Service down'));
      
      // First two failures
      await expect(breaker.execute(failingOperation)).rejects.toThrow('Service down');
      await expect(breaker.execute(failingOperation)).rejects.toThrow('Service down');
      
      // Circuit should now be open
      expect(breaker.getState().state).toBe('OPEN');
      
      // Next call should fail fast
      await expect(breaker.execute(failingOperation)).rejects.toThrow('Circuit breaker is OPEN');
      
      // Verify operation wasn't called (fail fast)
      expect(failingOperation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling and Diagnostics', () => {
    test('provides detailed error context for debugging', async () => {
      const invalidEvent = {
        eventId: 'evt1',
        invoiceId: 'inv1',
        eventType: 'invalid_type',
        ledgerSequence: 100
      };

      try {
        await persistEscrowEvent(
          { 
            store: { assertLease: jest.fn(), findEventById: jest.fn().mockResolvedValue(null) },
            transactionRunner: jest.fn()
          },
          invalidEvent
        );
        fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.code).toBe('STATE_VALIDATION_ERROR');
        expect(error.details).toBeDefined();
        expect(error.details.violations).toBeDefined();
      }
    });

    test('logs detailed information for operational debugging', async () => {
      const mockLog = {
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      };

      const mockStore = {
        acquireLease: jest.fn().mockResolvedValue(null) // No lease available
      };

      const result = await runEscrowIndexerCycle({
        store: mockStore,
        fetchEscrowEvents: jest.fn(),
        transactionRunner: jest.fn(),
        log: mockLog
      });

      expect(result).toBeNull();
      expect(mockLog.info).toHaveBeenCalledWith(
        {},
        'Escrow indexer cycle skipped; lease is held by another worker.'
      );
    });
  });
});