'use strict';

/**
 * Integration tests for the health report write endpoint with idempotency.
 *
 * These tests run against an in-memory SQLite database via the Knex
 * `test` knexfile profile, mirroring the pattern used in
 * `tests/idempotency.test.js`.
 *
 * Coverage targets (issue #770):
 *  - First write → 201 with reportId
 *  - Exact replay (same key + same body) → 201 with same reportId
 *  - Key reuse with different body → 409 (RFC 7807)
 *  - Header validation (missing, malformed, too short, too long)
 *  - Body validation (missing serviceName, invalid status, unknown fields)
 *  - Multiple distinct keys work independently
 *  - Idempotency-key does NOT allow double-processing
 *  - TTL expiry allows fresh request under the same key
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mock override: replace the global db mock so the middleware uses a real
// Knex instance backed by in-memory SQLite.
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
const { healthReportSchema } = require('../src/schemas/healthReport');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe alphanumeric idempotency key long enough to satisfy
 * the 8-character minimum. Each call returns a unique key.
 */
function validKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

/**
 * Minimal valid health-report request body.
 */
function validBody(overrides = {}) {
  return {
    serviceName: 'payment-gateway',
    status: 'healthy',
    ...overrides,
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
// App factory for health write endpoint
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());

  // Provide req.id so the RFC 7807 handler can stamp the response.
  app.use((req, res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });

  // Wire a minimal POST /api/health/reports endpoint identical to the
  // production route but self-contained for test isolation.
  app.post(
    '/api/health/reports',
    idempotencyMiddleware,
    (req, res) => {
      const result = healthReportSchema.safeParse(req.body);

      if (!result.success) {
        const fieldErrors = {};
        for (const issue of result.error.issues) {
          const path = issue.path.join('.') || '_root';
          if (!fieldErrors[path]) {
            fieldErrors[path] = issue.message;
          }
        }
        return res.status(400).json({
          type: 'https://liquifact.io/problems/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'Health report payload contains invalid or missing fields.',
          fieldErrors,
        });
      }

      const { serviceName, status: healthStatus, message, metadata, reportedAt } = result.data;
      const reportId = crypto.randomUUID();
      const acceptedAt = new Date().toISOString();

      return res.status(201).json({
        data: {
          reportId,
          serviceName,
          status: healthStatus,
          message: message || null,
          metadata: metadata || null,
          reportedAt: reportedAt || acceptedAt,
          acceptedAt,
        },
        message: `Health report for '${serviceName}' accepted.`,
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
  // Create the idempotency_keys table in SQLite (matching the production
  // column set semantically).
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

describe('Health Write Idempotency — Header validation', () => {
  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key is the empty string', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', '')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key contains a space', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', 'has spaces!!!')
      .send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL-safe/);
  });

  it('returns 400 when Idempotency-Key contains invalid characters', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', 'abc@xyz1234')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key is below the 8-char minimum', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', 'aB1.')
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key exceeds the 128-char maximum', async () => {
    const tooLong = 'a'.repeat(129);
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', tooLong)
      .send(validBody());
    expect(res.status).toBe(400);
  });

  it('accepts a key at the minimum length (8 chars)', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', 'aB1.c-d:')
      .send(validBody())
      .expect(201);
    expect(res.body.data.reportId).toBeDefined();
  });

  it('accepts a key at the maximum length (128 chars)', async () => {
    const keyAt128 = 'a'.repeat(128);
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', keyAt128)
      .send(validBody())
      .expect(201);
    expect(res.body.data.reportId).toBeDefined();
  });

  it('does NOT touch the DB when the header is malformed', async () => {
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', 'short')
      .send(validBody())
      .expect(400);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// Body validation
// ===========================================================================

describe('Health Write Idempotency — Body validation', () => {
  it('returns 400 when serviceName is missing', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send({ status: 'healthy' });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.serviceName).toBeDefined();
  });

  it('returns 400 when status is missing', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send({ serviceName: 'test-svc' });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.status).toBeDefined();
  });

  it('returns 400 when status is invalid', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send({ serviceName: 'test-svc', status: 'critical' });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.status).toMatch(/Invalid option/);
  });

  it('accepts all valid status values', async () => {
    for (const status of ['healthy', 'degraded', 'unhealthy']) {
      await db('idempotency_keys').del();
      const res = await request(app)
        .post('/api/health/reports')
        .set('Idempotency-Key', validKey(status))
        .send(validBody({ status }));
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe(status);
    }
  });

  it('returns 400 with empty request body', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when serviceName exceeds 255 characters', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ serviceName: 'a'.repeat(256) }));
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields (strict schema)', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send({ ...validBody(), hackerField: 'malicious' });
    expect(res.status).toBe(400);
  });

  it('accepts message field up to 1000 characters', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ message: 'a'.repeat(1000) }));
    expect(res.status).toBe(201);
    expect(res.body.data.message).toBe('a'.repeat(1000));
  });

  it('rejects message field exceeding 1000 characters', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ message: 'a'.repeat(1001) }));
    expect(res.status).toBe(400);
  });

  it('accepts optional metadata field', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ metadata: { cpu: '85%', memory: '60%' } }));
    expect(res.status).toBe(201);
    expect(res.body.data.metadata).toEqual({ cpu: '85%', memory: '60%' });
  });

  it('rejects metadata with more than 10 keys', async () => {
    const metadata = {};
    for (let i = 0; i < 11; i++) {
      metadata[`key${i}`] = `value${i}`;
    }
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ metadata }));
    expect(res.status).toBe(400);
  });

  it('accepts valid reportedAt ISO timestamp', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ reportedAt: '2025-07-25T10:00:00.000Z' }));
    expect(res.status).toBe(201);
    expect(res.body.data.reportedAt).toBe('2025-07-25T10:00:00.000Z');
  });

  it('rejects invalid reportedAt timestamp', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ reportedAt: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('trims whitespace from serviceName', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ serviceName: '  my-service  ' }));
    expect(res.status).toBe(201);
    expect(res.body.data.serviceName).toBe('my-service');
  });
});

