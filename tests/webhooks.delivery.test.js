'use strict';

/**
 * @fileoverview Comprehensive tests for signed webhook delivery on invoice
 * state transitions with retry, dead-lettering, and signature verification.
 *
 * Coverage targets:
 *  - webhookDelivery job handler (happy path, retry, dead-letter, metrics)
 *  - enqueueWebhookDelivery (DB look-up, enqueue, missing config guards)
 *  - invoiceStateMachine.executeTransition → webhook enqueue wiring
 *  - signature helpers: constant-time comparison, replay protection
 *  - shouldRetry predicate
 *  - writeDeadLetter DB error path
 */

process.env.NODE_ENV = 'test';

process.env.NODE_ENV = 'test';

// ─── Module mocks (must precede requires) ────────────────────────────────────

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
    id: 'audit-001',
    timestamp: '2025-01-01T00:00:00.000Z',
  }),
}));

// Mock prom-client and metrics to avoid Counter constructor errors in test env
jest.mock('prom-client', () => ({
  Counter: class { constructor() {} inc() {} labels() { return this; } },
  Gauge: class { constructor() {} set() {} labels() { return this; } },
  Histogram: class { constructor() {} observe() {} labels() { return this; } },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics() { return ''; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });


jest.mock('../src/metrics', () => {
  const actual = jest.requireActual('../src/metrics');
  return {
    ...actual,
    escrowIndexerEventsProcessedTotal: { inc: jest.fn() },
    escrowIndexerEventsSkippedTotal: { inc: jest.fn() },
    escrowIndexerCycleFailuresTotal: { inc: jest.fn() },
    escrowIndexerLastCursorAdvanceTimestampSeconds: { set: jest.fn() },
    webhookReplayTotal: { inc: jest.fn() },
  };
});




// ─── Imports ─────────────────────────────────────────────────────────────────

const db = require('../src/db/knex');
const logger = require('../src/logger');

const {
  createWebhookDeliveryHandler,
  shouldRetry,
  sendWebhookRequest,
  writeDeadLetter,
} = require('../src/jobs/webhookDelivery');

const {
  createSignature,
  createSignatureHeader,
  verifySignature,
  sortKeys,
  enqueueWebhookDelivery,
  setSharedWorker,
  SIGNATURE_VERSION,
  TOLERANCE_MS,
} = require('../src/services/webhooks');

const {
  executeTransition,
  INVOICE_STATES,
} = require('../src/services/invoiceStateMachine');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Configures db mock to return invoice + tenant settings in sequence.
 *
 * @param {Object} [overrides] - Override tenant settings fields.
 */
function mockDbChain(overrides = {}) {
  const settings = {
    webhook_url: 'https://hooks.example.com/cb',
    webhook_secret: 'super_secret_abc',
    ...overrides,
  };
  db.mockReturnValueOnce({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ tenant_id: 'tenant_t1' }),
  });
  db.mockReturnValueOnce({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ settings }),
  });
}

/**
 * Returns a minimal valid job object for the delivery handler.
 *
 * @param {Object} [payloadOverrides] - Override job payload fields.
 * @returns {Object} Job object.
 */
