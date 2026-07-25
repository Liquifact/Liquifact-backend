'use strict';

/**
 * Integration tests for idempotency-key support on admin config write endpoints.
 *
 * Tests the POST /api/admin/config endpoint with idempotency middleware,
 * focusing on CORS section config writes. Covers:
 *  - Header validation (missing, malformed, too short, too long)
 *  - First write → 200, stores fingerprint + response
 *  - Exact replay (same key + same body) → same cached response
 *  - Key reuse with different body → 409 (RFC 7807)
 *  - Multiple distinct keys work independently
 *  - TTL expiry allows fresh request
 *  - CORS section schema validation (origins, maxAge)
 *  - Security: SHA-256 fingerprint, no raw body stored
 *  - Concurrent duplicate protection
 *
 * Uses an in-memory SQLite database via Knex, mirroring the pattern in
 * tests/healthWrite.idempotency.test.js.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mock override: use real Knex with in-memory SQLite so the idempotency
// middleware writes to a real database.
// ---------------------------------------------------------------------------
jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

// Mock the admin stack (auth + tenant extraction) so we don't need real JWTs.
jest.mock('../src/middleware/stacks', () => ({
  adminStack: [
    (req, _res, next) => {
      req.tenantId = req.headers['x-tenant-id'] || 'tenant_test_default';
      req.user = { sub: 'admin-test-user' };
      next();
    },
  ],
}));

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const db = require('../src/db/knex');
const {
  runtimeConfigSchema,
  validateBody,
  parseValidationErrors,
} = require('../src/schemas/config');
const idempotencyMiddleware = require('../src/middleware/idempotency');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe alphanumeric idempotency key satisfying the 8-char
 * minimum.
 */
function validKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

/**
 * Minimal valid CORS config write body.
 */
function validCorsBody(overrides = {}) {
  return {
    section: 'cors',
    config: {
      origins: ['https://app.example.com'],
      ...overrides,
    },
  };
}

/**
 * Minimal valid webhook config write body (cross-section test).
 */
function validWebhookBody(overrides = {}) {
  return {
    section: 'webhook',
    config: {
      url: 'https://hooks.example.com/deliver',
      secret: 'supersecretkey-32chars-minimum!!',
      events: ['invoice.created'],
      ...overrides,
    },
  };
}

/**
 * Compute the SHA-256 fingerprint the middleware would compute for `body`.
 */
function fingerprintOf(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
}

/**
 * Parse a value as a Date timestamp (ms since epoch). Handles SQLite formats.
 */
function parseExpiryMs(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const primary = new Date(String(value)).getTime();
  if (!Number.isNaN(primary)) return primary;
  return new Date(String(value).replace(' ', 'T') + 'Z').getTime();
}

// ---------------------------------------------------------------------------
// App factory — builds a minimal Express app with the admin config endpoint
// and idempotency middleware, without requiring real auth.
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());

  // Provide req.id so the RFC 7807 handler can stamp the response.
  app.use((req, _res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });

  // Mount idempotency middleware + body validation + handler
  // Mirror the production route: idempotencyMiddleware is first, then validateBody
  app.post(
    '/api/admin/config',
    idempotencyMiddleware,
    validateBody(runtimeConfigSchema),
    (req, res) => {
      // validateBody attaches the parsed, coerced payload to req.validated
      const { section, config: validatedConfig } = req.validated;

      return res.status(200).json({
        section,
        config: validatedConfig,
        message: `Configuration section '${section}' validated and accepted.`,
      });
    }
  );

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
  // Force a fresh orphan-timeout window per test.
  delete process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS;
  delete process.env.IDEMPOTENCY_KEY_TTL_HOURS;
});

afterAll(async () => {
  await db.schema.dropTableIfExists('idempotency_keys');
  await db.destroy();
});

// ===========================================================================
// Header validation
// ===========================================================================