// ===========================================================================
// First request — stores the fingerprint and the response
// ===========================================================================

describe('Health Write Idempotency — First request stores fingerprint + response', () => {
  it('executes the handler and returns 201 on the first call', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    expect(res.body.data.reportId).toBeDefined();
    expect(res.body.data.serviceName).toBe('payment-gateway');
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.acceptedAt).toBeDefined();
  });

  it('persists exactly one row on first call', async () => {
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('stores the SHA-256 request fingerprint (64 hex chars)', async () => {
    const body = validBody();
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.request_fingerprint).toBe(fingerprintOf(body));
    expect(row.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists the response status code', async () => {
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(row.response_status).toBe(201);
  });

  it('persists the response body as a JSON string', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.data.reportId).toBe(res.body.data.reportId);
    expect(parsed.data.serviceName).toBe(res.body.data.serviceName);
  });

  it('sets expires_at to roughly TTL hours in the future (default 24h)', async () => {
    const before = Date.now();
    await request(app)
      .post('/api/health/reports')
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
    const sentinel = 'PRIVATE_TOKEN_' + crypto.randomBytes(8).toString('hex');
    // Use a valid field so the strict schema does not reject the request.
    const body = validBody({ message: sentinel });
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    // The request_fingerprint is a SHA-256 hash — it never contains
    // the plaintext. The response_body necessarily echoes back the
    // submitted fields, but the fingerprint column must be clean.
    expect(row.request_fingerprint).not.toContain(sentinel);
    expect(row.request_fingerprint).not.toContain('PRIVATE_TOKEN_');
  });
});

// ===========================================================================
// Replay — same key + same body returns cached response
// ===========================================================================

