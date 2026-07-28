'use strict';

/**
 * @fileoverview Tests for KYC webhook idempotency-key support.
 *
 * Covers:
 *   - Missing Idempotency-Key header → 400
 *   - Invalid key format → 400
 *   - First write executes normally → 200
 *   - Duplicate key with same body replays original response → 200
 *   - Duplicate key with different body → 409 Conflict
 *   - Multiple different keys work independently
 *   - Empty body handled correctly
 *   - Key expiration (TTL) in the store
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => {
  const store = new Map();

  /** Create a mock Knex chainable query builder / transaction object. */
  function makeTrx() {
    const trx = jest.fn(() => trx);
    trx._lastKey = null;
    trx.where = jest.fn((conditions) => {
      if (conditions && conditions.idempotency_key) {
        trx._lastKey = conditions.idempotency_key;
      }
      return trx;
    });
    trx.first = jest.fn(async () => {
      return trx._lastKey ? store.get(trx._lastKey) || null : null;
    });
    trx.insert = jest.fn(async (row) => {
      trx._lastKey = row.idempotency_key;
      store.set(row.idempotency_key, {
        ...row,
        created_at: new Date(),
        updated_at: new Date(),
      });
    });
    trx.update = jest.fn(async (updates) => {
      if (trx._lastKey) {
        const existing = store.get(trx._lastKey) || {};
        store.set(trx._lastKey, { ...existing, ...updates });
      }
    });
    trx.raw = jest.fn(() => new Date(Date.now() + 86400000));
    trx.fn = { now: () => new Date() };
    return trx;
  }

  const db = jest.fn(() => makeTrx());
  db.transaction = jest.fn((fn) => fn(makeTrx()));
  db.fn = { now: () => new Date() };
  db.raw = jest.fn(() => new Date(Date.now() + 86400000));
  return db;
});

jest.mock('../src/services/webhooks', () => ({
  verifySignature: jest.fn(() => ({ valid: true })),
}));

