'use strict';

/**
 * Retry and backoff tests for the delivery engine.
 *
 * Uses Jest fake timers and mocked fetch to control retry timing without
 * waiting for real delays.
 */

const request = require('supertest');
const app = require('../src/app');
const webhookStore = require('../src/webhooks/store');
const { deliverToWebhook } = require('../src/webhooks/deliver');
const { verifySignature } = require('../src/webhooks/signature');

describe('delivery retries', () => {
  beforeEach(() => {
    webhookStore.reset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('500, 500, 200 → 3 attempts, status delivered', async () => {
    // Use store's createWebhook to get a proper record, then override the internal fetch
    const { createWebhook } = webhookStore;
    const created = createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    let callCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return { status: 500 };
      }
      return { status: 200 };
    });

    // Run delivery — advances fake timers for each retry delay
    const deliveryPromise = deliverToWebhook(internal, 'invoice.created', { id: 'INV_TEST' });

    // Drain timers for all retry delays (up to 5 attempts worth)
    // We need to advance past each setTimeout in the retry loop
    for (let i = 0; i < 10; i++) {
      await Promise.resolve(); // flush microtasks
      jest.runAllTimers();
    }

    await deliveryPromise;

    const log = webhookStore.getDeliveries(created.id);
    expect(log).toBeDefined();
    expect(log.length).toBeGreaterThan(0);

    const record = log[0];
    expect(record.attempts.length).toBe(3);
    expect(record.attempts[0].status).toBe(500);
    expect(record.attempts[1].status).toBe(500);
    expect(record.attempts[2].status).toBe(200);
    expect(record.status).toBe('delivered');
  });

  test('all 5 attempts fail → delivery status is failed', async () => {
    const { createWebhook } = webhookStore;
    const created = createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    jest.spyOn(global, 'fetch').mockResolvedValue({ status: 500 });

    const deliveryPromise = deliverToWebhook(internal, 'invoice.created', { id: 'INV_FAIL' });

    for (let i = 0; i < 15; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }

    await deliveryPromise;

    const log = webhookStore.getDeliveries(created.id);
    const record = log[0];
    expect(record.attempts.length).toBe(5);
    expect(record.status).toBe('failed');
  });

  test('network error (fetch throws) is recorded as attempt with error field', async () => {
    const { createWebhook } = webhookStore;
    const created = createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.funded'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const deliveryPromise = deliverToWebhook(internal, 'invoice.funded', { id: 'INV_NET' });

    for (let i = 0; i < 15; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }

    await deliveryPromise;

    const log = webhookStore.getDeliveries(created.id);
    const record = log[0];
    expect(record.attempts.length).toBe(5);
    expect(record.attempts[0].error).toMatch(/ECONNREFUSED/);
    expect(record.status).toBe('failed');
  });

  test('410 permanent: exactly one attempt, reason permanent_4xx', async () => {
    const created = webhookStore.createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 410,
      headers: { get: () => null },
    });

    const deliveryPromise = deliverToWebhook(internal, 'invoice.created', { id: 'INV_410' });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }
    await deliveryPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const record = webhookStore.getDeliveries(created.id)[0];
    expect(record.status).toBe('failed');
    expect(record.reason).toBe('permanent_4xx');
    expect(record.attempts.length).toBe(1);
  });

  test('400 permanent: exactly one attempt (client error, not retryable)', async () => {
    const created = webhookStore.createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 400,
      headers: { get: () => null },
    });

    const deliveryPromise = deliverToWebhook(internal, 'invoice.created', { id: 'INV_400' });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }
    await deliveryPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(webhookStore.getDeliveries(created.id)[0].reason).toBe('permanent_4xx');
  });

  test('429 with Retry-After: 2 waits ~2s before retrying', async () => {
    const created = webhookStore.createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    let calls = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return { status: 429, headers: { get: (h) => (h === 'retry-after' ? '2' : null) } };
      }
      return { status: 200, headers: { get: () => null } };
    });

    const deliveryPromise = deliverToWebhook(internal, 'invoice.created', { id: 'INV_429' });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Not yet: needs ~2000ms (with up to 25% jitter, so advance generously but less than jitter could stretch past 2000+500)
    jest.advanceTimersByTime(1900);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now it should fire (2500 covers jitter up to +25% of 2000)
    jest.advanceTimersByTime(700);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }
    await deliveryPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(webhookStore.getDeliveries(created.id)[0].status).toBe('delivered');
  });

  test('Retry-After HTTP-date is honored', async () => {
    const created = webhookStore.createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    let calls = 0;
    const dateInTwoSecs = new Date(Date.now() + 2000).toUTCString();
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return { status: 503, headers: { get: (h) => (h === 'retry-after' ? dateInTwoSecs : null) } };
      }
      return { status: 200, headers: { get: () => null } };
    });

    const deliveryPromise = deliverToWebhook(internal, 'invoice.created', { id: 'INV_DATE' });
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    // Still within the Retry-After window (2s), so still 1 attempt.
    expect(calls).toBe(1);

    jest.advanceTimersByTime(2000);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }
    await deliveryPromise;
    expect(calls).toBe(2);
  });
});

