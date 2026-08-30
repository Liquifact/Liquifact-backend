'use strict';

/**
 * @fileoverview Unit tests for webhook outbox service (issue #1210).
 *
 * Tests:
 *   - insertOutboxEvent: writes row inside transaction
 *   - fetchPendingEvents: returns pending rows in order
 *   - markDelivered: updates status and delivered_at
 *   - markFailed: increments attempts, applies backoff, marks failed when exhausted
 *   - getOutboxStats: returns counts by status
 *   - purgeDelivered: removes old delivered rows
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

jest.mock('../logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const {
  insertOutboxEvent,
  fetchPendingEvents,
  markDelivered,
  markFailed,
  getOutboxStats,
  purgeDelivered,
} = require('./webhookOutbox');

// Use in-memory SQLite via the test knex mock
const db = require('../db/knex');

describe('webhookOutbox', () => {
  beforeAll(async () => {
    // Create the outbox table for testing (SQLite-compatible schema)
    const exists = await db.schema.hasTable('webhook_outbox');
    if (!exists) {
      await db.schema.createTable('webhook_outbox', (t) => {
        t.string('id').notNullable().primary();
        t.string('invoice_id').notNullable();
        t.string('tenant_id').notNullable().defaultTo('');
        t.string('event').notNullable();
        t.text('payload').notNullable();
        t.string('status').notNullable().defaultTo('pending');
        t.integer('attempts').notNullable().defaultTo(0);
        t.integer('max_attempts').notNullable().defaultTo(5);
        t.text('last_error');
        t.string('next_retry_at');
        t.string('correlation_id');
        t.string('created_at').notNullable().defaultTo(new Date().toISOString());
        t.string('delivered_at');
      });
    }
  });

  beforeEach(async () => {
    await db('webhook_outbox').del();
  });

  afterAll(async () => {
    await db('webhook_outbox').del();
    await db.destroy();
  });

  describe('insertOutboxEvent', () => {
    it('inserts an event row inside a transaction', async () => {
      let row;
      await db.transaction(async (trx) => {
        row = await insertOutboxEvent(trx, {
          invoiceId: 'inv_001',
          tenantId: 'tenant_1',
          event: 'invoice.submitted_to_approved',
          payload: { invoiceId: 'inv_001', event: 'invoice.submitted_to_approved' },
          correlationId: 'corr_abc',
        });
      });

      expect(row).toBeDefined();
      expect(row.id).toMatch(/^outbox_/);
      expect(row.invoice_id).toBe('inv_001');
      expect(row.event).toBe('invoice.submitted_to_approved');
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.correlation_id).toBe('corr_abc');

      // Verify persisted
      const stored = await db('webhook_outbox').where('id', row.id).first();
      expect(stored).toBeDefined();
      expect(stored.invoice_id).toBe('inv_001');
    });

    it('rolls back if transaction fails', async () => {
      try {
        await db.transaction(async (trx) => {
          await insertOutboxEvent(trx, {
            invoiceId: 'inv_002',
            tenantId: 'tenant_1',
            event: 'test.event',
            payload: { test: true },
          });
          throw new Error('simulated failure');
        });
      } catch (_) {
        // expected
      }

      const count = await db('webhook_outbox').count('* as c').first();
      expect(Number(count.c)).toBe(0);
    });
  });

  describe('fetchPendingEvents', () => {
    it('returns pending events in creation order', async () => {
      await db.transaction(async (trx) => {
        await insertOutboxEvent(trx, { invoiceId: 'inv_003', tenantId: 't1', event: 'e1', payload: {} });
        await insertOutboxEvent(trx, { invoiceId: 'inv_004', tenantId: 't1', event: 'e2', payload: {} });
      });

      const events = await fetchPendingEvents();
      expect(events.length).toBe(2);
      expect(events[0].event).toBe('e1');
      expect(events[1].event).toBe('e2');
    });

    it('does not return delivered events', async () => {
      await db.transaction(async (trx) => {
        const row = await insertOutboxEvent(trx, { invoiceId: 'inv_005', tenantId: 't1', event: 'e1', payload: {} });
        await markDelivered(row.id);
      });

      const events = await fetchPendingEvents();
      expect(events.length).toBe(0);
    });

    it('does not return events with future next_retry_at', async () => {
      await db.transaction(async (trx) => {
        await insertOutboxEvent(trx, { invoiceId: 'inv_006', tenantId: 't1', event: 'e1', payload: {} });
      });
      // Update next_retry_at to future
      await db('webhook_outbox').update({ next_retry_at: '2099-01-01T00:00:00.000Z' });

      const events = await fetchPendingEvents();
      expect(events.length).toBe(0);
    });

    it('respects limit parameter', async () => {
      await db.transaction(async (trx) => {
        for (let i = 0; i < 5; i++) {
          await insertOutboxEvent(trx, { invoiceId: `inv_${i}`, tenantId: 't1', event: 'e', payload: {} });
        }
      });

      const events = await fetchPendingEvents(2);
      expect(events.length).toBe(2);
    });
  });

  describe('markDelivered', () => {
    it('sets status to delivered and delivered_at', async () => {
      let row;
      await db.transaction(async (trx) => {
        row = await insertOutboxEvent(trx, { invoiceId: 'inv_007', tenantId: 't1', event: 'e', payload: {} });
      });

      await markDelivered(row.id);

      const stored = await db('webhook_outbox').where('id', row.id).first();
      expect(stored.status).toBe('delivered');
      expect(stored.delivered_at).toBeTruthy();
    });
  });

  describe('markFailed', () => {
    it('increments attempts and applies backoff', async () => {
      let row;
      await db.transaction(async (trx) => {
        row = await insertOutboxEvent(trx, { invoiceId: 'inv_008', tenantId: 't1', event: 'e', payload: {} });
      });

      await markFailed(row.id, 'connection refused', row);

      const stored = await db('webhook_outbox').where('id', row.id).first();
      expect(stored.attempts).toBe(1);
      expect(stored.status).toBe('pending'); // not exhausted yet
      expect(stored.last_error).toBe('connection refused');
    });

    it('marks as failed when max attempts exhausted', async () => {
      let row;
      await db.transaction(async (trx) => {
        row = await insertOutboxEvent(trx, {
          invoiceId: 'inv_009', tenantId: 't1', event: 'e', payload: {},
          maxAttempts: 2,
        });
      });

      // First failure
      await markFailed(row.id, 'error 1', { ...row, attempts: 0, max_attempts: 2 });
      // Second failure (exhausted)
      await markFailed(row.id, 'error 2', { ...row, attempts: 1, max_attempts: 2 });

      const stored = await db('webhook_outbox').where('id', row.id).first();
      expect(stored.attempts).toBe(2);
      expect(stored.status).toBe('failed');
      expect(stored.next_retry_at).toBeNull();
    });
  });

  describe('getOutboxStats', () => {
    it('returns counts by status', async () => {
      await db.transaction(async (trx) => {
        for (let i = 0; i < 3; i++) {
          await insertOutboxEvent(trx, { invoiceId: `inv_p${i}`, tenantId: 't1', event: 'e', payload: {} });
        }
        const d1 = await insertOutboxEvent(trx, { invoiceId: 'inv_d1', tenantId: 't1', event: 'e', payload: {} });
        const d2 = await insertOutboxEvent(trx, { invoiceId: 'inv_d2', tenantId: 't1', event: 'e', payload: {} });
        await markDelivered(d1.id);
        await markDelivered(d2.id);
      });

      const stats = await getOutboxStats();
      expect(stats.pending).toBe(3);
      expect(stats.delivered).toBe(2);
      expect(stats.failed).toBe(0);
    });
  });

  describe('purgeDelivered', () => {
    it('removes old delivered rows', async () => {
      await db.transaction(async (trx) => {
        const row = await insertOutboxEvent(trx, { invoiceId: 'inv_purge', tenantId: 't1', event: 'e', payload: {} });
        await markDelivered(row.id);
      });

      // Backdate delivered_at
      const old = new Date(Date.now() - 2 * 86400000).toISOString();
      await db('webhook_outbox').update({ delivered_at: old });

      const purged = await purgeDelivered(86400000); // 24h threshold
      expect(purged).toBe(1);

      const remaining = await db('webhook_outbox').count('* as c').first();
      expect(Number(remaining.c)).toBe(0);
    });

    it('does not remove recent delivered rows', async () => {
      await db.transaction(async (trx) => {
        const row = await insertOutboxEvent(trx, { invoiceId: 'inv_recent', tenantId: 't1', event: 'e', payload: {} });
        await markDelivered(row.id);
      });

      const purged = await purgeDelivered(86400000);
      expect(purged).toBe(0);

      const remaining = await db('webhook_outbox').count('* as c').first();
      expect(Number(remaining.c)).toBe(1);
    });
  });
});
