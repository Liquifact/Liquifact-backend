/**
 * Invoice State Machine — Full Transition Matrix & Audit Emission Tests
 *
 * Covers:
 *   - Every entry in VALID_TRANSITIONS succeeds
 *   - Every disallowed pair is rejected with a clear error code
 *   - Terminal states reject all further transitions
 *   - REJECTED / CANCELLED require a normalized reason
 *   - Control characters are stripped via normalizeTransitionReason
 *   - An audit log entry is created on each successful transition
 *   - Route handlers persist transitions via tenant-scoped invoiceService access
 *
 * @jest-environment node
 */

const request = require('supertest');
const express = require('express');
const { run: runContext } = require('../src/requestContext');

// Mock KYC gating so link-escrow routes pass through in tests
jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
}));

// Stub auth so unit tests can exercise invoice-state handler behavior without
// requiring a valid Authorization header on every request.
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: jest.fn((req, res, next) => next()),
}));

const {
  INVOICE_STATES,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  isValidState,
  isTransitionAllowed,
  isTerminalState,
  getAllowedTransitions,
  validateTransition,
  executeTransition,
  getTransitionHistory,
  canLinkToEscrow,
} = require('../src/services/invoiceStateMachine');
const { clearAuditLogs, getAuditLogs } = require('../src/services/auditLog');

// Mock escrowSubmit so the idempotency middleware (now referenced from
// invoiceStateRoutes via optionalIdempotency) does not chain into metrics.js
// which has pre-existing undefined exports.
jest.mock('../src/services/escrowSubmit', () => ({
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9._:-]{8,128}$/,
}));

const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const invoiceService = require('../src/services/invoiceService');

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

const TERMINAL_REASON_REQUIRED_STATES = [
  INVOICE_STATES.REJECTED,
  INVOICE_STATES.CANCELLED,
];

/* ------------------------------------------------------------------ */
/*  Helper: build the expected error code for a (from, to) pair       */
/*  when calling validateTransition *without* a reason.               */
/* ------------------------------------------------------------------ */
function expectedValidationCode(fromState, targetState) {
  if (fromState === targetState) return 'ALREADY_IN_TARGET_STATE';
  if (TERMINAL_STATES.includes(fromState)) return 'TERMINAL_STATE';
  if (TERMINAL_REASON_REQUIRED_STATES.includes(targetState)) {
    return 'MISSING_TRANSITION_REASON';
  }
  const allowed = VALID_TRANSITIONS[fromState] || [];
  if (!allowed.includes(targetState)) return 'INVALID_TRANSITION';
  return null; // valid
}

/* ------------------------------------------------------------------ */
/*  Helper: build the expected error code for executeTransition       */
/*  when a reason IS provided for valid transitions that need one.    */
/* ------------------------------------------------------------------ */
function expectedExecutionCode(fromState, targetState) {
  if (fromState === targetState) return 'ALREADY_IN_TARGET_STATE';
  if (TERMINAL_STATES.includes(fromState)) return 'TERMINAL_STATE';
  const allowed = VALID_TRANSITIONS[fromState] || [];
  if (!allowed.includes(targetState)) return 'INVALID_TRANSITION';
  return null; // valid — executeTransition will succeed
}

/* ------------------------------------------------------------------ */
/*  normalizeTransitionReason (tested indirectly via exported API)    */
/* ------------------------------------------------------------------ */
describe('normalizeTransitionReason', () => {
  it('should strip control characters from reason via validateTransition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 'Reason\u0000with\u001Fcontrol\u007Fchars',
    });
    expect(result.isValid).toBe(true);
  });

  it('should treat whitespace-only reason as missing for terminal states', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: '   ',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('should treat null reason as missing for terminal states', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'cancelled',
      actor: 'tester',
      reason: null,
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('should treat undefined reason as missing for terminal states', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('should normalize non-string reason (number) to string', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason: 42,
    });
    expect(result.isValid).toBe(true);
  });

  it('should allow reason with exactly MAX_TRANSITION_REASON_LENGTH chars', () => {
    const reason = 'x'.repeat(1024);
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason,
    });
    expect(result.isValid).toBe(true);
  });

  it('should reject reason exceeding MAX_TRANSITION_REASON_LENGTH chars', () => {
    const reason = 'x'.repeat(1025);
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'tester',
      reason,
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('TRANSITION_REASON_TOO_LONG');
  });
});

