'use strict';

const db = require('../src/db/knex');
const { executeTransition, INVOICE_STATES } = require('../src/services/invoiceStateMachine');
const { getAuditLogs, clearAuditLogs } = require('../src/services/auditLog');

describe('Audit Log Persistence', () => {
  beforeEach(async () => {
    await clearAuditLogs();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('persists state transitions and makes them queryable', async () => {
    // 1. Generate a transition
    const invoiceId = 'test-invoice-123';
    const result = await executeTransition({
      invoiceId,
      currentState: INVOICE_STATES.PENDING,
      targetState: INVOICE_STATES.APPROVED,
      actor: 'user-789',
      reason: 'Looks good',
      ipAddress: '192.168.1.1',
      userAgent: 'TestAgent/1.0',
    });

    expect(result.success).toBe(true);

    // 2. Query the audit log
    const logs = await getAuditLogs({
      resourceId: invoiceId,
      resourceType: 'invoice',
      action: 'STATE_TRANSITION',
    });

    expect(logs).toHaveLength(1);
    const log = logs[0];
    
    expect(log.actor).toBe('user-789');
    expect(log.action).toBe('STATE_TRANSITION');
    expect(log.resourceId).toBe(invoiceId);
    expect(log.changes.before.state).toBe(INVOICE_STATES.PENDING);
    expect(log.changes.after.state).toBe(INVOICE_STATES.APPROVED);
    expect(log.metadata.reason).toBe('Looks good');
  });

  it('enforces append-only semantics (no updates or deletes)', async () => {
    // Insert a dummy log using the store directly or via createAuditLog
    const { createAuditLog } = require('../src/services/auditLog');
    
    const log = await createAuditLog({
      actor: 'hacker',
      action: 'CREATE',
      resourceType: 'invoice',
      resourceId: 'test-invoice-999',
    });

    // Try to update it
    await expect(
      db('audit_log_events').where({ target_id: 'test-invoice-999' }).update({ action: 'DELETE' })
    ).rejects.toThrow(/audit_log_events is append-only/);

    // Try to delete it (bypassing clearAuditLogs which drops the trigger temporarily)
    await expect(
      db('audit_log_events').where({ target_id: 'test-invoice-999' }).del()
    ).rejects.toThrow(/audit_log_events is append-only/);
  });
});