describe('manual webhook delivery replay', () => {
  const ADMIN_TOKEN = 'test-admin-token-webhook-replay';
  let originalAdminToken;

  beforeAll(() => {
    originalAdminToken = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  });

  afterAll(() => {
    process.env.ADMIN_API_TOKEN = originalAdminToken;
  });

  beforeEach(() => {
    webhookStore.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('POST /api/webhooks/:id/deliveries/:deliveryId/replay returns 202, preserves eventId, and re-signs with a fresh timestamp', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const created = webhookStore.createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });
    const internal = webhookStore.getWebhookInternal(created.id);

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 500 });

    const deliveryPromise = deliverToWebhook(internal, 'invoice.created', { id: 'INV_REPLAY' });
    for (let i = 0; i < 15; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }
    await deliveryPromise;

    const originalRecord = webhookStore.getDeliveries(created.id)[0];
    expect(originalRecord.status).toBe('failed');
    const originalSig = fetchMock.mock.calls[0][1].headers['LiquiFact-Signature'];
    const originalTs = parseInt(originalSig.split(',')[0].split('=')[1], 10);

    // Advance wall-clock time so the replay must produce a fresh signature timestamp
    jest.useRealTimers();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:10:00.000Z').getTime());

    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ status: 200 });

    const res = await request(app)
      .post(`/api/webhooks/${created.id}/deliveries/${originalRecord.deliveryId}/replay`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(202);
    expect(res.body.data.deliveryId).toMatch(/^dlv_/);
    expect(res.body.data.deliveryId).not.toBe(originalRecord.deliveryId);
    expect(res.body.data.eventId).toBe(originalRecord.eventId);
    expect(res.body.data.replayedFrom).toBe(originalRecord.deliveryId);

    // Allow async replay delivery to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['LiquiFact-Event-Id']).toBe(originalRecord.eventId);
    expect(init.body).toBe(originalRecord.rawBody);

    const replaySig = init.headers['LiquiFact-Signature'];
    const replayTs = parseInt(replaySig.split(',')[0].split('=')[1], 10);
    expect(replayTs).toBeGreaterThan(originalTs);
    expect(verifySignature(created.secret, replaySig, init.body)).toEqual({ ok: true });

    const deliveries = webhookStore.getDeliveries(created.id);
    expect(deliveries.length).toBe(2);
    expect(deliveries[0].deliveryId).toBe(res.body.data.deliveryId);
    expect(deliveries[0].eventId).toBe(originalRecord.eventId);
    expect(deliveries[0].status).toBe('delivered');

    nowSpy.mockRestore();
  });

  test('returns 404 for unknown webhook id or unknown delivery id', async () => {
    const created = webhookStore.createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });

    const unknownWh = await request(app)
      .post('/api/webhooks/wh_does_not_exist/deliveries/dlv_missing/replay')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(unknownWh.status).toBe(404);

    const unknownDelivery = await request(app)
      .post(`/api/webhooks/${created.id}/deliveries/dlv_does_not_exist/replay`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(unknownDelivery.status).toBe(404);
  });

  test('returns 409 while the original delivery is still pending', async () => {
    const created = webhookStore.createWebhook({
      url: 'https://example.com/hook',
      pinnedUrl: 'https://93.184.216.34/hook',
      host: 'example.com',
      events: ['invoice.created'],
    });

    const pendingRecord = {
      deliveryId: 'dlv_pending123456',
      eventId: 'evt_pending12345678',
      eventType: 'invoice.created',
      webhookId: created.id,
      url: created.url,
      attempts: [],
      status: 'pending',
      rawBody: JSON.stringify({ id: 'evt_pending12345678', type: 'invoice.created', data: { invoice: { id: 'INV_1' } } }),
      createdAt: new Date().toISOString(),
    };
    webhookStore.appendDelivery(created.id, pendingRecord);

    const res = await request(app)
      .post(`/api/webhooks/${created.id}/deliveries/${pendingRecord.deliveryId}/replay`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending/i);
  });
});