/* ------------------------------------------------------------------ */
/*  State validation                                                  */
/* ------------------------------------------------------------------ */
describe('State Validation', () => {
  it('should recognize all valid states', () => {
    expect(isValidState('pending')).toBe(true);
    expect(isValidState('approved')).toBe(true);
    expect(isValidState('linked_escrow')).toBe(true);
    expect(isValidState('rejected')).toBe(true);
    expect(isValidState('cancelled')).toBe(true);
  });

  it('should reject invalid states', () => {
    expect(isValidState('invalid')).toBe(false);
    expect(isValidState('PENDING')).toBe(false);
    expect(isValidState('')).toBe(false);
    expect(isValidState(null)).toBe(false);
    expect(isValidState(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  isTransitionAllowed — individual cases for readability            */
/* ------------------------------------------------------------------ */
describe('Transition Rules — individual assertions', () => {
  it('should allow pending → approved', () => {
    expect(isTransitionAllowed('pending', 'approved')).toBe(true);
  });

  it('should allow pending → rejected', () => {
    expect(isTransitionAllowed('pending', 'rejected')).toBe(true);
  });

  it('should allow pending → cancelled', () => {
    expect(isTransitionAllowed('pending', 'cancelled')).toBe(true);
  });

  it('should allow approved → linked_escrow', () => {
    expect(isTransitionAllowed('approved', 'linked_escrow')).toBe(true);
  });

  it('should allow approved → cancelled', () => {
    expect(isTransitionAllowed('approved', 'cancelled')).toBe(true);
  });

  it('should NOT allow pending → linked_escrow (silent jump)', () => {
    expect(isTransitionAllowed('pending', 'linked_escrow')).toBe(false);
  });

  it('should NOT allow transitions involving an unrecognized state', () => {
    expect(isTransitionAllowed('invalid', 'pending')).toBe(false);
    expect(isTransitionAllowed('pending', 'invalid')).toBe(false);
  });

  it('should NOT allow approved → rejected', () => {
    expect(isTransitionAllowed('approved', 'rejected')).toBe(false);
  });

  it('should NOT allow approved → pending (reversal)', () => {
    expect(isTransitionAllowed('approved', 'pending')).toBe(false);
  });

  it('should NOT allow linked_escrow → any state', () => {
    expect(isTransitionAllowed('linked_escrow', 'approved')).toBe(false);
    expect(isTransitionAllowed('linked_escrow', 'pending')).toBe(false);
    expect(isTransitionAllowed('linked_escrow', 'rejected')).toBe(false);
  });

  it('should NOT allow rejected → any state', () => {
    expect(isTransitionAllowed('rejected', 'approved')).toBe(false);
    expect(isTransitionAllowed('rejected', 'pending')).toBe(false);
    expect(isTransitionAllowed('rejected', 'linked_escrow')).toBe(false);
  });

  it('should NOT allow cancelled → any state', () => {
    expect(isTransitionAllowed('cancelled', 'approved')).toBe(false);
    expect(isTransitionAllowed('cancelled', 'pending')).toBe(false);
  });

  it('should NOT allow same-state transitions', () => {
    expect(isTransitionAllowed('pending', 'pending')).toBe(false);
    expect(isTransitionAllowed('approved', 'approved')).toBe(false);
    expect(isTransitionAllowed('linked_escrow', 'linked_escrow')).toBe(false);
    expect(isTransitionAllowed('rejected', 'rejected')).toBe(false);
    expect(isTransitionAllowed('cancelled', 'cancelled')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Exhaustive Cartesian product — isTransitionAllowed                 */
/* ------------------------------------------------------------------ */
describe('Transition Rules — exhaustive matrix (Cartesian product)', () => {
  const states = Object.values(INVOICE_STATES);

  states.forEach((fromState) => {
    states.forEach((targetState) => {
      const expected = (VALID_TRANSITIONS[fromState] || []).includes(targetState)
        && fromState !== targetState
        && !TERMINAL_STATES.includes(fromState);

      it(`isTransitionAllowed: ${fromState} → ${targetState} → ${expected ? 'ALLOWED' : 'DENIED'}`, () => {
        expect(isTransitionAllowed(fromState, targetState)).toBe(expected);
      });
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Terminal states                                                   */
/* ------------------------------------------------------------------ */
describe('Terminal States', () => {
  it('should identify terminal states', () => {
    expect(isTerminalState('linked_escrow')).toBe(true);
    expect(isTerminalState('rejected')).toBe(true);
    expect(isTerminalState('cancelled')).toBe(true);
  });

  it('should identify non-terminal states', () => {
    expect(isTerminalState('pending')).toBe(false);
    expect(isTerminalState('approved')).toBe(false);
  });

  it('should reject all transitions from terminal states via validateTransition', () => {
    TERMINAL_STATES.forEach((terminalState) => {
      const result = validateTransition({
        invoiceId: 'inv-terminal',
        currentState: terminalState,
        targetState: 'pending',
        actor: 'tester',
      });
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('TERMINAL_STATE');
    });
  });
});

/* ------------------------------------------------------------------ */
/*  getAllowedTransitions                                              */
/* ------------------------------------------------------------------ */
describe('Allowed Transitions', () => {
  it('should return correct allowed transitions for pending', () => {
    const allowed = getAllowedTransitions('pending');
    expect(allowed).toContain('approved');
    expect(allowed).toContain('rejected');
    expect(allowed).toContain('cancelled');
    expect(allowed).toHaveLength(3);
  });

  it('should return correct allowed transitions for approved', () => {
    const allowed = getAllowedTransitions('approved');
    expect(allowed).toContain('linked_escrow');
    expect(allowed).toContain('cancelled');
    expect(allowed).toHaveLength(2);
  });

  it('should return empty array for terminal states', () => {
    expect(getAllowedTransitions('linked_escrow')).toEqual([]);
    expect(getAllowedTransitions('rejected')).toEqual([]);
    expect(getAllowedTransitions('cancelled')).toEqual([]);
  });

  it('should return empty array for invalid states', () => {
    expect(getAllowedTransitions('invalid')).toEqual([]);
    expect(getAllowedTransitions(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  validateTransition — detailed validation error codes              */
/* ------------------------------------------------------------------ */
describe('Transition Validation', () => {
  it('should validate a valid pending → approved transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject transition with missing invoice ID', () => {
    const result = validateTransition({
      currentState: 'pending',
      targetState: 'approved',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_INVOICE_ID');
  });

  it('should reject transition with missing current state', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      targetState: 'approved',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_CURRENT_STATE');
  });

  it('should reject transition with missing target state', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TARGET_STATE');
  });

  it('should reject transition with missing actor', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_ACTOR');
  });

  it('should reject transition with invalid current state', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'invalid',
      targetState: 'approved',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_CURRENT_STATE');
  });

  it('should reject transition with invalid target state', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'invalid',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_TARGET_STATE');
  });

  it('should reject transition to same state', () => {
    Object.values(INVOICE_STATES).forEach((state) => {
      const result = validateTransition({
        invoiceId: 'inv-001',
        currentState: state,
        targetState: state,
        actor: 'user-123',
      });
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('ALREADY_IN_TARGET_STATE');
    });
  });

  it('should reject invalid transition (silent jump)', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'linked_escrow',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('INVALID_TRANSITION');
    expect(result.allowedTransitions).toEqual(['approved', 'rejected', 'cancelled']);
  });

  it('should reject transition from terminal state', () => {
    TERMINAL_STATES.forEach((terminalState) => {
      const result = validateTransition({
        invoiceId: 'inv-001',
        currentState: terminalState,
        targetState: 'approved',
        actor: 'user-123',
        reason: 'should not matter',
      });
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('TERMINAL_STATE');
    });
  });

  it('should require reason for terminal transition targets', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'approved',
      targetState: 'cancelled',
      actor: 'user-123',
    });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe('MISSING_TRANSITION_REASON');
  });

  it('should provide allowed transitions hint on invalid transition', () => {
    const result = validateTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'linked_escrow',
      actor: 'user-123',
    });
    expect(result.allowedTransitions).toEqual(['approved', 'rejected', 'cancelled']);
  });
});

/* ------------------------------------------------------------------ */
/*  Exhaustive Cartesian product — validateTransition                  */
/*  (without reason, so reason-required states show MISSING_REASON)   */
/* ------------------------------------------------------------------ */
describe('Transition Validation — exhaustive matrix', () => {
  const states = Object.values(INVOICE_STATES);

  states.forEach((fromState) => {
    states.forEach((targetState) => {
      const code = expectedValidationCode(fromState, targetState);

      it(`validateTransition: ${fromState} → ${targetState} → ${code || 'VALID'}`, () => {
        const result = validateTransition({
          invoiceId: 'inv-matrix',
          currentState: fromState,
          targetState,
          actor: 'matrix-user',
        });

        if (code === null) {
          expect(result.isValid).toBe(true);
          expect(result.error).toBeUndefined();
        } else {
          expect(result.isValid).toBe(false);
          expect(result.code).toBe(code);
        }
      });
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Transition Execution (async)                                      */
/* ------------------------------------------------------------------ */
describe('Transition Execution', () => {
  beforeEach(() => {
    clearAuditLogs();
  });

  it('should execute valid pending → approved and create audit log', async () => {
    const result = await executeTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'user-123',
      reason: 'Invoice verified',
      ipAddress: '192.168.1.1',
      userAgent: 'Test Agent',
    });

    expect(result.success).toBe(true);
    expect(result.previousState).toBe('pending');
    expect(result.newState).toBe('approved');
    expect(result.transitionedBy).toBe('user-123');
    expect(result.auditLog).toBeDefined();
    expect(result.auditLog.action).toBe('STATE_TRANSITION');
    expect(result.auditLog.metadata.reason).toBe('Invoice verified');

    const logs = await getAuditLogs({ resourceId: 'inv-001' });
    expect(logs).toHaveLength(1);
    expect(logs[0].changes.before.state).toBe('pending');
    expect(logs[0].changes.after.state).toBe('approved');
    expect(logs[0].metadata.reason).toBe('Invoice verified');
  });

  it('should persist terminal transition reason in audit metadata', async () => {
    const result = await executeTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'user-123',
      reason: 'Failed KYC checks',
    });

    expect(result.success).toBe(true);
    expect(result.newState).toBe('rejected');
    expect(result.auditLog.metadata.reason).toBe('Failed KYC checks');

    const logs = await getAuditLogs({ resourceId: 'inv-001' });
    expect(logs[0].metadata.reason).toBe('Failed KYC checks');
  });

  it('should reject invalid transition with error', async () => {
    await expect(
      executeTransition({
        invoiceId: 'inv-001',
        currentState: 'pending',
        targetState: 'linked_escrow',
        actor: 'user-123',
        reason: 'Silent jump',
      })
    ).rejects.toThrow(/Invalid state transition/);
  });

  it('should include additional metadata in audit log', async () => {
    const result = await executeTransition({
      invoiceId: 'inv-002',
      currentState: 'approved',
      targetState: 'linked_escrow',
      actor: 'user-456',
      reason: 'Escrow created',
      metadata: { escrowId: 'escrow-123', method: 'POST' },
    });

    expect(result.auditLog.metadata.escrowId).toBe('escrow-123');
    expect(result.auditLog.metadata.method).toBe('POST');
  });

  it('should strip control characters from reason in audit log', async () => {
    const result = await executeTransition({
      invoiceId: 'inv-001',
      currentState: 'pending',
      targetState: 'rejected',
      actor: 'user-123',
      reason: 'Bad\u0000reason\u0001with\u007Fcontrol',
    });

    expect(result.success).toBe(true);
    expect(result.auditLog.metadata.reason).toBe('Bad reason with control');
  });

  it('should reject transition with oversized reason', async () => {
    await expect(
      executeTransition({
        invoiceId: 'inv-001',
        currentState: 'pending',
        targetState: 'rejected',
        actor: 'user-123',
        reason: 'x'.repeat(1025),
      })
    ).rejects.toThrow(/1024 characters or fewer/);
  });

  it('should reject transition without reason for terminal target', async () => {
    await expect(
      executeTransition({
        invoiceId: 'inv-001',
        currentState: 'pending',
        targetState: 'rejected',
        actor: 'user-123',
      })
    ).rejects.toThrow(/Reason is required/);
  });
});

/* ------------------------------------------------------------------ */
/*  Exhaustive Cartesian product — executeTransition                   */
/*  (with reason for valid transitions that need one)                 */
/* ------------------------------------------------------------------ */
describe('Transition Execution — exhaustive matrix with audit verification', () => {
  const states = Object.values(INVOICE_STATES);

  beforeEach(() => {
    clearAuditLogs();
  });

  states.forEach((fromState) => {
    states.forEach((targetState) => {
      it(`executeTransition + audit: ${fromState} → ${targetState}`, async () => {
        const code = expectedExecutionCode(fromState, targetState);
        const invoiceId = `inv-matrix-${fromState}-${targetState}`;

        if (code === null) {
          const reason = `Reason ${fromState}→${targetState}`;
          const result = await executeTransition({
            invoiceId,
            currentState: fromState,
            targetState,
            actor: 'matrix-user',
            reason,
            ipAddress: '192.0.2.1',
            userAgent: 'Test-UA',
            metadata: { testMatrix: true },
          });

          expect(result.success).toBe(true);
          expect(result.previousState).toBe(fromState);
          expect(result.newState).toBe(targetState);
          expect(result.auditLog).toBeDefined();

          const logs = await getAuditLogs({ resourceId: invoiceId, action: 'STATE_TRANSITION' });
          expect(logs).toHaveLength(1);
          expect(logs[0].changes.before.state).toBe(fromState);
          expect(logs[0].changes.after.state).toBe(targetState);
          expect(logs[0].metadata.transitionType).toBe(`${fromState}_to_${targetState}`);
          expect(logs[0].metadata.reason).toBe(reason);
        } else {
          await expect(
            executeTransition({
              invoiceId,
              currentState: fromState,
              targetState,
              actor: 'matrix-user',
              reason: 'Should not transition',
              ipAddress: '192.0.2.1',
              userAgent: 'Test-UA',
            })
          ).rejects.toThrow();
        }
      });
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Transition History                                                */
/* ------------------------------------------------------------------ */
describe('Transition History', () => {
  beforeEach(() => {
    clearAuditLogs();
  });

  it('should retrieve transition history for an invoice', async () => {
    await executeTransition({
      invoiceId: 'inv-003',
      currentState: 'pending',
      targetState: 'approved',
      actor: 'user-123',
      reason: 'First approval',
    });

    await executeTransition({
      invoiceId: 'inv-003',
      currentState: 'approved',
      targetState: 'linked_escrow',
      actor: 'user-456',
      reason: 'Linked to escrow',
    });

    const history = await getTransitionHistory('inv-003', getAuditLogs);

    expect(history).toHaveLength(2);
    expect(history[0].fromState).toBe('approved');
    expect(history[0].toState).toBe('linked_escrow');
    expect(history[1].fromState).toBe('pending');
    expect(history[1].toState).toBe('approved');
  });

  it('should return empty array for invoice with no transitions', async () => {
    const history = await getTransitionHistory('inv-999', getAuditLogs);
    expect(history).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Business Rules — Link to Escrow                                   */
/* ------------------------------------------------------------------ */
describe('Business Rules — Link to Escrow', () => {
  it('should allow linking approved invoice to escrow', () => {
    const invoice = { id: 'inv-001', status: 'approved', amount: 1000 };
    const result = canLinkToEscrow(invoice);
    expect(result.canLink).toBe(true);
  });

  it('should not allow linking pending invoice to escrow', () => {
    const invoice = { id: 'inv-001', status: 'pending', amount: 1000 };
    const result = canLinkToEscrow(invoice);
    expect(result.canLink).toBe(false);
    expect(result.reason).toContain('approved state');
  });

  it('should not allow linking rejected invoice to escrow', () => {
    const invoice = { id: 'inv-001', status: 'rejected', amount: 1000 };
    const result = canLinkToEscrow(invoice);
    expect(result.canLink).toBe(false);
    expect(result.reason).toContain('approved state');
  });

  it('should not allow linking null invoice', () => {
    const result = canLinkToEscrow(null);
    expect(result.canLink).toBe(false);
    expect(result.reason).toBe('Invoice not found');
  });
});

/* ------------------------------------------------------------------ */
/*  Invoice State API Routes                                          */
/* ------------------------------------------------------------------ */
describe('Invoice State API Routes', () => {
  let app;
  /** @type {Map<string, object>} */
  let invoiceStore;

  function storeKey(tenantId, invoiceId) {
    return `${tenantId}:${invoiceId}`;
  }

  function seedRouteFixtures() {
    invoiceStore.set(storeKey(TENANT_A, 'inv-001'), {
      invoice_id: 'inv-001',
      tenant_id: TENANT_A,
      status: 'pending',
      amount: 1000,
      customer: 'Acme Corp',
    });
    invoiceStore.set(storeKey(TENANT_A, 'inv-002'), {
      invoice_id: 'inv-002',
      tenant_id: TENANT_A,
      status: 'approved',
      amount: 2000,
      customer: 'TechCo',
    });
    invoiceStore.set(storeKey(TENANT_A, 'inv-003'), {
      invoice_id: 'inv-003',
      tenant_id: TENANT_A,
      status: 'linked_escrow',
      amount: 5000,
      customer: 'GlobalInc',
    });
  }

  beforeEach(() => {
    clearAuditLogs();
    invoiceStore = new Map();
    seedRouteFixtures();

    jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
      return invoiceStore.get(storeKey(tenantId, id)) || null;
    });

    jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId, options = {}) => {
      const key = storeKey(tenantId, id);
      const existing = invoiceStore.get(key);
      if (!existing) {
        return null;
      }
      if (options.expectedStatus !== undefined && existing.status !== options.expectedStatus) {
        return null;
      }
      const updated = { ...existing, ...updates };
      invoiceStore.set(key, updated);
      return updated;
    });

    app = express();
    app.use(express.json());

    app.use((req, _res, next) => {
      req.user = { id: 'test-user-123', sub: 'test-user-123', smeId: 'sme-verified' };
      next();
    });

    // Seed correlation ID on the request object and in the AsyncLocalStorage
    // context so that route handlers can include it in responses and downstream
    // calls (mirrors the real correlationIdMiddleware → requestContext chain).
    app.use((req, res, next) => {
      const correlationId = 'test-corr-001';
      req.id = correlationId;
      req.correlationId = correlationId;
      runContext({ requestId: correlationId, correlationId }, next);
    });

    app.use('/api/invoices', invoiceStateRoutes);

    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function expectSuccessEnvelope(body, message, expectedData) {
    expect(body).toEqual(expect.objectContaining({
      data: expect.any(Object),
      meta: expect.objectContaining({
        timestamp: expect.any(String),
        version: '0.1.0',
      }),
      error: null,
      correlationId: 'test-corr-001',
      message,
    }));
    expect(Object.keys(body).sort()).toEqual(['correlationId', 'data', 'error', 'message', 'meta']);
    expect(body.data).toEqual(expectedData);
  }

  function expectErrorEnvelope(body, expectedCode, expectedMessageMatcher, expectedDetails = undefined) {
    expect(body).toEqual(expect.objectContaining({
      data: null,
      meta: expect.objectContaining({
        timestamp: expect.any(String),
        version: '0.1.0',
      }),
      error: expect.objectContaining({
        code: expectedCode,
        message: expectedMessageMatcher,
      }),
      correlationId: 'test-corr-001',
    }));
    expect(Object.keys(body).sort()).toEqual(['correlationId', 'data', 'error', 'meta']);
    if (expectedDetails === undefined) {
      expect(body.error.details).toBeNull();
    } else {
      expect(body.error.details).toEqual(expectedDetails);
    }
  }

  describe('GET /api/invoices/:id/state', () => {
    it('should return current state and allowed transitions', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice state retrieved successfully', {
        invoiceId: 'inv-001',
        currentState: 'pending',
        allowedTransitions: ['approved', 'rejected', 'cancelled'],
        isTerminal: false,
      });
    });

    it('should return terminal state info', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-003/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice state retrieved successfully', {
        invoiceId: 'inv-003',
        currentState: 'linked_escrow',
        allowedTransitions: [],
        isTerminal: true,
      });
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-999/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'INVOICE_NOT_FOUND', 'Invoice not found');
    });

    it('should return 404 for cross-tenant invoice access', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_B);

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'INVOICE_NOT_FOUND', 'Invoice not found');
    });

    it('should handle unexpected errors when reading state', async () => {
      jest.spyOn(invoiceService, 'getInvoiceById').mockRejectedValue(new Error('DB unavailable'));

      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/invoices/:id/transition', () => {
    it('should execute valid transition and persist to database', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved', reason: 'Invoice verified by finance team' });

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice transitioned from pending to approved', {
        invoiceId: 'inv-001',
        previousState: 'pending',
        currentState: 'approved',
        transitionedAt: expect.any(String),
        transitionedBy: 'test-user-123',
        reason: 'Invoice verified by finance team',
        auditLogId: expect.any(String),
      });

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-001'));
      expect(persisted.status).toBe('approved');

      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs).toHaveLength(1);
    });

    it('should reject invalid transition (silent jump)', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'linked_escrow', reason: 'Trying to skip approval' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'INVALID_TRANSITION', expect.stringContaining('Invalid state transition'), {
        allowedTransitions: ['approved', 'rejected', 'cancelled'],
      });

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-001'));
      expect(persisted.status).toBe('pending');
    });

    it('should reject transition from terminal state', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'TERMINAL_STATE', 'Cannot transition from terminal state: linked_escrow');
    });

    it('should require reason for terminal rejected transition', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'rejected' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'MISSING_TRANSITION_REASON', expect.stringContaining('Reason is required'));
    });

    it('should reject missing target state', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Missing target state' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'MISSING_TARGET_STATE', 'Target state is required');
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-999/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'INVOICE_NOT_FOUND', 'Invoice not found');
    });

    it('should return 404 for cross-tenant transition attempt', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_B)
        .send({ targetState: 'approved', reason: 'Cross-tenant attempt' });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'INVOICE_NOT_FOUND', 'Invoice not found');
    });
  });

  describe('POST /api/invoices/:id/approve', () => {
    it('should approve pending invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'All checks passed' });

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice approved successfully', {
        invoiceId: 'inv-001',
        previousState: 'pending',
        currentState: 'approved',
        transitionedAt: expect.any(String),
        transitionedBy: 'test-user-123',
        auditLogId: expect.any(String),
      });

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-001'));
      expect(persisted.status).toBe('approved');
    });

    it('should reject approval of already approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Already approved' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'ALREADY_IN_TARGET_STATE', 'Invoice is already in state: approved');
    });
  });

  describe('POST /api/invoices/:id/link-escrow', () => {
    it('should link approved invoice to escrow', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-123', reason: 'Escrow contract created' });

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice linked to escrow successfully', {
        invoiceId: 'inv-002',
        previousState: 'approved',
        currentState: 'linked_escrow',
        escrowId: 'escrow-123',
        transitionedAt: expect.any(String),
        transitionedBy: 'test-user-123',
        auditLogId: expect.any(String),
      });

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-002'));
      expect(persisted.status).toBe('linked_escrow');
    });

    it('should reject linking pending invoice to escrow', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-456' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'CANNOT_LINK_TO_ESCROW', expect.stringContaining('approved state'));
    });

    it('should reject linking already linked invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-789' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'CANNOT_LINK_TO_ESCROW', expect.stringContaining('approved state'));
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-999/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-000' });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'INVOICE_NOT_FOUND', 'Invoice not found');
    });

    it('should return 404 for cross-tenant link-escrow attempt', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_B)
        .send({ escrowId: 'escrow-000' });

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'INVOICE_NOT_FOUND', 'Invoice not found');
    });

    it('should surface coded transition errors from the state machine', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(
        Object.assign(new Error('Invoice is already in state: linked_escrow'), {
          code: 'ALREADY_IN_TARGET_STATE',
        }),
      );

      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-123' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'ALREADY_IN_TARGET_STATE', 'Invoice is already in state: linked_escrow');

      invoiceService.transitionInvoice.mockRestore();
    });
  });

  describe('POST /api/invoices/:id/reject', () => {
    it('should reject pending invoice with reason', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Invalid documentation' });

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice rejected successfully', {
        invoiceId: 'inv-001',
        previousState: 'pending',
        currentState: 'rejected',
        reason: 'Invalid documentation',
        transitionedAt: expect.any(String),
        transitionedBy: 'test-user-123',
        auditLogId: expect.any(String),
      });

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-001'));
      expect(persisted.status).toBe('rejected');
    });

    it('should require reason for rejection', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'MISSING_TRANSITION_REASON', expect.stringContaining('Reason is required'));
    });

    it('should not allow rejecting approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Cannot reject approved invoice' });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'INVALID_TRANSITION', expect.stringContaining('Invalid state transition'), {
        allowedTransitions: ['linked_escrow', 'cancelled'],
      });
    });
  });

  describe('GET /api/invoices/:id/history', () => {
    it('should return transition history', async () => {
      await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved', reason: 'First transition' });

      await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'linked_escrow', reason: 'Second transition' });

      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice transition history retrieved successfully', {
        invoiceId: 'inv-001',
        currentState: 'linked_escrow',
        transitions: expect.any(Array),
        totalTransitions: 2,
      });
      expect(res.body.data.transitions).toHaveLength(2);
    });

    it('should return empty history for invoice with no transitions', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expectSuccessEnvelope(res.body, 'Invoice transition history retrieved successfully', {
        invoiceId: 'inv-001',
        currentState: 'pending',
        transitions: [],
        totalTransitions: 0,
      });
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-999/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'INVOICE_NOT_FOUND', 'Invoice not found');
    });

    it('should handle unexpected errors when reading history', async () => {
      jest.spyOn(invoiceService, 'getInvoiceById').mockRejectedValue(new Error('DB unavailable'));

      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(500);
    });
  });

  describe('Audit Trail Verification', () => {
    it('should create audit log with complete information', async () => {
      await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .set('User-Agent', 'Test Client/1.0')
        .send({ reason: 'Comprehensive audit test' });

      const logs = await getAuditLogs({ resourceId: 'inv-001' });

      expect(logs).toHaveLength(1);
      expect(logs[0].actor).toBe('test-user-123');
      expect(logs[0].action).toBe('STATE_TRANSITION');
      expect(logs[0].resourceType).toBe('invoice');
      expect(logs[0].resourceId).toBe('inv-001');
      expect(logs[0].changes.before.state).toBe('pending');
      expect(logs[0].changes.after.state).toBe('approved');
      expect(logs[0].metadata.reason).toBe('Comprehensive audit test');
      expect(logs[0].userAgent).toBe('Test Client/1.0');
    });

    it('should track multiple transitions in order', async () => {
      await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Step 1' });

      await request(app)
        .post('/api/invoices/inv-001/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Step 2', escrowId: 'escrow-001' });

      const logs = await getAuditLogs({ resourceId: 'inv-001' });

      expect(logs).toHaveLength(2);
      expect(logs[0].changes.after.state).toBe('linked_escrow');
      expect(logs[1].changes.after.state).toBe('approved');
    });
  });

  describe('Security and Edge Cases', () => {
    it('should handle concurrent transition attempts gracefully', async () => {
      // Yield between read and write so concurrent requests can interleave.
      jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
        await new Promise((resolve) => setImmediate(resolve));
        return invoiceStore.get(storeKey(tenantId, id)) || null;
      });

      const results = await Promise.all([
        request(app).post('/api/invoices/inv-001/approve').set('x-tenant-id', TENANT_A).send({ reason: 'Concurrent 1' }),
        request(app).post('/api/invoices/inv-001/approve').set('x-tenant-id', TENANT_A).send({ reason: 'Concurrent 2' }),
      ]);

      const successCount = results.filter((r) => r.status === 200).length;
      const conflictOrAlready = results.filter((r) =>
        r.status === 409 ||
        (r.status === 400 && r.body?.error?.code === 'ALREADY_IN_TARGET_STATE'),
      ).length;

      expect(successCount).toBe(1);
      expect(conflictOrAlready).toBe(1);
      expect(invoiceStore.get(storeKey(TENANT_A, 'inv-001')).status).toBe('approved');

      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs).toHaveLength(1);
      expect(logs[0].changes.after.state).toBe('approved');
    });

    it('should handle special characters in reason', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Special chars: <script>alert("xss")</script> & "quotes"' });

      expect(res.status).toBe(200);
      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs[0].metadata.reason).toContain('Special chars');
    });

    it('should handle control characters in reason via API', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Reason\u0000with\u001Fcontrol' });

      expect(res.status).toBe(200);
      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs[0].metadata.reason).toBe('Reason with control');
    });

    it('should handle transition with no reason provided for non-terminal', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Invoice approved successfully');
    });

    it('should handle link-escrow without escrowId', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'No escrow ID provided' });

      expect(res.status).toBe(200);
      expect(res.body.data.escrowId).toBeNull();
    });

    it('should reject requests without tenant context', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state');

      expect(res.status).toBe(400);
    });

    it('should handle unexpected errors in transition endpoint', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(new Error('Unexpected error'));

      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(500);

      invoiceService.transitionInvoice.mockRestore();
    });
  });

  describe('Additional Edge Cases', () => {
    it('should handle approve endpoint with unexpected error', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(new Error('Unexpected error'));

      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test' });

      expect(res.status).toBe(500);
      invoiceService.transitionInvoice.mockRestore();
    });

    it('should handle link-escrow endpoint with unexpected error', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(new Error('Unexpected error'));

      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'test' });

      expect(res.status).toBe(500);
      invoiceService.transitionInvoice.mockRestore();
    });

    it('should handle reject endpoint with unexpected error', async () => {
      jest.spyOn(invoiceService, 'transitionInvoice').mockRejectedValue(new Error('Unexpected error'));

      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test rejection' });

      expect(res.status).toBe(500);
      invoiceService.transitionInvoice.mockRestore();
    });
  });

  describe('Correlation ID Propagation', () => {
    it('should include correlationId in approve success response', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Correlation test' });

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in approve error response', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Already approved' });

      expect(res.status).toBe(400);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in link-escrow success response', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-123', reason: 'Correlation test' });

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in link-escrow error response', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-456' });

      expect(res.status).toBe(400);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in reject success response', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Correlation test rejection' });

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in reject error response', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in history success response', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in history error response', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-999/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in bulk success response', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([
          { invoiceId: 'inv-001', action: 'approve', reason: 'Bulk correlation test' },
        ]);

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should include correlationId in bulk validation error response', async () => {
      const res = await request(app)
        .post('/api/invoices/bulk')
        .set('x-tenant-id', TENANT_A)
        .send([]);

      expect(res.status).toBe(400);
      expect(res.body.correlationId).toBe('test-corr-001');
    });

    it('should use X-Correlation-Id header when provided by client', async () => {
      // Build a fresh app without the seeded middleware so we can test
      // that a caller-supplied correlationId flows through.
      const freshApp = express();
      freshApp.use(express.json());

      freshApp.use((req, _res, next) => {
        req.user = { id: 'test-user-123', sub: 'test-user-123', smeId: 'sme-verified' };
        next();
      });

      freshApp.use((req, res, next) => {
        // Simulate what correlationIdMiddleware does — read from header,
        // attach to req, and seed AsyncLocalStorage.
        const headerCorrelationId = req.headers['x-correlation-id'] || null;
        const correlationId = headerCorrelationId || 'server-generated-id';
        req.id = correlationId;
        req.correlationId = correlationId;
        runContext({ requestId: correlationId, correlationId }, next);
      });

      freshApp.use('/api/invoices', invoiceStateRoutes);

      freshApp.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
      });

      jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
        if (id === 'inv-001' && tenantId === TENANT_A) return { invoice_id: 'inv-001', tenant_id: TENANT_A, status: 'pending', amount: 1000, customer: 'Acme Corp' };
        return null;
      });

      jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId) => {
        return { invoice_id: id, tenant_id: tenantId, status: updates?.status || 'approved', amount: 1000 };
      });

      const res = await request(freshApp)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .set('X-Correlation-Id', 'caller-supplied-corr-id')
        .send({ reason: 'Header correlation test' });

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe('caller-supplied-corr-id');
    });

    it('should generate correlationId when none is provided', async () => {
      const freshApp = express();
      freshApp.use(express.json());

      freshApp.use((req, _res, next) => {
        req.user = { id: 'test-user-123', sub: 'test-user-123', smeId: 'sme-verified' };
        next();
      });

      freshApp.use((req, res, next) => {
        const generatedId = `req_${require('crypto').randomUUID().replace(/-/g, '')}`;
        req.id = generatedId;
        req.correlationId = generatedId;
        runContext({ requestId: generatedId, correlationId: generatedId }, next);
      });

      freshApp.use('/api/invoices', invoiceStateRoutes);

      freshApp.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
      });

      jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
        if (id === 'inv-001' && tenantId === TENANT_A) return { invoice_id: 'inv-001', tenant_id: TENANT_A, status: 'pending', amount: 1000, customer: 'Acme Corp' };
        return null;
      });

      jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId) => {
        return { invoice_id: id, tenant_id: tenantId, status: updates?.status || 'approved', amount: 1000 };
      });

      const res = await request(freshApp)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Generated correlation test' });

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBeTruthy();
      expect(res.body.correlationId).toMatch(/^req_[a-f0-9]{32}$/);
    });

    it('should include correlationId in buildContext passed to service layer', async () => {
      let capturedContext = null;

      jest.spyOn(invoiceService, 'transitionInvoice').mockImplementation(async (id, targetState, tenantId, options) => {
        capturedContext = options;
        return {
          previousState: 'pending',
          newState: 'approved',
          transitionedAt: new Date().toISOString(),
          transitionedBy: options.actor,
          auditLog: { id: 'audit-test-001' },
        };
      });

      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Context correlation test' });

      expect(res.status).toBe(200);
      // The correlationId from the request should flow into the response body.
      expect(res.body.correlationId).toBe('test-corr-001');
      // The captured context options passed to transitionInvoice should include
      // the actor, IP address, user agent, and metadata (but correlationId is NOT
      // forwarded through context — it propagates via AsyncLocalStorage instead).
      expect(capturedContext).not.toBeNull();
      expect(capturedContext.actor).toBe('test-user-123');
      expect(capturedContext.metadata).toBeDefined();
    });
  });

  describe('INVOICE_STATE_ENABLED feature flag', () => {
    let originalGet;

    beforeEach(() => {
      const config = require('../src/config');
      originalGet = config.get;
      config.get = jest.fn(() => ({ INVOICE_STATE_ENABLED: 'false' }));
    });

    afterEach(() => {
      const config = require('../src/config');
      config.get = originalGet;
      jest.restoreAllMocks();
    });

    it('should return 404 for GET /state when disabled', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
    });

    it('should return 404 for POST /transition when disabled', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(404);
    });

    it('should return 404 for POST /approve when disabled', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test' });

      expect(res.status).toBe(404);
    });

    it('should return 404 for POST /link-escrow when disabled', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'test' });

      expect(res.status).toBe(404);
    });

    it('should return 404 for POST /reject when disabled', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Test rejection' });

      expect(res.status).toBe(404);
    });

    it('should return 404 for GET /history when disabled', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
    });
  });
});
