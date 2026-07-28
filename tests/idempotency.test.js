'use strict';

/**
 * Integration tests for the idempotency middleware in
 * `src/middleware/idempotency.js`.
 *
 * These tests run against an **in-memory SQLite database** via the Knex
 * `test` knexfile profile, mirroring the pattern used in
 * `tests/v1.invoices.test.js`. The global Jest setup (`tests/mocks/setup.js`)
 * mocks `src/db/knex` with a generic chainable object; we override it here
 * via `jest.mock('../src/db/knex', ...)` so the middleware sees a real
 * Knex instance backed by SQLite `:memory:`.
 *
 * Coverage targets (issue #378):
 *  - Header pattern validation rejects malformed keys.
 *  - First request stores the fingerprint and the response.
 *  - Duplicate (same key + same body) replays the cached response.
 *  - Reused key + different body returns 409 (RFC 7807).
 *  - TTL expiry allows a fresh request under the same key.
 *  - Transactional store prevents a concurrent duplicate from
 *    double-processing the funding handler.
 *  - Security: only the SHA-256 fingerprint is persisted; raw payload is
 *    never stored.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mock override: replace the global db mock so the middleware uses a real
// Knex instance backed by in-memory SQLite. This is the same pattern used in
// tests/v1.invoices.test.js.
// ---------------------------------------------------------------------------
jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const db = require('../src/db/knex');
const idempotencyMiddleware = require('../src/middleware/idempotency');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe alphanumeric idempotency key long enough to satisfy
 * the 8-character minimum. Each call returns a unique key so tests are
 * fully isolated.
 */
function validKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

/**
 * Minimal valid funding-request body.
 */
function validBody(overrides = {}) {
  return {
    invoiceId: 'INV-2024-001',
    investmentAmount: 5000.0,
    smeId: 'SME-789',
    ...overrides,
  };
}

/**
 * Compute the SHA-256 fingerprint the middleware would compute for `body`.
 * Kept identical to `fingerprint()` in src/middleware/idempotency.js so
 * tests can assert on stored values without trusting the implementation.
 */
function fingerprintOf(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}

/**
 * Parse a value as a Date timestamp (ms since epoch). Handles the various
 * shapes SQLite may return — numeric ms epoch, ISO 8601, or the bare
 * 'YYYY-MM-DD HH:MM:SS' format — by accepting any value `new Date()`
 * understands, and falling back to a space-to-'T' rewrite for SQLite's
 * default non-ISO layout.
 *
 * @param {unknown} value
 * @returns {number} ms since epoch, or NaN if unparseable
 */
function parseExpiryMs(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const primary = new Date(String(value)).getTime();
  if (!Number.isNaN(primary)) return primary;
  // SQLite default datetime: 'YYYY-MM-DD HH:MM:SS' — rewrite the space
  // and append 'Z' so the parser treats it as UTC.
  return new Date(String(value).replace(' ', 'T') + 'Z').getTime();
}

/**
 * Build a fresh Express app wired to the idempotency middleware.
 * The optional `onExecute` callback is fired inside the route handler —
 * concurrency tests use it to count handler invocations.
 *
 * @param {function} [onExecute]
 * @param {function} [handler]  Override the default 201 handler if needed.
 * @returns {import('express').Express}
 */
