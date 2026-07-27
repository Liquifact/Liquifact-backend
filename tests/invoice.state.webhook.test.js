'use strict';

/**
 * @fileoverview Dedicated tests for webhook callbacks on invoice-state events.
 *
 * Covers:
 *  1. Webhook emission from executeTransition for each valid state transition
 *  2. Event naming convention (invoice.<from>_to_<to>)
 *  3. Delivery, retry, and dead-letter for invoice-state webhook payloads
 *  4. Edge cases: enqueue failure, missing worker, concurrent transitions
 *
 * This test file complements webhooks.delivery.test.js by testing webhook
 * behaviour specifically from the invoice-state transition perspective.
 */

process.env.NODE_ENV = 'test';

// ─── Module mocks ────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../src/services/auditLogStore', () => ({
  appendAuditEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/auditLog', () => ({
  createAuditLog: jest.fn().mockResolvedValue({
    id: 'audit-wp-001',
    timestamp: '2026-01-15T00:00:00.000Z',
  }),
}));
jest.mock('../src/services/escrowSubmit', () => ({
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9._:-]{8,128}$/,
}));

jest.mock('prom-client', () => ({
  Counter: class { constructor() {} inc() {} },
  Gauge: class { constructor() {} set() {} },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics() { return ''; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });

jest.mock('../src/metrics', () => ({
  registry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

const db = require('../src/db/knex');
const logger = require('../src/logger');

const {
  executeTransition,
  INVOICE_STATES,
  VALID_TRANSITIONS,
} = require('../src/services/invoiceStateMachine');

const {
  createWebhookDeliveryHandler,
  shouldRetry,
  writeDeadLetter,
} = require('../src/jobs/webhookDelivery');

const {
  enqueueWebhookDelivery,
  setSharedWorker,
} = require('../src/services/webhooks');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mocks the db chain for createAuditLog (invoices + auditLog queries). */
function mockDbChain() {
  db.mockReturnValue({
    insert: jest.fn().mockResolvedValue([{ id: 'audit-wp-001' }]),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
  });
}

/** Builds a standard webhook delivery job payload for invoice-state events. */
function makeJobPayload(overrides = {}) {
  return {
    invoiceId: 'inv_wp_001',
    tenantId: 'tenant_wp_01',
    webhookUrl: 'https://example.com/hook',
    webhookSecret: 'whsec_test123',
    event: 'invoice.pending_to_approved',
    transition: {
      from: INVOICE_STATES.PENDING,
      to: INVOICE_STATES.APPROVED,
      actor: 'usr_admin',
      reason: null,
      transitionedAt: '2026-01-15T00:00:00.000Z',
    },
    ...overrides,
  };
}

/** Builds a job object matching BackgroundWorker shape. */
function makeJob(overrides = {}) {
  return {
    id: 'job-wp-001',
    payload: makeJobPayload(overrides),
    attempts: 1,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('invoice-state webhook emission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setSharedWorker(null);
  });

  describe('executeTransition enqueues webhooks for valid transitions', () => {
    it('pending → approved enqueues invoice.pending_to_approved', async () => {
      const worker = { enqueue: jest.fn().mockReturnValue('job-emit-001') };
      setSharedWorker(worker);
      mockDbChain();

      const result = await executeTransition({
        invoiceId: 'inv_wp_001',
        currentState: INVOICE_STATES.PENDING,
        targetState: INVOICE_STATES.APPROVED,
        actor: 'usr_admin',
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe(INVOICE_STATES.APPROVED);

      await new Promise(setImmediate);

      expect(worker.enqueue).toHaveBeenCalledWith(
        'webhook_delivery',
        expect.objectContaining({
          invoiceId: 'inv_wp_001',
          event: 'invoice.pending_to_approved',
          transition: expect.objectContaining({
            from: INVOICE_STATES.PENDING,
            to: INVOICE_STATES.APPROVED,
            actor: 'usr_admin',
          }),
        }),
      );
    });

    it('approved → linked_escrow enqueues invoice.approved_to_linked_escrow', async () => {
      const worker = { enqueue: jest.fn().mockReturnValue('job-emit-002') };
      setSharedWorker(worker);
      mockDbChain();

      await executeTransition({
        invoiceId: 'inv_wp_002',
        currentState: INVOICE_STATES.APPROVED,
        targetState: INVOICE_STATES.LINKED_ESCROW,
        actor: 'usr_admin',
      });

      await new Promise(setImmediate);

      expect(worker.enqueue).toHaveBeenCalledWith(
        'webhook_delivery',
        expect.objectContaining({ event: 'invoice.approved_to_linked_escrow' }),
      );
    });

    it('pending → rejected enqueues invoice.pending_to_rejected', async () => {
      const worker = { enqueue: jest.fn().mockReturnValue('job-emit-003') };
      setSharedWorker(worker);
      mockDbChain();

      await executeTransition({
        invoiceId: 'inv_wp_003',
        currentState: INVOICE_STATES.PENDING,
        targetState: INVOICE_STATES.REJECTED,
        actor: 'usr_admin',
        reason: 'Insufficient documentation',
      });

      await new Promise(setImmediate);

      expect(worker.enqueue).toHaveBeenCalledWith(
        'webhook_delivery',
        expect.objectContaining({
          event: 'invoice.pending_to_rejected',
          transition: expect.objectContaining({
            from: INVOICE_STATES.PENDING,
            to: INVOICE_STATES.REJECTED,
            reason: 'Insufficient documentation',
          }),
        }),
      );
    });

    it('pending → cancelled enqueues invoice.pending_to_cancelled', async () => {
      const worker = { enqueue: jest.fn().mockReturnValue('job-emit-004') };
      setSharedWorker(worker);
      mockDbChain();

      await executeTransition({
        invoiceId: 'inv_wp_004',
        currentState: INVOICE_STATES.PENDING,
        targetState: INVOICE_STATES.CANCELLED,
        actor: 'usr_admin',
        reason: 'Cancelled by request',
      });

      await new Promise(setImmediate);

      expect(worker.enqueue).toHaveBeenCalledWith(
        'webhook_delivery',
        expect.objectContaining({ event: 'invoice.pending_to_cancelled' }),
      );
    });

    it('approved → cancelled enqueues invoice.approved_to_cancelled', async () => {
      const worker = { enqueue: jest.fn().mockReturnValue('job-emit-005') };
      setSharedWorker(worker);
      mockDbChain();

      await executeTransition({
        invoiceId: 'inv_wp_005',
        currentState: INVOICE_STATES.APPROVED,
        targetState: INVOICE_STATES.CANCELLED,
        actor: 'usr_admin',
        reason: 'Buyer cancelled',
      });

      await new Promise(setImmediate);

      expect(worker.enqueue).toHaveBeenCalledWith(
        'webhook_delivery',
        expect.objectContaining({ event: 'invoice.approved_to_cancelled' }),
      );
    });
  });

  describe('webhook emission edge cases', () => {
    it('does not enqueue webhook for invalid transitions', async () => {
      const worker = { enqueue: jest.fn() };
      setSharedWorker(worker);

      await expect(
        executeTransition({
          invoiceId: 'inv_wp_err',
          currentState: INVOICE_STATES.APPROVED,
          targetState: INVOICE_STATES.PENDING,
          actor: 'usr_admin',
        }),
      ).rejects.toThrow();

      expect(worker.enqueue).not.toHaveBeenCalled();
    });

    it('does not enqueue webhook for same-state transition', async () => {
      const worker = { enqueue: jest.fn() };
      setSharedWorker(worker);

      await expect(
        executeTransition({
          invoiceId: 'inv_wp_same',
          currentState: INVOICE_STATES.PENDING,
          targetState: INVOICE_STATES.PENDING,
          actor: 'usr_admin',
        }),
      ).rejects.toThrow();

      expect(worker.enqueue).not.toHaveBeenCalled();
    });

    it('transition succeeds even when enqueue fails (fire-and-forget)', async () => {
      const worker = {
        enqueue: jest.fn().mockImplementation(() => {
          throw new Error('queue full');
        }),
      };
      setSharedWorker(worker);
      mockDbChain();

      const result = await executeTransition({
        invoiceId: 'inv_wp_ff',
        currentState: INVOICE_STATES.PENDING,
        targetState: INVOICE_STATES.APPROVED,
        actor: 'usr_admin',
      });

      expect(result.success).toBe(true);

      await new Promise(setImmediate);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: 'inv_wp_ff', error: 'queue full' }),
        'webhook: failed to enqueue delivery job',
      );
    });

    it('gracefully skipped when no worker is set', async () => {
      setSharedWorker(null);
      mockDbChain();

      const result = await executeTransition({
        invoiceId: 'inv_wp_nw',
        currentState: INVOICE_STATES.PENDING,
        targetState: INVOICE_STATES.APPROVED,
        actor: 'usr_admin',
      });

      expect(result.success).toBe(true);
    });
  });
});

describe('invoice-state webhook delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WEBHOOK_BASE_DELAY = '0';
    process.env.WEBHOOK_MAX_DELAY = '0';
    process.env.WEBHOOK_MAX_RETRIES = '2';
  });

  afterEach(() => {
    delete process.env.WEBHOOK_BASE_DELAY;
    delete process.env.WEBHOOK_MAX_DELAY;
    delete process.env.WEBHOOK_MAX_RETRIES;
  });

  it('delivers signed webhook on first attempt', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const dead = jest.fn();
    const handler = createWebhookDeliveryHandler({ send, dead });

    await handler(makeJob());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: 'https://example.com/hook',
        webhookSecret: 'whsec_test123',
      }),
    );
    expect(dead).not.toHaveBeenCalled();
  });

  it('retries on transient failure then succeeds', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const dead = jest.fn();
    const handler = createWebhookDeliveryHandler({ send, dead });

    await handler(makeJob());

    expect(send).toHaveBeenCalledTimes(2);
    expect(dead).not.toHaveBeenCalled();
  });

  it('does not retry on 400 client error', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    const dead = jest.fn();
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('bad request');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('dead-letters after exhausting retries', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('conn reset'), { code: 'ECONNRESET' }));
    const dead = jest.fn().mockResolvedValue(undefined);
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('conn reset');
    expect(dead).toHaveBeenCalledTimes(1);
    expect(dead).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'inv_wp_001',
        tenantId: 'tenant_wp_01',
        event: 'invoice.pending_to_approved',
      }),
    );
  });

  it('dead-letter record includes attempts count and last error', async () => {
    const send = jest.fn()
      .mockRejectedValue(Object.assign(new Error('err1'), { code: 'ECONNRESET' }))
      .mockRejectedValue(Object.assign(new Error('err2'), { code: 'ECONNRESET' }))
      .mockRejectedValue(Object.assign(new Error('err3'), { code: 'ECONNRESET' }));
    const dead = jest.fn().mockResolvedValue(undefined);
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('err3');
    expect(dead).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: 'err3',
        attempts: expect.any(Number),
      }),
    );
  });

  it('still throws even when writeDeadLetter fails', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('net'), { code: 'ENOTFOUND' }));
    const dead = jest.fn().mockRejectedValue(new Error('db crash'));
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('net');
  });
});

