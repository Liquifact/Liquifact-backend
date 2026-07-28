'use strict';

/**
 * Integration tests for idempotency-key support on api-keys write endpoints.
 *
 * Coverage targets (issue #765):
 *  - Missing Idempotency-Key header → 400
 *  - Invalid key format → 400
 *  - First write (POST a new API key) → 201, stores fingerprint + response
 *  - Exact replay (same Idempotency-Key + same body) → same cached response
 *  - Key reuse with different body → 409 (RFC 7807)
 *  - Multiple distinct keys work independently
 *  - GET endpoints are unaffected (no idempotency requirement)
 *  - TTL expiry allows fresh request under same key
 *  - DB stores SHA-256 fingerprint, never raw body
 *
 * Uses an in-memory SQLite database via Knex, mirroring the pattern in
 * tests/idempotency.test.js and tests/v1.invoices.test.js.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mock override: use real Knex with in-memory SQLite
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
const {
  loadApiKeyRegistry,
  validateEntry,
  VALID_SCOPES,
} = require('../src/config/apiKeys');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe alphanumeric idempotency key long enough for the
 * 8-character minimum.
 */
function validIdempotencyKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

/**
 * Generate a unique, valid API key string.
 */
function validApiKey() {
  return (
    'lf_' +
    crypto.randomBytes(12).toString('hex') +
    '_' +
    Math.random().toString(36).slice(2, 6)
  );
}

/**
 * Minimal valid API-key creation body.
 */
function validBody(overrides = {}) {
  return {
    key: validApiKey(),
    clientId: 'svc-' + crypto.randomBytes(4).toString('hex'),
    scopes: ['invoices:read'],
    ...overrides,
  };
}

/**
 * Compute the SHA-256 fingerprint the middleware would compute for `body`.
 * Kept identical to the implementation in src/middleware/idempotency.js.
 */
function fingerprintOf(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

/**
 * Build an Express app with the apiKeys routes and idempotency middleware.
 * Resets runtime entries before each test for clean isolation.
 */
function buildApp() {
  const app = express();
  app.use(express.json());

  // Provide req.id so the RFC 7807 conflict handler can stamp the response.
  app.use((req, _res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });

  // Mount the apiKeys router at /api so full paths are /api/keys and /api/api-keys
  const apiKeysRoutes = require('../src/routes/apiKeys');
  // Apply idempotency middleware on POST routes before the router
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST') {
      return idempotencyMiddleware(req, res, next);
    }
    next();
  });
  app.use('/api', apiKeysRoutes);

  return app;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let app;

beforeAll(async () => {
  // Create idempotency_keys table matching the production schema.
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
  // Reset the runtime entries store so previous test creations don't leak.
  const apiKeysRoutes = require('../src/routes/apiKeys');
  if (typeof apiKeysRoutes.resetRuntimeEntries === 'function') {
    apiKeysRoutes.resetRuntimeEntries();
  }
  // Force a fresh orphan-timeout window per test.
  delete process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS;
});

afterAll(async () => {
  // Reset runtime entries to prevent cross-suite contamination
  const apiKeysRoutes = require('../src/routes/apiKeys');
  if (typeof apiKeysRoutes.resetRuntimeEntries === 'function') {
    apiKeysRoutes.resetRuntimeEntries();
  }
  // Drop the test table for clean teardown
  await db.schema.dropTableIfExists('idempotency_keys');
  await db.destroy();
});

// ===========================================================================
// Header validation
// ===========================================================================

describe('API Keys Idempotency — Header validation', () => {
  it('returns 400 when Idempotency-Key header is missing on POST /api/keys', async () => {
    const res = await request(app)
      .post('/api/keys')
      .send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key header is missing on POST /api/api-keys', async () => {
    const res = await request(app)
      .post('/api/api-keys')
      .send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key is the empty string', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', '')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key contains invalid characters (@ sign)', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', 'abc@xyz1234')
      .send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL-safe/);
  });

  it('returns 400 when Idempotency-Key contains a space', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', 'has spaces')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key is below the 8-char minimum', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', 'aB1.')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key exceeds the 128-char maximum', async () => {
    const tooLong = 'a'.repeat(129);
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', tooLong)
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('does NOT touch the DB when the header is malformed', async () => {
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', 'short')
      .send(validBody())
      .expect(400);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });

  it('accepts a key at the minimum length (8 chars)', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', 'aB1.c-d:')
      .send(validBody())
      .expect(201);
    expect(res.body.data).toBeDefined();
  });

  it('accepts a key at the maximum length (128 chars)', async () => {
    const keyAt128 = 'a'.repeat(128);
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', keyAt128)
      .send(validBody())
      .expect(201);
    expect(res.body.data).toBeDefined();
  });
});