function buildApp(onExecute, handler) {
  const app = express();
  app.use(express.json());

  // Provide req.id so the RFC 7807 handler can stamp the response.
  app.use((req, res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });

  app.post(
    '/test/funding',
    idempotencyMiddleware,
    handler ||
      ((req, res) => {
        if (typeof onExecute === 'function') onExecute(req);
        res.status(201).json({
          investmentId:
            'inv_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
          invoiceId: req.body.invoiceId,
          smeId: req.body.smeId,
          amount: req.body.investmentAmount,
          status: 'pending',
        });
      })
  );

  return app;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let app;

beforeAll(async () => {
  // The Postgres migration (migrations/20260601000000_create_idempotency_keys.sql)
  // uses uuid_generate_v4() and JSONB, neither of which exist in SQLite.
  // We create the table directly via the schema builder, matching the
  // production column set semantically so behaviour (fingerprint, replay,
  // TTL) is identical.
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

  app = buildApp();
});

beforeEach(async () => {
  await db('idempotency_keys').del();
  // Force a fresh orphan-timeout window per test.
  delete process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS;
});

afterAll(async () => {
  await db.destroy();
});

// ===========================================================================
// Header validation
// ===========================================================================

describe('Idempotency Middleware — Header validation', () => {
  // The Idempotency-Key pattern is /^[A-Za-z0-9._:-]{8,128}$/

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app).post('/test/funding').send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key is the empty string', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', '')
      .send(validBody());
    // Empty header is falsy under req.header(...) so it hits the missing branch
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key contains a space', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', 'has spaces!!!')
      .send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL-safe/);
  });

  it('returns 400 when Idempotency-Key contains a forbidden non-URL-safe char', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', 'abc@xyz1234')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key is below the 8-char minimum', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', 'aB1.')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key exceeds the 128-char maximum', async () => {
    const tooLong = 'a'.repeat(129);
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', tooLong)
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('accepts a key at the minimum length (8 chars)', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', 'aB1.c-d:')
      .send(validBody())
      .expect(201);
    expect(res.body.investmentId).toBeDefined();
  });

  it('accepts a key at the maximum length (128 chars)', async () => {
    const keyAt128 = 'a'.repeat(128);
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', keyAt128)
      .send(validBody())
      .expect(201);
    expect(res.body.investmentId).toBeDefined();
  });

  it('does NOT touch the DB when the header is malformed', async () => {
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', 'short')
      .send(validBody())
      .expect(400);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// First request — stores the fingerprint and the response
// ===========================================================================

describe('Idempotency Middleware — First request stores fingerprint + response', () => {
  it('executes the handler and returns 201 on the first call', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    expect(res.body.investmentId).toBeDefined();
    expect(res.body.status).toBe('pending');
  });

  it('persists exactly one row on first call', async () => {
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('stores the SHA-256 request fingerprint (64 hex chars)', async () => {
    const body = validBody();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.request_fingerprint).toBe(fingerprintOf(body));
    expect(row.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists the response status code', async () => {
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.response_status).toBe(201);
  });

  it('persists the response body as a JSON string', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.investmentId).toBe(res.body.investmentId);
    expect(parsed.invoiceId).toBe(res.body.invoiceId);
  });

  it('sets expires_at to roughly TTL hours in the future (default 24h)', async () => {
    const before = Date.now();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const after = Date.now();
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    const ttlMs = 24 * 3600 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresMs).toBeLessThanOrEqual(after + ttlMs + 1000);
  });

  it('does NOT store the raw request body — only the SHA-256 fingerprint', async () => {
    const sentinel = 'PRIVATE_PII_' + crypto.randomBytes(8).toString('hex');
    const body = validBody({ secret_note: sentinel });
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    const blob = [
      row.idempotency_key,
      row.request_fingerprint,
      row.response_body,
    ]
      .filter(Boolean)
      .join('\n');
    expect(blob).not.toContain(sentinel);
    expect(blob).not.toContain('PRIVATE_PII_');
  });

  it('stores distinct fingerprints for distinct request bodies', async () => {
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody({ amount: 100 }))
      .expect(201);
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody({ amount: 200 }))
      .expect(201);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows[0].request_fingerprint).not.toBe(rows[1].request_fingerprint);
  });
});

// ===========================================================================
// Replay — same key + same body
// ===========================================================================