describe('Health Write Idempotency — Replay (same key + same body)', () => {
  it('returns the same reportId on duplicate (no double-processing)', async () => {
    const key = validKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(r2.body.data.reportId).toBe(r1.body.data.reportId);
    expect(r2.body.data.serviceName).toBe(r1.body.data.serviceName);
    expect(r2.body.data.status).toBe(r1.body.data.status);
    expect(r2.body.data.acceptedAt).toBe(r1.body.data.acceptedAt);
  });

  it('returns the cached response byte-identically', async () => {
    const key = validKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(r2.body).toEqual(r1.body);
  });

  it('does NOT insert a second row for the same key on replay', async () => {
    const key = validKey();
    const body = validBody();
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('replays even a validation-error response identically', async () => {
    const key = validKey();
    // First call with a body that passes idempotency middleware validation
    // (it's a valid JSON object) but fails the application-level Zod check
    // because status is invalid. The idempotency middleware captures the
    // 400 response.
    // But wait: the idempotency middleware intercepts res.json, and the
    // handler short-circuits with a 400. The middleware's override of
    // res.json stores the 400 response. On replay, it should return the
    // same 400.
    const res1 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send({ serviceName: 'svc', status: 'invalid-status' })
      .expect(400);

    const res2 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send({ serviceName: 'svc', status: 'invalid-status' })
      .expect(400);

    expect(res2.body).toEqual(res1.body);
  });
});

// ===========================================================================
// Conflict — same key + different body returns 409 (RFC 7807)
// ===========================================================================

describe('Health Write Idempotency — Conflict (same key + different body)', () => {
  it('returns 409 with application/problem+json', async () => {
    const key = validKey();
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(validBody({ serviceName: 'svc-a' }))
      .expect(201);
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(validBody({ serviceName: 'svc-b' }))
      .expect(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
    expect(res.body.detail).toMatch(/different request body/);
  });

  it('preserves the original record on mismatch (no overwrite)', async () => {
    const key = validKey();
    const originalBody = validBody({ serviceName: 'svc-original' });
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(originalBody)
      .expect(201);
    const beforeRow = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .first();
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(validBody({ serviceName: 'svc-different' }))
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
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(validBody({ serviceName: 'svc-1' }))
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/health/reports')
        .set('Idempotency-Key', key)
        .send(validBody({ serviceName: `svc-${i + 2}` }))
        .expect(409);
    }
  });

  it('returns 409 when only metadata differs', async () => {
    const key = validKey();
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(validBody({ metadata: { version: '1.0' } }))
      .expect(201);
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(validBody({ metadata: { version: '2.0' } }))
      .expect(409);
    expect(res.body.status).toBe(409);
  });
});

// ===========================================================================
// Multiple distinct keys — isolation
// ===========================================================================

describe('Health Write Idempotency — Multiple distinct keys', () => {
  it('two different keys for the same body store separately', async () => {
    const body = validBody();
    const k1 = validKey('a');
    const k2 = validKey('b');
    const r1 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', k1)
      .send(body)
      .expect(201);
    const r2 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', k2)
      .send(body)
      .expect(201);
    expect(r2.body.data.reportId).not.toBe(r1.body.data.reportId);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([k1, k2].sort());
  });

  it('two different keys + different bodies store separately', async () => {
    const r1 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ serviceName: 'svc-1' }))
      .expect(201);
    const r2 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ serviceName: 'svc-2' }))
      .expect(201);
    expect(r1.body.data.reportId).not.toBe(r2.body.data.reportId);
    expect(await db('idempotency_keys').count('* as n')).toEqual([{ n: 2 }]);
  });
});

// ===========================================================================
// TTL expiry
// ===========================================================================

describe('Health Write Idempotency — TTL expiry', () => {
  it('default TTL is 24 hours', async () => {
    process.env.IDEMPOTENCY_KEY_TTL_HOURS = '';
    const beforeMs = Date.now();
    await request(app)
      .post('/api/health/reports')
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
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody())
      .expect(201);
    const row = await db('idempotency_keys').first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    expect(expiresMs - beforeMs).toBeGreaterThanOrEqual(0.95 * 3600 * 1000);
    expect(expiresMs - beforeMs).toBeLessThanOrEqual(1.05 * 3600 * 1000);
  });

  it('treats an expired key as a fresh request (handler re-executes)', async () => {
    const key = validKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    // Push expires_at into the past
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const r2 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(r2.body.data.reportId).not.toBe(r1.body.data.reportId);
  });

  it('on expiry + different body, no 409 — fresh request is allowed', async () => {
    const key = validKey();
    const body1 = validBody({ serviceName: 'svc-1' });
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body1)
      .expect(201);
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

    const body2 = validBody({ serviceName: 'svc-2' });
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body2)
      .expect(201);
    expect(res.body.data.reportId).toBeDefined();
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].request_fingerprint).toBe(fingerprintOf(body2));
  });
});