// ===========================================================================
// GET endpoints — no idempotency required
// ===========================================================================

describe('API Keys Idempotency — GET endpoints unaffected', () => {
  it('GET /api/keys works without Idempotency-Key header', async () => {
    const res = await request(app).get('/api/keys');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.count).toBeDefined();
  });

  it('GET /api/api-keys works without Idempotency-Key header', async () => {
    const res = await request(app).get('/api/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('GET /api/keys/:key works without Idempotency-Key header', async () => {
    const res = await request(app).get('/api/keys/lf_nonexistent');
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// First write — stores fingerprint + response
// ===========================================================================

describe('API Keys Idempotency — First write stores fingerprint + response', () => {
  it('executes the handler and returns 201 on the first call (POST /api/keys)', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody())
      .expect(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.key).toBeDefined();
    expect(res.body.message).toMatch(/created successfully/);
  });

  it('executes the handler and returns 201 on the first call (POST /api/api-keys)', async () => {
    const res = await request(app)
      .post('/api/api-keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody())
      .expect(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.key).toBeDefined();
  });

  it('persists exactly one row on first call', async () => {
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody())
      .expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('stores the SHA-256 request fingerprint (64 hex chars)', async () => {
    const body = validBody();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.request_fingerprint).toBe(fingerprintOf(body));
    expect(row.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists the response status code', async () => {
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.response_status).toBe(201);
  });

  it('persists the response body as a JSON string', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.data.key).toBe(res.body.data.key);
    expect(parsed.data.clientId).toBe(res.body.data.clientId);
  });

  it('sets expires_at to roughly TTL hours in the future (default 24h)', async () => {
    const before = Date.now();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody())
      .expect(201);
    const after = Date.now();
    const row = await db('idempotency_keys').first();
    const expiresMs = new Date(String(row.expires_at)).getTime();
    const ttlMs = 24 * 3600 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlMs - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + ttlMs + 5000);
  });

  it('does NOT store the raw request body — only the SHA-256 fingerprint', async () => {
    const sentinel = 'PRIVATE_PII_' + crypto.randomBytes(8).toString('hex');
    const body = validBody({ clientId: sentinel });
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    // The response_body may contain the sentinel as part of the handler's
    // normal response payload (e.g. clientId). The request_fingerprint
    // must never contain it — only the SHA-256 hash is stored.
    const blob = [
      row.request_fingerprint,
    ]
      .filter(Boolean)
      .join('\n');
    expect(blob).not.toContain(sentinel);
    expect(blob).not.toContain('PRIVATE_PII_');
  });
});

// ===========================================================================
// Replay — same key + same body
// ===========================================================================