describe('Idempotency Middleware — Replay (same key + same body)', () => {
  it('returns the same investmentId on duplicate (no double-funding)', async () => {
    const key = validKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(r2.body.investmentId).toBe(r1.body.investmentId);
  });

  it('returns the cached response byte-identically', async () => {
    const key = validKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(r2.body).toEqual(r1.body);
  });

  it('does NOT execute the handler again on replay', async () => {
    let handlerInvocations = 0;
    const localApp = buildApp(() => {
      handlerInvocations++;
    });
    const key = validKey();
    const body = validBody();
    await request(localApp)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    await request(localApp)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(handlerInvocations).toBe(1);
  });

  it('does NOT insert a second row for the same key on replay', async () => {
    const key = validKey();
    const body = validBody();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// Conflict — same key + different body returns 409 (RFC 7807)
// ===========================================================================

describe('Idempotency Middleware — Conflict (same key + different body)', () => {
  it('returns 409 with application/problem+json', async () => {
    const key = validKey();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(validBody({ amount: 1000 }))
      .expect(201);
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(validBody({ amount: 2000 }))
      .expect(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
    expect(res.body.detail).toMatch(/different request body/);
  });

  it('preserves the original record on mismatch (no overwrite)', async () => {
    const key = validKey();
    const originalBody = validBody({ amount: 1000 });
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(originalBody)
      .expect(201);
    const beforeRow = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .first();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(validBody({ amount: 2000 }))
      .expect(409);
    const afterRow = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .first();
    expect(afterRow.request_fingerprint).toBe(beforeRow.request_fingerprint);
    expect(afterRow.request_fingerprint).toBe(fingerprintOf(originalBody));
    expect(afterRow.response_status).toBe(beforeRow.response_status);
    expect(afterRow.response_body).toBe(beforeRow.response_body);
  });

  it('returns 409 on every subsequent mismatch (not just the first)', async () => {
    const key = validKey();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(validBody({ amount: 1000 }))
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/test/funding')
        .set('Idempotency-Key', key)
        .send(validBody({ amount: 100 + i }))
        .expect(409);
    }
  });
});

// ===========================================================================
// Multiple distinct keys — isolation
// ===========================================================================

describe('Idempotency Middleware — Multiple distinct keys', () => {
  it('two different keys for the same body store separately', async () => {
    const body = validBody();
    const k1 = validKey('a');
    const k2 = validKey('b');
    const r1 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', k1)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', k2)
      .send(body)
      .expect(201);
    expect(r2.body.investmentId).not.toBe(r1.body.investmentId);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([k1, k2].sort());
  });

  it('two different keys + different bodies store separately', async () => {
    const r1 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody({ invoiceId: 'INV-1' }))
      .expect(201);
    const r2 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody({ invoiceId: 'INV-2' }))
      .expect(201);
    expect(r1.body.investmentId).not.toBe(r2.body.investmentId);
    expect(await db('idempotency_keys').count('* as n')).toEqual([{ n: 2 }]);
  });
});

// ===========================================================================
// TTL expiry
// ===========================================================================

describe('Idempotency Middleware — TTL expiry', () => {
  it('default TTL is 24 hours', async () => {
    process.env.IDEMPOTENCY_KEY_TTL_HOURS = '';
    const beforeMs = Date.now();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs - beforeMs).toBeGreaterThanOrEqual(23.9 * 3600 * 1000);
    expect(expiresMs - beforeMs).toBeLessThanOrEqual(24.1 * 3600 * 1000);
  });

  it('honours IDEMPOTENCY_KEY_TTL_HOURS env var', async () => {
    process.env.IDEMPOTENCY_KEY_TTL_HOURS = '1';
    const beforeMs = Date.now();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs - beforeMs).toBeGreaterThanOrEqual(0.95 * 3600 * 1000);
    expect(expiresMs - beforeMs).toBeLessThanOrEqual(1.05 * 3600 * 1000);
  });

  it('falls back to 24h on non-numeric TTL_H input', async () => {
    process.env.IDEMPOTENCY_KEY_TTL_HOURS = 'forever';
    const beforeMs = Date.now();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs - beforeMs).toBeGreaterThanOrEqual(23.9 * 3600 * 1000);
  });

  it('treats an expired key as a fresh request (handler re-executes)', async () => {
    const key = validKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    // Push expires_at into the past
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    let handlerInvocations = 0;
    const localApp = buildApp(() => {
      handlerInvocations++;
    });
    const r2 = await request(localApp)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(handlerInvocations).toBe(1);
    expect(r2.body.investmentId).not.toBe(r1.body.investmentId);
  });

  it('on expiry + different body, no 409 — fresh request is allowed', async () => {
    const key = validKey();
    const body1 = validBody({ amount: 1000 });
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body1)
      .expect(201);
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const body2 = validBody({ amount: 9999 });
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body2)
      .expect(201);
    expect(res.body.investmentId).toBeDefined();
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].request_fingerprint).toBe(fingerprintOf(body2));
  });

  it('on expiry, expires_at is refreshed to a fresh 24h window', async () => {
    const key = validKey();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(validBody())
      .expect(201);
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const before = Date.now();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(validBody())
      .expect(201);
    const after = Date.now();

    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs).toBeGreaterThanOrEqual(before + 24 * 3600 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 24 * 3600 * 1000 + 1000);
  });
});