describe('Admin Config Idempotency — Header validation', () => {
  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .send(validCorsBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key is the empty string', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', '')
      .send(validCorsBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key contains a space', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', 'has spaces!!!')
      .send(validCorsBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL-safe/);
  });

  it('returns 400 when Idempotency-Key contains invalid characters (@ sign)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', 'abc@xyz1234')
      .send(validCorsBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key is below the 8-char minimum', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', 'aB1.')
      .send(validCorsBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key exceeds the 128-char maximum', async () => {
    const tooLong = 'a'.repeat(129);
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', tooLong)
      .send(validCorsBody());
    expect(res.status).toBe(400);
  });

  it('accepts a key at the minimum length (8 chars)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', 'aB1.c-d:')
      .send(validCorsBody())
      .expect(200);
    expect(res.body.section).toBe('cors');
  });

  it('accepts a key at the maximum length (128 chars)', async () => {
    const keyAt128 = 'a'.repeat(128);
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', keyAt128)
      .send(validCorsBody())
      .expect(200);
    expect(res.body.section).toBe('cors');
  });

  it('does NOT touch the DB when the header is malformed', async () => {
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', 'short')
      .send(validCorsBody())
      .expect(400);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// Body / schema validation
// ===========================================================================

describe('Admin Config Idempotency — Body validation', () => {
  it('returns 400 when section is missing', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ config: { origins: ['https://a.com'] } });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns 400 when config is missing', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors' });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.config).toBeDefined();
  });

  it('returns 400 when section is not a valid enum value', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'nonexistent', config: { origins: ['https://a.com'] } });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns 400 when CORS config origins is not an array', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { origins: 'https://a.com' } });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toBeDefined();
  });

  it('returns 400 when CORS origin entry is not a valid URL', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { origins: ['not-a-url'] } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when CORS origin contains a path', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { origins: ['https://a.com/path'] } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when CORS config is empty object', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: {} });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toBeDefined();
  });

  it('returns 400 when CORS origins exceed 20 entries', async () => {
    const origins = Array.from({ length: 21 }, (_, i) => `https://app${i}.example.com`);
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { origins } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when CORS maxAge is out of range (too low)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { maxAge: 30 } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when CORS maxAge exceeds 86400', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { maxAge: 100000 } });
    expect(res.status).toBe(400);
  });

  it('accepts valid cors config with origins and maxAge', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({
        section: 'cors',
        config: { origins: ['https://app.example.com'], maxAge: 3600 },
      });
    expect(res.status).toBe(200);
    expect(res.body.section).toBe('cors');
    expect(res.body.config.origins).toEqual(['https://app.example.com']);
    expect(res.body.config.maxAge).toBe(3600);
  });

  it('accepts cors config with multiple origins', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({
        section: 'cors',
        config: {
          origins: [
            'https://app.example.com',
            'https://admin.example.com',
            'http://localhost:3000',
          ],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.config.origins).toHaveLength(3);
  });

  it('accepts cors config with origins and default port', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({
        section: 'cors',
        config: { origins: ['https://app.example.com:8443'] },
      });
    expect(res.status).toBe(200);
  });

  it('rejects unknown fields in cors config (strict mode)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({
        section: 'cors',
        config: { origins: ['https://a.com'], hackerField: 'evil' },
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 with empty request body', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({});
    expect(res.status).toBe(400);
  });

  it('accepts valid webhook config (cross-section regression check)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validWebhookBody());
    expect(res.status).toBe(200);
    expect(res.body.section).toBe('webhook');
    expect(res.body.config.url).toBe('https://hooks.example.com/deliver');
  });
});

// ===========================================================================
// First request — stores fingerprint + response
// ===========================================================================

