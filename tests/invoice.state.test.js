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

// Mock KYC gating so link-escrow routes pass through in tests
jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
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
const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const invoiceService = require('../src/services/invoiceService');
const { getSharedStore } = require('../src/services/cacheStore');

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
    getSharedStore().clear();
    invoiceStore = new Map();
    seedRouteFixtures();

    jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
      return invoiceStore.get(storeKey(tenantId, id)) || null;
    });

    jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId) => {
      const key = storeKey(tenantId, id);
      const existing = invoiceStore.get(key);
      if (!existing) {
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

    app.use('/api/invoices', invoiceStateRoutes);

    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/invoices/:id/state', () => {
    it('should return current state and allowed transitions', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.currentState).toBe('pending');
      expect(res.body.data.allowedTransitions).toContain('approved');
      expect(res.body.data.allowedTransitions).toContain('rejected');
      expect(res.body.data.isTerminal).toBe(false);
    });

    it('should return terminal state info', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-003/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.allowedTransitions).toEqual([]);
      expect(res.body.data.isTerminal).toBe(true);
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-999/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });

    it('should return 404 for cross-tenant invoice access', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_B);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
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
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('approved');
      expect(res.body.data.transitionedBy).toBe('test-user-123');
      expect(res.body.data.reason).toBe('Invoice verified by finance team');
      expect(res.body.data.auditLogId).toBeDefined();

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
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(res.body.error.details.allowedTransitions).toContain('approved');

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-001'));
      expect(persisted.status).toBe('pending');
    });

    it('should reject transition from terminal state', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TERMINAL_STATE');
    });

    it('should require reason for terminal rejected transition', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'rejected' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_TRANSITION_REASON');
      expect(res.body.error.message).toContain('Reason is required');
    });

    it('should reject missing target state', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Missing target state' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_TARGET_STATE');
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-999/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });

    it('should return 404 for cross-tenant transition attempt', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_B)
        .send({ targetState: 'approved', reason: 'Cross-tenant attempt' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  describe('POST /api/invoices/:id/approve', () => {
    it('should approve pending invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'All checks passed' });

      expect(res.status).toBe(200);
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('approved');
      expect(res.body.message).toBe('Invoice approved successfully');

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-001'));
      expect(persisted.status).toBe('approved');
    });

    it('should reject approval of already approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Already approved' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ALREADY_IN_TARGET_STATE');
    });
  });

  describe('POST /api/invoices/:id/link-escrow', () => {
    it('should link approved invoice to escrow', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-123', reason: 'Escrow contract created' });

      expect(res.status).toBe(200);
      expect(res.body.data.previousState).toBe('approved');
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.escrowId).toBe('escrow-123');
      expect(res.body.message).toBe('Invoice linked to escrow successfully');

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-002'));
      expect(persisted.status).toBe('linked_escrow');
    });

    it('should reject linking pending invoice to escrow', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CANNOT_LINK_TO_ESCROW');
    });

    it('should reject linking already linked invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-789' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CANNOT_LINK_TO_ESCROW');
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-999/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'escrow-000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });

    it('should return 404 for cross-tenant link-escrow attempt', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_B)
        .send({ escrowId: 'escrow-000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
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
      expect(res.body.error.code).toBe('ALREADY_IN_TARGET_STATE');

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
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('rejected');
      expect(res.body.data.reason).toBe('Invalid documentation');

      const persisted = invoiceStore.get(storeKey(TENANT_A, 'inv-001'));
      expect(persisted.status).toBe('rejected');
    });

    it('should require reason for rejection', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_TRANSITION_REASON');
    });

    it('should not allow rejecting approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Cannot reject approved invoice' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
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
      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.transitions).toHaveLength(2);
      expect(res.body.data.totalTransitions).toBe(2);
    });

    it('should return empty history for invoice with no transitions', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data.transitions).toEqual([]);
      expect(res.body.data.totalTransitions).toBe(0);
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-999/history')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
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
      const promises = [
        request(app).post('/api/invoices/inv-001/approve').set('x-tenant-id', TENANT_A).send({ reason: 'Concurrent 1' }),
        request(app).post('/api/invoices/inv-001/approve').set('x-tenant-id', TENANT_A).send({ reason: 'Concurrent 2' }),
      ];

      const results = await Promise.all(promises);

      const successCount = results.filter(r => r.status === 200).length;
      expect(successCount).toBeGreaterThanOrEqual(1);
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

  describe('State Cache', () => {
    it('should return X-Cache: MISS on first request (cold cache)', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.headers['x-cache']).toBe('MISS');
    });

    it('should return X-Cache: HIT on second request for same invoice', async () => {
      const first = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(first.headers['x-cache']).toBe('MISS');

      const second = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(second.status).toBe(200);
      expect(second.headers['x-cache']).toBe('HIT');
      expect(second.body).toEqual(first.body);
    });

    it('should invalidate cache after state transition', async () => {
      await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      await request(app)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved', reason: 'Cache invalidation test' });

      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.body.data.currentState).toBe('approved');
    });

    it('should invalidate cache after approve', async () => {
      await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      await request(app)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Cache invalidation test' });

      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.body.data.currentState).toBe('approved');
    });

    it('should invalidate cache after reject', async () => {
      await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      await request(app)
        .post('/api/invoices/inv-001/reject')
        .set('x-tenant-id', TENANT_A)
        .send({ reason: 'Rejected for invalidation test' });

      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.body.data.currentState).toBe('rejected');
    });

    it('should invalidate cache after link-escrow', async () => {
      await request(app)
        .get('/api/invoices/inv-002/state')
        .set('x-tenant-id', TENANT_A);

      await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .set('x-tenant-id', TENANT_A)
        .send({ escrowId: 'esc_001' });

      const res = await request(app)
        .get('/api/invoices/inv-002/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.body.data.currentState).toBe('linked_escrow');
    });

    it('should cache different invoices independently', async () => {
      const firstA = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);
      expect(firstA.headers['x-cache']).toBe('MISS');

      const firstB = await request(app)
        .get('/api/invoices/inv-002/state')
        .set('x-tenant-id', TENANT_A);
      expect(firstB.headers['x-cache']).toBe('MISS');

      const secondA = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);
      expect(secondA.headers['x-cache']).toBe('HIT');
      expect(secondA.body).toEqual(firstA.body);

      const secondB = await request(app)
        .get('/api/invoices/inv-002/state')
        .set('x-tenant-id', TENANT_A);
      expect(secondB.headers['x-cache']).toBe('HIT');
      expect(secondB.body).toEqual(firstB.body);
    });

    it('should bypass cache when Cache-Control: no-cache is set', async () => {
      await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A)
        .set('Cache-Control', 'no-cache');

      expect(res.status).toBe(200);
      // No X-Cache header when bypassed — cache middleware calls next() early
      expect(res.headers['x-cache']).toBeUndefined();
    });

    it('should not cache 404 responses', async () => {
      const res = await request(app)
        .get('/api/invoices/inv-999/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(404);
    });

    it('should return MISS after TTL expires', async () => {
      const baseTime = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

      try {
        // Request at fake time baseTime → cached with expiresAt = baseTime + 30s
        await request(app)
          .get('/api/invoices/inv-001/state')
          .set('x-tenant-id', TENANT_A);

        // Still within TTL → HIT (Date.now still returns baseTime)
        const hit = await request(app)
          .get('/api/invoices/inv-001/state')
          .set('x-tenant-id', TENANT_A);
        expect(hit.headers['x-cache']).toBe('HIT');

        // Advance Date.now past the 30s TTL
        nowSpy.mockReturnValue(baseTime + 31000);

        const miss = await request(app)
          .get('/api/invoices/inv-001/state')
          .set('x-tenant-id', TENANT_A);
        expect(miss.headers['x-cache']).toBe('MISS');
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('should fall through when store.get throws', async () => {
      const store = getSharedStore();
      jest.spyOn(store, 'get').mockImplementation(() => {
        throw new Error('Simulated store error');
      });

      const res = await request(app)
        .get('/api/invoices/inv-001/state')
        .set('x-tenant-id', TENANT_A);

      expect(res.status).toBe(200);
      expect(res.body.data.currentState).toBe('pending');
      // No X-Cache header because cache error falls through without setting it
      expect(res.headers['x-cache']).toBeUndefined();
    });
  });

  describe('Fallback branch coverage', () => {
    let fallbackApp;
    let fallbackStore;

    function fallbackSeed() {
      fallbackStore.set('tenant-a:inv-001', {
        invoice_id: 'inv-001',
        tenant_id: 'tenant-a',
        status: 'pending',
        amount: 1000,
        customer: 'Acme Corp',
      });
    }

    beforeEach(() => {
      clearAuditLogs();
      getSharedStore().clear();
      fallbackStore = new Map();
      fallbackSeed();

      jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(async (id, tenantId) => {
        return fallbackStore.get(tenantId + ':' + id) || null;
      });
      jest.spyOn(invoiceService, 'updateInvoice').mockImplementation(async (id, updates, tenantId) => {
        const key = tenantId + ':' + id;
        const existing = fallbackStore.get(key);
        if (!existing) { return null; }
        const updated = { ...existing, ...updates };
        fallbackStore.set(key, updated);
        return updated;
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should resolve actor from req.user.sub when req.user.id is absent', async () => {
      fallbackApp = express();
      fallbackApp.use(express.json());
      fallbackApp.use((req, _res, next) => {
        req.user = { sub: 'sub-user' };
        next();
      });
      fallbackApp.use('/api/invoices', invoiceStateRoutes);
      fallbackApp.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(fallbackApp)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', 'tenant-a')
        .send({ targetState: 'approved', reason: 'Testing sub fallback' });

      expect(res.status).toBe(200);
      expect(res.body.data.transitionedBy).toBe('sub-user');
    });

    it('should handle transition POST without body (req.body undefined)', async () => {
      fallbackApp = express();
      fallbackApp.use(express.json());
      fallbackApp.use((req, _res, next) => {
        req.user = { id: 'test-user', sub: 'test-user' };
        next();
      });
      fallbackApp.use('/api/invoices', invoiceStateRoutes);
      fallbackApp.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(fallbackApp)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', 'tenant-a');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_TARGET_STATE');
    });

    it('should handle approve POST without body (req.body undefined)', async () => {
      fallbackApp = express();
      fallbackApp.use(express.json());
      fallbackApp.use((req, _res, next) => {
        req.user = { id: 'test-user', sub: 'test-user' };
        next();
      });
      fallbackApp.use('/api/invoices', invoiceStateRoutes);
      fallbackApp.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(fallbackApp)
        .post('/api/invoices/inv-001/approve')
        .set('x-tenant-id', 'tenant-a');

      expect(res.status).toBe(200);
    });

    it('should fall back to socket.remoteAddress when req.ip is absent', async () => {
      fallbackApp = express();
      fallbackApp.use(express.json());
      fallbackApp.use((req, _res, next) => {
        req.user = { id: 'test-user' };
        Object.defineProperty(req, 'ip', { value: undefined, configurable: true });
        next();
      });
      fallbackApp.use('/api/invoices', invoiceStateRoutes);
      fallbackApp.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(fallbackApp)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', 'tenant-a')
        .send({ targetState: 'approved', reason: 'Testing socket fallback' });

      expect(res.status).toBe(200);
      expect(res.body.data.transitionedBy).toBe('test-user');
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

    it('should fall back to "unknown" when req.ip and socket are absent', async () => {
      fallbackApp = express();
      fallbackApp.use(express.json());
      fallbackApp.use((req, _res, next) => {
        req.user = { id: 'test-user' };
        Object.defineProperty(req, 'ip', { value: undefined, configurable: true });
        req.socket = undefined;
        next();
      });
      fallbackApp.use('/api/invoices', invoiceStateRoutes);
      fallbackApp.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(fallbackApp)
        .post('/api/invoices/inv-001/transition')
        .set('x-tenant-id', TENANT_A)
        .send({ targetState: 'approved', reason: 'Testing unknown fallback' });

      expect(res.status).toBe(200);
    });
  });
});