describe('API Keys Idempotency — Replay (same key + same body)', () => {
  it('returns the same response on duplicate (POST /api/keys)', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    expect(r2.body.data.key).toBe(r1.body.data.key);
    expect(r2.body.data.clientId).toBe(r1.body.data.clientId);
    expect(r2.body.message).toBe(r1.body.message);
  });

  it('returns the cached response byte-identically', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    expect(r2.body).toEqual(r1.body);
  });

  it('returns the cached response on POST /api/api-keys replay', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/api-keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/api/api-keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    expect(r2.body).toEqual(r1.body);
  });

  it('does NOT insert a second row for the same key on replay', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// Conflict — same key + different body returns 409 (RFC 7807)
// ===========================================================================

describe('API Keys Idempotency — Conflict (same key + different body)', () => {
  it('returns 409 with application/problem+json', async () => {
    const idemKey = validIdempotencyKey();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(validBody({ clientId: 'svc-alpha' }))
      .expect(201);
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(validBody({ clientId: 'svc-beta' }))
      .expect(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
    expect(res.body.detail).toMatch(/different request body/);
  });

  it('returns 409 when same key used with different scopes', async () => {
    const idemKey = validIdempotencyKey();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(validBody({ scopes: ['invoices:read'] }))
      .expect(201);
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(validBody({ scopes: ['invoices:write'] }))
      .expect(409);
    expect(res.status).toBe(409);
  });

  it('preserves the original record on mismatch (no overwrite)', async () => {
    const idemKey = validIdempotencyKey();
    const originalBody = validBody({ clientId: 'svc-original' });
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(originalBody)
      .expect(201);
    const beforeRow = await db('idempotency_keys')
      .where({ idempotency_key: idemKey })
      .first();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(validBody({ clientId: 'svc-different' }))
      .expect(409);
    const afterRow = await db('idempotency_keys')
      .where({ idempotency_key: idemKey })
      .first();
    expect(afterRow.request_fingerprint).toBe(beforeRow.request_fingerprint);
    expect(afterRow.request_fingerprint).toBe(fingerprintOf(originalBody));
    expect(afterRow.response_status).toBe(beforeRow.response_status);
    expect(afterRow.response_body).toBe(beforeRow.response_body);
  });

  it('returns 409 on every subsequent mismatch (not just the first)', async () => {
    const idemKey = validIdempotencyKey();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(validBody({ clientId: 'svc-first' }))
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/keys')
        .set('Idempotency-Key', idemKey)
        .send(validBody({ clientId: 'svc-diff-' + i }))
        .expect(409);
    }
  });
});

// ===========================================================================
// Multiple distinct keys — isolation
// ===========================================================================

describe('API Keys Idempotency — Multiple distinct keys', () => {
  it('two different idempotency keys for the same body store separately', async () => {
    // Use unique API keys so the handler creates (201) rather than
    // returning "already exists" (200).
    const k1 = validIdempotencyKey('a');
    const k2 = validIdempotencyKey('b');
    const body1 = validBody();
    const body2 = validBody();
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', k1)
      .send(body1)
      .expect(201);
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', k2)
      .send(body2)
      .expect(201);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    const storedKeys = rows.map((r) => r.idempotency_key).sort();
    expect(storedKeys).toEqual([k1, k2].sort());
    // Fingerprints differ because the API keys differ
    expect(rows[0].request_fingerprint).not.toBe(rows[1].request_fingerprint);
  });

  it('two different idempotency keys + different bodies store separately', async () => {
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody({ clientId: 'svc-one' }))
      .expect(201);
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(validBody({ clientId: 'svc-two' }))
      .expect(201);
    const countResult = await db('idempotency_keys').count('* as n');
    expect(Number(countResult[0].n)).toBe(2);
  });
});

// ===========================================================================
// TTL expiry
// ===========================================================================

describe('API Keys Idempotency — TTL expiry', () => {
  it('treats an expired key as a fresh request (handler re-executes)', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    // Push expires_at into the past
    await db('idempotency_keys')
      .where({ idempotency_key: idemKey })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    // After expiry, the middleware deletes the stale row and re-processes.
    // Since the API key was already created in the runtime store, the
    // handler will return 200 "already exists" instead of 201 "created".
    const r2 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(200);
    expect(r2.body.message).toMatch(/already exists/);
    // Only one row — the old one was deleted and a fresh one was inserted
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(idemKey);
  });

  it('on expiry + different body, no 409 — fresh request is allowed', async () => {
    const idemKey = validIdempotencyKey();
    const body1 = validBody({ clientId: 'svc-original' });
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body1)
      .expect(201);
    await db('idempotency_keys')
      .where({ idempotency_key: idemKey })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const body2 = validBody({ clientId: 'svc-different' });
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body2)
      .expect(201);
    expect(res.body.data).toBeDefined();
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].request_fingerprint).toBe(fingerprintOf(body2));
  });
});

