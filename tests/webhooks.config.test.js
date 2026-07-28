'use strict';

/**
 * @fileoverview Comprehensive unit and integration tests for outbound config
 * event webhooks (`config.updated`), HMAC signing, delivery, retry/backoff,
 * dead-letter queue (DLQ), and payload size bounding.
 */

process.env.NODE_ENV = 'test';

// ── Module mocks ─────────────────────────────────────────────────────────────

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


jest.mock('../src/metrics', () => {
  const actual = jest.requireActual('../src/metrics');
  return {
    ...actual,
    webhookReplayTotal: { inc: jest.fn() },
  };
});



// ── Imports ──────────────────────────────────────────────────────────────────

const db = require('../src/db/knex');
const logger = require('../src/logger');
const {
  emitConfigWebhook,
  verifySignature,
  createSignatureHeader,
  setSharedWorker,
  MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES,
} = require('../src/services/webhooks');

// Save global fetch
const originalFetch = global.fetch;

describe('Outbound Config Event Webhooks (Issue #975)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setSharedWorker(null);
    global.fetch = jest.fn();
    process.env.WEBHOOK_BASE_DELAY = '0';
    process.env.WEBHOOK_MAX_DELAY = '0';
    process.env.WEBHOOK_MAX_RETRIES = '2';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.WEBHOOK_BASE_DELAY;
    delete process.env.WEBHOOK_MAX_DELAY;
    delete process.env.WEBHOOK_MAX_RETRIES;
  });

  // ── 1. Guards & Configuration Requirements ────────────────────────────────

  describe('guards and configuration requirements', () => {
    it('warns and exits if tenantId is missing', async () => {
      await emitConfigWebhook({ tenantId: null, section: 'cors', config: { origins: ['https://example.com'] } });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ section: 'cors' }),
        'Tenant ID missing for config webhook emission'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('logs info and exits if tenant settings do not exist in DB', async () => {
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
      });

      await emitConfigWebhook({ tenantId: 't_missing', section: 'cors', config: { origins: ['https://example.com'] } });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't_missing', section: 'cors' }),
        'Tenant settings not found for config webhook'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('logs info and exits if webhook_url is missing', async () => {
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ settings: { webhook_secret: 'sec_123' } }),
      });

      await emitConfigWebhook({ tenantId: 't_1', section: 'cors', config: { origins: ['https://example.com'] } });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't_1', section: 'cors' }),
        'Webhook URL or secret not configured for config event'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('logs info and exits if webhook_secret is missing', async () => {
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ settings: { webhook_url: 'https://subscriber.example.com/hook' } }),
      });

      await emitConfigWebhook({ tenantId: 't_1', section: 'cors', config: { origins: ['https://example.com'] } });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't_1', section: 'cors' }),
        'Webhook URL or secret not configured for config event'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('filters out event if webhook_events array excludes config.updated', async () => {
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: 'https://subscriber.example.com/hook',
            webhook_secret: 'sec_1234567890123456',
            webhook_events: ['escrow_funded'],
          },
        }),
      });

      await emitConfigWebhook({ tenantId: 't_1', section: 'cors', config: { origins: ['https://example.com'] } });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't_1', section: 'cors', event: 'config.updated' }),
        'Config webhook event filtered out by tenant settings'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ── 2. Signature Verification & Event Delivery ─────────────────────────────

  describe('delivery & signature verification', () => {
    it('delivers signed HTTP POST payload on config update', async () => {
      const secret = 'super_secret_signing_key_12345';
      const webhookUrl = 'https://subscriber.example.com/webhook';

      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: webhookUrl,
            webhook_secret: secret,
          },
        }),
      });

      global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

      await emitConfigWebhook({
        tenantId: 'tenant_test_1',
        section: 'cors',
        config: { origins: ['https://app.example.com'], maxAge: 3600 },
        actor: 'usr_admin',
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [urlArg, optionsArg] = global.fetch.mock.calls[0];

      expect(urlArg).toBe(webhookUrl);
      expect(optionsArg.method).toBe('POST');
      expect(optionsArg.headers['Content-Type']).toBe('application/json');
      expect(optionsArg.headers['X-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

      // Verify body shape and signature
      const bodyString = optionsArg.body;
      const parsedBody = JSON.parse(bodyString);

      expect(parsedBody).toMatchObject({
        event: 'config.updated',
        tenantId: 'tenant_test_1',
        section: 'cors',
        config: { origins: ['https://app.example.com'], maxAge: 3600 },
        actor: 'usr_admin',
        truncated: false,
      });

      // Verify HMAC signature passes validation
      const sigResult = verifySignature(secret, bodyString, optionsArg.headers['X-Signature']);
      expect(sigResult.valid).toBe(true);
      expect(sigResult.error).toBeNull();
    });
  });

  // ── 3. Payload Size Bounding ──────────────────────────────────────────────

  describe('payload size bounding', () => {
    it('truncates oversized config payloads exceeding max bytes', async () => {
      const secret = 'super_secret_signing_key_12345';
      const webhookUrl = 'https://subscriber.example.com/webhook';

      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: webhookUrl,
            webhook_secret: secret,
          },
        }),
      });

      global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

      // Generate oversized config exceeding MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES
      const hugeData = 'x'.repeat(MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES + 100);
      const hugeConfig = { hugeField: hugeData, normalField: 'test' };

      await emitConfigWebhook({
        tenantId: 'tenant_test_1',
        section: 'hugeSection',
        config: hugeConfig,
        actor: 'usr_admin',
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [, optionsArg] = global.fetch.mock.calls[0];
      const parsedBody = JSON.parse(optionsArg.body);

      expect(parsedBody.truncated).toBe(true);
      expect(parsedBody.config).toEqual({
        _summary: 'Config payload exceeded maximum size limit',
        keys: ['hugeField', 'normalField'],
      });

      // Signature on truncated payload must remain valid
      const sigResult = verifySignature(secret, optionsArg.body, optionsArg.headers['X-Signature']);
      expect(sigResult.valid).toBe(true);
    });
  });

  // ── 4. Retry & Backoff ────────────────────────────────────────────────────

  describe('retry and backoff', () => {
    it('retries on 500 error then succeeds on second try', async () => {
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: 'https://subscriber.example.com/webhook',
            webhook_secret: 'secret_123456789012345',
          },
        }),
      });

      global.fetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      await emitConfigWebhook({
        tenantId: 't_retry',
        section: 'retention',
        config: { retentionDays: 90 },
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'config.updated', section: 'retention' }),
        'Config event webhook emitted successfully'
      );
    });
  });

  // ── 5. Dead-Letter Queue (DLQ) ────────────────────────────────────────────

  describe('dead-letter queue (DLQ) on retry exhaustion', () => {
    it('writes row to webhook_dead_letters after retries are exhausted', async () => {
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: 'https://subscriber.example.com/webhook',
            webhook_secret: 'secret_123456789012345',
          },
        }),
      });

      const insertMock = jest.fn().mockResolvedValue([1]);
      db.mockReturnValueOnce({ insert: insertMock });

      global.fetch.mockResolvedValue({ ok: false, status: 502 });

      await emitConfigWebhook({
        tenantId: 't_dlq',
        section: 'kyc',
        config: { timeoutMs: 5000 },
      });

      expect(global.fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(db).toHaveBeenCalledWith('webhook_dead_letters');
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 't_dlq',
          invoice_id: null,
          event: 'config.updated',
          webhook_url: 'https://subscriber.example.com/webhook',
          attempts: 3,
        })
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'config.updated', section: 'kyc' }),
        'Failed to emit config event webhook'
      );
    });

    it('handles DB error gracefully during DLQ write', async () => {
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: 'https://subscriber.example.com/webhook',
            webhook_secret: 'secret_123456789012345',
          },
        }),
      });

      db.mockReturnValueOnce({ insert: jest.fn().mockRejectedValue(new Error('DB crash')) });
      global.fetch.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));

      await expect(
        emitConfigWebhook({
          tenantId: 't_dlq',
          section: 'cors',
          config: { origins: ['https://example.com'] },
        })
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'DB crash' }),
        'Failed to persist config webhook dead-letter'
      );
    });
  });

  // ── 6. BackgroundWorker Integration ──────────────────────────────────────

  describe('BackgroundWorker integration', () => {
    it('enqueues job on shared worker if configured', async () => {
      const mockWorker = { enqueue: jest.fn().mockReturnValue('job_123') };
      setSharedWorker(mockWorker);

      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: 'https://subscriber.example.com/webhook',
            webhook_secret: 'secret_123456789012345',
          },
        }),
      });

      await emitConfigWebhook({
        tenantId: 't_worker',
        section: 'cors',
        config: { origins: ['https://app.com'] },
        actor: 'usr_admin',
      });

      expect(mockWorker.enqueue).toHaveBeenCalledWith(
        'webhook_delivery',
        expect.objectContaining({
          tenantId: 't_worker',
          event: 'config.updated',
          section: 'cors',
          actor: 'usr_admin',
        })
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
