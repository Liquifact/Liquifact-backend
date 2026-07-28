'use strict';

/**
 * @fileoverview Tests for outbound metrics-event webhook callbacks (issue #970).
 *
 * Coverage:
 *  - emitMetricsWebhook: missing tenantId warns and skips
 *  - emitMetricsWebhook: missing tenant DB record → info log, no fetch
 *  - emitMetricsWebhook: missing webhook_url or webhook_secret → info log
 *  - emitMetricsWebhook: event filtered by webhook_events allowlist
 *  - emitMetricsWebhook: metrics.* wildcard passes through
 *  - emitMetricsWebhook: global * wildcard passes through
 *  - emitMetricsWebhook: successful delivery → fetch called with signed body
 *  - emitMetricsWebhook: HMAC signature is valid on delivery
 *  - emitMetricsWebhook: payload size bounding — oversized metrics truncated
 *  - emitMetricsWebhook: transient 5xx → retry → success
 *  - emitMetricsWebhook: exhausted retries → dead-letter insert
 *  - emitMetricsWebhook: dead-letter DB failure does not throw
 *  - emitMetricsWebhook: shared worker enqueue path (skips direct fetch)
 */

process.env.NODE_ENV = 'test';

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../src/services/auditLogStore', () => ({
  appendAuditEvent: jest.fn().mockResolvedValue(undefined),
}));
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

const crypto = require('crypto');
const db = require('../src/db/knex');
const logger = require('../src/logger');
const {
  emitMetricsWebhook,
  verifySignature,
  setSharedWorker,
  MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES,
} = require('../src/services/webhooks');

const TENANT_SETTINGS_WITH_HOOK = {
  webhook_url: 'https://subscriber.example.com/hook',
  webhook_secret: 'metrics-webhook-secret-32-chars!!',
};

function mockTenantDb(settings) {
  db.mockReturnValueOnce({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(settings ? { settings } : null),
  });
}

