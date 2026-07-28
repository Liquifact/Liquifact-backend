'use strict';

/**
 * @fileoverview Comprehensive tests for KYC outbound webhook callbacks.
 *
 * Coverage:
 *  1. kycWebhookEmitter – statusToEvent mapping, tenant lookup, enqueue,
 *     payload-size guard, fire-and-forget error suppression
 *  2. kycWebhookDelivery job handler – happy path, retry/backoff, dead-letter,
 *     payload-too-large, metrics, shouldRetry predicate
 *  3. kycService.persistKycRecord → webhook emission integration
 *  4. Edge cases: missing worker, missing tenants, DB errors, metric failures
 */

process.env.NODE_ENV = 'test';

// ─── Module mocks (must precede requires) ────────────────────────────────────

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

jest.mock('prom-client', () => ({
  Counter: class { constructor() {} inc() {} },
  Gauge:   class { constructor() {} set() {} },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics() { return ''; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });

jest.mock('../src/metrics', () => ({
  registry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
  escrowIndexerEventsProcessedTotal: { inc: jest.fn() },
  escrowIndexerEventsSkippedTotal:   { inc: jest.fn() },
  escrowIndexerCycleFailuresTotal:   { inc: jest.fn() },
  escrowIndexerLastCursorAdvanceTimestampSeconds: { set: jest.fn() },
  metricsAuth:    jest.fn(),
  metricsHandler: jest.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

const db     = require('../src/db/knex');
const logger = require('../src/logger');

const {
  KYC_WEBHOOK_EVENTS,
  statusToEvent,
  setSharedWorker,
  findTenantsForSme,
  enqueueKycWebhookDelivery,
  emitKycWebhookForSme,
  getMaxPayloadBytes,
  DEFAULT_MAX_PAYLOAD_BYTES,
} = require('../src/services/kycWebhookEmitter');

const {
  createKycWebhookDeliveryHandler,
  shouldRetry,
  writeKycDeadLetter,
} = require('../src/jobs/kycWebhookDelivery');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Builds a minimal mock DB chain for the invoices+tenants lookup path. */
function mockTenantsForSme(invoiceRows, tenantRows) {
  // invoices query: select + where + distinct
  db.mockReturnValueOnce({
    select: jest.fn().mockReturnThis(),
    where:  jest.fn().mockReturnThis(),
    distinct: jest.fn().mockResolvedValue(invoiceRows),
  });
  // tenants query: only queued when invoices returns rows (code returns early otherwise)
  if (invoiceRows.length > 0) {
    db.mockReturnValueOnce({
      select:  jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockResolvedValue(tenantRows),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. statusToEvent
// ─────────────────────────────────────────────────────────────────────────────

describe('statusToEvent', () => {
  it('maps verified  → kyc.verified',  () => expect(statusToEvent('verified')).toBe(KYC_WEBHOOK_EVENTS.VERIFIED));
  it('maps rejected  → kyc.rejected',  () => expect(statusToEvent('rejected')).toBe(KYC_WEBHOOK_EVENTS.REJECTED));
  it('maps exempted  → kyc.exempted',  () => expect(statusToEvent('exempted')).toBe(KYC_WEBHOOK_EVENTS.EXEMPTED));
  it('maps pending   → kyc.pending',   () => expect(statusToEvent('pending')).toBe(KYC_WEBHOOK_EVENTS.PENDING));
  it('returns null for unknown status', () => expect(statusToEvent('mystery')).toBeNull());
  it('returns null for empty string',   () => expect(statusToEvent('')).toBeNull());
  it('returns null for undefined',      () => expect(statusToEvent(undefined)).toBeNull());
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getMaxPayloadBytes
// ─────────────────────────────────────────────────────────────────────────────

describe('getMaxPayloadBytes', () => {
  afterEach(() => { delete process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES; });

  it('returns DEFAULT_MAX_PAYLOAD_BYTES when env var is unset', () => {
    expect(getMaxPayloadBytes()).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  it('returns custom value from env var', () => {
    process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = '1024';
    expect(getMaxPayloadBytes()).toBe(1024);
  });

  it('falls back to default for non-numeric env var', () => {
    process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = 'abc';
    expect(getMaxPayloadBytes()).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  it('falls back to default for zero', () => {
    process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = '0';
    expect(getMaxPayloadBytes()).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  it('falls back to default for negative value', () => {
    process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = '-100';
    expect(getMaxPayloadBytes()).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. findTenantsForSme
// ─────────────────────────────────────────────────────────────────────────────

describe('findTenantsForSme', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns tenants that have webhook configured', async () => {
    mockTenantsForSme(
      [{ tenant_id: 'tenant-1' }],
      [{ id: 'tenant-1', settings: { webhook_url: 'https://cb.example.com', webhook_secret: 'sec' } }],
    );

    const result = await findTenantsForSme('sme-001');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tenantId: 'tenant-1', webhookUrl: 'https://cb.example.com' });
  });

  it('excludes tenants with no webhook_url', async () => {
    mockTenantsForSme(
      [{ tenant_id: 'tenant-2' }],
      [{ id: 'tenant-2', settings: { webhook_secret: 'sec' } }],
    );

    const result = await findTenantsForSme('sme-002');
    expect(result).toHaveLength(0);
  });

  it('excludes tenants with no webhook_secret', async () => {
    mockTenantsForSme(
      [{ tenant_id: 'tenant-3' }],
      [{ id: 'tenant-3', settings: { webhook_url: 'https://x' } }],
    );

    const result = await findTenantsForSme('sme-003');
    expect(result).toHaveLength(0);
  });

  it('excludes tenants with null settings', async () => {
    mockTenantsForSme(
      [{ tenant_id: 'tenant-4' }],
      [{ id: 'tenant-4', settings: null }],
    );

    const result = await findTenantsForSme('sme-004');
    expect(result).toHaveLength(0);
  });

  it('returns empty array when SME has no invoices', async () => {
    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where:  jest.fn().mockReturnThis(),
      distinct: jest.fn().mockResolvedValue([]),
    });

    const result = await findTenantsForSme('sme-no-invoices');
    expect(result).toHaveLength(0);
  });

  it('returns multiple tenants when SME has invoices under multiple tenants', async () => {
    mockTenantsForSme(
      [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }],
      [
        { id: 'tenant-a', settings: { webhook_url: 'https://a', webhook_secret: 'sa' } },
        { id: 'tenant-b', settings: { webhook_url: 'https://b', webhook_secret: 'sb' } },
      ],
    );

    const result = await findTenantsForSme('sme-multi');
    expect(result).toHaveLength(2);
  });

  it('returns empty array and logs error when DB throws', async () => {
    db.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where:  jest.fn().mockReturnThis(),
      distinct: jest.fn().mockRejectedValue(new Error('db boom')),
    });

    const result = await findTenantsForSme('sme-dberr');
    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. enqueueKycWebhookDelivery
// ─────────────────────────────────────────────────────────────────────────────

describe('enqueueKycWebhookDelivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES;
  });

  afterEach(() => {
    setSharedWorker(null);
  });

  it('returns [] when shared worker is not set', async () => {
    setSharedWorker(null);
    const result = await enqueueKycWebhookDelivery({ smeId: 'sme-1', event: 'kyc.verified', kycData: {} });
    expect(result).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ smeId: 'sme-1' }),
      expect.stringContaining('shared worker not set'),
    );
  });

  it('returns [] when no tenants have webhooks configured', async () => {
    setSharedWorker({ enqueue: jest.fn() });
    mockTenantsForSme([], []);

    const result = await enqueueKycWebhookDelivery({ smeId: 'sme-none', event: 'kyc.verified', kycData: {} });
    expect(result).toEqual([]);
  });

  it('enqueues one job per tenant and returns job IDs', async () => {
    const mockEnqueue = jest.fn().mockReturnValue('job-001');
    setSharedWorker({ enqueue: mockEnqueue });

    mockTenantsForSme(
      [{ tenant_id: 'tenant-x' }],
      [{ id: 'tenant-x', settings: { webhook_url: 'https://x', webhook_secret: 'sx' } }],
    );

    const result = await enqueueKycWebhookDelivery({
      smeId: 'sme-5',
      event: KYC_WEBHOOK_EVENTS.VERIFIED,
      kycData: { status: 'verified', recordId: 'rec_1', verifiedAt: '2026-01-01T00:00:00Z' },
    });

    expect(result).toEqual(['job-001']);
    expect(mockEnqueue).toHaveBeenCalledWith('kyc_webhook_delivery', expect.objectContaining({
      smeId: 'sme-5',
      tenantId: 'tenant-x',
      event: 'kyc.verified',
    }));
  });

  it('returns [] and logs warning when payload exceeds size limit', async () => {
    process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = '10';
    const mockEnqueue = jest.fn();
    setSharedWorker({ enqueue: mockEnqueue });

    const result = await enqueueKycWebhookDelivery({
      smeId: 'sme-big',
      event: 'kyc.verified',
      kycData: { status: 'verified', recordId: 'rec_big', verifiedAt: '2026-01-01T00:00:00Z' },
    });

    expect(result).toEqual([]);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ smeId: 'sme-big' }),
      expect.stringContaining('payload too large'),
    );
  });

  it('continues enqueueing remaining tenants if one enqueue throws', async () => {
    const mockEnqueue = jest.fn()
      .mockImplementationOnce(() => { throw new Error('enqueue failed'); })
      .mockReturnValueOnce('job-002');
    setSharedWorker({ enqueue: mockEnqueue });

    mockTenantsForSme(
      [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }],
      [
        { id: 'tenant-a', settings: { webhook_url: 'https://a', webhook_secret: 'sa' } },
        { id: 'tenant-b', settings: { webhook_url: 'https://b', webhook_secret: 'sb' } },
      ],
    );

    const result = await enqueueKycWebhookDelivery({ smeId: 'sme-partial', event: 'kyc.verified', kycData: {} });
    expect(result).toEqual(['job-002']);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. emitKycWebhookForSme (fire-and-forget wrapper)
// ─────────────────────────────────────────────────────────────────────────────

describe('emitKycWebhookForSme', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    setSharedWorker(null);
  });

  it('never throws even when inner logic errors', async () => {
    // worker not set → enqueueKycWebhookDelivery returns []
    setSharedWorker(null);
    await expect(emitKycWebhookForSme({ smeId: 'sme-1', status: 'verified' })).resolves.toBeUndefined();
  });

  it('skips emission and logs warn for invalid smeId', async () => {
    await emitKycWebhookForSme({ smeId: '', status: 'verified' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ smeId: '' }),
      expect.stringContaining('invalid smeId'),
    );
  });

  it('skips emission and logs warn for unknown status', async () => {
    await emitKycWebhookForSme({ smeId: 'sme-1', status: 'bogus' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'bogus' }),
      expect.stringContaining('unknown status'),
    );
  });

  it('emits for all four valid statuses without throwing', async () => {
    for (const status of ['verified', 'rejected', 'exempted', 'pending']) {
      setSharedWorker(null); // worker not set → graceful skip
      await expect(
        emitKycWebhookForSme({ smeId: 'sme-x', status })
      ).resolves.toBeUndefined();
    }
  });

  it('suppresses unexpected errors from enqueueKycWebhookDelivery', async () => {
    // Cause findTenantsForSme to throw unexpectedly via DB mock
    db.mockReturnValueOnce({
      select:   jest.fn().mockReturnThis(),
      where:    jest.fn().mockReturnThis(),
      distinct: jest.fn().mockRejectedValue(new Error('unexpected')),
    });

    const mockWorker = { enqueue: jest.fn() };
    setSharedWorker(mockWorker);

    await expect(
      emitKycWebhookForSme({ smeId: 'sme-err', status: 'verified' })
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. shouldRetry predicate
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldRetry (kycWebhookDelivery)', () => {
  it('retries on ECONNRESET', () => {
    const e = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(shouldRetry(e)).toBe(true);
  });
  it('retries on ETIMEDOUT', () => {
    const e = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(shouldRetry(e)).toBe(true);
  });
  it('retries on ECONNREFUSED', () => {
    const e = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(shouldRetry(e)).toBe(true);
  });
  it('retries on ENOTFOUND', () => {
    const e = Object.assign(new Error('notfound'), { code: 'ENOTFOUND' });
    expect(shouldRetry(e)).toBe(true);
  });
  it('retries on EAI_AGAIN', () => {
    const e = Object.assign(new Error('again'), { code: 'EAI_AGAIN' });
    expect(shouldRetry(e)).toBe(true);
  });
  it('retries on AbortError', () => {
    const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(shouldRetry(e)).toBe(true);
  });
  it('retries on HTTP 500', () => {
    const e = Object.assign(new Error('500'), { status: 500 });
    expect(shouldRetry(e)).toBe(true);
  });
  it('retries on HTTP 503', () => {
    const e = Object.assign(new Error('503'), { status: 503 });
    expect(shouldRetry(e)).toBe(true);
  });
  it('does NOT retry on HTTP 400', () => {
    const e = Object.assign(new Error('400'), { status: 400 });
    expect(shouldRetry(e)).toBe(false);
  });
  it('does NOT retry on HTTP 401', () => {
    const e = Object.assign(new Error('401'), { status: 401 });
    expect(shouldRetry(e)).toBe(false);
  });
  it('does NOT retry on generic error with no code/status', () => {
    expect(shouldRetry(new Error('generic'))).toBe(false);
  });
  it('returns false for null/undefined', () => {
    expect(shouldRetry(null)).toBe(false);
    expect(shouldRetry(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. writeKycDeadLetter
// ─────────────────────────────────────────────────────────────────────────────

describe('writeKycDeadLetter', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('inserts a record into kyc_webhook_dead_letters', async () => {
    const insertMock = jest.fn().mockResolvedValue([1]);
    db.mockReturnValueOnce({ insert: insertMock });

    await writeKycDeadLetter({
      tenantId: 't1', smeId: 'sme-1', event: 'kyc.verified',
      payload: { event: 'kyc.verified' }, lastError: 'boom', attempts: 3,
    });

    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 't1',
      sme_id: 'sme-1',
      event: 'kyc.verified',
      last_error: 'boom',
      attempts: 3,
    }));
  });

  it('logs a warning when DB insert fails but does not throw', async () => {
    db.mockReturnValueOnce({ insert: jest.fn().mockRejectedValue(new Error('dbfail')) });

    await expect(writeKycDeadLetter({
      tenantId: 't1', smeId: 'sme-1', event: 'kyc.rejected',
      payload: {}, lastError: 'err', attempts: 1,
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'dbfail' }),
      expect.stringContaining('dead-letter'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. createKycWebhookDeliveryHandler – job handler
// ─────────────────────────────────────────────────────────────────────────────

describe('createKycWebhookDeliveryHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WEBHOOK_MAX_RETRIES;
    delete process.env.WEBHOOK_BASE_DELAY;
    delete process.env.WEBHOOK_MAX_DELAY;
    delete process.env.WEBHOOK_TIMEOUT_MS;
    delete process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES;
  });

  /** Builds a minimal job object. */
  function makeJob(overrides = {}) {
    return {
      id: 'job-test-1',
      attempts: 1,
      payload: {
        smeId: 'sme-abc',
        tenantId: 'tenant-xyz',
        webhookUrl: 'https://cb.example.com/kyc',
        webhookSecret: 'secret123',
        event: 'kyc.verified',
        kycData: { status: 'verified', recordId: 'rec_1', verifiedAt: '2026-01-01T00:00:00Z' },
        ...overrides,
      },
    };
  }

  it('delivers successfully on first attempt', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const dead = jest.fn();
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    await handler(makeJob());

    expect(send).toHaveBeenCalledTimes(1);
    expect(dead).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'kyc.verified' }),
      expect.stringContaining('delivered successfully'),
    );
  });

  it('retries on transient error then succeeds', async () => {
    process.env.WEBHOOK_MAX_RETRIES = '3';
    process.env.WEBHOOK_BASE_DELAY = '1';

    const send = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const dead = jest.fn();
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    await handler(makeJob());

    expect(send).toHaveBeenCalledTimes(2);
    expect(dead).not.toHaveBeenCalled();
  });

  it('dead-letters after exhausting retries', async () => {
    process.env.WEBHOOK_MAX_RETRIES = '2';
    process.env.WEBHOOK_BASE_DELAY = '1';

    const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    const send = jest.fn().mockRejectedValue(netErr);
    const dead = jest.fn().mockResolvedValue(undefined);
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('ECONNRESET');

    expect(send).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(dead).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-xyz',
      smeId: 'sme-abc',
      event: 'kyc.verified',
      attempts: 3,
    }));
  });

  it('does NOT retry on 4xx and dead-letters immediately', async () => {
    process.env.WEBHOOK_MAX_RETRIES = '3';
    process.env.WEBHOOK_BASE_DELAY = '1';

    const err400 = Object.assign(new Error('Bad Request'), { status: 400 });
    const send = jest.fn().mockRejectedValue(err400);
    const dead = jest.fn().mockResolvedValue(undefined);
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow('Bad Request');

    expect(send).toHaveBeenCalledTimes(1);
    expect(dead).toHaveBeenCalledTimes(1);
  });

  it('dead-letters immediately when payload exceeds size limit', async () => {
    process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = '10';

    const send = jest.fn();
    const dead = jest.fn().mockResolvedValue(undefined);
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    await expect(handler(makeJob())).rejects.toThrow(/payload exceeds size limit/);

    expect(send).not.toHaveBeenCalled();
    expect(dead).toHaveBeenCalledWith(expect.objectContaining({
      smeId: 'sme-abc',
      lastError: expect.stringContaining('payload exceeds size limit'),
      attempts: 1,
    }));
  });

  it('still throws after dead() itself fails', async () => {
    process.env.WEBHOOK_MAX_RETRIES = '1';
    process.env.WEBHOOK_BASE_DELAY = '1';

    const send = jest.fn().mockRejectedValue(Object.assign(new Error('net'), { code: 'ECONNRESET' }));
    const dead = jest.fn().mockRejectedValue(new Error('db dead fail'));
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    // Should re-throw original error, not the dead() error
    await expect(handler(makeJob())).rejects.toThrow('net');
  });

  it('logs retry warnings with attempt number', async () => {
    process.env.WEBHOOK_MAX_RETRIES = '2';
    process.env.WEBHOOK_BASE_DELAY = '1';

    const send = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fail'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const dead = jest.fn();
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    await handler(makeJob());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      expect.stringContaining('transient failure'),
    );
  });

  it('handles kycData defaults gracefully when kycData is omitted', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const dead = jest.fn();
    const handler = createKycWebhookDeliveryHandler({ send, dead });

    const job = { id: 'j2', attempts: 1, payload: {
      smeId: 'sme-1', tenantId: 't1',
      webhookUrl: 'https://x', webhookSecret: 'sec',
      event: 'kyc.pending',
      // kycData intentionally omitted
    }};

    await expect(handler(job)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. kycService.persistKycRecord → webhook emission integration
// ─────────────────────────────────────────────────────────────────────────────

describe('kycService.persistKycRecord → webhook integration', () => {
  let kycService;
  let emitterModule;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Re-mock db and logger for fresh module loads
    jest.mock('../src/db/knex', () => jest.fn());
    jest.mock('../src/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

    // Spy on kycWebhookEmitter.emitKycWebhookForSme
    jest.mock('../src/services/kycWebhookEmitter', () => ({
      emitKycWebhookForSme: jest.fn().mockResolvedValue(undefined),
      KYC_WEBHOOK_EVENTS: {
        VERIFIED: 'kyc.verified', REJECTED: 'kyc.rejected',
        EXEMPTED: 'kyc.exempted', PENDING:  'kyc.pending',
      },
      statusToEvent:             jest.fn(),
      setSharedWorker:           jest.fn(),
      findTenantsForSme:         jest.fn(),
      enqueueKycWebhookDelivery: jest.fn().mockResolvedValue([]),
      getMaxPayloadBytes:        jest.fn().mockReturnValue(65536),
      DEFAULT_MAX_PAYLOAD_BYTES: 65536,
    }));

    kycService   = require('../src/services/kycService');
    emitterModule = require('../src/services/kycWebhookEmitter');
  });

  afterEach(() => {
    jest.resetModules();
  });

  function setupDb(existingRow) {
    const freshDb = require('../src/db/knex');
    freshDb.mockImplementation(() => ({
      where:  jest.fn().mockReturnThis(),
      first:  jest.fn().mockResolvedValue(existingRow),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));
  }

  it('calls emitKycWebhookForSme after insert (new record)', async () => {
    setupDb(null); // no existing row → insert path
    await kycService.persistKycRecord({ smeId: 'sme-new', status: 'verified' });
    expect(emitterModule.emitKycWebhookForSme).toHaveBeenCalledWith(
      expect.objectContaining({ smeId: 'sme-new', status: 'verified' }),
    );
  });

  it('calls emitKycWebhookForSme after update (existing record)', async () => {
    setupDb({ sme_id: 'sme-existing' });
    await kycService.persistKycRecord({ smeId: 'sme-existing', status: 'rejected' });
    expect(emitterModule.emitKycWebhookForSme).toHaveBeenCalledWith(
      expect.objectContaining({ smeId: 'sme-existing', status: 'rejected' }),
    );
  });

  it('passes recordId and verifiedAt through to the emitter', async () => {
    setupDb(null);
    await kycService.persistKycRecord({
      smeId: 'sme-full', status: 'verified',
      providerRecordId: 'rec_99', verifiedAt: '2026-07-01T00:00:00Z',
    });
    expect(emitterModule.emitKycWebhookForSme).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec_99',
        verifiedAt: '2026-07-01T00:00:00Z',
      }),
    );
  });

  it('persistKycRecord still resolves even when emitter throws', async () => {
    setupDb(null);
    emitterModule.emitKycWebhookForSme.mockRejectedValueOnce(new Error('emitter crash'));

    const result = await kycService.persistKycRecord({ smeId: 'sme-robust', status: 'pending' });
    expect(result).toMatchObject({ smeId: 'sme-robust', status: 'pending' });
  });

  it('emits correct event for each KYC status', async () => {
    for (const [status] of [['verified'], ['rejected'], ['exempted'], ['pending']]) {
      jest.clearAllMocks();
      emitterModule.emitKycWebhookForSme.mockResolvedValue(undefined);
      setupDb(null);

      await kycService.persistKycRecord({ smeId: `sme-${status}`, status });
      expect(emitterModule.emitKycWebhookForSme).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Payload structure and signature compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe('KYC webhook payload structure', () => {
  const { sortKeys, createSignatureHeader, verifySignature } = require('../src/services/webhooks');

  it('payload keys are deterministically sorted', () => {
    const payload = sortKeys({
      tenantId: 't1', event: 'kyc.verified', smeId: 'sme-1',
      timestamp: '2026-01-01T00:00:00Z',
      kyc: { verifiedAt: null, status: 'verified', recordId: 'r1' },
    });
    const keys = Object.keys(payload);
    expect(keys).toEqual([...keys].sort());
  });

  it('signed payload passes verifySignature', () => {
    const secret = 'webhook-secret-abc';
    const payload = sortKeys({
      event: 'kyc.verified', smeId: 'sme-1', tenantId: 't1',
      timestamp: '2026-01-01T00:00:00Z',
      kyc: { recordId: 'r1', status: 'verified', verifiedAt: null },
    });
    const body   = JSON.stringify(payload);
    const header = createSignatureHeader(secret, body);
    const result = verifySignature(secret, body, header, 60_000);
    expect(result.valid).toBe(true);
  });

  it('tampered payload fails verifySignature', () => {
    const secret  = 'webhook-secret-abc';
    const body    = JSON.stringify({ event: 'kyc.verified', smeId: 'sme-1' });
    const header  = createSignatureHeader(secret, body);
    const tampered = JSON.stringify({ event: 'kyc.exempted', smeId: 'sme-1' });
    const result  = verifySignature(secret, tampered, header, 60_000);
    expect(result.valid).toBe(false);
  });

  it('KYC_WEBHOOK_EVENTS contains all four events', () => {
    expect(KYC_WEBHOOK_EVENTS).toEqual({
      VERIFIED: 'kyc.verified',
      REJECTED: 'kyc.rejected',
      EXEMPTED: 'kyc.exempted',
      PENDING:  'kyc.pending',
    });
  });
});
