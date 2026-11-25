'use strict';

const http = require('http');
const express = require('express');
const request = require('supertest');
const config = require('../src/config');
const webhookStore = require('../src/webhooks/store');
const { dispatch, deliverToWebhook, drain } = require('../src/webhooks/deliver');
const webhooksRouter = require('../src/routes/webhooks');

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhooksRouter);

describe('webhook circuit breaker', () => {
  let receiver;
  let statusCode;
  let received;
  let originalThreshold;
  let originalCooldown;
  let originalAdminToken;

  beforeEach(async () => {
    webhookStore.reset();
    statusCode = 410;
    received = 0;
    originalThreshold = config.webhookFailureThreshold;
    originalCooldown = config.webhookCooldownMs;
    originalAdminToken = process.env.ADMIN_API_TOKEN;
    receiver = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received += 1;
        res.writeHead(statusCode).end();
      });
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    config.webhookFailureThreshold = originalThreshold;
    config.webhookCooldownMs = originalCooldown;
    if (originalAdminToken === undefined) {
      delete process.env.ADMIN_API_TOKEN;
    } else {
      process.env.ADMIN_API_TOKEN = originalAdminToken;
    }
    await drain(3000);
    await new Promise((resolve) => receiver.close(resolve));
  });

  function createWebhook() {
    const url = `http://127.0.0.1:${receiver.address().port}/hook`;
    const created = webhookStore.createWebhook({
      url,
      pinnedUrl: url,
      host: `127.0.0.1:${receiver.address().port}`,
      events: ['invoice.created'],
    });
    return webhookStore.getWebhookInternal(created.id);
  }

  test('disables after the configured number of failed deliveries', async () => {
    config.webhookFailureThreshold = 2;
    const webhook = createWebhook();

    await deliverToWebhook(webhook, 'invoice.created', { id: 'INV_1' });
    await deliverToWebhook(webhook, 'invoice.created', { id: 'INV_2' });

    const view = webhookStore.getWebhook(webhook.id);
    expect(view.status).toBe('disabled');
    expect(view.consecutiveFailures).toBe(2);
    expect(view.disabledAt).toEqual(expect.any(String));
    expect(view.disabledReason).toBe('consecutive_failures');
  });

  test('does not dispatch new events to a disabled webhook', async () => {
    const webhook = createWebhook();
    webhookStore.recordDeliveryResult(webhook.id, false, 1);

    dispatch('invoice.created', { id: 'INV_SKIP' });
    await drain(3000);

    expect(received).toBe(0);
    expect(webhookStore.getWebhook(webhook.id).status).toBe('disabled');
  });

  test('admin enable resets breaker state', async () => {
    process.env.ADMIN_API_TOKEN = 'breaker-admin-token';
    const webhook = createWebhook();
    webhookStore.recordDeliveryResult(webhook.id, false, 1);

    const response = await request(app)
      .post(`/api/webhooks/${webhook.id}/enable`)
      .set('Authorization', 'Bearer breaker-admin-token');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('enabled');
    expect(response.body.data.consecutiveFailures).toBe(0);
    expect(response.body.data.disabledAt).toBeNull();
    expect(response.body.data.disabledReason).toBeNull();

    const listResponse = await request(app)
      .get('/api/webhooks')
      .set('Authorization', 'Bearer breaker-admin-token');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data[0]).toMatchObject({
      status: 'enabled',
      consecutiveFailures: 0,
    });
  });

  test('allows one half-open probe after cooldown and recovers on success', async () => {
    config.webhookCooldownMs = 0;
    const webhook = createWebhook();
    webhookStore.recordDeliveryResult(webhook.id, false, 1);
    statusCode = 204;

    dispatch('invoice.created', { id: 'INV_PROBE' });
    dispatch('invoice.created', { id: 'INV_DUPLICATE_PROBE' });
    await drain(3000);
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toBe(1);
    expect(webhookStore.getWebhook(webhook.id)).toMatchObject({
      status: 'enabled',
      consecutiveFailures: 0,
      disabledAt: null,
      disabledReason: null,
    });
  });
});