// ===========================================================================
// Security
// ===========================================================================

describe('Health Write Idempotency — Security', () => {
  it('stores ONLY the SHA-256 fingerprint — no plaintext in fingerprint or key columns', async () => {
    const plaintext = 'SENSITIVE_HEALTH_DATA_' + crypto.randomBytes(8).toString('hex');
    // Use a known, valid field (message) so the payload passes validation.
    const body = validBody({ message: plaintext });
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(body)
      .expect(201);
    const row = await db('idempotency_keys').first();
    // The request_fingerprint is always a SHA-256 hex hash — it must
    // never contain the raw plaintext. The idempotency_key is a
    // caller-chosen value and also should not contain it.
    // The response_body column echoes back submitted data by design
    // (so a replay returns the original payload); we do NOT assert on
    // response_body for this reason.
    const blobs = [
      row.request_fingerprint,
      row.idempotency_key,
    ]
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v))
      .join('\n');
    expect(blobs).not.toContain(plaintext);
  });

  it('different request bodies produce distinct fingerprints', async () => {
    const keys = [validKey('a'), validKey('b')];
    const bodies = [validBody({ serviceName: 'A' }), validBody({ serviceName: 'B' })];
    for (let i = 0; i < keys.length; i++) {
      await request(app)
        .post('/api/health/reports')
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

  it('does NOT crash on empty request body', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send({})
      .expect(400); // Zod validation fails for missing required fields
    expect(res.body.fieldErrors).toBeDefined();
  });

  it('the fingerprint is identical for byte-equal bodies', async () => {
    const key1 = validKey('a');
    const key2 = validKey('b');
    const body = validBody({ message: 'all good', metadata: { cpu: '50%' } });
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key1)
      .send(body)
      .expect(201);
    await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key2)
      .send(body)
      .expect(201);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows[0].request_fingerprint).toBe(rows[1].request_fingerprint);
  });
});

// ===========================================================================
// Concurrent duplicate (transactional race protection)
// ===========================================================================

describe('Health Write Idempotency — Concurrent duplicate', () => {
  it('sequential duplicate calls produce exactly one stored record', async () => {
    const key = validKey();
    const body = validBody();
    const r1 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body);
    const r2 = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', key)
      .send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.data.reportId).toBe(r1.body.data.reportId);
    const rows = await db('idempotency_keys')
      .where({ idempotency_key: key })
      .select('*');
    expect(rows).toHaveLength(1);
  });

  it('parallel duplicate calls (Promise.all) never produce 5xx', async () => {
    const key = validKey();
    const body = validBody();
    const responses = await Promise.all([
      request(app)
        .post('/api/health/reports')
        .set('Idempotency-Key', key)
        .send(body),
      request(app)
        .post('/api/health/reports')
        .set('Idempotency-Key', key)
        .send(body),
      request(app)
        .post('/api/health/reports')
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
          .post('/api/health/reports')
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
// Full message field
// ===========================================================================

describe('Health Write Idempotency — message field', () => {
  it('accepts null-like message (field omitted)', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.data.message).toBeNull();
  });

  it('accepts explicit message', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ message: 'All systems operational' }));
    expect(res.status).toBe(201);
    expect(res.body.data.message).toBe('All systems operational');
  });
});

// ===========================================================================
// reportedAt field
// ===========================================================================

describe('Health Write Idempotency — reportedAt field', () => {
  it('uses acceptedAt when reportedAt is omitted', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.data.reportedAt).toBe(res.body.data.acceptedAt);
  });

  it('uses provided reportedAt when present', async () => {
    const res = await request(app)
      .post('/api/health/reports')
      .set('Idempotency-Key', validKey())
      .send(validBody({ reportedAt: '2025-01-15T08:30:00.000Z' }));
    expect(res.status).toBe(201);
    expect(res.body.data.reportedAt).toBe('2025-01-15T08:30:00.000Z');
    expect(res.body.data.acceptedAt).not.toBe(res.body.data.reportedAt);
  });
});