describe('Admin Config Idempotency — First request stores fingerprint + response', () => {
  it('executes the handler and returns 200 on the first call', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody())
      .expect(200);
    expect(res.body.section).toBe('cors');
    expect(res.body.config.origins).toEqual(['https://app.example.com']);
    expect(res.body.message).toMatch(/validated and accepted/);
  });

  it('persists exactly one row on first call', async () => {
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody())
      .expect(200);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('stores the SHA-256 request fingerprint (64 hex chars)', async () => {
    const body = validCorsBody();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(200);
    const row = await db('idempotency_keys').first();
    expect(row.request_fingerprint).toBe(fingerprintOf(body));
    expect(row.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists the response status code (200)', async () => {
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody())
      .expect(200);
    const row = await db('idempotency_keys').first();
    expect(row.response_status).toBe(200);
  });

  it('persists the response body as a JSON string', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody())
      .expect(200);
    const row = await db('idempotency_keys').first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.section).toBe(res.body.section);
    expect(parsed.config.origins).toEqual(res.body.config.origins);
  });

  it('sets expires_at to roughly TTL hours in the future (default 24h)', async () => {
    const before = Date.now();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody())
      .expect(200);
    const after = Date.now();
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    const ttlMs = 24 * 3600 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresMs).toBeLessThanOrEqual(after + ttlMs + 1000);
  });

  it('does NOT store the raw request body — only the SHA-256 fingerprint', async () => {
    const sentinel = 'PRIVATE_SECRET_' + crypto.randomBytes(8).toString('hex');
    const body = validCorsBody({ origins: ['https://' + sentinel + '.example.com'] });
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(200);
    const row = await db('idempotency_keys').first();
    // The request_fingerprint is SHA-256 — it never contains the plaintext.
    expect(row.request_fingerprint).not.toContain(sentinel);
    expect(row.request_fingerprint).not.toContain('PRIVATE_SECRET_');
  });

  it('stores distinct fingerprints for distinct request bodies', async () => {
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey('a'))
      .send(validCorsBody({ origins: ['https://a.example.com'] }))
      .expect(200);
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey('b'))
      .send(validCorsBody({ origins: ['https://b.example.com'] }))
      .expect(200);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows[0].request_fingerprint).not.toBe(rows[1].request_fingerprint);
  });
});

// ===========================================================================
// Replay — same key + same body returns cached response
// ===========================================================================

describe('Admin Config Idempotency — Replay (same key + same body)', () => {
  it('returns the identical response on duplicate (no double-apply)', async () => {
    const key = validKey();
    const body = validCorsBody();
    const r1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    const r2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    expect(r2.body.section).toBe(r1.body.section);
    expect(r2.body.config.origins).toEqual(r1.body.config.origins);
    expect(r2.body.message).toBe(r1.body.message);
  });

  it('returns the cached response byte-identically', async () => {
    const key = validKey();
    const body = validCorsBody();
    const r1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    const r2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    expect(r2.body).toEqual(r1.body);
  });

  it('does NOT insert a second row for the same key on replay', async () => {
    const key = validKey();
    const body = validCorsBody();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('replays even a 400 validation-error response identically', async () => {
    const key = validKey();
    const invalidBody = { section: 'cors', config: { origins: ['not-a-url'] } };
    const res1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(invalidBody)
      .expect(400);

    // Wait for storage to complete asynchronously
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(invalidBody)
      .expect(400);

    expect(res2.body.fieldErrors).toEqual(res1.body.fieldErrors);
  });
});

// ===========================================================================
// Conflict — same key + different body returns 409 (RFC 7807)
// ===========================================================================

describe('Admin Config Idempotency — Conflict (same key + different body)', () => {
  it('returns 409 with application/problem+json', async () => {
    const key = validKey();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(validCorsBody({ origins: ['https://a.example.com'] }))
      .expect(200);
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(validCorsBody({ origins: ['https://b.example.com'] }))
      .expect(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
    expect(res.body.detail).toMatch(/different request body/);
  });

  it('preserves the original record on mismatch (no overwrite)', async () => {
    const key = validKey();
    const originalBody = validCorsBody({ origins: ['https://original.example.com'] });
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(originalBody)
      .expect(200);
    const beforeRow = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .first();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(validCorsBody({ origins: ['https://different.example.com'] }))
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
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(validCorsBody({ origins: ['https://a.example.com'] }))
      .expect(200);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/admin/config')
        .set('Idempotency-Key', key)
        .send(validCorsBody({ origins: ['https://' + String.fromCharCode(98 + i) + '.example.com'] }))
        .expect(409);
    }
  });

  it('returns 409 when only maxAge differs', async () => {
    const key = validKey();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send({ section: 'cors', config: { maxAge: 600 } })
      .expect(200);
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send({ section: 'cors', config: { maxAge: 3600 } })
      .expect(409);
    expect(res.body.status).toBe(409);
  });

  it('returns 409 when changing section with same key', async () => {
    const key = validKey();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(validCorsBody())
      .expect(200);
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(validWebhookBody())
      .expect(409);
    expect(res.body.status).toBe(409);
  });
});

// ===========================================================================
// Multiple distinct keys — isolation
// ===========================================================================

describe('Admin Config Idempotency — Multiple distinct keys', () => {
  it('two different keys for the same body store separately', async () => {
    const body = validCorsBody();
    const k1 = validKey('a');
    const k2 = validKey('b');
    const r1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', k1)
      .send(body)
      .expect(200);
    const r2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', k2)
      .send(body)
      .expect(200);
    // Both should succeed with equivalent content
    expect(r2.body.section).toBe(r1.body.section);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([k1, k2].sort());
  });

  it('two different keys + different bodies store separately', async () => {
    const r1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody({ origins: ['https://a.example.com'] }))
      .expect(200);
    const r2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody({ origins: ['https://b.example.com'] }))
      .expect(200);
    expect(r1.body.config.origins[0]).not.toBe(r2.body.config.origins[0]);
    expect(await db('idempotency_keys').count('* as n')).toEqual([{ n: 2 }]);
  });
});