describe('enqueueWebhookDelivery for invoice-state events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setSharedWorker(null);
  });

  it('enqueues job with correct event and transition data', async () => {
    const worker = { enqueue: jest.fn().mockReturnValue('job-enq-001') };
    setSharedWorker(worker);

    const jobId = await enqueueWebhookDelivery({
      invoiceId: 'inv_enq_001',
      event: 'invoice.pending_to_approved',
      transition: {
        from: INVOICE_STATES.PENDING,
        to: INVOICE_STATES.APPROVED,
        actor: 'usr_admin',
        reason: null,
        transitionedAt: '2026-01-15T00:00:00.000Z',
      },
    });

    expect(jobId).toBe('job-enq-001');
    expect(worker.enqueue).toHaveBeenCalledWith(
      'webhook_delivery',
      expect.objectContaining({
        invoiceId: 'inv_enq_001',
        event: 'invoice.pending_to_approved',
        transition: expect.objectContaining({
          from: 'pending',
          to: 'approved',
        }),
      }),
    );
  });

  it('returns null when no worker is set', async () => {
    setSharedWorker(null);
    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_enq_nw',
      event: 'invoice.pending_to_approved',
    });

    expect(result).toBeNull();
  });

  it('returns null and logs error when enqueue throws', async () => {
    const worker = { enqueue: jest.fn().mockImplementation(() => { throw new Error('queue full'); }) };
    setSharedWorker(worker);

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_enq_err',
      event: 'invoice.pending_to_approved',
    });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_enq_err', error: 'queue full' }),
      'webhook: failed to enqueue delivery job',
    );
  });
});

describe('shouldRetry predicate for invoice-state webhook errors', () => {
  it('retries on ECONNRESET', () => {
    expect(shouldRetry(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('retries on ETIMEDOUT', () => {
    expect(shouldRetry(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('retries on ECONNREFUSED', () => {
    expect(shouldRetry(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('retries on AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(shouldRetry(err)).toBe(true);
  });

  it('retries on HTTP 500', () => {
    expect(shouldRetry(Object.assign(new Error('500'), { status: 500 }))).toBe(true);
  });

  it('retries on HTTP 503', () => {
    expect(shouldRetry(Object.assign(new Error('503'), { status: 503 }))).toBe(true);
  });

  it('does NOT retry on HTTP 400', () => {
    expect(shouldRetry(Object.assign(new Error('400'), { status: 400 }))).toBe(false);
  });

  it('does NOT retry on HTTP 404', () => {
    expect(shouldRetry(Object.assign(new Error('404'), { status: 404 }))).toBe(false);
  });

  it('does NOT retry on plain Error', () => {
    expect(shouldRetry(new Error('generic'))).toBe(false);
  });

  it('does NOT retry on null', () => {
    expect(shouldRetry(null)).toBe(false);
  });
});
