'use strict';

/**
 * Regression tests for issue #729 — rate limiting on the kyc-webhooks
 * endpoints. Uses a tiny window/max (set via env before requiring the
 * module, since limits are read at module-load time) so at-limit,
 * over-limit, and window-reset behaviour can be verified quickly.
 */

const express = require('express');
const request = require('supertest');

// This module is globally stubbed in tests/mocks/setup.js (no-op middleware,
// missing kycWebhookLimiter). Use the real implementation for these tests.
jest.unmock('../src/middleware/rateLimit');

const WINDOW_MS = 200;
const MAX = 2;

describe('kyc-webhooks rate limiting (#729)', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    process.env.KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);
    process.env.KYC_WEBHOOK_RATE_LIMIT_MAX = String(MAX);

    // Build a minimal app around just the kyc router, avoiding the full
    // app.js dependency chain (DB, other routers).
    const kycRoutes = require('../src/routes/kyc');
    app = express();
    app.use(express.json());
    app.use('/api/kyc', kycRoutes);
  });

  afterEach(() => {
    delete process.env.KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS;
    delete process.env.KYC_WEBHOOK_RATE_LIMIT_MAX;
  });

  const body = { event: 'verification.completed', subjectId: 'test-subject' };

  it('allows requests up to the configured max (at-limit)', async () => {
    for (let i = 0; i < MAX; i++) {
      const res = await request(app).post('/api/kyc/webhook').send(body);
      expect(res.status).not.toBe(429);
    }
  });

  it('returns 429 with a Retry-After header once the max is exceeded', async () => {
    for (let i = 0; i < MAX; i++) {
      await request(app).post('/api/kyc/webhook').send(body);
    }
    const res = await request(app).post('/api/kyc/webhook').send(body);
    expect(res.status).toBe(429);
    expect(res.headers).toHaveProperty('retry-after');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(0);
  });

  it('returns a config-driven problem+json body scoped to kyc-webhooks', async () => {
    for (let i = 0; i < MAX; i++) {
      await request(app).post('/api/kyc/webhook').send(body);
    }
    const res = await request(app).post('/api/kyc/webhook').send(body);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: 'RATE_LIMITED',
      scope: 'kyc-webhooks',
      retryable: true,
    });
  });

  it('resets the count after the configured window elapses', async () => {
    for (let i = 0; i < MAX; i++) {
      await request(app).post('/api/kyc/webhook').send(body);
    }
    const blocked = await request(app).post('/api/kyc/webhook').send(body);
    expect(blocked.status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 100));

    const afterReset = await request(app).post('/api/kyc/webhook').send(body);
    expect(afterReset.status).not.toBe(429);
  });

  it('rate-limits per client key (API key) independently of other clients', async () => {
    for (let i = 0; i < MAX; i++) {
      await request(app)
        .post('/api/kyc/webhook')
        .set('x-api-key', 'client-a')
        .send(body);
    }
    const blockedA = await request(app)
      .post('/api/kyc/webhook')
      .set('x-api-key', 'client-a')
      .send(body);
    expect(blockedA.status).toBe(429);

    // A different API key must not be affected by client-a's usage.
    const clientB = await request(app)
      .post('/api/kyc/webhook')
      .set('x-api-key', 'client-b')
      .send(body);
    expect(clientB.status).not.toBe(429);
  });

  it('falls back to per-IP limiting when no API key is present', async () => {
    for (let i = 0; i < MAX; i++) {
      await request(app).post('/api/kyc/webhook').send(body);
    }
    const blocked = await request(app).post('/api/kyc/webhook').send(body);
    expect(blocked.status).toBe(429);
  });

  it('is config-driven: a different env value changes the effective max', async () => {
    jest.resetModules();
    process.env.KYC_WEBHOOK_RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);
    process.env.KYC_WEBHOOK_RATE_LIMIT_MAX = '1';
    const routesWithMaxOne = require('../src/routes/kyc');
    const smallApp = express();
    smallApp.use(express.json());
    smallApp.use('/api/kyc', routesWithMaxOne);

    const first = await request(smallApp).post('/api/kyc/webhook').send(body);
    expect(first.status).not.toBe(429);
    const second = await request(smallApp).post('/api/kyc/webhook').send(body);
    expect(second.status).toBe(429);
  });
});