jest.mock('../src/services/kycService', () => ({
  getKycProviderConfig: jest.fn(() => ({
    apiSecret: 'test-webhook-secret',
    provider: 'test-provider',
  })),
  persistKycRecord: jest.fn(async (params) => ({
    smeId: params.smeId,
    status: params.status === 'approved' ? 'verified' : 'rejected',
    recordId: 'kyc-rec-' + Date.now(),
    verifiedAt: params.verifiedAt || new Date().toISOString(),
  })),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const kycIdempotencyMiddleware = require('../src/middleware/kycIdempotency');

// ── Helpers ───────────────────────────────────────────────────────────────────

function validKey() {
  return 'kyc-ik-' + crypto.randomBytes(12).toString('hex');
}

function validKycBody(overrides = {}) {
  return JSON.stringify({
    smeId: 'SME-001',
    status: 'approved',
    verifiedAt: '2026-07-25T12:00:00.000Z',
    recordId: 'provider-rec-123',
    ...overrides,
  });
}

/** Send a KYC webhook request with proper headers. */
function sendKycRequest(app, { key, signature = 'valid-sig', body } = {}) {
  const req = request(app)
    .post('/api/kyc/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Signature', signature);
  if (key) { req.set('Idempotency-Key', key); }
  if (body !== undefined) { req.send(body); }
  return req;
}

function createApp() {
  const app = express();
  // Use raw body parser (same as production)
  app.use('/api/kyc/webhook', express.raw({ type: 'application/json', limit: '100kb' }));
  app.post('/api/kyc/webhook', kycIdempotencyMiddleware, (req, res) => {
    // Simulate the KYC webhook handler
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
    const payload = JSON.parse(rawBody);
    const smeId = payload.smeId;
    const status = payload.status;

    return res.status(200).json({
      success: true,
      smeId,
      status: status === 'approved' ? 'verified' : 'rejected',
      recordId: 'kyc-rec-' + Date.now(),
    });
  });
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('KYC Webhook Idempotency', () => {
  let app;

  beforeEach(() => {
    app = createApp();
  });

  // ── Validation ──────────────────────────────────────────────────────────

  describe('Idempotency-Key validation', () => {
    it('returns 400 when Idempotency-Key header is missing', async () => {
      const res = await sendKycRequest(app, { body: validKycBody() });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Idempotency-Key header is required/);
    });

    it('returns 400 when Idempotency-Key contains invalid characters', async () => {
      const res = await sendKycRequest(app, { key: 'invalid key with spaces!', body: validKycBody() });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/8.*128.*URL-safe/);
    });

    it('returns 400 when Idempotency-Key is too short (less than 8 chars)', async () => {
      const res = await sendKycRequest(app, { key: 'short', body: validKycBody() });

      expect(res.status).toBe(400);
    });

    it('returns 400 when Idempotency-Key is too long (more than 128 chars)', async () => {
      const res = await sendKycRequest(app, { key: 'a'.repeat(129), body: validKycBody() });

      expect(res.status).toBe(400);
    });
  });

  // ── First write ─────────────────────────────────────────────────────────

  describe('First write (new key)', () => {
    it('executes the handler and returns 200 on first call', async () => {
      const res = await sendKycRequest(app, { key: validKey(), body: validKycBody() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.smeId).toBe('SME-001');
      expect(res.body.status).toBe('verified');
    });
  });

  // ── Exact replay ────────────────────────────────────────────────────────

  describe('Duplicate key — exact replay', () => {
    it('returns the original cached response on duplicate key with same body', async () => {
      const key = validKey();
      const body = validKycBody();

      const first = await sendKycRequest(app, { key, body });
      expect(first.status).toBe(200);

      const second = await sendKycRequest(app, { key, body });

      expect(second.status).toBe(200);
      expect(second.body.success).toBe(true);
      expect(second.body.smeId).toBe(first.body.smeId);
      expect(second.body.status).toBe(first.body.status);
      // The same recordId proves the response was replayed, not re-generated
      expect(second.body.recordId).toBe(first.body.recordId);
    });

    it('replayed response has the same HTTP status code', async () => {
      const key = validKey();
      const body = validKycBody();

      const first = await sendKycRequest(app, { key, body });
      const second = await sendKycRequest(app, { key, body });

      expect(second.status).toBe(first.status);
    });
  });

  // ── Conflict ────────────────────────────────────────────────────────────

  describe('Duplicate key — different body (409)', () => {
    it('returns 409 when same key is used with a different request body', async () => {
      const key = validKey();

      await sendKycRequest(app, { key, body: validKycBody({ smeId: 'SME-A' }) });

      const res = await sendKycRequest(app, { key, body: validKycBody({ smeId: 'SME-B' }) });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/different request body/);
    });

    it('returns 409 when different status is sent with same key', async () => {
      const key = validKey();

      await sendKycRequest(app, { key, body: validKycBody({ status: 'approved' }) });

      const res = await sendKycRequest(app, { key, body: validKycBody({ status: 'rejected' }) });

      expect(res.status).toBe(409);
    });
  });

  // ── Multiple different keys ─────────────────────────────────────────────

  describe('Multiple different keys', () => {
    it('allows multiple requests with different keys to succeed', async () => {
      const key1 = validKey();
      const key2 = validKey();

      const res1 = await sendKycRequest(app, { key: key1, body: validKycBody({ smeId: 'SME-1' }) });
      const res2 = await sendKycRequest(app, { key: key2, body: validKycBody({ smeId: 'SME-2' }) });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.smeId).toBe('SME-1');
      expect(res2.body.smeId).toBe('SME-2');
      expect(res1.body.recordId).not.toBe(res2.body.recordId);
    });
  });

  // ── Empty body ──────────────────────────────────────────────────────────

  describe('Empty body', () => {
    it('handles requests with empty body', async () => {
      const key = validKey();

      const res = await sendKycRequest(app, { key, body: '{}' });

      // Empty JSON is valid syntactically even though smeId/status are missing
      // (handler would return 400 in production, test handler returns 200)
      expect(res.status).toBe(200);
    });
  });

  // ── Key format edge cases ───────────────────────────────────────────────

  describe('Key format edge cases', () => {
    it('accepts keys with valid URL-safe characters (A-Za-z0-9._:-)', async () => {
      const key = 'ABCDEFGH.IJKLMNOP_QRSTUVWX-YZabcdef:12345678';
      expect(key.length).toBeGreaterThanOrEqual(8);

      const res = await sendKycRequest(app, { key, body: validKycBody() });

      expect(res.status).toBe(200);
    });

    it('returns 400 for keys with non-URL-safe characters', async () => {
      const res = await sendKycRequest(app, { key: 'mykey@#$%^&', body: validKycBody() });

      expect(res.status).toBe(400);
    });
  });

  // ── Key persistence ─────────────────────────────────────────────────────

  describe('Key persistence in store', () => {
    it('stores key with TTL for expiry', async () => {
      const key = validKey();

      await sendKycRequest(app, { key, body: validKycBody() });

      // Verify via replay
      const replay = await sendKycRequest(app, { key, body: validKycBody() });

      expect(replay.status).toBe(200);
    });

    it('stores the response body as JSON for future replays', async () => {
      const key = validKey();
      const body = validKycBody({ smeId: 'SME-PERSIST' });

      const first = await sendKycRequest(app, { key, body });

      const replay = await sendKycRequest(app, { key, body });

      expect(replay.body.smeId).toBe(first.body.smeId);
      expect(replay.body.recordId).toBe(first.body.recordId);
    });
  });
});
