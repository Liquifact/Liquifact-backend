/**
 * Integration tests for Idempotency-Key support on the SME bulk metrics
 * write endpoint (issue #745).
 *
 * `POST /api/sme/metrics/bulk` optionally accepts an `Idempotency-Key`
 * header via `optionalIdempotency` -> `idempotencyMiddleware`. Coverage:
 *
 *  - Legacy behavior is unchanged when no key is supplied.
 *  - First request with a key executes normally and stores the response.
 *  - Exact replay (same key + same body) returns the original cached
 *    response WITHOUT re-invoking the underlying service.
 *  - Key reuse with a different body returns 409 (RFC 7807 problem+json).
 *  - Distinct keys are tracked independently.
 *  - Malformed / undersized / oversized keys are rejected with 400 before
 *    any DB access.
 *  - Expired keys are purged and a fresh request under the same key
 *    re-executes rather than replaying stale data.
 *
 * Bypasses the global knex mock to run against a real in-memory SQLite
 * database, matching the pattern used in `tests/sme.metrics.bulk.test.js`
 * and `tests/healthWrite.idempotency.test.js`.
 */

'use strict';

jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const express = require('express');
const db = require('../src/db/knex');
const invoiceService = require('../src/services/invoiceService');
const metricsRouter = require('../src/routes/sme/metrics');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

/**
 * Minimal, self-contained app mounting the real, unmodified
 * `src/routes/sme/metrics.js` router under `/api/sme`. This avoids pulling
 * in `src/app.js`'s full dependency graph (unrelated services unaffected by
 * this change), matching the isolation pattern already used by
 * `tests/healthWrite.idempotency.test.js`.
 */