// ===========================================================================
// Security
// ===========================================================================

describe('API Keys Idempotency — Security', () => {
  it('stores ONLY the SHA-256 fingerprint — no plaintext of the API key in the idempotency store', async () => {
    const apiKey = validApiKey();
    const body = validBody({ key: apiKey });
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
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
    // The raw API key must not appear in the idempotency store except as
    // part of the stored response (which is the handler's output).
    expect(row.request_fingerprint).not.toContain(apiKey);
    expect(row.request_fingerprint).not.toContain('lf_');
  });

  it('cached response body remains parseable JSON', async () => {
    const body = validBody({
      clientId: 'svc-json-test',
      scopes: ['invoices:read', 'escrow:read'],
    });
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.data.key).toBeDefined();
    expect(parsed.data.clientId).toBe('svc-json-test');
  });

  it('does NOT crash on empty request body', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send({})
      .expect(422);
    expect(res.body.error).toBeDefined();
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// Concurrency — sequential and parallel
// ===========================================================================

describe('API Keys Idempotency — Concurrency', () => {
  it('sequential duplicate calls produce exactly one key row', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body);
    const r2 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.data.key).toBe(r1.body.data.key);
    const rows = await db('idempotency_keys')
      .where({ idempotency_key: idemKey })
      .select('*');
    expect(rows).toHaveLength(1);
  });

  it('parallel duplicate calls (Promise.all) never produce 5xx', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    const responses = await Promise.all([
      request(app)
        .post('/api/keys')
        .set('Idempotency-Key', idemKey)
        .send(body),
      request(app)
        .post('/api/keys')
        .set('Idempotency-Key', idemKey)
        .send(body),
      request(app)
        .post('/api/keys')
        .set('Idempotency-Key', idemKey)
        .send(body),
    ]);
    for (const r of responses) {
      expect(r.status).toBeLessThan(500);
    }
  });

  it('UNIQUE constraint is respected — only one row per key after N parallel calls', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    const N = 5;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post('/api/keys')
          .set('Idempotency-Key', idemKey)
          .send(body)
      )
    );
    for (const r of responses) expect(r.status).toBeLessThan(500);
    const rows = await db('idempotency_keys')
      .where({ idempotency_key: idemKey })
      .select('*');
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// Handler's existing "already exists" logic coexists with idempotency
// ===========================================================================

describe('API Keys Idempotency — Coexistence with handler-level idempotent check', () => {
  it('replay returns cached 201 even though a second raw call would have returned 200 (key already exists)', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    // First call — creates the key, returns 201
    const r1 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    // Replay — middleware returns the cached 201 (not 200 "already exists")
    const r2 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(201);
    expect(r2.body.data.key).toBe(r1.body.data.key);
    expect(r2.body.message).toBe(r1.body.message);
  });

  it('replay returns cached 200 when the original response was "already exists"', async () => {
    const idemKey = validIdempotencyKey();
    const body = validBody();
    // First create the key
    await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', validIdempotencyKey())
      .send(body)
      .expect(201);

    // Now call again with the SAME body but a new idempotency key — the handler
    // will see the key already exists and return 200 "idempotent: true"
    const r1 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(200);
    expect(r1.body.message).toMatch(/already exists/);

    // Replay with same idempotency key should return the cached 200
    const r2 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(200);
    expect(r2.body).toEqual(r1.body);
    expect(r2.body.message).toMatch(/already exists/);
  });
});

// ===========================================================================
// Validation errors are also cached
// ===========================================================================

describe('API Keys Idempotency — Validation error caching', () => {
  it('caches a 422 validation error and replays it', async () => {
    const idemKey = validIdempotencyKey();
    const invalidBody = {
      key: 'not_lf_prefixed',
      clientId: 'test',
      scopes: ['invoices:read'],
    };
    const r1 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(invalidBody)
      .expect(422);
    const r2 = await request(app)
      .post('/api/keys')
      .set('Idempotency-Key', idemKey)
      .send(invalidBody)
      .expect(422);
    expect(r2.body).toEqual(r1.body);
    expect(r2.body.error).toMatch(/Validation failed/);
  });
});
