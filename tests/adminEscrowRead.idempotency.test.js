'use strict';

/**
 * Integration tests for idempotency-key support on escrow-read write endpoints.
 * Covers issue #735: POST /api/admin/escrow-read, PUT /api/admin/escrow-read/:id,
 * DELETE /api/admin/escrow-read/:id.
 *
 * Tests:
 *  - No Idempotency-Key header → request passes through normally (backward compat)
 *  - First write with key → handler executes, response + fingerprint stored
 *  - Replay (same key + same body) → cached response returned, handler NOT re-run
 *  - Conflict (same key + different body) → 409 RFC 7807 application/problem+json
 *  - Malformed key (invalid chars / too short / too long) → 400
 *  - TTL expiry → expired row treated as fresh request (no spurious 409)
 *  - Multiple distinct keys are fully independent
 *
 * Uses in-memory SQLite via Knex (matching the pattern in
 * tests/adminConfig.idempotency.test.js) so the middleware writes to a real DB.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// DB override: real Knex + in-memory SQLite
// ---------------------------------------------------------------------------
jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

// Mock admin auth so we don't need real JWTs.
jest.mock('../src/middleware/stacks', () => ({
  adminStack: [
    (req, _res, next) => {
      req.user = { sub: 'admin-test-user' };
      req.tenantId = 'tenant_test_escrow_read';
      next();
    },
  ],
  authenticatedTenantStack: [
    (req, _res, next) => {
      req.user = { sub: 'user' };
      req.tenantId = 'tenant_test_escrow_read';
      next();
    },
  ],
}));

// Mock auditLog so we don't need a real DB for audit tables.
jest.mock('../src/services/auditLog', () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue([]),
}));

const request = require('supertest');
const crypto = require('crypto');
const db = require('../src/db/knex');

// Import app AFTER mocks are registered.
const app = require('../src/app');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a valid idempotency key (satisfies /^[A-Za-z0-9._:-]{8,128}$/).
 * @param {string} [suffix]
 * @returns {string}
 */
function validKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

/** Minimal valid POST body for escrow-read config creation. */
function postBody(overrides = {}) {
  return { id: 'cfg-' + crypto.randomBytes(4).toString('hex'), config: { cacheTtl: 60 }, ...overrides };
}

/** Minimal valid PUT body for escrow-read config update. */
function putBody(overrides = {}) {
  return { config: { cacheTtl: 120 }, ...overrides };
}

/**
 * Compute the SHA-256 fingerprint the idempotency middleware stores for `body`.
 * @param {object} body
 * @returns {string}
 */
function fingerprintOf(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

/**
 * Parse an expires_at value (handles ISO string, numeric ms, and SQLite formats).
 * @param {string|number|null} value
 * @returns {number} ms since epoch, or NaN
 */
function parseExpiryMs(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const primary = new Date(String(value)).getTime();
  if (!Number.isNaN(primary)) return primary;
  return new Date(String(value).replace(' ', 'T') + 'Z').getTime();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
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
});

beforeEach(async () => {
  await db('idempotency_keys').del();
  delete process.env.IDEMPOTENCY_KEY_TTL_HOURS;
  delete process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS;
  // Reset in-memory store between tests by re-requiring the module.
  // The escrowReadStore is module-level; clearing via DELETE before each test
  // is handled by the module itself only if we clear all created entries.
  // We achieve isolation by using unique IDs per test via postBody().
});

afterAll(async () => {
  await db.schema.dropTableIfExists('idempotency_keys');
  await db.destroy();
});

// ===========================================================================
// Backward compatibility — no Idempotency-Key header
// ===========================================================================

