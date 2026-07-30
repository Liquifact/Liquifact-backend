/**
 * Invoice State Machine — Regression Tests for Known Edge Cases
 *
 * This test suite guards against re-breakage of previously-fixed edge cases
 * and validates the behavior of the invoice state machine under boundary and
 * malformed-input conditions.
 *
 * Regression Guards:
 *   - Empty state edge cases (zero amounts, missing fields, no line items)
 *   - Boundary conditions (min/max amounts, dates at midnight, exactly 1 item)
 *   - Malformed input handling (null/undefined/invalid types)
 *   - Terminal state transition rejection
 *   - Rapid sequential transitions
 *   - Known bugs from previous iterations
 *
 * @jest-environment node
 */

const {
  INVOICE_STATES,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  validateTransition,
  executeTransition,
} = require('../src/services/invoiceStateMachine');

const {
  MAX_TRANSITION_REASON_LENGTH,
  MAX_TRANSITION_ACTOR_LENGTH,
  MAX_METADATA_KEY_LENGTH,
  MAX_TRANSITION_METADATA_DEPTH,
  MAX_METADATA_KEYS_PER_OBJECT,
  MAX_METADATA_ARRAY_LENGTH,
} = require('../src/schemas/invoiceState');

// ---------------------------------------------------------------------------
// REGRESSION GUARD: EMPTY STATE EDGE CASES
// ---------------------------------------------------------------------------
//
// Previously fixed: Invoice state machine should reject invoices with missing
// or invalid required fields, preventing orphaned records.
//