function buildApp() {
  const app = express();
  app.use((req, res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });
  app.use('/api/sme', metricsRouter);

  // Minimal AppError-aware error handler, mirroring src/app.js's
  // handleInternalError for the subset this route can throw.
  app.use((err, req, res, next) => {
    if (err && err.status && err.status >= 400 && err.status <= 599) {
      return res.status(err.status).json({
        error: { code: err.code || String(err.status), message: err.detail || err.title || err.message },
      });
    }
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

const app = buildApp();

/**
 * Generate a fresh, valid (8-128 URL-safe chars) idempotency key.
 */
function validKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

describe('SME Bulk Metrics API — Idempotency-Key', () => {
  const userId = 'idem_sme_user';
  const tenantId = 'idem_tenant';
  const token = jwt.sign({ id: userId, tenantId }, JWT_SECRET);

  const requestBody = { operations: [{ tenantId, userId }] };
  const otherBody = { operations: [{ tenantId, userId }, { tenantId, userId: 'other_user' }] };

  beforeAll(async () => {
    await db.migrate.latest({ directory: './migrations' });

    // The idempotency_keys table is defined by a raw Postgres migration
    // (migrations/20260601000000_create_idempotency_keys.sql) intended for
    // node-pg-migrate in production; Knex's SQLite migrator only picks up
    // .js migrations. Create the equivalent table by hand for this
    // in-memory SQLite test run, mirroring tests/idempotency.test.js and
    // tests/healthWrite.idempotency.test.js.
    const hasTable = await db.schema.hasTable('idempotency_keys');
    if (!hasTable) {
      await db.schema.createTable('idempotency_keys', (t) => {
        t.increments('id').primary();
        t.string('idempotency_key', 128).notNullable().unique();
        t.string('request_fingerprint', 64).notNullable();
        t.integer('response_status').nullable();
        t.text('response_body').nullable();
        t.timestamp('created_at').defaultTo(db.fn.now());
        t.timestamp('updated_at').defaultTo(db.fn.now());
        t.timestamp('expires_at').notNullable();
      });
    }
  });

  beforeEach(async () => {
    await db('invoices').del();
    await db('idempotency_keys').del();
    delete process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS;
    delete process.env.IDEMPOTENCY_KEY_TTL_HOURS;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ── Legacy / backward-compatible behavior ─────────────────────────────

  describe('no Idempotency-Key header (legacy behavior)', () => {
    it('processes the request normally and writes no idempotency row', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send(requestBody);

      expect(res.status).toBe(200);
      expect(res.body.meta.succeeded).toBe(1);

      const rows = await db('idempotency_keys').select('*');
      expect(rows).toHaveLength(0);
    });

    it('does NOT deduplicate repeated calls without a key (each call re-executes)', async () => {
      const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send(requestBody)
        .expect(200);

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send(requestBody)
        .expect(200);

      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  // ── Header validation ──────────────────────────────────────────────────

  describe('header validation', () => {
    it('returns 400 when Idempotency-Key contains invalid characters', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'has spaces!!!')
        .send(requestBody);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/URL-safe/);
    });

    it('returns 400 when Idempotency-Key is below the 8-character minimum', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'aB1.')
        .send(requestBody);

      expect(res.status).toBe(400);
    });

    it('returns 400 when Idempotency-Key exceeds the 128-character maximum', async () => {
      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'a'.repeat(129))
        .send(requestBody);

      expect(res.status).toBe(400);
    });

    it('does not touch the idempotency store when the key is malformed', async () => {
      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'short')
        .send(requestBody)
        .expect(400);

      const rows = await db('idempotency_keys').select('*');
      expect(rows).toHaveLength(0);
    });
  });

  // ── First write ─────────────────────────────────────────────────────────

  describe('first write', () => {
    it('executes normally, returns 200, and persists a completed idempotency row', async () => {
      const key = validKey();

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody);

      expect(res.status).toBe(200);
      expect(res.body.meta.succeeded).toBe(1);

      const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
      expect(row).toBeDefined();
      expect(row.response_status).toBe(200);
      expect(JSON.parse(row.response_body)).toEqual(res.body);
    });
  });

  // ── Exact replay ────────────────────────────────────────────────────────

  describe('exact replay', () => {
    it('returns the identical cached response on retry with same key + same body', async () => {
      await db('invoices').insert([
        { invoice_id: 'idem-1', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 500, customer: 'CustA' },
      ]);

      const key = validKey();

      const first = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody);

      expect(first.status).toBe(200);
      expect(first.body.results[0].data.funded).toBe(1);

      // Mutate underlying data — if replay re-executed, the counts would
      // change. A true replay must ignore this and return the original.
      await db('invoices').insert([
        { invoice_id: 'idem-2', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 500, customer: 'CustB' },
      ]);

      const replay = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(replay.body.results[0].data.funded).toBe(1);
    });

    it('does not re-invoke the underlying service on replay', async () => {
      const key = validKey();
      const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody)
        .expect(200);

      expect(spy).toHaveBeenCalledTimes(1);

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody)
        .expect(200);

      // Still 1 — the second call was served entirely from the cached
      // response and never reached the handler / service layer.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('preserves the original HTTP status code on replay', async () => {
      const key = validKey();

      const first = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody);

      const replay = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody);

      expect(replay.status).toBe(first.status);
    });
  });

  // ── Key reuse with a different body (conflict) ─────────────────────────

  describe('key reuse with a different body', () => {
    it('returns 409 RFC 7807 problem+json when the same key is reused with a different body', async () => {
      const key = validKey();

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody)
        .expect(200);

      const conflict = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(otherBody);

      expect(conflict.status).toBe(409);
      expect(conflict.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(conflict.body.status).toBe(409);
      expect(conflict.body.title).toBe('Conflict');
      expect(conflict.body.detail).toMatch(/different request body/i);
    });

    it('does not execute the handler again on conflict', async () => {
      const key = validKey();

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody)
        .expect(200);

      const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(otherBody)
        .expect(409);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── Independent keys ────────────────────────────────────────────────────

  describe('distinct keys', () => {
    it('tracks separate Idempotency-Keys independently, even with the same body', async () => {
      const keyA = validKey('a');
      const keyB = validKey('b');

      const resA = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', keyA)
        .send(requestBody)
        .expect(200);

      const resB = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', keyB)
        .send(requestBody)
        .expect(200);

      expect(resA.body.results).toEqual(resB.body.results);
      expect(resA.body.meta.succeeded).toBe(resB.body.meta.succeeded);

      const rows = await db('idempotency_keys').select('idempotency_key');
      const keys = rows.map((r) => r.idempotency_key).sort();
      expect(keys).toEqual([keyA, keyB].sort());
    });
  });

  // ── Expiry / bounded store ──────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('re-executes (rather than replaying) once the stored key has expired', async () => {
      const key = validKey();

      await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody)
        .expect(200);

      // Force the stored row into the past so it's treated as expired.
      await db('idempotency_keys')
        .where({ idempotency_key: key })
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

      await db('invoices').insert([
        { invoice_id: 'idem-exp-1', sme_id: userId, tenant_id: tenantId, status: 'funded', amount: 500, customer: 'CustC' },
      ]);

      const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

      const res = await request(app)
        .post('/api/sme/metrics/bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(requestBody);

      expect(res.status).toBe(200);
      // Expired row was purged inline, so this counts as a fresh execution.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.body.results[0].data.funded).toBe(1);
    });
  });
});
