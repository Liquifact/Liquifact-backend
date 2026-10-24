'use strict';

/**
 * Retry and backoff tests for the delivery engine.
 *
 * Uses Jest fake timers and mocked fetch to control retry timing without
 * waiting for real delays.
 */

const webhookStore = require('../src/webhooks/store');
const { deliverToWebhook } = require('../src/webhooks/deliver');

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
});