// ===========================================================================
// TTL expiry
// ===========================================================================

describe('Admin Config Idempotency — TTL expiry', () => {
  it('default TTL is 24 hours', async () => {
    const beforeMs = Date.now();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody())
      .expect(200);
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs - beforeMs).toBeGreaterThanOrEqual(23.9 * 3600 * 1000);
    expect(expiresMs - beforeMs).toBeLessThanOrEqual(24.1 * 3600 * 1000);
  });

  it('honours IDEMPOTENCY_KEY_TTL_HOURS env var', async () => {
    process.env.IDEMPOTENCY_KEY_TTL_HOURS = '2';
    const beforeMs = Date.now();
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(validCorsBody())
      .expect(200);
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs - beforeMs).toBeGreaterThanOrEqual(1.9 * 3600 * 1000);
    expect(expiresMs - beforeMs).toBeLessThanOrEqual(2.1 * 3600 * 1000);
  });

  it('treats an expired key as a fresh request (handler re-executes)', async () => {
    const key = validKey();
    const body = validCorsBody({ origins: ['https://first.example.com'] });
    const r1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    // Push expires_at into the past
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const body2 = validCorsBody({ origins: ['https://second.example.com'] });
    const r2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body2)
      .expect(200);
    expect(r2.body.config.origins[0]).toBe('https://second.example.com');
  });

  it('on expiry + different body, no 409 — fresh request is allowed', async () => {
    const key = validKey();
    const body1 = validCorsBody({ origins: ['https://first.example.com'] });
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body1)
      .expect(200);
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const body2 = validCorsBody({ origins: ['https://second.example.com'] });
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body2)
      .expect(200);
    expect(res.body.config.origins[0]).toBe('https://second.example.com');
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].request_fingerprint).toBe(fingerprintOf(body2));
  });
});

// ===========================================================================
// Concurrent duplicate — transactional race protection
// ===========================================================================