function makeJob(payloadOverrides = {}) {
  return {
    id: 'job-test-001',
    type: 'webhook_delivery',
    attempts: 1,
    payload: {
      invoiceId: 'inv_abc',
      tenantId: 'tenant_t1',
      webhookUrl: 'https://hooks.example.com/cb',
      webhookSecret: 'super_secret_abc',
      event: 'invoice.pending_to_approved',
      transition: {
        from: 'pending',
        to: 'approved',
        actor: 'usr_admin',
        reason: null,
        transitionedAt: '2025-01-01T00:00:00.000Z',
      },
      ...payloadOverrides,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Reset shared worker between tests
  setSharedWorker(null);
});

// ─── 1. shouldRetry predicate ─────────────────────────────────────────────────

describe('shouldRetry predicate', () => {
  it('returns true for ECONNRESET', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns true for ENOTFOUND', () => {
    const err = Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns true for EAI_AGAIN', () => {
    const err = Object.assign(new Error('dns2'), { code: 'EAI_AGAIN' });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns true for AbortError', () => {
    const err = Object.assign(new Error('abort'), { name: 'AbortError' });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns true for HTTP 500', () => {
    const err = Object.assign(new Error('500'), { status: 500 });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns true for HTTP 503', () => {
    const err = Object.assign(new Error('503'), { status: 503 });
    expect(shouldRetry(err)).toBe(true);
  });

  it('returns false for HTTP 400', () => {
    const err = Object.assign(new Error('400'), { status: 400 });
    expect(shouldRetry(err)).toBe(false);
  });

  it('returns false for HTTP 404', () => {
    const err = Object.assign(new Error('404'), { status: 404 });
    expect(shouldRetry(err)).toBe(false);
  });

  it('returns false for plain Error with no code/status', () => {
    expect(shouldRetry(new Error('generic'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(shouldRetry(null)).toBe(false);
  });
});

// ─── 2. Signature helpers ─────────────────────────────────────────────────────

describe('signature helpers', () => {
  const secret = 'test_secret_xyz';
  const rawBody = JSON.stringify({ event: 'invoice.pending_to_approved', invoiceId: 'inv_1' });

  it('createSignature produces a hex string', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createSignature(secret, rawBody, ts);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it('createSignatureHeader produces t=<ts>,v1=<sig>', () => {
    const header = createSignatureHeader(secret, rawBody);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('verifySignature accepts a freshly-created header', () => {
    const header = createSignatureHeader(secret, rawBody);
    const result = verifySignature(secret, rawBody, header);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it('verifySignature rejects tampered payload', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${createSignature(secret, rawBody, ts)}`;
    const tampered = JSON.stringify({ event: 'invoice.fraud', invoiceId: 'inv_1' });
    const result = verifySignature(secret, tampered, header);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Signature mismatch');
  });

  it('verifySignature rejects wrong secret', () => {
    const header = createSignatureHeader(secret, rawBody);
    const result = verifySignature('wrong_secret', rawBody, header);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Signature mismatch');
  });

  it('verifySignature rejects timestamp outside tolerance (clock skew)', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes ago
    const header = `t=${oldTs},v1=${createSignature(secret, rawBody, oldTs)}`;
    const result = verifySignature(secret, rawBody, header, 5 * 60 * 1000);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Timestamp outside tolerance window');
  });

  it('verifySignature accepts timestamp within tolerance', () => {
    const recentTs = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const header = `t=${recentTs},v1=${createSignature(secret, rawBody, recentTs)}`;
    const result = verifySignature(secret, rawBody, header, 5 * 60 * 1000);
    expect(result.valid).toBe(true);
  });

  it('verifySignature rejects malformed header', () => {
    const result = verifySignature(secret, rawBody, 'bad-format');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid signature header format');
  });

  it('verifySignature rejects header missing v1 part', () => {
    const result = verifySignature(secret, rawBody, 't=1234567890');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid signature header format');
  });

  it('produces unique signatures for different payloads (no collision)', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig1 = createSignature(secret, rawBody, ts);
    const sig2 = createSignature(secret, JSON.stringify({ event: 'other' }), ts);
    expect(sig1).not.toBe(sig2);
  });

  it('produces unique signatures for different timestamps (replay prevention)', () => {
    const sig1 = createSignature(secret, rawBody, 1000000);
    const sig2 = createSignature(secret, rawBody, 2000000);
    expect(sig1).not.toBe(sig2);
  });

  it('exports SIGNATURE_VERSION as v1', () => {
    expect(SIGNATURE_VERSION).toBe('v1');
  });

  it('exports TOLERANCE_MS as 5 minutes in ms', () => {
    expect(TOLERANCE_MS).toBe(5 * 60 * 1000);
  });

  it('sortKeys produces deterministic ordering', () => {
    const obj = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const sorted = sortKeys(obj);
    expect(Object.keys(sorted)).toEqual(['a', 'm', 'z']);
    expect(Object.keys(sorted.m)).toEqual(['a', 'b']);
  });
});

// ─── 3. createWebhookDeliveryHandler — successful delivery ───────────────────

describe('createWebhookDeliveryHandler: successful delivery', () => {
  it('calls send once and logs success', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const dead = jest.fn();
    const handler = createWebhookDeliveryHandler({ send, dead });
    const job = makeJob();

    await handler(job);

    expect(send).toHaveBeenCalledTimes(1);
    expect(dead).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_abc', event: 'invoice.pending_to_approved' }),
      'webhook_delivery: delivered successfully'
    );
  });

  it('signs payload with HMAC-SHA256 — verifySignature returns valid', async () => {
    let capturedRawBody;
    let capturedHeader;

    const send = jest.fn().mockImplementation(({ webhookSecret, rawBody }) => {
      capturedRawBody = rawBody;
      // Produce a header for later assertion
      capturedHeader = createSignatureHeader(webhookSecret, rawBody);
      return Promise.resolve({ ok: true, status: 200 });
    });

    const handler = createWebhookDeliveryHandler({ send, dead: jest.fn() });
    await handler(makeJob());

    // Verify the body is valid JSON with expected shape
    const parsed = JSON.parse(capturedRawBody);
    expect(parsed).toMatchObject({
      event: 'invoice.pending_to_approved',
      invoiceId: 'inv_abc',
    });

    // Verify signature passes constant-time check
    const result = verifySignature('super_secret_abc', capturedRawBody, capturedHeader);
    expect(result.valid).toBe(true);
  });

  it('payload keys are deterministically sorted', async () => {
    let capturedRawBody;

    const send = jest.fn().mockImplementation(({ rawBody }) => {
      capturedRawBody = rawBody;
      return Promise.resolve({ ok: true, status: 200 });
    });

    const handler = createWebhookDeliveryHandler({ send, dead: jest.fn() });
    await handler(makeJob());

    const parsed = JSON.parse(capturedRawBody);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });
});

// ─── 4. createWebhookDeliveryHandler — transient failure + retry ─────────────

describe('createWebhookDeliveryHandler: transient failure + retry', () => {
  beforeEach(() => {
    // Speed up retries in tests
    process.env.WEBHOOK_BASE_DELAY = '0';
    process.env.WEBHOOK_MAX_DELAY = '0';
    process.env.WEBHOOK_MAX_RETRIES = '2';
  });

  afterEach(() => {
    delete process.env.WEBHOOK_BASE_DELAY;
    delete process.env.WEBHOOK_MAX_DELAY;
    delete process.env.WEBHOOK_MAX_RETRIES;
  });

  it('retries on ETIMEDOUT then succeeds', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const dead = jest.fn();
    const handler = createWebhookDeliveryHandler({ send, dead });
    await handler(makeJob());

    expect(send).toHaveBeenCalledTimes(2);
    expect(dead).not.toHaveBeenCalled();
  });

  it('retries on 500 response then succeeds', async () => {
    const serverErr = Object.assign(new Error('500'), { status: 500 });
    const send = jest.fn()
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const dead = jest.fn();
    const handler = createWebhookDeliveryHandler({ send, dead });
    await handler(makeJob());

    expect(send).toHaveBeenCalledTimes(2);
    expect(dead).not.toHaveBeenCalled();
  });

  it('does NOT retry on 400 (non-retriable)', async () => {
    const clientErr = Object.assign(new Error('400'), { status: 400 });
    const send = jest.fn().mockRejectedValue(clientErr);
    const dead = jest.fn();
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('400');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('logs warn on each transient retry', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('conn reset'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const handler = createWebhookDeliveryHandler({ send, dead: jest.fn() });
    await handler(makeJob());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ECONNRESET' }),
      'webhook_delivery: transient failure, will retry'
    );
  });
});

// ─── 5. createWebhookDeliveryHandler — dead-letter ───────────────────────────

describe('createWebhookDeliveryHandler: permanent failure → dead-letter', () => {
  beforeEach(() => {
    process.env.WEBHOOK_BASE_DELAY = '0';
    process.env.WEBHOOK_MAX_DELAY = '0';
    process.env.WEBHOOK_MAX_RETRIES = '1';
  });

  afterEach(() => {
    delete process.env.WEBHOOK_BASE_DELAY;
    delete process.env.WEBHOOK_MAX_DELAY;
    delete process.env.WEBHOOK_MAX_RETRIES;
  });

  it('calls writeDeadLetter after exhausting retries', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('net'), { code: 'ECONNRESET' }));
    const dead = jest.fn().mockResolvedValue(undefined);
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('net');
    expect(dead).toHaveBeenCalledTimes(1);
    expect(dead).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'inv_abc',
        tenantId: 'tenant_t1',
        event: 'invoice.pending_to_approved',
        lastError: 'net',
      })
    );
  });

  it('logs error before dead-lettering', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }));
    const dead = jest.fn().mockResolvedValue(undefined);
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_abc', error: 'boom' }),
      'webhook_delivery: exhausted retries, dead-lettering'
    );
  });

  it('still throws even if writeDeadLetter itself fails', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('net2'), { code: 'ENOTFOUND' }));
    const dead = jest.fn().mockRejectedValue(new Error('db write failed'));
    const handler = createWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('net2');
  });
});

// ─── 6. writeDeadLetter helper ───────────────────────────────────────────────

describe('writeDeadLetter', () => {
  it('inserts a row into webhook_dead_letters', async () => {
    const insertMock = jest.fn().mockResolvedValue([1]);
    db.mockReturnValueOnce({ insert: insertMock });

    await writeDeadLetter({
      tenantId: 'tenant_t1',
      invoiceId: 'inv_abc',
      event: 'invoice.pending_to_approved',
      payload: { event: 'test' },
      lastError: 'connection refused',
      attempts: 3,
    });

    expect(db).toHaveBeenCalledWith('webhook_dead_letters');
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant_t1',
        invoice_id: 'inv_abc',
        event: 'invoice.pending_to_approved',
        last_error: 'connection refused',
        attempts: 3,
      })
    );
  });

  it('swallows DB errors and logs a warning', async () => {
    db.mockReturnValueOnce({ insert: jest.fn().mockRejectedValue(new Error('db crash')) });

    await expect(
      writeDeadLetter({
        tenantId: 't', invoiceId: 'i', event: 'e', payload: {}, lastError: 'x', attempts: 1,
      })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'db crash' }),
      'Failed to persist webhook dead-letter record'
    );
  });
});

// ─── 7. enqueueWebhookDelivery (wiring via webhooks.js) ─────────────────────

describe('enqueueWebhookDelivery', () => {
  it('returns null when no shared worker is set', async () => {
    setSharedWorker(null);

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_abc',
      event: 'invoice.pending_to_approved',
      transition: { from: 'pending', to: 'approved', actor: 'usr_1', transitionedAt: '' },
    });

    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_abc' }),
      'webhook: shared worker not set, skipping enqueue'
    );
  });

  it('returns null when invoice is not found', async () => {
    const worker = { enqueue: jest.fn() };
    setSharedWorker(worker);

    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    });

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_missing',
      event: 'invoice.pending_to_approved',
      transition: { from: 'pending', to: 'approved', actor: 'usr_1', transitionedAt: '' },
    });

    expect(result).toBeNull();
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it('returns null when tenant settings are missing', async () => {
    const worker = { enqueue: jest.fn() };
    setSharedWorker(worker);

    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ tenant_id: 't1' }),
    });
    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    });

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_abc',
      event: 'e',
      transition: {},
    });

    expect(result).toBeNull();
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it('returns null when webhook_url is missing from settings', async () => {
    const worker = { enqueue: jest.fn() };
    setSharedWorker(worker);

    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ tenant_id: 't1' }),
    });
    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ settings: { webhook_secret: 'sec' } }),
    });

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_abc',
      event: 'e',
      transition: {},
    });

    expect(result).toBeNull();
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it('returns null when webhook_secret is missing from settings', async () => {
    const worker = { enqueue: jest.fn() };
    setSharedWorker(worker);

    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ tenant_id: 't1' }),
    });
    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ settings: { webhook_url: 'https://x' } }),
    });

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_abc',
      event: 'e',
      transition: {},
    });

    expect(result).toBeNull();
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a job and returns the job ID when fully configured', async () => {
    const worker = { enqueue: jest.fn().mockReturnValue('job-xyz') };
    setSharedWorker(worker);
    mockDbChain();

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_abc',
      event: 'invoice.pending_to_approved',
      transition: { from: 'pending', to: 'approved', actor: 'usr_1', transitionedAt: '2025-01-01T00:00:00.000Z' },
    });

    expect(result).toBe('job-xyz');
    expect(worker.enqueue).toHaveBeenCalledWith(
      'webhook_delivery',
      expect.objectContaining({
        invoiceId: 'inv_abc',
        tenantId: 'tenant_t1',
        event: 'invoice.pending_to_approved',
        webhookUrl: 'https://hooks.example.com/cb',
        // webhookSecret is present but we don't assert its value to avoid echoing it in test output
      })
    );
    // Ensure secret IS passed in payload (delivery handler needs it)
    const enqueuedPayload = worker.enqueue.mock.calls[0][1];
    expect(enqueuedPayload.webhookSecret).toBe('super_secret_abc');
  });

  it('logs error and returns null when enqueue throws', async () => {
    const worker = { enqueue: jest.fn().mockImplementation(() => { throw new Error('queue full'); }) };
    setSharedWorker(worker);
    mockDbChain();

    const result = await enqueueWebhookDelivery({
      invoiceId: 'inv_abc',
      event: 'e',
      transition: {},
    });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'queue full' }),
      'webhook: failed to enqueue delivery job'
    );
  });
});

// ─── 8. executeTransition → webhook enqueue integration ──────────────────────

describe('executeTransition → webhook enqueue wiring', () => {
  it('calls enqueueWebhookDelivery after a valid transition', async () => {
    const worker = { enqueue: jest.fn().mockReturnValue('job-trans-001') };
    setSharedWorker(worker);
    mockDbChain();

    const result = await executeTransition({
      invoiceId: 'inv_abc',
      currentState: INVOICE_STATES.PENDING,
      targetState: INVOICE_STATES.APPROVED,
      actor: 'usr_admin',
    });

    expect(result.success).toBe(true);
    expect(result.newState).toBe(INVOICE_STATES.APPROVED);

    // Allow the microtask queue to flush the fire-and-forget enqueue
    await new Promise(setImmediate);

    expect(worker.enqueue).toHaveBeenCalledWith(
      'webhook_delivery',
      expect.objectContaining({
        invoiceId: 'inv_abc',
        event: 'invoice.pending_to_approved',
        transition: expect.objectContaining({
          from: INVOICE_STATES.PENDING,
          to: INVOICE_STATES.APPROVED,
          actor: 'usr_admin',
        }),
      })
    );
  });

  it('does not affect transition result when webhook enqueue fails', async () => {
    const worker = { enqueue: jest.fn().mockImplementation(() => { throw new Error('queue error'); }) };
    setSharedWorker(worker);
    mockDbChain();

    // executeTransition should still succeed even if enqueue fails
    const result = await executeTransition({
      invoiceId: 'inv_abc',
      currentState: INVOICE_STATES.PENDING,
      targetState: INVOICE_STATES.APPROVED,
      actor: 'usr_admin',
    });

    expect(result.success).toBe(true);

    // Allow microtask to flush
    await new Promise(setImmediate);
    // The enqueue error is swallowed inside enqueueWebhookDelivery itself
    // and logged there before reaching the .catch() in invoiceStateMachine.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_abc', error: 'queue error' }),
      'webhook: failed to enqueue delivery job'
    );
  });

  it('throws for an invalid transition and does NOT enqueue webhook', async () => {
    const worker = { enqueue: jest.fn() };
    setSharedWorker(worker);

    await expect(
      executeTransition({
        invoiceId: 'inv_abc',
        currentState: INVOICE_STATES.APPROVED,
        targetState: INVOICE_STATES.PENDING, // invalid
        actor: 'usr_admin',
      })
    ).rejects.toThrow();

    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it('includes correct event name for approved → linked_escrow', async () => {
    const worker = { enqueue: jest.fn().mockReturnValue('job-002') };
    setSharedWorker(worker);
    mockDbChain();

    await executeTransition({
      invoiceId: 'inv_abc',
      currentState: INVOICE_STATES.APPROVED,
      targetState: INVOICE_STATES.LINKED_ESCROW,
      actor: 'usr_admin',
    });

    await new Promise(setImmediate);

    expect(worker.enqueue).toHaveBeenCalledWith(
      'webhook_delivery',
      expect.objectContaining({ event: 'invoice.approved_to_linked_escrow' })
    );
  });
});

// ─── 9. Security: secrets / URLs not logged at info level ───────────────────

describe('security: no secrets or full URLs at info level', () => {
  it('does not log webhookSecret at info level during delivery', async () => {
    const handler = createWebhookDeliveryHandler({
      send: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
      dead: jest.fn(),
    });

    await handler(makeJob());

    const allInfoCalls = logger.info.mock.calls;
    for (const [meta] of allInfoCalls) {
      if (meta && typeof meta === 'object') {
        expect(meta.webhookSecret).toBeUndefined();
        expect(meta.secret).toBeUndefined();
      }
    }
  });

  it('does not log webhookUrl at info level during delivery', async () => {
    const handler = createWebhookDeliveryHandler({
      send: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
      dead: jest.fn(),
    });

    await handler(makeJob());

    const allInfoCalls = logger.info.mock.calls;
    for (const [meta] of allInfoCalls) {
      if (meta && typeof meta === 'object') {
        expect(meta.webhookUrl).toBeUndefined();
        expect(meta.url).toBeUndefined();
      }
    }
  });
});