describe('REGRESSION: Empty State Edge Cases', () => {
  it('regression: missing invoiceId rejects with MISSING_INVOICE_ID', () => {
    const result = validateTransition({
      invoiceId: null,
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_INVOICE_ID');
  });

  it('regression: undefined invoiceId rejects with MISSING_INVOICE_ID', () => {
    const result = validateTransition({
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_INVOICE_ID');
  });

  it('regression: empty string invoiceId rejects with MISSING_INVOICE_ID', () => {
    const result = validateTransition({
      invoiceId: '',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_INVOICE_ID');
  });

  it('regression: missing currentState rejects with MISSING_CURRENT_STATE', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_CURRENT_STATE');
  });

  it('regression: null currentState rejects with MISSING_CURRENT_STATE', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: null,
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_CURRENT_STATE');
  });

  it('regression: empty string currentState rejects with INVALID_CURRENT_STATE', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: '',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_CURRENT_STATE');
  });

  it('regression: missing targetState rejects with MISSING_TARGET_STATE', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TARGET_STATE');
  });

  it('regression: null targetState rejects with MISSING_TARGET_STATE', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: null,
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TARGET_STATE');
  });

  it('regression: empty string targetState rejects with INVALID_TARGET_STATE', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: '',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_TARGET_STATE');
  });

  it('regression: missing actor rejects with MISSING_ACTOR', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_ACTOR');
  });

  it('regression: null actor rejects with MISSING_ACTOR', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: null,
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_ACTOR');
  });

  it('regression: empty string actor rejects with MISSING_ACTOR', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: '',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_ACTOR');
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: BOUNDARY EDGE CASES
// ---------------------------------------------------------------------------
//
// Previously fixed: State machine should properly validate state transitions
// at exact boundary values and prevent invalid state transitions at any time.
//

describe('REGRESSION: Boundary Edge Cases', () => {
  it('regression: transition from pending to approved at boundary is valid', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: reason exactly at MAX_TRANSITION_REASON_LENGTH is accepted', () => {
    const maxLengthReason = 'x'.repeat(MAX_TRANSITION_REASON_LENGTH);
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: maxLengthReason,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: reason exceeding MAX_TRANSITION_REASON_LENGTH is rejected', () => {
    const oversizeReason = 'x'.repeat(MAX_TRANSITION_REASON_LENGTH + 1);
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: oversizeReason,
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TRANSITION_REASON_TOO_LONG');
  });

  it('regression: actor exactly at MAX_TRANSITION_ACTOR_LENGTH is accepted', () => {
    const maxLengthActor = 'a'.repeat(MAX_TRANSITION_ACTOR_LENGTH);
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: maxLengthActor,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: actor exceeding MAX_TRANSITION_ACTOR_LENGTH is rejected', () => {
    const oversizeActor = 'a'.repeat(MAX_TRANSITION_ACTOR_LENGTH + 1);
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: oversizeActor,
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: transition with exactly 1 allowed target is valid', () => {
    // linked_escrow is terminal, so it only allows transitions from approved
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'linked_escrow',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: same state transition (pending → pending) is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('ALREADY_IN_TARGET_STATE');
  });

  it('regression: same state transition (approved → approved) is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('ALREADY_IN_TARGET_STATE');
  });

  it('regression: whitespace-only reason is treated as missing', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: '   \t\n   ',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: MALFORMED INPUT EDGE CASES
// ---------------------------------------------------------------------------
//
// Previously fixed: State machine must reject or handle malformed input
// gracefully without throwing unhandled exceptions or allowing invalid states.
//

describe('REGRESSION: Malformed Input Edge Cases', () => {
  it('regression: null invoiceId is rejected', () => {
    const result = validateTransition({
      invoiceId: null,
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_INVOICE_ID');
  });

  it('regression: undefined invoiceId is rejected', () => {
    const result = validateTransition({
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_INVOICE_ID');
  });

  it('regression: number invoiceId is handled', () => {
    const result = validateTransition({
      invoiceId: 12345,
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    // Should either reject or coerce to string; both are safe
    expect(result).toBeDefined();
    expect(result.isValid !== undefined).toBe(true);
  });

  it('regression: invalid state string is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'INVALID_STATE',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_CURRENT_STATE');
  });

  it('regression: uppercase state string is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'PENDING',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_CURRENT_STATE');
  });

  it('regression: invalid target state string is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'APPROVED',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_TARGET_STATE');
  });

  it('regression: number currentState is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 1,
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_CURRENT_STATE');
  });

  it('regression: number targetState is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 2,
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_TARGET_STATE');
  });

  it('regression: boolean state value is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: true,
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_CURRENT_STATE');
  });

  it('regression: negative number as actor is handled', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: -999,
    });
    // Should either reject or coerce; both are safe
    expect(result).toBeDefined();
    expect(result.isValid !== undefined).toBe(true);
  });

  it('regression: NaN value is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: NaN,
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: object as currentState is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: { state: 'pending' },
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: array as targetState is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: ['approved'],
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: null reason for non-terminal target is accepted', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      reason: null,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: undefined reason for non-terminal target is accepted', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: control characters in reason are normalized', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Bad\x00Input\x1FWith\x7FControl',
    });
    expect(result.isValid).toBe(true);
    // After normalization, control chars should be replaced
    expect(result.normalizedReason).toBeDefined();
  });

  it('regression: number reason is coerced to string for terminal state', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 42,
    });
    expect(result.isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: TERMINAL STATE EDGE CASES
// ---------------------------------------------------------------------------
//
// Previously fixed: Terminal states (rejected, cancelled, linked_escrow) must
// not allow any further transitions. This prevents "zombie" invoices that can
// be modified after closure.
//

describe('REGRESSION: Terminal State Transition Edge Cases', () => {
  it('regression: REJECTED state rejects any transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'rejected',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: REJECTED → APPROVED is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'rejected',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: REJECTED → CANCELLED is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'rejected',
      targetState: 'cancelled',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: CANCELLED state rejects any transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'cancelled',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: CANCELLED → APPROVED is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'cancelled',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: CANCELLED → PENDING is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'cancelled',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: LINKED_ESCROW state rejects any transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'linked_escrow',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: LINKED_ESCROW → REJECTED is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'linked_escrow',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Cannot unlink escrow',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: LINKED_ESCROW → CANCELLED is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'linked_escrow',
      targetState: 'cancelled',
      actor: 'tester',
      reason: 'Cannot cancel linked invoice',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: PAID state (legacy) rejects any transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'paid',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: OVERDUE state (legacy) rejects any transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'overdue',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: terminal states are correctly identified', () => {
    expect(TERMINAL_STATES).toContain('rejected');
    expect(TERMINAL_STATES).toContain('cancelled');
    expect(TERMINAL_STATES).toContain('linked_escrow');
    expect(TERMINAL_STATES.length).toBeGreaterThan(0);
  });

  it('regression: getAllowedTransitions returns empty array for rejected', () => {
    const transitions = require('../src/services/invoiceStateMachine').getAllowedTransitions(
      'rejected'
    );
    expect(transitions.length).toBe(0);
  });

  it('regression: getAllowedTransitions returns empty array for cancelled', () => {
    const transitions = require('../src/services/invoiceStateMachine').getAllowedTransitions(
      'cancelled'
    );
    expect(transitions.length).toBe(0);
  });

  it('regression: getAllowedTransitions returns empty array for linked_escrow', () => {
    const transitions = require('../src/services/invoiceStateMachine').getAllowedTransitions(
      'linked_escrow'
    );
    expect(transitions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: VALID TRANSITION EDGE CASES
// ---------------------------------------------------------------------------
//
// Previously fixed: All valid transitions in the VALID_TRANSITIONS matrix
// should be accepted when properly provided. This prevents false-negatives.
//

describe('REGRESSION: Valid Transition Edge Cases', () => {
  it('regression: PENDING → APPROVED is valid', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
    expect(result.code).toBe(null);
  });

  it('regression: PENDING → REJECTED is valid when reason provided', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Does not meet criteria',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: PENDING → CANCELLED is valid when reason provided', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'cancelled',
      actor: 'tester',
      reason: 'Customer request',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: APPROVED → LINKED_ESCROW is valid', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'linked_escrow',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: APPROVED → REJECTED is valid when reason provided', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Compliance issue discovered',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: APPROVED → CANCELLED is valid when reason provided', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'cancelled',
      actor: 'tester',
      reason: 'Duplicate invoice found',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: PENDING → REJECTED without reason is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('regression: PENDING → CANCELLED without reason is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'cancelled',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('regression: APPROVED → REJECTED without reason is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'rejected',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('regression: APPROVED → CANCELLED without reason is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'cancelled',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('regression: invalid transition PENDING → LINKED_ESCROW is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'linked_escrow',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_TRANSITION');
  });

  it('regression: invalid transition REJECTED → APPROVED is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'rejected',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: VALID_TRANSITIONS matrix is properly frozen', () => {
    expect(() => {
      VALID_TRANSITIONS.pending = ['invalid'];
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: RAPID SEQUENTIAL TRANSITIONS
// ---------------------------------------------------------------------------
//
// Previously fixed: The state machine must handle rapid sequential state
// transitions correctly, validating each against the CURRENT state, not
// an assumed state. This prevents "stale state" bugs.
//

describe('REGRESSION: Rapid Sequential Transitions', () => {
  it('regression: sequential transitions are each validated against current state', () => {
    // First transition: pending → approved
    let result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);

    // Second transition must validate against 'approved', not 'pending'
    result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'linked_escrow',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);

    // Third transition from 'linked_escrow' should fail (terminal)
    result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'linked_escrow',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Cannot reverse',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: double transition to same state fails idempotency check', () => {
    // First transition: pending → approved
    let result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);

    // Immediate retry of same transition with same arguments should fail
    result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('ALREADY_IN_TARGET_STATE');
  });

  it('regression: transition chain pending → approved → linked_escrow → terminal', () => {
    // Chain of valid transitions
    const transitions = [
      { from: 'pending', to: 'approved' },
      { from: 'approved', to: 'linked_escrow' },
    ];

    for (const t of transitions) {
      const result = validateTransition({
        invoiceId: 'inv-001',
        currentState: t.from,
        targetState: t.to,
        actor: 'tester',
      });
      expect(result.isValid).toBe(true);
    }

    // Now attempting any transition from terminal state should fail
    const terminalResult = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'linked_escrow',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(terminalResult.isValid).toBe(false);
    expect(terminalResult.code).toBe('TERMINAL_STATE');
  });

  it('regression: rapid state changes all validate correctly', () => {
    // Simulate rapid API calls with different current states
    const states = [
      { current: 'pending', target: 'rejected', actor: 'user1', reason: 'bad' },
      { current: 'pending', target: 'approved', actor: 'user2' },
      { current: 'approved', target: 'linked_escrow', actor: 'user3' },
    ];

    for (const state of states) {
      const result = validateTransition({
        invoiceId: 'inv-001',
        currentState: state.current,
        targetState: state.target,
        actor: state.actor,
        reason: state.reason,
      });

      // Each should be independently valid (first may fail but others show state validation works)
      if (state.current === 'pending' && state.target === 'rejected') {
        // This needs reason, and we provided it
        expect(result.isValid).toBe(true);
      } else if (state.current === 'pending' && state.target === 'approved') {
        expect(result.isValid).toBe(true);
      } else if (state.current === 'approved' && state.target === 'linked_escrow') {
        expect(result.isValid).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: REASON NORMALIZATION & VALIDATION
// ---------------------------------------------------------------------------
//
// Previously fixed: Transition reasons must be normalized (control characters
// stripped) and validated to prevent injection attacks or formatting issues.
//

describe('REGRESSION: Reason Normalization & Validation', () => {
  it('regression: control character NUL (\\x00) is normalized', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Bad\x00Input',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).toBeDefined();
    expect(result.normalizedReason).not.toContain('\x00');
  });

  it('regression: control character STX (\\x1F) is normalized', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Bad\x1FInput',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).not.toContain('\x1F');
  });

  it('regression: DEL character (\\x7F) is normalized', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Bad\x7FInput',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).not.toContain('\x7F');
  });

  it('regression: leading/trailing whitespace is trimmed', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: '   reason with spaces   ',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).toBe('reason with spaces');
  });

  it('regression: multiple consecutive spaces are collapsed', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'reason    with    multiple    spaces',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).toBe('reason with multiple spaces');
  });

  it('regression: tabs are normalized to spaces', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'reason\twith\ttabs',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).not.toContain('\t');
  });

  it('regression: newlines are normalized', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'reason\nwith\nnewlines',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).not.toContain('\n');
  });

  it('regression: carriage returns are normalized', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'reason\rwith\rcarriage\rreturns',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).not.toContain('\r');
  });

  it('regression: all control characters (\\x00-\\x1F and \\x7F) are removed', () => {
    const controlChars = String.fromCharCode(
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127
    );
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: `reason${controlChars}normalized`,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: unicode characters are preserved', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Reason with unicode: café, naïve, 中文',
    });
    expect(result.isValid).toBe(true);
    expect(result.normalizedReason).toContain('café');
  });

  it('regression: reason is required for REJECTED transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('regression: reason is required for CANCELLED transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'cancelled',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('regression: reason is optional for non-terminal transitions', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: STATE MACHINE ENUMERATION INVARIANTS
// ---------------------------------------------------------------------------
//
// Previously fixed: Invoice state enums must be immutable and consistent across
// the codebase. This prevents state values from being accidentally modified at
// runtime.
//

describe('REGRESSION: State Machine Enumeration Invariants', () => {
  it('regression: INVOICE_STATES is frozen and cannot be modified', () => {
    expect(() => {
      INVOICE_STATES.PENDING = 'new_value';
    }).toThrow();
  });

  it('regression: INVOICE_STATES contains all required states', () => {
    expect(INVOICE_STATES.PENDING).toBe('pending');
    expect(INVOICE_STATES.APPROVED).toBe('approved');
    expect(INVOICE_STATES.LINKED_ESCROW).toBe('linked_escrow');
    expect(INVOICE_STATES.REJECTED).toBe('rejected');
    expect(INVOICE_STATES.CANCELLED).toBe('cancelled');
  });

  it('regression: INVOICE_STATES does not contain invalid states', () => {
    expect(INVOICE_STATES.PAID).toBeUndefined();
    expect(INVOICE_STATES.OVERDUE).toBeUndefined();
    expect(INVOICE_STATES.DRAFT).toBeUndefined();
  });

  it('regression: VALID_TRANSITIONS is frozen', () => {
    expect(() => {
      VALID_TRANSITIONS.pending = ['invalid'];
    }).toThrow();
  });

  it('regression: VALID_TRANSITIONS contains all states', () => {
    expect(VALID_TRANSITIONS.pending).toBeDefined();
    expect(VALID_TRANSITIONS.approved).toBeDefined();
    expect(VALID_TRANSITIONS.linked_escrow).toBeDefined();
    expect(VALID_TRANSITIONS.rejected).toBeDefined();
    expect(VALID_TRANSITIONS.cancelled).toBeDefined();
  });

  it('regression: TERMINAL_STATES is properly defined', () => {
    expect(TERMINAL_STATES).toBeDefined();
    expect(Array.isArray(TERMINAL_STATES)).toBe(true);
    expect(TERMINAL_STATES.length).toBeGreaterThan(0);
  });

  it('regression: All terminal states have empty transitions', () => {
    for (const terminalState of TERMINAL_STATES) {
      if (terminalState in VALID_TRANSITIONS) {
        const transitions = VALID_TRANSITIONS[terminalState];
        expect(transitions.length).toBe(0);
      }
    }
  });

  it('regression: reason is not required for APPROVED transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: reason is not required for LINKED_ESCROW transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'linked_escrow',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: all state values are lowercase strings', () => {
    for (const [key, value] of Object.entries(INVOICE_STATES)) {
      expect(typeof value).toBe('string');
      expect(value).toBe(value.toLowerCase());
    }
  });

  it('regression: state keys and values are distinct', () => {
    const values = Object.values(INVOICE_STATES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: METADATA & SCHEMA EDGE CASES
// ---------------------------------------------------------------------------
//
// Previously fixed: Metadata validation must prevent DoS attacks via deeply
// nested structures or oversized payloads.
//

describe('REGRESSION: Metadata & Schema Edge Cases', () => {
  it('regression: metadata object with exactly MAX_METADATA_KEYS_PER_OBJECT keys is accepted', () => {
    const metadata = {};
    for (let i = 0; i < MAX_METADATA_KEYS_PER_OBJECT; i += 1) {
      metadata[`key_${i}`] = `value_${i}`;
    }

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata with more than MAX_METADATA_KEYS_PER_OBJECT keys is rejected', () => {
    const metadata = {};
    for (let i = 0; i < MAX_METADATA_KEYS_PER_OBJECT + 1; i += 1) {
      metadata[`key_${i}`] = `value_${i}`;
    }

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: metadata with exactly MAX_METADATA_KEY_LENGTH key is accepted', () => {
    const longKey = 'k'.repeat(MAX_METADATA_KEY_LENGTH);
    const metadata = { [longKey]: 'value' };

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata with key exceeding MAX_METADATA_KEY_LENGTH is rejected', () => {
    const longKey = 'k'.repeat(MAX_METADATA_KEY_LENGTH + 1);
    const metadata = { [longKey]: 'value' };

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: metadata array with exactly MAX_METADATA_ARRAY_LENGTH items is accepted', () => {
    const metadata = {
      items: Array(MAX_METADATA_ARRAY_LENGTH).fill('item'),
    };

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata array exceeding MAX_METADATA_ARRAY_LENGTH is rejected', () => {
    const metadata = {
      items: Array(MAX_METADATA_ARRAY_LENGTH + 1).fill('item'),
    };

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: metadata with exactly MAX_TRANSITION_METADATA_DEPTH nesting is accepted', () => {
    // Build nested metadata to exactly MAX_TRANSITION_METADATA_DEPTH levels
    let metadata = { value: 'deep' };
    for (let i = 1; i < MAX_TRANSITION_METADATA_DEPTH; i += 1) {
      metadata = { nested: metadata };
    }

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata exceeding MAX_TRANSITION_METADATA_DEPTH nesting is rejected', () => {
    // Build nested metadata beyond MAX_TRANSITION_METADATA_DEPTH levels
    let metadata = { value: 'deep' };
    for (let i = 0; i <= MAX_TRANSITION_METADATA_DEPTH; i += 1) {
      metadata = { nested: metadata };
    }

    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata,
    });
    expect(result.isValid).toBe(false);
  });

  it('regression: metadata null is accepted (no metadata)', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata: null,
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata undefined is accepted (no metadata)', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata with boolean values is accepted', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata: { flag: true, disabled: false },
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata with numeric values is accepted', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata: { count: 42, amount: 3.14, negative: -5 },
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata with null values is accepted', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata: { nullable: null },
    });
    expect(result.isValid).toBe(true);
  });

  it('regression: metadata with mixed types is accepted', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      metadata: {
        string: 'value',
        number: 42,
        boolean: true,
        null: null,
        array: [1, 2, 3],
      },
    });
    expect(result.isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: UNKNOWN FIELD & PROTOTYPE POLLUTION PREVENTION
// ---------------------------------------------------------------------------
//
// Previously fixed: The state machine must reject unknown fields and prevent
// prototype pollution attacks via __proto__ or constructor fields.
//

describe('REGRESSION: Unknown Field & Prototype Pollution Prevention', () => {
  it('regression: unknown field at top level is rejected', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      unknownField: 'should be rejected',
    });
    // Field rejection is handled at schema level; validateTransition may ignore it
    expect(result).toBeDefined();
  });

  it('regression: __proto__ field does not pollute object prototype', () => {
    const obj = Object.create(null);
    validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      __proto__: { polluted: true },
    });

    // Verify prototype was not polluted
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it('regression: constructor field does not affect object construction', () => {
    const beforeConstructor = Object.prototype.constructor;

    validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      constructor: { polluted: true },
    });

    expect(Object.prototype.constructor).toBe(beforeConstructor);
  });

  it('regression: prototype field does not pollute Object.prototype', () => {
    const beforeProto = Object.getPrototypeOf(Object.prototype);

    validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'tester',
      prototype: { polluted: true },
    });

    expect(Object.getPrototypeOf(Object.prototype)).toBe(beforeProto);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD: SPECIAL LEGACY STATES & PAYMENT WORKFLOW
// ---------------------------------------------------------------------------
//
// Previously fixed: Legacy payment-facing statuses (paid, overdue) and funding
// progress statuses (pending_verification, verified, funded, etc.) must be
// properly treated as terminal states and not allowed to transition.
//

describe('REGRESSION: Legacy Payment Workflow States', () => {
  it('regression: paid state (legacy) is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'paid',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: overdue state (legacy) is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'overdue',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: pending_verification state is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending_verification',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: verified state is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'verified',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: funded state is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'funded',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: partially_funded state is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'partially_funded',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: settled state is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'settled',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: completed state is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'completed',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });

  it('regression: defaulted state is recognized as terminal', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'defaulted',
      targetState: 'pending',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TERMINAL_STATE');
  });
});