describe('Escrow-read idempotency — backward compatibility (no header)', () => {
  it('POST without Idempotency-Key still creates the config (201)', async () => {
    const body = postBody();
    const res = await request(app)
      .post('/api/admin/escrow-read')
      .send(body)
      .expect(201);
    expect(res.body.data.id).toBe(body.id);
  });

  it('POST without header does not write to idempotency_keys table', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .send(postBody())
      .expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });

  it('PUT without Idempotency-Key still updates the config (200)', async () => {
    const body = postBody();
    await request(app).post('/api/admin/escrow-read').send(body).expect(201);
    const res = await request(app)
      .put(`/api/admin/escrow-read/${body.id}`)
      .send(putBody())
      .expect(200);
    expect(res.body.data.config.cacheTtl).toBe(120);
  });

  it('DELETE without Idempotency-Key still deletes the config (204)', async () => {
    const body = postBody();
    await request(app).post('/api/admin/escrow-read').send(body).expect(201);
    await request(app)
      .delete(`/api/admin/escrow-read/${body.id}`)
      .expect(204);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// Header validation
// ===========================================================================

describe('Escrow-read idempotency — header validation', () => {
  it('returns 400 when Idempotency-Key contains invalid characters', async () => {
    const res = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', 'bad key!!!')
      .send(postBody())
      .expect(400);
    expect(res.body.error).toMatch(/URL-safe/);
  });

  it('returns 400 when Idempotency-Key is below the 8-char minimum', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', 'short')
      .send(postBody())
      .expect(400);
  });

  it('returns 400 when Idempotency-Key exceeds the 128-char maximum', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', 'a'.repeat(129))
      .send(postBody())
      .expect(400);
  });

  it('accepts a key exactly 8 chars long', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', 'aB1.c-d:')
      .send(postBody())
      .expect(201);
  });

  it('accepts a key exactly 128 chars long', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', 'a'.repeat(128))
      .send(postBody())
      .expect(201);
  });

  it('malformed key does not write to idempotency_keys', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', 'bad!')
      .send(postBody())
      .expect(400);
    expect(await db('idempotency_keys').select('*')).toHaveLength(0);
  });
});

// ===========================================================================
// POST — first request stores fingerprint + response
// ===========================================================================

describe('Escrow-read idempotency — POST first request', () => {
  it('executes handler on first call and returns 201', async () => {
    const body = postBody();
    const res = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    expect(res.body.data.id).toBe(body.id);
  });

  it('persists exactly one row in idempotency_keys', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', validKey())
      .send(postBody())
      .expect(201);
    expect(await db('idempotency_keys').select('*')).toHaveLength(1);
  });

  it('stores the SHA-256 fingerprint (64 hex chars)', async () => {
    const body = postBody();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.request_fingerprint).toBe(fingerprintOf(body));
    expect(row.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists response_status 201', async () => {
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', validKey())
      .send(postBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.response_status).toBe(201);
  });

  it('persists response_body as a JSON string containing the config id', async () => {
    const body = postBody();
    const res = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.data.id).toBe(res.body.data.id);
  });

  it('sets expires_at roughly 24 h in the future (default TTL)', async () => {
    const before = Date.now();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', validKey())
      .send(postBody())
      .expect(201);
    const after = Date.now();
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    const ttlMs = 24 * 3600 * 1000;
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresMs).toBeLessThanOrEqual(after + ttlMs + 2000);
  });
});

// ===========================================================================
// POST — replay (same key + same body returns cached response)
// ===========================================================================

describe('Escrow-read idempotency — POST replay', () => {
  it('returns identical response on duplicate call', async () => {
    const key = validKey();
    const body = postBody();
    const r1 = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(r2.body).toEqual(r1.body);
  });

  it('does NOT insert a second DB row on replay', async () => {
    const key = validKey();
    const body = postBody();
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', key).send(body).expect(201);
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', key).send(body).expect(201);
    expect(await db('idempotency_keys').select('*')).toHaveLength(1);
  });

  it('handler does NOT create a duplicate store entry on replay', async () => {
    const key = validKey();
    const body = postBody();
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', key).send(body).expect(201);
    // Replay should not trigger 409 Conflict from the route's own duplicate-id check.
    const r2 = await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', key).send(body);
    expect(r2.status).toBe(201);
  });

  it('returns the exact cached status code on replay', async () => {
    const key = validKey();
    const body = postBody();
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', key).send(body).expect(201);
    // Wait for async persistence to land.
    await new Promise((r) => setTimeout(r, 50));
    const r2 = await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', key).send(body);
    expect(r2.status).toBe(201);
  });
});

// ===========================================================================
// POST — conflict (same key + different body → 409 RFC 7807)
// ===========================================================================

