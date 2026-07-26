'use strict';

/**
 * Tests for the KYC webhook feature flag (KYC_WEBHOOK_ENABLED).
 *
 * Covers:
 *  1. Flag OFF (default) — POST /api/kyc/webhook returns 503
 *  2. Flag ON            — endpoint is active and processes valid payloads
 *  3. Flag ON            — existing security checks still enforced (sig, fields)
 *  4. isKycWebhookEnabled() helper — unit coverage for all env values
 */

jest.mock('../src/db/knex');

const request = require('supertest');
const express = require('express');
const db = require('../src/db/knex');
const { createSignatureHeader } = require('../src/services/webhooks');
const kycRoutes = require('../src/routes/kyc');
const { isKycWebhookEnabled } = require('../src/routes/kyc');

// ── app factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  // The route expects a raw Buffer body for signature verification
  app.use(express.raw({ type: 'application/json', limit: '100kb' }));
  app.use('/api/kyc', kycRoutes);
  return app;
}

// ── env helpers ───────────────────────────────────────────────────────────────

function enableFlag() { process.env.KYC_WEBHOOK_ENABLED = 'true'; }
function disableFlag() { process.env.KYC_WEBHOOK_ENABLED = 'false'; }
function clearFlag()  { delete process.env.KYC_WEBHOOK_ENABLED; }

beforeEach(() => {
  jest.clearAllMocks();
  clearFlag();
  delete process.env.KYC_PROVIDER_SECRET;
});

afterEach(() => {
  clearFlag();
  delete process.env.KYC_PROVIDER_SECRET;
});

// ── 1. Flag OFF (default) — endpoint must return 503 ─────────────────────────

describe('KYC_WEBHOOK_ENABLED = false (default)', () => {
  it('returns 503 when flag is absent (safe default)', async () => {
    // Flag not set at all — must default to disabled
    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ smeId: 'sme-x', status: 'approved' }));

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it('returns 503 when KYC_WEBHOOK_ENABLED is explicitly "false"', async () => {
    disableFlag();

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ smeId: 'sme-x', status: 'approved' }));

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it('returns 503 for any non-"true" value of the flag', async () => {
    for (const val of ['0', 'yes', 'TRUE', '1', 'enabled']) {
      process.env.KYC_WEBHOOK_ENABLED = val;

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ smeId: 'sme-x', status: 'approved' }));

      expect(res.status).toBe(503);
    }
  });

  it('does not touch the database when flag is off', async () => {
    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ smeId: 'sme-db-check', status: 'approved' }));

    expect(res.status).toBe(503);
    expect(db).not.toHaveBeenCalled();
  });
});

// ── 2. Flag ON — endpoint processes valid payloads ───────────────────────────

describe('KYC_WEBHOOK_ENABLED = true', () => {
  beforeEach(() => {
    enableFlag();
    process.env.KYC_PROVIDER_SECRET = 'test-secret';
  });

  it('returns 200 and persists record for a valid signed payload', async () => {
    const payload = {
      smeId: 'sme-flag-on-01',
      status: 'approved',
      recordId: 'rec_001',
      verifiedAt: '2026-06-25T10:00:00.000Z',
    };
    const rawBody = JSON.stringify(payload);
    const sig = createSignatureHeader('test-secret', rawBody);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('verified');
    expect(res.body.smeId).toBe('sme-flag-on-01');
  });

  it('persists the KYC record to the database', async () => {
    const payload = { smeId: 'sme-flag-on-02', status: 'verified' };
    const rawBody = JSON.stringify(payload);
    const sig = createSignatureHeader('test-secret', rawBody);

    const insert = jest.fn().mockResolvedValue([1]);
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert,
      update: jest.fn().mockResolvedValue(1),
    }));

    await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(rawBody);

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ sme_id: 'sme-flag-on-02', status: 'verified' })
    );
  });

  it('updates an existing record on repeated delivery (idempotent)', async () => {
    const payload = {
      smeId: 'sme-flag-on-03',
      status: 'approved',
      recordId: 'rec_003',
    };
    const rawBody = JSON.stringify(payload);
    const sig = createSignatureHeader('test-secret', rawBody);

    const update = jest.fn().mockResolvedValue(1);
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ sme_id: 'sme-flag-on-03' }),
      insert: jest.fn(),
      update,
    }));

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});

// ── 3. Flag ON — security checks still enforced ──────────────────────────────

describe('KYC_WEBHOOK_ENABLED = true — security still enforced', () => {
  beforeEach(() => {
    enableFlag();
    process.env.KYC_PROVIDER_SECRET = 'test-secret';
  });

  it('returns 401 when X-Signature header is missing', async () => {
    const rawBody = JSON.stringify({ smeId: 'sme-nosig', status: 'approved' });

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing X-Signature/);
  });

  it('returns 401 when signature is invalid', async () => {
    const rawBody = JSON.stringify({ smeId: 'sme-badsig', status: 'approved' });

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 't=0,v1=deadbeef')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid webhook signature/);
  });

  it('returns 503 when secret is not configured even with flag on', async () => {
    delete process.env.KYC_PROVIDER_SECRET;

    const rawBody = JSON.stringify({ smeId: 'sme-nosecret', status: 'approved' });

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/);
  });

  it('returns 400 for missing smeId', async () => {
    const rawBody = JSON.stringify({ status: 'approved' });
    const sig = createSignatureHeader('test-secret', rawBody);

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/smeId/);
  });

  it('returns 400 for unknown provider status', async () => {
    const rawBody = JSON.stringify({ smeId: 'sme-badstatus', status: 'unknown_xyz' });
    const sig = createSignatureHeader('test-secret', rawBody);

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown provider status/);
  });

  it('returns 400 for missing status field', async () => {
    const rawBody = JSON.stringify({ smeId: 'sme-nostatus' });
    const sig = createSignatureHeader('test-secret', rawBody);

    const res = await request(buildApp())
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(rawBody);

    expect(res.status).toBe(400);
  });
});

// ── 4. isKycWebhookEnabled() unit tests ──────────────────────────────────────

describe('isKycWebhookEnabled()', () => {
  it('returns false when env var is absent', () => {
    clearFlag();
    expect(isKycWebhookEnabled()).toBe(false);
  });

  it('returns false when set to "false"', () => {
    disableFlag();
    expect(isKycWebhookEnabled()).toBe(false);
  });

  it('returns true only when set to exactly "true"', () => {
    enableFlag();
    expect(isKycWebhookEnabled()).toBe(true);
  });

  it('returns false for any truthy-looking but non-"true" string', () => {
    for (const val of ['TRUE', 'True', '1', 'yes', 'on', 'enabled']) {
      process.env.KYC_WEBHOOK_ENABLED = val;
      expect(isKycWebhookEnabled()).toBe(false);
    }
  });
});
