/**
 * Invoice State Machine Tests
 * Tests for invoice lifecycle state transitions with audit logging
 * 
 * @jest-environment node
 */

jest.mock('../src/db/knex', () => {
  const auditRows = [];

  function mapWhereArgs(column, value) {
    if (typeof column === 'object' && column !== null) {
      return Object.entries(column);
    }
    return [[column, value]];
  }

  function createQuery(tableName) {
    const filters = [];
    let rowLimit = Infinity;
    let rowOffset = 0;
    let orderDirection = null;

    const readRows = () => {
      if (tableName !== 'audit_log_events') {
        return [];
      }

      const rows = auditRows
        .filter((row) => filters.every(([column, value]) => row[column] === value));

      if (orderDirection === 'desc') {
        rows.reverse();
      }

      return rows.slice(rowOffset, rowLimit === Infinity ? undefined : rowOffset + rowLimit);
    };

    const query = {
      select: jest.fn(() => query),
      orderBy: jest.fn((_column, direction) => {
        orderDirection = direction;
        return query;
      }),
      where: jest.fn((column, value) => {
        filters.push(...mapWhereArgs(column, value));
        return query;
      }),
      limit: jest.fn((limit) => {
        rowLimit = limit;
        return query;
      }),
      offset: jest.fn((offset) => {
        rowOffset = offset;
        return query;
      }),
      insert: jest.fn(async (record) => {
        auditRows.push({
          id: `audit-${auditRows.length + 1}`,
          created_at: new Date().toISOString(),
          ...record,
        });
        return [1];
      }),
      del: jest.fn(async () => {
        auditRows.length = 0;
        return 1;
      }),
      returning: jest.fn(async () => readRows()),
      first: jest.fn(async () => readRows()[0] || null),
      then: (resolve, reject) => Promise.resolve(readRows()).then(resolve, reject),
      catch: (reject) => Promise.resolve(readRows()).catch(reject),
    };

    return query;
  }

  const db = jest.fn((tableName) => createQuery(tableName));
  db.raw = jest.fn(async () => undefined);
  return db;
});

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: (_req, _res, next) => next(),
  auditKycAccess: (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const {
  INVOICE_STATES,
  VALID_TRANSITIONS,
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

describe('Invoice State Machine', () => {
  beforeEach(async () => {
    await clearAuditLogs();
  });

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

  describe('Transition Rules', () => {
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

    it('should NOT allow approved → rejected', () => {
      expect(isTransitionAllowed('approved', 'rejected')).toBe(false);
    });

    it('should NOT allow transitions from terminal states', () => {
      expect(isTransitionAllowed('linked_escrow', 'approved')).toBe(false);
      expect(isTransitionAllowed('linked_escrow', 'pending')).toBe(false);
      expect(isTransitionAllowed('rejected', 'approved')).toBe(false);
      expect(isTransitionAllowed('cancelled', 'pending')).toBe(false);
    });

    it('should NOT allow same-state transitions', () => {
      expect(isTransitionAllowed('pending', 'pending')).toBe(false);
      expect(isTransitionAllowed('approved', 'approved')).toBe(false);
    });

    describe('Exhaustive transition matrix (Cartesian product)', () => {
      const states = Object.values(INVOICE_STATES);
      const terminalStates = [
        INVOICE_STATES.LINKED_ESCROW,
        INVOICE_STATES.REJECTED,
        INVOICE_STATES.CANCELLED,
      ];

      const getExpectedValidationCode = ({ fromState, targetState }) => {
        if (fromState === targetState) return 'ALREADY_IN_TARGET_STATE';
        if (terminalStates.includes(fromState)) return 'TERMINAL_STATE';

        const allowedTargets = VALID_TRANSITIONS[fromState] || [];
        if (!allowedTargets.includes(targetState)) return 'INVALID_TRANSITION';
        return null; // valid
      };

      states.forEach((fromState) => {
        states.forEach((targetState) => {
          const expectedAllowed = (VALID_TRANSITIONS[fromState] || []).includes(targetState) && fromState !== targetState && !terminalStates.includes(fromState);
          const expectedCode = getExpectedValidationCode({ fromState, targetState });

          it(`isTransitionAllowed/validateTransition/executeTransition: ${fromState} → ${targetState}`, () => {
            return (async () => {
            expect(isTransitionAllowed(fromState, targetState)).toBe(expectedAllowed);

            const reason = `Reason ${fromState}-${targetState}`;
            const validation = validateTransition({
              invoiceId: 'inv-matrix',
              currentState: fromState,
              targetState,
              actor: 'matrix-user',
              reason,
            });

            if (expectedCode === null) {
              expect(validation.isValid).toBe(true);
              expect(validation.error).toBeUndefined();
            } else {
              expect(validation.isValid).toBe(false);
              expect(validation.code).toBe(expectedCode);
              if (expectedCode === 'INVALID_TRANSITION') {
                expect(validation.allowedTransitions).toEqual(VALID_TRANSITIONS[fromState]);
              }
            }

            await clearAuditLogs();

            if (expectedCode === null) {
              const reason = `Reason ${fromState}→${targetState}`;
              const exec = await executeTransition({
                invoiceId: 'inv-matrix-exec',
                currentState: fromState,
                targetState,
                actor: 'matrix-user',
                reason,
                ipAddress: '192.0.2.1',
                userAgent: 'Test-UA',
                metadata: { testMatrix: true },
              });

              expect(exec.success).toBe(true);
              expect(exec.previousState).toBe(fromState);
              expect(exec.newState).toBe(targetState);

              const logs = await getAuditLogs({ resourceId: 'inv-matrix-exec', action: 'STATE_TRANSITION' });
              expect(logs).toHaveLength(1);
              expect(logs[0].changes.before.state).toBe(fromState);
              expect(logs[0].changes.after.state).toBe(targetState);
              expect(logs[0].metadata.transitionType).toBe(`${fromState}_to_${targetState}`);
              expect(logs[0].metadata.reason).toBe(reason);
            } else {
              await expect(
                executeTransition({
                  invoiceId: 'inv-matrix-exec',
                  currentState: fromState,
                  targetState,
                  actor: 'matrix-user',
                  reason: 'Should not transition',
                  ipAddress: '192.0.2.1',
                  userAgent: 'Test-UA',
                })
              ).rejects.toMatchObject({ code: expectedCode });
            }
            })();
          });
        });
      });
    });
  });


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
  });

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

  describe('Transition Validation', () => {
    it('should validate a valid transition', () => {
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
      const result = validateTransition({
        invoiceId: 'inv-001',
        currentState: 'pending',
        targetState: 'pending',
        actor: 'user-123',
      });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe('ALREADY_IN_TARGET_STATE');
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
      expect(result.allowedTransitions).toContain('approved');
    });

    it('should reject transition from terminal state', () => {
      const result = validateTransition({
        invoiceId: 'inv-001',
        currentState: 'linked_escrow',
        targetState: 'approved',
        actor: 'user-123',
      });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe('TERMINAL_STATE');
    });
  });

  describe('Transition Execution', () => {
    it('should execute valid transition and create audit log', async () => {
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

      // Verify audit log was created
      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs.length).toBe(1);
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
      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs[0].metadata.reason).toBe('Failed KYC checks');
    });

    it('should throw error for invalid transition', async () => {
      await expect(
        executeTransition({
          invoiceId: 'inv-001',
          currentState: 'pending',
          targetState: 'linked_escrow',
          actor: 'user-123',
        })
      ).rejects.toThrow();
    });

    it('should include metadata in audit log', async () => {
      await executeTransition({
        invoiceId: 'inv-002',
        currentState: 'approved',
        targetState: 'linked_escrow',
        actor: 'user-456',
        reason: 'Escrow created',
        metadata: {
          escrowId: 'escrow-123',
          method: 'POST',
        },
      });

      const logs = await getAuditLogs({ resourceId: 'inv-002' });
      expect(logs[0].metadata.escrowId).toBe('escrow-123');
      expect(logs[0].metadata.method).toBe('POST');
    });
  });

  describe('Transition History', () => {
    it('should retrieve transition history for an invoice', async () => {
      // Execute multiple transitions
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

  describe('Business Rules - Link to Escrow', () => {
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

    it('should not allow linking null invoice', () => {
      const result = canLinkToEscrow(null);

      expect(result.canLink).toBe(false);
      expect(result.reason).toBe('Invoice not found');
    });
  });
});

describe('Invoice State API Routes', () => {
  let app;

  beforeEach(async () => {
    await clearAuditLogs();
    
    // Reset mock invoices
    const { mockInvoices } = require('../src/routes/invoiceStateRoutes');
    mockInvoices.clear();
    mockInvoices.set('inv-001', { id: 'inv-001', status: 'pending', amount: 1000, customer: 'Acme Corp' });
    mockInvoices.set('inv-002', { id: 'inv-002', status: 'approved', amount: 2000, customer: 'TechCo' });
    mockInvoices.set('inv-003', { id: 'inv-003', status: 'linked_escrow', amount: 5000, customer: 'GlobalInc' });

    app = express();
    app.use(express.json());
    
    // Mock auth middleware
    app.use((req, res, next) => {
      req.user = { id: 'test-user-123' };
      next();
    });
    
    app.use('/api/invoices', invoiceStateRoutes);
  });

  describe('GET /api/invoices/:id/state', () => {
    it('should return current state and allowed transitions', async () => {
      const res = await request(app).get('/api/invoices/inv-001/state');

      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.currentState).toBe('pending');
      expect(res.body.data.allowedTransitions).toContain('approved');
      expect(res.body.data.allowedTransitions).toContain('rejected');
      expect(res.body.data.isTerminal).toBe(false);
    });

    it('should return terminal state info', async () => {
      const res = await request(app).get('/api/invoices/inv-003/state');

      expect(res.status).toBe(200);
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.allowedTransitions).toEqual([]);
      expect(res.body.data.isTerminal).toBe(true);
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app).get('/api/invoices/inv-999/state');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  describe('POST /api/invoices/:id/transition', () => {
    it('should execute valid transition', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .send({
          targetState: 'approved',
          reason: 'Invoice verified by finance team',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('approved');
      expect(res.body.data.transitionedBy).toBe('test-user-123');
      expect(res.body.data.reason).toBe('Invoice verified by finance team');
      expect(res.body.data.auditLogId).toBeDefined();

      // Verify audit log was created
      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs.length).toBe(1);
    });

    it('should reject invalid transition (silent jump)', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .send({
          targetState: 'linked_escrow',
          reason: 'Trying to skip approval',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TRANSITION');
      expect(res.body.allowedTransitions).toContain('approved');
    });

    it('should reject transition from terminal state', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/transition')
        .send({
          targetState: 'approved',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TERMINAL_STATE');
    });

    it('should require reason for terminal rejected transition', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .send({
          targetState: 'rejected',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_TRANSITION_REASON');
      expect(res.body.error).toContain('Reason is required');
    });

    it('should reject missing target state', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .send({
          reason: 'Missing target state',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_TARGET_STATE');
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-999/transition')
        .send({
          targetState: 'approved',
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  describe('POST /api/invoices/:id/approve', () => {
    it('should approve pending invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .send({
          reason: 'All checks passed',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('approved');
      expect(res.body.message).toBe('Invoice approved successfully');
    });

    it('should reject approval of already approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/approve')
        .send({
          reason: 'Already approved',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ALREADY_IN_TARGET_STATE');
    });
  });

  describe('POST /api/invoices/:id/link-escrow', () => {
    it('should link approved invoice to escrow', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .send({
          escrowId: 'escrow-123',
          reason: 'Escrow contract created',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.previousState).toBe('approved');
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.escrowId).toBe('escrow-123');
      expect(res.body.message).toBe('Invoice linked to escrow successfully');
    });

    it('should reject linking pending invoice to escrow', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/link-escrow')
        .send({
          escrowId: 'escrow-456',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CANNOT_LINK_TO_ESCROW');
    });

    it('should reject linking already linked invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-003/link-escrow')
        .send({
          escrowId: 'escrow-789',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CANNOT_LINK_TO_ESCROW');
    });
  });

  describe('POST /api/invoices/:id/reject', () => {
    it('should reject pending invoice with reason', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .send({
          reason: 'Invalid documentation',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.previousState).toBe('pending');
      expect(res.body.data.currentState).toBe('rejected');
      expect(res.body.data.reason).toBe('Invalid documentation');
    });

    it('should require reason for rejection', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_TRANSITION_REASON');
    });

    it('should not allow rejecting approved invoice', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/reject')
        .send({
          reason: 'Cannot reject approved invoice',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('GET /api/invoices/:id/history', () => {
    it('should return transition history', async () => {
      // Execute transitions
      await request(app)
        .post('/api/invoices/inv-001/transition')
        .send({ targetState: 'approved', reason: 'First transition' });

      await request(app)
        .post('/api/invoices/inv-001/transition')
        .send({ targetState: 'linked_escrow', reason: 'Second transition' });

      const res = await request(app).get('/api/invoices/inv-001/history');

      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe('inv-001');
      expect(res.body.data.currentState).toBe('linked_escrow');
      expect(res.body.data.transitions).toHaveLength(2);
      expect(res.body.data.totalTransitions).toBe(2);
    });

    it('should return empty history for invoice with no transitions', async () => {
      const res = await request(app).get('/api/invoices/inv-001/history');

      expect(res.status).toBe(200);
      expect(res.body.data.transitions).toEqual([]);
      expect(res.body.data.totalTransitions).toBe(0);
    });

    it('should return 404 for non-existent invoice', async () => {
      const res = await request(app).get('/api/invoices/inv-999/history');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  describe('Audit Trail Verification', () => {
    it('should create audit log with complete information', async () => {
      await request(app)
        .post('/api/invoices/inv-001/approve')
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
        .send({ reason: 'Step 1' });

      await request(app)
        .post('/api/invoices/inv-001/link-escrow')
        .send({ reason: 'Step 2', escrowId: 'escrow-001' });

      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      
      expect(logs).toHaveLength(2);
      // Logs are in reverse chronological order
      expect(logs[0].changes.after.state).toBe('linked_escrow');
      expect(logs[1].changes.after.state).toBe('approved');
    });
  });

  describe('Security and Edge Cases', () => {
    it('should handle concurrent transition attempts gracefully', async () => {
      // This test simulates race conditions
      const promises = [
        request(app).post('/api/invoices/inv-001/approve').send({ reason: 'Concurrent 1' }),
        request(app).post('/api/invoices/inv-001/approve').send({ reason: 'Concurrent 2' }),
      ];

      const results = await Promise.all(promises);
      
      // At least one should succeed
      const successCount = results.filter(r => r.status === 200).length;
      expect(successCount).toBeGreaterThanOrEqual(1);
    });

    it('should sanitize and handle special characters in reason', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .send({
          reason: 'Special chars: <script>alert("xss")</script> & "quotes"',
        });

      expect(res.status).toBe(200);
      const logs = await getAuditLogs({ resourceId: 'inv-001' });
      expect(logs[0].metadata.reason).toContain('Special chars');
    });

    it('should handle very long reason text', async () => {
      const longReason = 'A'.repeat(10000);
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .send({ reason: longReason });

      expect(res.status).toBe(200);
    });

    it('should handle transition with no reason provided', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Invoice approved successfully');
    });

    it('should handle link-escrow without escrowId', async () => {
      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .send({ reason: 'No escrow ID provided' });

      expect(res.status).toBe(200);
      expect(res.body.data.escrowId).toBeNull();
    });

    it('should handle unexpected errors in transition endpoint', async () => {
      // Create a mock that will throw an unexpected error
      const { mockInvoices } = require('../src/routes/invoiceStateRoutes');
      const originalGet = mockInvoices.get;
      
      // Temporarily replace get to throw error
      mockInvoices.get = () => {
        const invoice = { id: 'inv-001', status: 'pending' };
        // Simulate an unexpected error during processing
        Object.defineProperty(invoice, 'status', {
          get() { throw new Error('Unexpected error'); }
        });
        return invoice;
      };

      const res = await request(app)
        .post('/api/invoices/inv-001/transition')
        .send({ targetState: 'approved' });

      // Should be handled by error handler
      expect(res.status).toBe(500);

      // Restore original
      mockInvoices.get = originalGet;
    });
  });

  describe('Additional Edge Cases', () => {
    it('should handle approve endpoint with unexpected error', async () => {
      const { mockInvoices } = require('../src/routes/invoiceStateRoutes');
      const originalGet = mockInvoices.get;
      
      mockInvoices.get = () => {
        const invoice = { id: 'inv-001', status: 'pending' };
        Object.defineProperty(invoice, 'status', {
          get() { throw new Error('Unexpected error'); }
        });
        return invoice;
      };

      const res = await request(app)
        .post('/api/invoices/inv-001/approve')
        .send({ reason: 'Test' });

      expect(res.status).toBe(500);
      mockInvoices.get = originalGet;
    });

    it('should handle link-escrow endpoint with unexpected error', async () => {
      const { mockInvoices } = require('../src/routes/invoiceStateRoutes');
      const originalGet = mockInvoices.get;
      
      mockInvoices.get = () => {
        const invoice = { id: 'inv-002', status: 'approved' };
        Object.defineProperty(invoice, 'status', {
          get() { throw new Error('Unexpected error'); }
        });
        return invoice;
      };

      const res = await request(app)
        .post('/api/invoices/inv-002/link-escrow')
        .send({ escrowId: 'test' });

      expect(res.status).toBe(500);
      mockInvoices.get = originalGet;
    });

    it('should handle reject endpoint with unexpected error', async () => {
      const { mockInvoices } = require('../src/routes/invoiceStateRoutes');
      const originalGet = mockInvoices.get;
      
      mockInvoices.get = () => {
        const invoice = { id: 'inv-001', status: 'pending' };
        Object.defineProperty(invoice, 'status', {
          get() { throw new Error('Unexpected error'); }
        });
        return invoice;
      };

      const res = await request(app)
        .post('/api/invoices/inv-001/reject')
        .send({ reason: 'Test rejection' });

      expect(res.status).toBe(500);
      mockInvoices.get = originalGet;
    });
  });
});