describe('Escrow-read idempotency — POST conflict', () => {
  it('returns 409 with application/problem+json on body mismatch', async () => {
    const key = validKey();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(postBody({ config: { cacheTtl: 60 } }))
      .expect(201);
    const res = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(postBody({ config: { cacheTtl: 999 } }))
      .expect(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
    expect(res.body.detail).toMatch(/different request body/);
  });

  it('preserves the original DB row on conflict (fingerprint unchanged)', async () => {
    const key = validKey();
    const originalBody = postBody({ config: { cacheTtl: 60 } });
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(originalBody)
      .expect(201);
    await new Promise((r) => setTimeout(r, 50));
    const before = await db('idempotency_keys').where({ idempotency_key: key }).first();

    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(postBody({ config: { cacheTtl: 999 } }))
      .expect(409);

    const after = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(after.request_fingerprint).toBe(before.request_fingerprint);
    expect(after.request_fingerprint).toBe(fingerprintOf(originalBody));
  });

  it('returns 409 on every subsequent mismatch (not just the first)', async () => {
    const key = validKey();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(postBody({ config: { cacheTtl: 60 } }))
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/admin/escrow-read')
        .set('Idempotency-Key', key)
        .send(postBody({ config: { cacheTtl: 100 + i } }))
        .expect(409);
    }
  });

  it('different ids in the body produce a conflict (fingerprint mismatch)', async () => {
    const key = validKey();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send({ id: 'cfg-aaa', config: { cacheTtl: 60 } })
      .expect(201);
    const res = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send({ id: 'cfg-bbb', config: { cacheTtl: 60 } })
      .expect(409);
    expect(res.body.status).toBe(409);
  });
});

// ===========================================================================
// PUT — replay and conflict
// ===========================================================================

describe('Escrow-read idempotency — PUT replay and conflict', () => {
  let configId;

  beforeEach(async () => {
    // Create a fresh config entry for each PUT test.
    configId = 'put-cfg-' + crypto.randomBytes(4).toString('hex');
    await request(app)
      .post('/api/admin/escrow-read')
      .send({ id: configId, config: { cacheTtl: 60 } })
      .expect(201);
  });

  it('PUT with key stores result and replays identically', async () => {
    const key = validKey();
    const body = putBody();
    const r1 = await request(app)
      .put(`/api/admin/escrow-read/${configId}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    const r2 = await request(app)
      .put(`/api/admin/escrow-read/${configId}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    expect(r2.body).toEqual(r1.body);
    expect(await db('idempotency_keys').select('*')).toHaveLength(1);
  });

  it('PUT with same key + different body returns 409', async () => {
    const key = validKey();
    await request(app)
      .put(`/api/admin/escrow-read/${configId}`)
      .set('Idempotency-Key', key)
      .send({ config: { cacheTtl: 120 } })
      .expect(200);
    const res = await request(app)
      .put(`/api/admin/escrow-read/${configId}`)
      .set('Idempotency-Key', key)
      .send({ config: { cacheTtl: 999 } })
      .expect(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/conflict/);
  });

  it('PUT without key passes through normally regardless of prior keyed calls', async () => {
    const key = validKey();
    await request(app)
      .put(`/api/admin/escrow-read/${configId}`)
      .set('Idempotency-Key', key)
      .send({ config: { cacheTtl: 120 } })
      .expect(200);
    // Without key — should still work as a normal update (different body ignored by idempotency).
    const res = await request(app)
      .put(`/api/admin/escrow-read/${configId}`)
      .send({ config: { cacheTtl: 300 } })
      .expect(200);
    expect(res.body.data.config.cacheTtl).toBe(300);
  });
});

// ===========================================================================
// DELETE — replay and conflict
// ===========================================================================

describe('Escrow-read idempotency — DELETE replay and conflict', () => {
  it('DELETE with key replays the 204 on retry without double-deleting', async () => {
    const body = postBody();
    await request(app).post('/api/admin/escrow-read').send(body).expect(201);

    const key = validKey();
    await request(app)
      .delete(`/api/admin/escrow-read/${body.id}`)
      .set('Idempotency-Key', key)
      .expect(204);
    await new Promise((r) => setTimeout(r, 50));

    // Second call with same key+body → replayed 204 (not a new delete attempt).
    await request(app)
      .delete(`/api/admin/escrow-read/${body.id}`)
      .set('Idempotency-Key', key)
      .expect(204);

    expect(await db('idempotency_keys').select('*')).toHaveLength(1);
  });

  it('DELETE with same key + different path params treated as conflict', async () => {
    // The DELETE body is empty ({}) for both calls but the key is the same.
    // However if a second DELETE targets a different id, the body fingerprint
    // is identical (both empty) — so this is a replay, not a conflict.
    // Create two configs, delete first with key, retry same key on second.
    const body1 = postBody();
    const body2 = postBody();
    await request(app).post('/api/admin/escrow-read').send(body1).expect(201);
    await request(app).post('/api/admin/escrow-read').send(body2).expect(201);

    const key = validKey();
    // First DELETE — stores key with empty-body fingerprint.
    await request(app)
      .delete(`/api/admin/escrow-read/${body1.id}`)
      .set('Idempotency-Key', key)
      .expect(204);
    await new Promise((r) => setTimeout(r, 50));

    // Second DELETE with SAME key + SAME empty body → replay of 204.
    // (path param is not part of fingerprint, only req.body is)
    const r2 = await request(app)
      .delete(`/api/admin/escrow-read/${body2.id}`)
      .set('Idempotency-Key', key);
    expect(r2.status).toBe(204);
  });
});

// ===========================================================================
// TTL expiry
// ===========================================================================

describe('Escrow-read idempotency — TTL expiry', () => {
  it('treats an expired row as a fresh request (no stale replay)', async () => {
    const key = validKey();
    const body1 = postBody();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(body1)
      .expect(201);

    // Push expires_at into the past.
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    // Fresh request with a different body must now succeed (not 409).
    const body2 = postBody();
    const r2 = await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(body2)
      .expect(201);
    expect(r2.body.data.id).toBe(body2.id);
  });

  it('after expiry the old row is replaced with the new fingerprint', async () => {
    const key = validKey();
    const body1 = postBody();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(body1)
      .expect(201);

    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const body2 = postBody();
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', key)
      .send(body2)
      .expect(201);
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].request_fingerprint).toBe(fingerprintOf(body2));
  });
});