// ===========================================================================
// Concurrent duplicate (transactional race protection)
// ===========================================================================

describe('Idempotency Middleware — Concurrent duplicate', () => {
  it('sequential duplicate calls produce exactly one handler invocation', async () => {
    let handlerInvocations = 0;
    const localApp = buildApp(() => {
      handlerInvocations++;
    });
    const key = validKey();
    const body = validBody();
    const r1 = await request(localApp)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body);
    const r2 = await request(localApp)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(handlerInvocations).toBe(1);
    expect(r2.body.investmentId).toBe(r1.body.investmentId);
  });

  it('parallel duplicate calls (Promise.all) result in ≤ 1 handler invocation', async () => {
    let handlerInvocations = 0;
    const localApp = buildApp(() => {
      handlerInvocations++;
    });
    const key = validKey();
    const body = validBody();

    const responses = await Promise.all([
      request(localApp)
        .post('/test/funding')
        .set('Idempotency-Key', key)
        .send(body),
      request(localApp)
        .post('/test/funding')
        .set('Idempotency-Key', key)
        .send(body),
    ]);

    // Never 5xx — caller might receive a 201 (replay) or 409 (in-flight)
    for (const r of responses) {
      expect([201, 409]).toContain(r.status);
    }
    // No double-funding
    expect(handlerInvocations).toBeLessThanOrEqual(1);

    // Both 201s MUST carry the same investmentId — exactly one funding
    // happened. (If one is 409, the other is 201; the funding handle only
    // ran once.)
    const ids = responses
      .filter((r) => r.status === 201)
      .map((r) => r.body.investmentId);
    expect(new Set(ids).size).toBeLessThanOrEqual(1);
  });

  it('parallel duplicate calls (Promise.all) never produce 5xx', async () => {
    const key = validKey();
    const body = validBody();
    const responses = await Promise.all([
      request(app)
        .post('/test/funding')
        .set('Idempotency-Key', key)
        .send(body),
      request(app)
        .post('/test/funding')
        .set('Idempotency-Key', key)
        .send(body),
      request(app)
        .post('/test/funding')
        .set('Idempotency-Key', key)
        .send(body),
    ]);
    for (const r of responses) {
      expect(r.status).toBeLessThan(500);
    }
  });

  it('UNIQUE constraint is respected — only one row per key after N parallel calls', async () => {
    const key = validKey();
    const body = validBody();
    const N = 5;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post('/test/funding')
          .set('Idempotency-Key', key)
          .send(body)
      )
    );
    for (const r of responses) expect(r.status).toBeLessThan(500);
    const rows = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .select('*');
    expect(rows).toHaveLength(1);
  });

  it('orphan in-flight protection: stale placeholder older than the orphan timeout is purged and re-inserted', async () => {
    const key = validKey();
    const body = validBody();
    // Insert a placeholder directly with a created_at far in the past
    await db('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: fingerprintOf(body),
      response_status: null,
      response_body: null,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000),
      created_at: new Date(Date.now() - 600000).toISOString(),
      updated_at: new Date(Date.now() - 600000).toISOString(),
    });

    let handlerInvocations = 0;
    const localApp = buildApp(() => {
      handlerInvocations++;
    });
    const res = await request(localApp)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    // Orphan was recycled, handler ran, fresh investmentId issued
    expect(handlerInvocations).toBe(1);
    expect(res.body.investmentId).toBeDefined();
    const rows = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].request_fingerprint).toBe(fingerprintOf(body));
  });

  it('non-orphan in-flight placeholder yields 409 on duplicate (cannot yet be replayed)', async () => {
    const key = validKey();
    const body = validBody();
    // Insert a fresh placeholder (response_status=null) directly
    await db('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: fingerprintOf(body),
      response_status: null,
      response_body: null,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    let handlerInvocations = 0;
    const localApp = buildApp(() => {
      handlerInvocations++;
    });
    const res = await request(localApp)
      .post('/test/funding')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(409);
    expect(handlerInvocations).toBe(0);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.detail).toMatch(/currently being processed/i);
  });
});