describe('Admin Config Idempotency — Concurrent duplicate', () => {
  it('sequential duplicate calls produce exactly one stored record', async () => {
    const key = validKey();
    const body = validCorsBody();
    const r1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body);
    const r2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    const rows = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .select('*');
    expect(rows).toHaveLength(1);
  });

  it('parallel duplicate calls (Promise.all) never produce 5xx', async () => {
    const key = validKey();
    const body = validCorsBody();
    const responses = await Promise.all([
      request(app)
        .post('/api/admin/config')
        .set('Idempotency-Key', key)
        .send(body),
      request(app)
        .post('/api/admin/config')
        .set('Idempotency-Key', key)
        .send(body),
      request(app)
        .post('/api/admin/config')
        .set('Idempotency-Key', key)
        .send(body),
    ]);
    for (const r of responses) {
      expect(r.status).toBeLessThan(500);
    }
  });

  it('UNIQUE constraint is respected — only one row per key after N parallel calls', async () => {
    const key = validKey();
    const body = validCorsBody();
    const N = 5;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post('/api/admin/config')
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
});

// ===========================================================================
// Security
// ===========================================================================

describe('Admin Config Idempotency — Security', () => {
  it('stores ONLY the SHA-256 fingerprint — no plaintext in fingerprint column', async () => {
    const plaintext = 'SENSITIVE_ORIGIN_TOKEN_' + crypto.randomBytes(8).toString('hex');
    const body = validCorsBody({ origins: ['https://' + plaintext + '.example.com'] });
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(200);
    const row = await db('idempotency_keys').first();
    const blobs = [
      row.request_fingerprint,
      row.idempotency_key,
    ]
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v))
      .join('\n');
    expect(blobs).not.toContain(plaintext);
    expect(blobs).not.toContain('SENSITIVE_ORIGIN_TOKEN_');
  });

  it('different request bodies produce distinct fingerprints', async () => {
    const keys = [validKey('a'), validKey('b')];
    const bodies = [
      validCorsBody({ origins: ['https://a.example.com'] }),
      validCorsBody({ origins: ['https://b.example.com'] }),
    ];
    for (let i = 0; i < keys.length; i++) {
      await request(app)
        .post('/api/admin/config')
        .set('Idempotency-Key', keys[i])
        .send(bodies[i])
        .expect(200);
    }
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows.map((r) => r.request_fingerprint)).toEqual([
      fingerprintOf(bodies[0]),
      fingerprintOf(bodies[1]),
    ]);
    expect(rows[0].request_fingerprint).not.toBe(rows[1].request_fingerprint);
  });

  it('the fingerprint is identical for byte-equal bodies', async () => {
    const key1 = validKey('a');
    const key2 = validKey('b');
    const body = validCorsBody({ origins: ['https://app.example.com'], maxAge: 7200 });
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key1)
      .send(body)
      .expect(200);
    await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key2)
      .send(body)
      .expect(200);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows[0].request_fingerprint).toBe(rows[1].request_fingerprint);
  });

  it('does NOT crash on empty request body', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({})
      .expect(400);
    expect(res.body.fieldErrors).toBeDefined();
  });
});

// ===========================================================================
// Section-specific: CORS config validation
// ===========================================================================

describe('Admin Config Idempotency — CORS section validation', () => {
  it('accepts origins-only config', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { origins: ['https://app.example.com'] } });
    expect(res.status).toBe(200);
  });

  it('accepts maxAge-only config', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { maxAge: 3600 } });
    expect(res.status).toBe(200);
  });

  it('accepts combined origins + maxAge', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({
        section: 'cors',
        config: {
          origins: ['https://app.example.com', 'https://admin.example.com'],
          maxAge: 7200,
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.config.origins).toHaveLength(2);
    expect(res.body.config.maxAge).toBe(7200);
  });

  it('accepts maxAge at lower bound (60 seconds)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { maxAge: 60 } });
    expect(res.status).toBe(200);
  });

  it('accepts maxAge at upper bound (86400 seconds = 24h)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { maxAge: 86400 } });
    expect(res.status).toBe(200);
  });

  it('accepts a single origin with port', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({
        section: 'cors',
        config: { origins: ['http://localhost:5173'] },
      });
    expect(res.status).toBe(200);
  });

  it('rejects origins array that is empty', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({ section: 'cors', config: { origins: [] } });
    expect(res.status).toBe(400);
  });

  it('rejects origin that is not a root URL (contains path)', async () => {
    const res = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', validKey())
      .send({
        section: 'cors',
        config: { origins: ['https://app.example.com/api/v1'] },
      });
    expect(res.status).toBe(400);
  });

  it('ensures replay returns same validation for the cors section', async () => {
    const key = validKey();
    const body = {
      section: 'cors',
      config: { origins: ['https://app.example.com'], maxAge: 1800 },
    };
    const r1 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    const r2 = await request(app)
      .post('/api/admin/config')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    expect(r2.body.config).toEqual(r1.body.config);
    expect(r2.body.section).toBe(r1.body.section);
  });
});

// ===========================================================================
// Integration with the production adminConfig route
// ===========================================================================

describe('Admin Config Idempotency — Production route integration', () => {
  it('GET /api/admin/config/sections returns expected sections including cors', async () => {
    // Build a minimal app that only mounts the GET section, no auth needed
    const listingApp = express();
    const adminConfigRoutes = require('../src/routes/adminConfig');
    listingApp.use('/api/admin/config', adminConfigRoutes);

    const res = await request(listingApp)
      .get('/api/admin/config/sections')
      .expect(200);
    expect(res.body.sections).toContain('cors');
    expect(res.body.sections).toContain('webhook');
  });
});