function mockDeadLetterInsert() {
  db.mockReturnValueOnce({
    insert: jest.fn().mockResolvedValue([1]),
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  setSharedWorker(null);
  global.fetch = jest.fn();
  process.env.WEBHOOK_BASE_DELAY = '0';
  process.env.WEBHOOK_MAX_DELAY = '0';
  process.env.WEBHOOK_MAX_RETRIES = '1';
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.WEBHOOK_BASE_DELAY;
  delete process.env.WEBHOOK_MAX_DELAY;
  delete process.env.WEBHOOK_MAX_RETRIES;
});

// ---------------------------------------------------------------------------
// 1. Guards
// ---------------------------------------------------------------------------

describe('emitMetricsWebhook — guards', () => {
  test('warns and skips when tenantId is missing', async () => {
    await emitMetricsWebhook({ tenantId: null, metrics: { open: 1 } });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'metrics.snapshot' }),
      'Tenant ID missing for metrics webhook emission',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('info-logs and skips when tenant not found in DB', async () => {
    mockTenantDb(null);
    await emitMetricsWebhook({ tenantId: 't_missing', metrics: {} });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't_missing' }),
      'Tenant settings not found for metrics webhook',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('info-logs and skips when webhook_url is missing', async () => {
    mockTenantDb({ webhook_secret: 'sec' });
    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't_1' }),
      'Webhook URL or secret not configured for metrics event',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('info-logs and skips when webhook_secret is missing', async () => {
    mockTenantDb({ webhook_url: 'https://hook.example.com' });
    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't_1' }),
      'Webhook URL or secret not configured for metrics event',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Event filtering
// ---------------------------------------------------------------------------

describe('emitMetricsWebhook — event filtering', () => {
  test('filters out event not in webhook_events list', async () => {
    mockTenantDb({
      ...TENANT_SETTINGS_WITH_HOOK,
      webhook_events: ['invoice.approved'],
    });
    await emitMetricsWebhook({ tenantId: 't_1', event: 'metrics.snapshot', metrics: {} });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'metrics.snapshot' }),
      'Metrics webhook event filtered out by tenant settings',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('passes through when event matches exactly', async () => {
    mockTenantDb({
      ...TENANT_SETTINGS_WITH_HOOK,
      webhook_events: ['metrics.snapshot'],
    });
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await emitMetricsWebhook({ tenantId: 't_1', event: 'metrics.snapshot', metrics: { open: 5 } });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('passes through when webhook_events includes metrics.*', async () => {
    mockTenantDb({
      ...TENANT_SETTINGS_WITH_HOOK,
      webhook_events: ['metrics.*'],
    });
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await emitMetricsWebhook({ tenantId: 't_1', event: 'metrics.snapshot', metrics: {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('passes through when webhook_events includes *', async () => {
    mockTenantDb({
      ...TENANT_SETTINGS_WITH_HOOK,
      webhook_events: ['*'],
    });
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await emitMetricsWebhook({ tenantId: 't_1', event: 'metrics.snapshot', metrics: {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('passes through when webhook_events is absent', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Successful delivery
// ---------------------------------------------------------------------------

describe('emitMetricsWebhook — successful delivery', () => {
  test('calls fetch with POST and correct headers', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await emitMetricsWebhook({ tenantId: 't_1', metrics: { open: 3, funded: 1 } });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://subscriber.example.com/hook');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-Signature']).toBeDefined();
  });

  test('HMAC signature is valid and verifiable', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await emitMetricsWebhook({ tenantId: 't_1', metrics: { open: 3 } });

    const [, opts] = global.fetch.mock.calls[0];
    const { body, headers } = opts;
    const result = verifySignature(
      TENANT_SETTINGS_WITH_HOOK.webhook_secret,
      body,
      headers['X-Signature'],
    );
    expect(result.valid).toBe(true);
  });

  test('payload contains event, timestamp, tenantId, metrics, actor, truncated', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await emitMetricsWebhook({
      tenantId: 't_1',
      event: 'metrics.snapshot',
      metrics: { open: 2 },
      actor: 'cron',
    });

    const [, opts] = global.fetch.mock.calls[0];
    const parsed = JSON.parse(opts.body);
    expect(parsed.event).toBe('metrics.snapshot');
    expect(parsed.tenantId).toBe('t_1');
    expect(parsed.actor).toBe('cron');
    expect(parsed.metrics).toEqual({ open: 2 });
    expect(parsed.truncated).toBe(false);
    expect(typeof parsed.timestamp).toBe('string');
  });

  test('logs success info', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't_1', event: 'metrics.snapshot' }),
      'Metrics webhook emitted successfully',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Payload size bounding
// ---------------------------------------------------------------------------

describe('emitMetricsWebhook — payload size bounding', () => {
  test('oversized metrics payload is truncated and truncated:true is set', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    const oversizedMetrics = { data: 'x'.repeat(200 * 1024) }; // > 64 KB
    await emitMetricsWebhook({ tenantId: 't_1', metrics: oversizedMetrics });

    const [, opts] = global.fetch.mock.calls[0];
    const parsed = JSON.parse(opts.body);
    expect(parsed.truncated).toBe(true);
    expect(parsed.metrics._summary).toBeDefined();
    expect(Array.isArray(parsed.metrics.keys)).toBe(true);
  });

  test('non-oversized metrics payload is not truncated', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await emitMetricsWebhook({ tenantId: 't_1', metrics: { open: 1, funded: 0 } });

    const [, opts] = global.fetch.mock.calls[0];
    const parsed = JSON.parse(opts.body);
    expect(parsed.truncated).toBe(false);
    expect(parsed.metrics).toEqual({ funded: 0, open: 1 });
  });
});

// ---------------------------------------------------------------------------
// 5. Retry and dead-letter
// ---------------------------------------------------------------------------

describe('emitMetricsWebhook — retry and dead-letter', () => {
  test('retries on transient 5xx and succeeds', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't_1' }),
      'Metrics webhook emitted successfully',
    );
  });

  test('dead-letters after exhausting retries', async () => {
    process.env.WEBHOOK_MAX_RETRIES = '1';
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    // All attempts fail with 503
    global.fetch.mockResolvedValue({ ok: false, status: 503 });

    // Mock the dead-letter insert
    mockDeadLetterInsert();

    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't_1' }),
      'Failed to emit metrics webhook',
    );
  });

  test('dead-letter DB failure is swallowed — does not throw', async () => {
    process.env.WEBHOOK_MAX_RETRIES = '0';
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: false, status: 500 });

    // Dead-letter insert throws
    db.mockReturnValueOnce({
      insert: jest.fn().mockRejectedValue(new Error('DB down')),
    });

    await expect(
      emitMetricsWebhook({ tenantId: 't_1', metrics: {} }),
    ).resolves.not.toThrow();
  });

  test('non-retriable 4xx does not retry', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: false, status: 400 });
    mockDeadLetterInsert();

    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });

    // fetch called once (no retries for 4xx)
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Shared worker enqueue path
// ---------------------------------------------------------------------------

describe('emitMetricsWebhook — shared worker path', () => {
  test('enqueues via shared worker and skips direct fetch', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);

    const mockWorker = { enqueue: jest.fn().mockReturnValue('job_1') };
    setSharedWorker(mockWorker);

    await emitMetricsWebhook({ tenantId: 't_1', metrics: { open: 5 } });

    expect(mockWorker.enqueue).toHaveBeenCalledWith(
      'webhook_delivery',
      expect.objectContaining({ tenantId: 't_1', event: 'metrics.snapshot' }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't_1' }),
      'Metrics webhook enqueued via shared worker',
    );
  });

  test('falls back to direct delivery when worker enqueue throws', async () => {
    mockTenantDb(TENANT_SETTINGS_WITH_HOOK);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    const mockWorker = { enqueue: jest.fn().mockImplementation(() => { throw new Error('queue full'); }) };
    setSharedWorker(mockWorker);

    await emitMetricsWebhook({ tenantId: 't_1', metrics: {} });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'queue full' }),
      'Failed to enqueue metrics webhook, falling back to direct delivery',
    );
  });
});