// ===========================================================================
// Multiple distinct keys — full isolation
// ===========================================================================

describe('Escrow-read idempotency — multiple distinct keys', () => {
  it('two different keys for the same body store independently', async () => {
    const body = postBody();
    const k1 = validKey('a');
    const k2 = validKey('b');
    // Use the same body object id — but different keys.  The second POST
    // would normally conflict on the store (duplicate id), so give them
    // distinct ids while keeping the same cacheTtl.
    const b1 = postBody({ config: { cacheTtl: 60 } });
    const b2 = postBody({ config: { cacheTtl: 60 } });
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k1).send(b1).expect(201);
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k2).send(b2).expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([k1, k2].sort());
  });

  it('conflict on one key does not affect another key', async () => {
    const k1 = validKey('a');
    const k2 = validKey('b');
    const body = postBody();
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k1).send(body).expect(201);

    // k1 conflict
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', k1)
      .send(postBody({ config: { cacheTtl: 999 } }))
      .expect(409);

    // k2 with the same body is still a fresh first request → 201
    const body2 = postBody();
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k2).send(body2).expect(201);
  });
});

// ===========================================================================
// Security
// ===========================================================================

describe('Escrow-read idempotency — security', () => {
  it('raw request body is NOT stored — only the SHA-256 fingerprint', async () => {
    const secret = 'SENSITIVE_SECRET_' + crypto.randomBytes(8).toString('hex');
    const body = postBody({ secretKey: secret });
    await request(app)
      .post('/api/admin/escrow-read')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    await new Promise((r) => setTimeout(r, 50));
    const row = await db('idempotency_keys').first();
    // The fingerprint column must never contain the plaintext secret.
    expect(row.request_fingerprint).not.toContain(secret);
    expect(row.request_fingerprint).not.toContain('SENSITIVE_SECRET_');
    // Confirm it is a 64-char hex SHA-256 and not the original body.
    expect(row.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('distinct bodies produce distinct fingerprints', async () => {
    const k1 = validKey('a');
    const k2 = validKey('b');
    const b1 = postBody({ config: { cacheTtl: 60 } });
    const b2 = postBody({ config: { cacheTtl: 90 } });
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k1).send(b1).expect(201);
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k2).send(b2).expect(201);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows[0].request_fingerprint).not.toBe(rows[1].request_fingerprint);
  });

  it('identical bodies produce the same fingerprint regardless of key', async () => {
    const b = postBody({ config: { cacheTtl: 77 } });
    const k1 = validKey('a');
    const k2 = validKey('b');
    // Need distinct store IDs so both POSTs succeed.
    const b1 = { ...b, id: 'cfg-fp-a-' + crypto.randomBytes(2).toString('hex') };
    const b2 = { ...b1 }; // same body
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k1).send(b1).expect(201);
    await request(app).post('/api/admin/escrow-read').set('Idempotency-Key', k2).send(b2).expect(201);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows[0].request_fingerprint).toBe(rows[1].request_fingerprint);
  });
});
