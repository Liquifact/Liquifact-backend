'use strict';

const {
  validateEventOrdering,
  validateProjectionConsistency,
  validateStateTransitionAndConstraints,
  generateEventFingerprint,
  normalizeEvent,
  persistEscrowEvent,
} = require('../../src/jobs/escrowIndexer');

describe('Escrow Indexer Performance Tests', () => {
  // Helper to generate test events
  function generateTestEvent(index) {
    return {
      eventId: `evt${index}`,
      invoiceId: `inv${index % 100}`, // 100 different invoices
      eventType: 'escrow_created',
      ledgerSequence: 1000 + index,
      pagingToken: `${1000 + index}-1`,
      contractId: 'CTESTCONTRACT123456789012345678901234567890123456',
      txHash: 'a'.repeat(64),
      eventBody: { 
        amount: `${1000 + index}0000000`,
        sender: 'GSENDER123456789012345678901234567890123456789012345',
        receiver: 'GRECEIVER123456789012345678901234567890123456789012345'
      },
      observedAt: new Date(Date.now() + index * 1000).toISOString()
    };
  }

  function generateTestProjection(invoiceId, eventIndex) {
    return {
      invoice_id: invoiceId,
      latest_event_id: `evt${eventIndex}`,
      latest_event_type: 'escrow_created',
      latest_ledger_sequence: 1000 + eventIndex,
      latest_paging_token: `${1000 + eventIndex}-1`,
      latest_observed_at: new Date(Date.now() + eventIndex * 1000).toISOString()
    };
  }

  describe('Event Ordering Validation Performance', () => {
    test('validates large batch of events efficiently', () => {
      const eventCount = 10000;
      const events = Array.from({ length: eventCount }, (_, i) => generateTestEvent(i));

      const startTime = process.hrtime.bigint();
      const result = validateEventOrdering(events);
      const endTime = process.hrtime.bigint();
      
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(result.isValid).toBe(true);
      expect(durationMs).toBeLessThan(1000); // Should complete in under 1 second
      
      console.log(`Event ordering validation: ${eventCount} events in ${durationMs.toFixed(2)}ms`);
      console.log(`Rate: ${(eventCount / durationMs * 1000).toFixed(0)} events/second`);
    });

    test('detects ordering violations in large dataset efficiently', () => {
      const eventCount = 5000;
      const events = Array.from({ length: eventCount }, (_, i) => generateTestEvent(i));
      
      // Introduce ordering violation in the middle
      const midpoint = Math.floor(eventCount / 2);
      events[midpoint] = {
        ...events[midpoint],
        ledgerSequence: 500 // Earlier than expected
      };

      const startTime = process.hrtime.bigint();
      const result = validateEventOrdering(events);
      const endTime = process.hrtime.bigint();
      
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(result.isValid).toBe(false);
      expect(result.violations.length).toBe(1);
      expect(durationMs).toBeLessThan(500); // Should still be fast
      
      console.log(`Violation detection: ${eventCount} events in ${durationMs.toFixed(2)}ms`);
    });
  });

  describe('Projection Validation Performance', () => {
    test('validates projection consistency at scale', () => {
      const testCount = 5000;
      const projections = Array.from({ length: testCount }, (_, i) => 
        generateTestProjection(`inv${i}`, i)
      );

      const startTime = process.hrtime.bigint();
      let validCount = 0;
      
      for (const projection of projections) {
        const event = generateTestEvent(testCount + 1);
        event.invoiceId = projection.invoice_id;
        
        const result = validateProjectionConsistency(projection, event);
        if (result.isValid) validCount++;
      }
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(validCount).toBe(testCount);
      expect(durationMs).toBeLessThan(2000); // Should complete in under 2 seconds
      
      console.log(`Projection validation: ${testCount} projections in ${durationMs.toFixed(2)}ms`);
      console.log(`Rate: ${(testCount / durationMs * 1000).toFixed(0)} projections/second`);
    });
  });

  describe('State Transition Validation Performance', () => {
    test('validates complex state transitions efficiently', () => {
      const testCount = 3000;
      const stateSequences = [
        ['escrow_created', 'escrow_funded'],
        ['escrow_funded', 'escrow_released'],
        ['escrow_created', 'escrow_cancelled'],
        ['escrow_funded', 'escrow_disputed'],
        ['escrow_disputed', 'escrow_resolved']
      ];

      const startTime = process.hrtime.bigint();
      let validTransitions = 0;
      
      for (let i = 0; i < testCount; i++) {
        const sequence = stateSequences[i % stateSequences.length];
        const event = {
          ...generateTestEvent(i),
          eventType: sequence[1],
          contractId: 'CTEST123456789012345678901234567890123456789012345678'
        };
        
        const currentProjection = {
          invoice_id: event.invoiceId,
          latest_event_type: sequence[0],
          latest_ledger_sequence: event.ledgerSequence - 1,
          latest_contract_id: event.contractId,
          latest_observed_at: new Date(Date.now() - 1000).toISOString()
        };
        
        const result = validateStateTransitionAndConstraints(event, currentProjection);
        if (result.isValid) validTransitions++;
      }
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(validTransitions).toBe(testCount);
      expect(durationMs).toBeLessThan(3000); // Should complete in under 3 seconds
      
      console.log(`State transition validation: ${testCount} transitions in ${durationMs.toFixed(2)}ms`);
      console.log(`Rate: ${(testCount / durationMs * 1000).toFixed(0)} transitions/second`);
    });
  });

  describe('Event Fingerprinting Performance', () => {
    test('generates fingerprints efficiently at scale', () => {
      const eventCount = 10000;
      const events = Array.from({ length: eventCount }, (_, i) => generateTestEvent(i));

      const startTime = process.hrtime.bigint();
      const fingerprints = new Set();
      
      for (const event of events) {
        const fingerprint = generateEventFingerprint(event);
        fingerprints.add(fingerprint);
      }
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      // Should generate unique fingerprints
      expect(fingerprints.size).toBe(eventCount);
      expect(durationMs).toBeLessThan(2000); // Should complete in under 2 seconds
      
      console.log(`Fingerprint generation: ${eventCount} events in ${durationMs.toFixed(2)}ms`);
      console.log(`Rate: ${(eventCount / durationMs * 1000).toFixed(0)} fingerprints/second`);
    });

    test('detects duplicates efficiently in large dataset', () => {
      const uniqueEventCount = 5000;
      const duplicateCount = 2000;
      
      const uniqueEvents = Array.from({ length: uniqueEventCount }, (_, i) => generateTestEvent(i));
      const duplicateEvents = Array.from({ length: duplicateCount }, (_, i) => 
        generateTestEvent(i % 1000) // Reuse first 1000 events
      );
      
      const allEvents = [...uniqueEvents, ...duplicateEvents];
      
      const startTime = process.hrtime.bigint();
      const seenFingerprints = new Set();
      const duplicates = [];
      
      for (const event of allEvents) {
        const fingerprint = generateEventFingerprint(event);
        if (seenFingerprints.has(fingerprint)) {
          duplicates.push(event.eventId);
        } else {
          seenFingerprints.add(fingerprint);
        }
      }
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(duplicates.length).toBe(duplicateCount);
      expect(durationMs).toBeLessThan(3000);
      
      console.log(`Duplicate detection: ${allEvents.length} events, ${duplicates.length} duplicates in ${durationMs.toFixed(2)}ms`);
    });
  });

  describe('Event Normalization Performance', () => {
    test('normalizes events efficiently at scale', () => {
      const eventCount = 8000;
      const rawEvents = Array.from({ length: eventCount }, (_, i) => ({
        eventId: `evt${i}`,
        invoiceId: `inv${i}`,
        eventType: 'escrow_created',
        ledgerSequence: 1000 + i,
        pagingToken: `${1000 + i}-1`,
        contractId: 'CTEST123456789012345678901234567890123456789012345678',
        txHash: 'abcdef0123456789'.repeat(4),
        eventBody: { 
          amount: `${1000 + i}0000000`,
          metadata: { processed: true, index: i }
        }
      }));

      const startTime = process.hrtime.bigint();
      const normalizedEvents = [];
      
      for (const rawEvent of rawEvents) {
        try {
          const normalized = normalizeEvent(rawEvent);
          normalizedEvents.push(normalized);
        } catch (error) {
          // Track validation failures
        }
      }
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(normalizedEvents.length).toBe(eventCount);
      expect(durationMs).toBeLessThan(4000); // Should complete in under 4 seconds
      
      console.log(`Event normalization: ${eventCount} events in ${durationMs.toFixed(2)}ms`);
      console.log(`Rate: ${(eventCount / durationMs * 1000).toFixed(0)} events/second`);
    });
  });

  describe('Memory Usage Tests', () => {
    test('does not leak memory during large batch processing', () => {
      const initialMemory = process.memoryUsage().heapUsed;
      const batchCount = 10;
      const batchSize = 1000;
      
      for (let batch = 0; batch < batchCount; batch++) {
        const events = Array.from({ length: batchSize }, (_, i) => 
          generateTestEvent(batch * batchSize + i)
        );
        
        // Process events (validation only for memory test)
        for (const event of events) {
          validateEventOrdering([event]);
          generateEventFingerprint(event);
        }
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      const memoryIncreaseMB = memoryIncrease / 1024 / 1024;
      
      console.log(`Memory usage: ${memoryIncreaseMB.toFixed(2)}MB increase after processing ${batchCount * batchSize} events`);
      
      // Memory increase should be reasonable (less than 50MB for this test)
      expect(memoryIncreaseMB).toBeLessThan(50);
    });
  });

  describe('Concurrent Performance Tests', () => {
    test('maintains performance under concurrent validation load', async () => {
      const concurrentWorkers = 5;
      const eventsPerWorker = 1000;
      
      const workerPromises = Array.from({ length: concurrentWorkers }, async (_, workerIndex) => {
        const events = Array.from({ length: eventsPerWorker }, (_, eventIndex) => 
          generateTestEvent(workerIndex * eventsPerWorker + eventIndex)
        );
        
        const startTime = process.hrtime.bigint();
        
        // Simulate concurrent processing
        const results = await Promise.all(
          events.map(async (event) => {
            const ordering = validateEventOrdering([event]);
            const fingerprint = generateEventFingerprint(event);
            return { ordering: ordering.isValid, fingerprint: !!fingerprint };
          })
        );
        
        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1000000;
        
        return { 
          workerIndex, 
          processedCount: results.length, 
          durationMs,
          rate: results.length / durationMs * 1000
        };
      });
      
      const workerResults = await Promise.all(workerPromises);
      const totalProcessed = workerResults.reduce((sum, result) => sum + result.processedCount, 0);
      const averageRate = workerResults.reduce((sum, result) => sum + result.rate, 0) / workerResults.length;
      
      console.log(`Concurrent processing: ${concurrentWorkers} workers, ${totalProcessed} total events`);
      console.log(`Average rate per worker: ${averageRate.toFixed(0)} events/second`);
      
      expect(totalProcessed).toBe(concurrentWorkers * eventsPerWorker);
      expect(averageRate).toBeGreaterThan(1000); // Each worker should process >1000 events/second
    });
  });

  describe('Stress Tests', () => {
    test('handles pathological input without performance degradation', () => {
      // Test with events that have complex nested structures
      const complexEventCount = 1000;
      const complexEvents = Array.from({ length: complexEventCount }, (_, i) => ({
        eventId: `complex_evt_${i}`,
        invoiceId: `complex_inv_${i}`,
        eventType: 'escrow_created',
        ledgerSequence: 1000 + i,
        eventBody: {
          // Deeply nested structure
          level1: {
            level2: {
              level3: {
                level4: {
                  level5: {
                    data: Array.from({ length: 100 }, (_, j) => ({ 
                      id: j, 
                      value: `value_${i}_${j}`,
                      metadata: { processed: true, timestamp: Date.now() }
                    }))
                  }
                }
              }
            }
          },
          // Large array
          transactions: Array.from({ length: 50 }, (_, j) => ({
            txId: `tx_${i}_${j}`,
            amount: `${1000000 + j}0000000`,
            participants: [`sender_${j}`, `receiver_${j}`]
          }))
        }
      }));

      const startTime = process.hrtime.bigint();
      
      let processedCount = 0;
      for (const event of complexEvents) {
        try {
          const fingerprint = generateEventFingerprint(event);
          if (fingerprint) processedCount++;
        } catch (error) {
          // Should handle complex structures gracefully
        }
      }
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(processedCount).toBe(complexEventCount);
      expect(durationMs).toBeLessThan(10000); // Should complete in under 10 seconds even with complex data
      
      console.log(`Complex event processing: ${complexEventCount} events in ${durationMs.toFixed(2)}ms`);
      console.log(`Rate: ${(complexEventCount / durationMs * 1000).toFixed(0)} complex events/second`);
    });

    test('validates extremely large individual events', () => {
      // Create an event with a very large event body (but within limits)
      const largeEvent = {
        eventId: 'large_evt_1',
        invoiceId: 'large_inv_1',
        eventType: 'escrow_created',
        ledgerSequence: 1000,
        eventBody: {
          // Large but valid JSON structure (~32KB)
          data: 'x'.repeat(32000),
          metadata: { size: 32000, type: 'large_test' }
        }
      };

      const startTime = process.hrtime.bigint();
      
      const fingerprint = generateEventFingerprint(largeEvent);
      const ordering = validateEventOrdering([largeEvent]);
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      expect(fingerprint).toBeTruthy();
      expect(ordering.isValid).toBe(true);
      expect(durationMs).toBeLessThan(100); // Should handle large events quickly
      
      console.log(`Large event processing: ${durationMs.toFixed(2)}ms for 32KB event`);
    });
  });
});