// ===========================================================================
// Security
// ===========================================================================

describe('Idempotency Middleware — Security', () => {
  it('stores ONLY the SHA-256 fingerprint — no plaintext of the request body', async () => {
    const plaintext = 'SENSITIVE_AMOUNT_999999_PRIVATE_NOTE_XYZ';
    const body = validBody({ private_note: plaintext });
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    const blobs = [
      row.request_fingerprint,
      row.response_body,
      row.idempotency_key,
    ]
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v))
      .join('\n');
    expect(blobs).not.toContain(plaintext);
    expect(blobs).not.toContain('SENSITIVE_AMOUNT');
    expect(blobs).not.toContain('PRIVATE_NOTE');
  });

  it('different request bodies produce distinct fingerprints (no accidental aliasing)', async () => {
    const keys = [validKey('a'), validKey('b')];
    const bodies = [validBody({ invoiceId: 'A' }), validBody({ invoiceId: 'B' })];
    for (let i = 0; i < keys.length; i++) {
      await request(app)
        .post('/test/funding')
        .set('Idempotency-Key', keys[i])
        .send(bodies[i])
        .expect(201);
    }
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows.map((r) => r.request_fingerprint)).toEqual([
      fingerprintOf(bodies[0]),
      fingerprintOf(bodies[1]),
    ]);
    expect(rows[0].request_fingerprint).not.toBe(rows[1].request_fingerprint);
  });

  it('rejects malformed keys BEFORE any database access', async () => {
    const before = Date.now();
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', 'short')
      .send(validBody())
      .expect(400);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
    expect(Date.now() - before).toBeLessThan(2000); // didn't time out
  });

  it('cached response body remains parseable JSON', async () => {
    const body = validBody({
      invoiceId: 'INV-2024-X1',
      nested: { a: 1, b: 'hello "world"', c: [true, false, null] },
    });
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.investmentId).toBeDefined();
  });

  it('does NOT crash on empty request body', async () => {
    const res = await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', validKey())
      .send({})
      .expect(201);
    expect(res.body.investmentId).toBeDefined();
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].request_fingerprint).toBe(fingerprintOf({}));
  });

  it('the fingerprint is identical for byte-equal bodies (idempotent hashing)', async () => {
    const key1 = validKey('a');
    const key2 = validKey('b');
    const body = validBody({ nested: { x: 1, y: [1, 2, 3] } });
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key1)
      .send(body)
      .expect(201);
    await request(app)
      .post('/test/funding')
      .set('Idempotency-Key', key2)
      .send(body)
      .expect(201);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows[0].request_fingerprint).toBe(rows[1].request_fingerprint);
  });
});
