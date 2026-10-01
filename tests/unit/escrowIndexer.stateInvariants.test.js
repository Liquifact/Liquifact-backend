'use strict';

const {
  validateStateTransition,
  validateBusinessConstraints,
  validateStateTransitionAndConstraints,
  validateProjectionIntegrity,
  validateProjectionConsistency,
  validateCursorOrdering,
  validateEventOrdering,
  comparePagingTokens,
  validateEventConsistency,
  generateEventFingerprint,
  validateStringField,
  validateNumericField,
  validateJsonField,
  validateLeaseDuration,
  hasLeaseTimeRemaining,
  ValidationError,
  LeaseLostError,
} = require('../../src/jobs/escrowIndexer');

describe('State Invariant Protection Tests', () => {
  describe('State Transition Validation', () => {
    test('allows valid initial states', () => {
      const result = validateStateTransition(null, 'escrow_created');
      expect(result.isValid).toBe(true);
      expect(result.reason).toBe('initial_state_allowed');
    });

    test('rejects invalid initial states', () => {
      const result = validateStateTransition(null, 'escrow_finalized');
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('invalid_initial_state');
      expect(result.allowedInitialStates).toContain('escrow_created');
    });

    test('allows valid state transitions', () => {
      const result = validateStateTransition('escrow_created', 'escrow_funded');
      expect(result.isValid).toBe(true);
      expect(result.reason).toBe('valid_transition');
    });

    test('rejects invalid state transitions', () => {
      const result = validateStateTransition('escrow_finalized', 'escrow_created');
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('invalid_transition');
    });

    test('allows idempotent transitions', () => {
      const result = validateStateTransition('escrow_created', 'escrow_created');
      expect(result.isValid).toBe(true);
      expect(result.reason).toBe('idempotent_transition');
    });

    test('handles edge case: terminal state restrictions', () => {
      const result = validateStateTransition('escrow_finalized', 'escrow_updated');
      expect(result.isValid).toBe(false);
    });
  });

  describe('Business Constraints Validation', () => {
    test('validates required fields for specific event types', () => {
      const event = {
        eventId: 'evt1',
        invoiceId: 'inv1',
        eventType: 'escrow_created',
        ledgerSequence: 100,
        // Missing contractId
      };

      const result = validateBusinessConstraints(event, null);
      expect(result.isValid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          type: 'missing_required_field',
          missingField: 'contractId'
        })
      ]);
    });

    test('validates contract ID consistency', () => {
      const event = {
        eventType: 'escrow_funded',
        contractId: 'CNEWCONTRACT',
        ledgerSequence: 200
      };

      const currentProjection = {
        latest_contract_id: 'COLDCONTRACT',
        latest_ledger_sequence: 100
      };

      const result = validateBusinessConstraints(event, currentProjection);
      expect(result.isValid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          type: 'contract_id_mismatch'
        })
      ]);
    });

    test('detects suspicious ledger gaps in critical operations', () => {
      const event = {
        eventType: 'escrow_released',
        ledgerSequence: 1200,
        contractId: 'CTEST'
      };

      const currentProjection = {
        latest_ledger_sequence: 100
      };

      const result = validateBusinessConstraints(event, currentProjection);
      expect(result.isValid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          type: 'suspicious_ledger_gap_in_critical_operation',
          ledgerGap: 1100
        })
      ]);
    });

    test('validates event body amount fields for funding events', () => {
      const event = {
        eventType: 'escrow_funded',
        contractId: 'CTEST',
        eventBody: {} // Missing amount/value
      };

      const result = validateBusinessConstraints(event, null);
      expect(result.isValid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          type: 'missing_amount_field'
        })
      ]);
    });

    test('allows valid business constraints', () => {
      const event = {
        eventType: 'escrow_funded',
        contractId: 'CTEST',
        ledgerSequence: 101,
        eventBody: { amount: '1000' }
      };

      const currentProjection = {
        latest_contract_id: 'CTEST',
        latest_ledger_sequence: 100
      };

      const result = validateBusinessConstraints(event, currentProjection);
      expect(result.isValid).toBe(true);
    });
  });

  describe('Projection Integrity Validation', () => {
    test('validates projection with all required fields', () => {
      const projection = {
        invoice_id: 'inv1',
        latest_event_id: 'evt1',
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: 100,
        latest_observed_at: '2026-01-01T00:00:00Z'
      };

      const result = validateProjectionIntegrity(projection);
      expect(result.isValid).toBe(true);
    });

    test('detects missing required fields', () => {
      const projection = {
        invoice_id: 'inv1',
        // Missing other required fields
      };

      const result = validateProjectionIntegrity(projection);
      expect(result.isValid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].type).toBe('missing_required_projection_field');
    });

    test('validates ledger sequence bounds', () => {
      const projection = {
        invoice_id: 'inv1',
        latest_event_id: 'evt1',
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: -5, // Invalid
        latest_observed_at: '2026-01-01T00:00:00Z'
      };

      const result = validateProjectionIntegrity(projection);
      expect(result.isValid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          type: 'invalid_ledger_sequence_range'
        })
      ]);
    });

    test('validates timestamp format and bounds', () => {
      const projection = {
        invoice_id: 'inv1',
        latest_event_id: 'evt1',
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: 100,
        latest_observed_at: '2020-01-01T00:00:00Z' // Too far in past
      };

      const result = validateProjectionIntegrity(projection);
      expect(result.isValid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          type: 'timestamp_out_of_reasonable_bounds'
        })
      ]);
    });

    test('validates event body JSON format', () => {
      const projection = {
        invoice_id: 'inv1',
        latest_event_id: 'evt1',
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: 100,
        latest_observed_at: '2026-01-01T00:00:00Z',
        latest_event_body: '{"invalid": json}' // Invalid JSON
      };

      const result = validateProjectionIntegrity(projection);
      expect(result.isValid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          type: 'event_body_json_parse_error'
        })
      ]);
    });
  });

  describe('Projection Consistency Validation', () => {
    test('allows creating new projection', () => {
      const event = {
        invoiceId: 'inv1',
        ledgerSequence: 100,
        observedAt: '2026-01-01T00:00:00Z'
      };

      const result = validateProjectionConsistency(null, event);
      expect(result.isValid).toBe(true);
      expect(result.action).toBe('create');
    });

    test('detects large ledger gaps', () => {
      const event = {
        invoiceId: 'inv1',
        ledgerSequence: 2000
      };

      const currentProjection = {
        invoice_id: 'inv1',
        latest_ledger_sequence: 100
      };

      const result = validateProjectionConsistency(currentProjection, event);
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('large_ledger_gap');
    });

    test('detects significant time reversals', () => {
      const event = {
        invoiceId: 'inv1',
        ledgerSequence: 101,
        observedAt: '2026-01-01T00:00:00Z'
      };

      const currentProjection = {
        invoice_id: 'inv1',
        latest_ledger_sequence: 100,
        latest_observed_at: '2026-01-01T01:30:00Z' // 90 minutes later
      };

      const result = validateProjectionConsistency(currentProjection, event);
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('significant_time_reversal');
    });

    test('detects invoice ID mismatch', () => {
      const event = {
        invoiceId: 'inv2',
        ledgerSequence: 101
      };

      const currentProjection = {
        invoice_id: 'inv1',
        latest_ledger_sequence: 100
      };

      const result = validateProjectionConsistency(currentProjection, event);
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('invoice_id_mismatch');
    });
  });

  describe('Cursor Ordering Validation', () => {
    test('allows initial cursor setting', () => {
      const result = validateCursorOrdering(null, 'cursor1');
      expect(result.isValid).toBe(true);
      expect(result.action).toBe('advance');
    });

    test('allows cursor advancement', () => {
      const result = validateCursorOrdering('100-1', '100-2');
      expect(result.isValid).toBe(true);
      expect(result.action).toBe('advance');
    });

    test('prevents cursor rollback', () => {
      const result = validateCursorOrdering('100-2', '100-1');
      expect(result.isValid).toBe(false);
      expect(result.action).toBe('reject');
      expect(result.reason).toBe('cursor_rollback_prevented');
    });

    test('handles equal cursors', () => {
      const result = validateCursorOrdering('100-1', '100-1');
      expect(result.isValid).toBe(true);
      expect(result.action).toBe('unchanged');
    });

    test('handles null proposed cursor', () => {
      const result = validateCursorOrdering('100-1', null);
      expect(result.isValid).toBe(true);
      expect(result.action).toBe('unchanged');
    });
  });

  describe('Paging Token Comparison', () => {
    test('compares ledger-index format tokens correctly', () => {
      expect(comparePagingTokens('100-1', '100-2')).toBe(-1);
      expect(comparePagingTokens('100-2', '100-1')).toBe(1);
      expect(comparePagingTokens('100-1', '100-1')).toBe(0);
      expect(comparePagingTokens('99-999', '100-1')).toBe(-1);
    });

    test('falls back to lexicographic comparison for other formats', () => {
      expect(comparePagingTokens('abc', 'def')).toBe(-1);
      expect(comparePagingTokens('def', 'abc')).toBe(1);
      expect(comparePagingTokens('abc', 'abc')).toBe(0);
    });

    test('handles mixed token formats', () => {
      expect(comparePagingTokens('100-1', 'abc')).toBe(-1);
      expect(comparePagingTokens('abc', '100-1')).toBe(1);
    });
  });

  describe('Event Ordering Validation', () => {
    test('validates correct event ordering', () => {
      const events = [
        { ledgerSequence: 100, pagingToken: '100-1', eventId: 'evt1' },
        { ledgerSequence: 100, pagingToken: '100-2', eventId: 'evt2' },
        { ledgerSequence: 101, pagingToken: '101-1', eventId: 'evt3' }
      ];

      const result = validateEventOrdering(events);
      expect(result.isValid).toBe(true);
    });

    test('detects ledger sequence rollback', () => {
      const events = [
        { ledgerSequence: 100, pagingToken: '100-1', eventId: 'evt1' },
        { ledgerSequence: 99, pagingToken: '99-1', eventId: 'evt2' }
      ];

      const result = validateEventOrdering(events);
      expect(result.isValid).toBe(false);
      expect(result.violations[0].type).toBe('ledger_sequence_rollback');
    });

    test('detects paging token rollback within same ledger', () => {
      const events = [
        { ledgerSequence: 100, pagingToken: '100-2', eventId: 'evt1' },
        { ledgerSequence: 100, pagingToken: '100-1', eventId: 'evt2' }
      ];

      const result = validateEventOrdering(events);
      expect(result.isValid).toBe(false);
      expect(result.violations[0].type).toBe('paging_token_rollback');
    });

    test('handles single event', () => {
      const events = [
        { ledgerSequence: 100, pagingToken: '100-1', eventId: 'evt1' }
      ];

      const result = validateEventOrdering(events);
      expect(result.isValid).toBe(true);
    });

    test('handles empty event array', () => {
      const result = validateEventOrdering([]);
      expect(result.isValid).toBe(true);
    });
  });

  describe('Event Consistency Validation', () => {
    test('allows new events', () => {
      const event = { eventId: 'evt1', invoiceId: 'inv1', eventType: 'created' };
      const result = validateEventConsistency(event, null);
      expect(result.isConsistent).toBe(true);
      expect(result.action).toBe('insert');
    });

    test('allows consistent duplicates', () => {
      const event = { 
        eventId: 'evt1', 
        invoiceId: 'inv1', 
        eventType: 'created', 
        ledgerSequence: 100,
        contractId: 'CTEST',
        txHash: 'hash123',
        pagingToken: '100-1'
      };

      const existingEvent = {
        event_id: 'evt1',
        invoice_id: 'inv1',
        event_type: 'created',
        ledger_sequence: 100,
        contract_id: 'CTEST',
        tx_hash: 'hash123',
        paging_token: '100-1'
      };

      const result = validateEventConsistency(event, existingEvent);
      expect(result.isConsistent).toBe(true);
      expect(result.action).toBe('ignore');
    });

    test('rejects inconsistent duplicates', () => {
      const event = {
        eventId: 'evt1',
        invoiceId: 'inv1',
        eventType: 'created',
        ledgerSequence: 100
      };

      const existingEvent = {
        event_id: 'evt1',
        invoice_id: 'inv1',
        event_type: 'updated', // Different!
        ledger_sequence: 100
      };

      const result = validateEventConsistency(event, existingEvent);
      expect(result.isConsistent).toBe(false);
      expect(result.action).toBe('reject');
      expect(result.inconsistencies.length).toBeGreaterThan(0);
    });
  });

  describe('Input Validation Functions', () => {
    describe('validateStringField', () => {
      test('validates required string fields', () => {
        expect(() => validateStringField('', 'testField', 10, true))
          .toThrow(ValidationError);
        expect(() => validateStringField(null, 'testField', 10, true))
          .toThrow(ValidationError);
        expect(() => validateStringField(123, 'testField', 10, false))
          .toThrow(ValidationError);
      });

      test('validates string length limits', () => {
        expect(() => validateStringField('toolong', 'testField', 5, false))
          .toThrow(ValidationError);
        
        const result = validateStringField('valid', 'testField', 10, false);
        expect(result).toBe('valid');
      });

      test('detects malicious control characters', () => {
        expect(() => validateStringField('bad\x00char', 'testField', 10, false))
          .toThrow(ValidationError);
      });

      test('trims whitespace', () => {
        const result = validateStringField('  trimmed  ', 'testField', 20, false);
        expect(result).toBe('trimmed');
      });
    });

    describe('validateNumericField', () => {
      test('validates numeric bounds', () => {
        expect(() => validateNumericField(1000, 'testField', 1, 100, true))
          .toThrow(ValidationError);
        expect(() => validateNumericField(-5, 'testField', 0, 100, true))
          .toThrow(ValidationError);
      });

      test('rejects non-finite numbers', () => {
        expect(() => validateNumericField(Infinity, 'testField', 1, 100, true))
          .toThrow(ValidationError);
        expect(() => validateNumericField(NaN, 'testField', 1, 100, true))
          .toThrow(ValidationError);
      });

      test('requires integers', () => {
        expect(() => validateNumericField(3.14, 'testField', 1, 100, true))
          .toThrow(ValidationError);
      });

      test('handles valid numeric inputs', () => {
        const result = validateNumericField(50, 'testField', 1, 100, true);
        expect(result).toBe(50);
      });
    });

    describe('validateJsonField', () => {
      test('validates JSON size limits', () => {
        const largeObject = { data: 'x'.repeat(100000) };
        expect(() => validateJsonField(largeObject, 'testField', 1000))
          .toThrow(ValidationError);
      });

      test('validates nesting depth', () => {
        const deepObject = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 'deep' } } } } } } } } } } };
        expect(() => validateJsonField(deepObject, 'testField'))
          .toThrow(ValidationError);
      });

      test('handles valid JSON objects', () => {
        const validObject = { key: 'value', number: 42 };
        const result = validateJsonField(validObject, 'testField');
        expect(result).toEqual(validObject);
      });

      test('returns empty object for null/undefined', () => {
        expect(validateJsonField(null, 'testField')).toEqual({});
        expect(validateJsonField(undefined, 'testField')).toEqual({});
      });
    });
  });

  describe('Lease Validation Functions', () => {
    test('validateLeaseDuration clamps values to safe bounds', () => {
      expect(validateLeaseDuration(-1000)).toBeGreaterThan(0);
      expect(validateLeaseDuration(500000)).toBeLessThan(400000);
      expect(validateLeaseDuration(30000)).toBe(30000);
    });

    test('hasLeaseTimeRemaining checks buffer correctly', () => {
      const futureTime = Date.now() + 60000;
      const nearFutureTime = Date.now() + 1000;
      
      expect(hasLeaseTimeRemaining({ token: 'test', expiresAt: futureTime })).toBe(true);
      expect(hasLeaseTimeRemaining({ token: 'test', expiresAt: nearFutureTime })).toBe(false);
      expect(hasLeaseTimeRemaining(null)).toBe(false);
    });
  });

  describe('Event Fingerprinting', () => {
    test('generates consistent fingerprints for same data', () => {
      const event1 = {
        invoiceId: 'inv1',
        ledgerSequence: 100,
        pagingToken: '100-1',
        contractId: 'CTEST',
        txHash: 'hash123',
        eventBody: { amount: '1000' }
      };

      const event2 = { ...event1 };

      const fingerprint1 = generateEventFingerprint(event1);
      const fingerprint2 = generateEventFingerprint(event2);
      
      expect(fingerprint1).toBe(fingerprint2);
      expect(fingerprint1).toMatch(/^[a-f0-9]{64}$/); // Valid SHA-256 hex
    });

    test('generates different fingerprints for different data', () => {
      const event1 = {
        invoiceId: 'inv1',
        ledgerSequence: 100,
        pagingToken: '100-1'
      };

      const event2 = {
        invoiceId: 'inv1',
        ledgerSequence: 101,
        pagingToken: '101-1'
      };

      const fingerprint1 = generateEventFingerprint(event1);
      const fingerprint2 = generateEventFingerprint(event2);
      
      expect(fingerprint1).not.toBe(fingerprint2);
    });
  });

  describe('Edge Cases and Error Conditions', () => {
    test('handles malformed input gracefully', () => {
      expect(() => validateStateTransition(undefined, null)).not.toThrow();
      expect(() => validateProjectionConsistency({}, null)).not.toThrow();
      expect(() => validateCursorOrdering('', '')).not.toThrow();
    });

    test('validates complex state transition scenarios', () => {
      // Test complex business flow
      let result = validateStateTransition(null, 'escrow_created');
      expect(result.isValid).toBe(true);
      
      result = validateStateTransition('escrow_created', 'escrow_funded');
      expect(result.isValid).toBe(true);
      
      result = validateStateTransition('escrow_funded', 'escrow_disputed');
      expect(result.isValid).toBe(true);
      
      result = validateStateTransition('escrow_disputed', 'escrow_resolved');
      expect(result.isValid).toBe(true);
      
      result = validateStateTransition('escrow_resolved', 'escrow_released');
      expect(result.isValid).toBe(true);
      
      result = validateStateTransition('escrow_released', 'escrow_finalized');
      expect(result.isValid).toBe(true);
      
      // Should not be able to go backwards
      result = validateStateTransition('escrow_finalized', 'escrow_created');
      expect(result.isValid).toBe(false);
    });

    test('handles boundary conditions in numeric validation', () => {
      const maxSafeInt = Number.MAX_SAFE_INTEGER;
      const minSafeInt = Number.MIN_SAFE_INTEGER;
      
      expect(validateNumericField(maxSafeInt, 'test', minSafeInt, maxSafeInt)).toBe(maxSafeInt);
      expect(() => validateNumericField(maxSafeInt + 1, 'test', minSafeInt, maxSafeInt))
        .toThrow(ValidationError);
    });
  });
});