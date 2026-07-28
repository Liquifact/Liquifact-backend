'use strict';

/**
 * Integration tests for multipart-aware idempotency middleware.
 *
 * POST /api/sme/invoice accepts multipart/form-data. The standard
 * idempotencyMiddleware only fingerprints req.body (JSON fields), so a retry
 * with a different file would sneak past the conflict check. The
 * multipartIdempotency middleware fingerprints BOTH the form fields and the
 * file buffer to prevent double-upload on retries.
 *
 * Coverage:
 *  - multipartFingerprint() unit tests (determinism, field-order independence,
 *    file-content sensitivity, no-file fallback)
 *  - Header validation (missing, malformed, too short, too long)
 *  - First upload stores fingerprint + response
 *  - Exact replay (same key + same fields + same file) returns cached response
 *  - Key reuse with different file → 409 Conflict (RFC 7807)
 *  - Key reuse with different form field → 409 Conflict
 *  - Key reuse with same fields but no file vs. file → 409 Conflict
 *  - TTL expiry allows fresh request under the same key
 *  - Orphan in-flight recovery
 *  - Concurrent duplicate protection (UNIQUE constraint)
 *  - No raw file content stored (only SHA-256 fingerprint)
 *  - Optional variant: passes through when header is absent
 */

// ---------------------------------------------------------------------------
// Override the global db mock so middleware uses a real Knex / SQLite instance
// ---------------------------------------------------------------------------
jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');

const db = require('../src/db/knex');
const {
  multipartIdempotencyMiddleware,
  optionalMultipartIdempotency,
  multipartFingerprint,
} = require('../src/middleware/multipartIdempotency');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique, valid idempotency key (≥ 8 URL-safe chars). */
function validKey(suffix = '') {
  return 'ik_' + crypto.randomBytes(8).toString('hex') + suffix;
}

/** Minimal fake PDF buffer. */
function fakePdf(label = 'A') {
  return Buffer.from(`%PDF-fake-content-${label}`);
}

/** Compute the fingerprint the middleware would store for given fields + buffer. */
function expectedFingerprint(fields, buf) {
  return multipartFingerprint(fields || {}, buf || null);
}

/** Parse expires_at from SQLite (handles ISO string, numeric epoch, or bare datetime). */
function parseExpiryMs(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const primary = new Date(String(value)).getTime();
  if (!Number.isNaN(primary)) return primary;
  return new Date(String(value).replace(' ', 'T') + 'Z').getTime();
}

// ---------------------------------------------------------------------------
// Express app factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app that mirrors the real POST /api/sme/invoice
 * middleware stack: multer → optionalMultipartIdempotency → handler.
 *
 * @param {{ mandatory?: boolean, handlerFn?: Function }} opts
 */
function buildApp(opts = {}) {
  const app = express();

  // Attach a request id (needed by problemJson)
  app.use((req, _res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });

  const upload = multer({ storage: multer.memoryStorage() });

  const idempotencyMw = opts.mandatory
    ? multipartIdempotencyMiddleware
    : optionalMultipartIdempotency;

  const handler =
    opts.handlerFn ||
    ((req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'file required' });
      }
      const uploadId = crypto.randomUUID();
      return res.status(200).json({
        uploadId,
        invoiceId: req.body.invoiceId || null,
        originalname: req.file.originalname,
        size: req.file.size,
      });
    });

  app.post(
    '/api/sme/invoice',
    upload.single('invoice'),
    idempotencyMw,
    handler
  );

  return app;
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
  delete process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS;
  delete process.env.IDEMPOTENCY_KEY_TTL_HOURS;
});

afterAll(async () => {
  await db.destroy();
});

// ===========================================================================
// Unit: multipartFingerprint()
// ===========================================================================

describe('multipartFingerprint()', () => {
  it('returns a 64-char lowercase hex string', () => {
    const fp = multipartFingerprint({}, fakePdf());
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic — same inputs produce the same fingerprint', () => {
    const fields = { invoiceId: 'inv-1' };
    const buf = fakePdf('X');
    expect(multipartFingerprint(fields, buf)).toBe(
      multipartFingerprint(fields, buf)
    );
  });

  it('differs when the file content changes', () => {
    const fields = { invoiceId: 'inv-1' };
    const fp1 = multipartFingerprint(fields, fakePdf('A'));
    const fp2 = multipartFingerprint(fields, fakePdf('B'));
    expect(fp1).not.toBe(fp2);
  });

  it('differs when a form field changes', () => {
    const buf = fakePdf('Z');
    const fp1 = multipartFingerprint({ invoiceId: 'inv-1' }, buf);
    const fp2 = multipartFingerprint({ invoiceId: 'inv-2' }, buf);
    expect(fp1).not.toBe(fp2);
  });

  it('is field-order independent (sorted keys)', () => {
    const buf = fakePdf('Y');
    const fp1 = multipartFingerprint({ a: '1', b: '2' }, buf);
    const fp2 = multipartFingerprint({ b: '2', a: '1' }, buf);
    expect(fp1).toBe(fp2);
  });

  it('handles null / undefined / empty buffer (no file)', () => {
    const fp1 = multipartFingerprint({ invoiceId: 'inv-1' }, null);
    const fp2 = multipartFingerprint({ invoiceId: 'inv-1' }, undefined);
    const fp3 = multipartFingerprint({ invoiceId: 'inv-1' }, Buffer.alloc(0));
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles null / undefined formFields gracefully', () => {
    const buf = fakePdf('Q');
    const fp1 = multipartFingerprint(null, buf);
    const fp2 = multipartFingerprint(undefined, buf);
    const fp3 = multipartFingerprint({}, buf);
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);
  });

  it('differs when file is present vs. absent', () => {
    const fields = {};
    const fpFile = multipartFingerprint(fields, fakePdf('A'));
    const fpNoFile = multipartFingerprint(fields, null);
    expect(fpFile).not.toBe(fpNoFile);
  });
});

// ===========================================================================
// Header validation
// ===========================================================================

describe('Multipart Idempotency — Header validation (mandatory)', () => {
  let app;
  beforeAll(() => {
    app = buildApp({ mandatory: true });
  });

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header is required/);
  });

  it('returns 400 when Idempotency-Key contains spaces', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', 'has spaces!!!')
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL-safe/);
  });

  it('returns 400 when Idempotency-Key is shorter than 8 chars', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', 'abc123')
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(400);
  });

  it('returns 400 when Idempotency-Key is longer than 128 chars', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', 'a'.repeat(129))
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(400);
  });

  it('accepts a key exactly 8 chars long', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', 'aB1.c-d:')
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(200);
  });

  it('accepts a key exactly 128 chars long', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', 'a'.repeat(128))
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(200);
  });

  it('does NOT write to the DB when the key is malformed', async () => {
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', 'bad key!')
      .attach('invoice', fakePdf(), 'invoice.pdf');
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// Optional variant passes through when header is absent
// ===========================================================================

describe('Multipart Idempotency — Optional variant', () => {
  let app;
  beforeAll(() => {
    app = buildApp({ mandatory: false });
  });

  it('passes through to the handler when no Idempotency-Key is sent', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(200);
    expect(res.body.uploadId).toBeDefined();
    // No row stored when header is absent
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(0);
  });

  it('activates idempotency when Idempotency-Key IS sent', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', validKey())
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(200);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// First upload — stores fingerprint + response
// ===========================================================================

describe('Multipart Idempotency — First upload stores fingerprint + response', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('executes the handler and returns 200 on the first call', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', validKey())
      .attach('invoice', fakePdf(), 'invoice.pdf');
    expect(res.status).toBe(200);
    expect(res.body.uploadId).toBeDefined();
  });

  it('persists exactly one row on first call', async () => {
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', validKey())
      .attach('invoice', fakePdf('S1'), 'invoice.pdf');
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });

  it('stores a 64-char hex compound fingerprint', async () => {
    const buf = fakePdf('FP');
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(row.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // Fingerprint must match what the helper computes
    expect(row.request_fingerprint).toBe(expectedFingerprint({}, buf));
  });

  it('stores the compound fingerprint covering BOTH fields and file', async () => {
    const buf = fakePdf('CFP');
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .field('invoiceId', 'inv-42')
      .attach('invoice', buf, 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(row.request_fingerprint).toBe(expectedFingerprint({ invoiceId: 'inv-42' }, buf));
  });

  it('persists the response status code (200)', async () => {
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf(), 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(row.response_status).toBe(200);
  });

  it('persists the response body as a JSON string', async () => {
    const key = validKey();
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf(), 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(typeof row.response_body).toBe('string');
    const parsed = JSON.parse(row.response_body);
    expect(parsed.uploadId).toBe(res.body.uploadId);
  });

  it('sets expires_at to roughly 24 h in the future', async () => {
    const before = Date.now();
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf(), 'invoice.pdf');
    const after = Date.now();
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(Number.isFinite(expiresMs)).toBe(true);
    const ttlMs = 24 * 3600 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlMs - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + ttlMs + 1000);
  });

  it('does NOT store raw file bytes — only the SHA-256 fingerprint', async () => {
    const sentinel = 'SENSITIVE_INVOICE_BYTES_' + crypto.randomBytes(4).toString('hex');
    const buf = Buffer.from(sentinel);
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(row.request_fingerprint).not.toContain(sentinel);
    expect(String(row.idempotency_key)).not.toContain(sentinel);
  });
});

// ===========================================================================
// Exact replay — same key + same file + same fields
// ===========================================================================

describe('Multipart Idempotency — Exact replay', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('returns the same uploadId on replay (no double-upload)', async () => {
    const key = validKey();
    const buf = fakePdf('R1');
    const r1 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    const r2 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.uploadId).toBe(r1.body.uploadId);
  });

  it('returns byte-identical response on replay', async () => {
    const key = validKey();
    const buf = fakePdf('R2');
    const r1 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    const r2 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    expect(r2.body).toEqual(r1.body);
  });

  it('does NOT insert a second row on replay', async () => {
    const key = validKey();
    const buf = fakePdf('R3');
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    const rows = await db('idempotency_keys').where({ idempotency_key: key }).select('*');
    expect(rows).toHaveLength(1);
  });

  it('replays even when form fields are included', async () => {
    const key = validKey();
    const buf = fakePdf('R4');
    const r1 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .field('invoiceId', 'inv-replay')
      .attach('invoice', buf, 'invoice.pdf');
    const r2 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .field('invoiceId', 'inv-replay')
      .attach('invoice', buf, 'invoice.pdf');
    expect(r2.body.uploadId).toBe(r1.body.uploadId);
    expect(r2.body.invoiceId).toBe('inv-replay');
  });
});

// ===========================================================================
// Conflict — same key + different payload → 409 (RFC 7807)
// ===========================================================================

describe('Multipart Idempotency — Conflict (same key + different payload)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('returns 409 with application/problem+json when file differs', async () => {
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf('C1'), 'invoice.pdf')
      .expect(200);
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf('C2'), 'invoice.pdf');
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(409);
    expect(res.body.type).toMatch(/conflict/);
    expect(res.body.detail).toMatch(/different request body/);
  });

  it('returns 409 when only a form field differs', async () => {
    const key = validKey();
    const buf = fakePdf('CF');
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .field('invoiceId', 'inv-original')
      .attach('invoice', buf, 'invoice.pdf')
      .expect(200);
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .field('invoiceId', 'inv-different')
      .attach('invoice', buf, 'invoice.pdf');
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/different request body/);
  });

  it('returns 409 when file is present on first call but absent on retry', async () => {
    const key = validKey();
    // First: with file
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf('CF2'), 'invoice.pdf')
      .expect(200);
    // Second: no file (fields-only body — handler would 400, but conflict check fires first)
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .field('invoiceId', 'inv-1');
    expect(res.status).toBe(409);
  });

  it('preserves the original record on mismatch (no overwrite)', async () => {
    const key = validKey();
    const originalBuf = fakePdf('ORIG');
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', originalBuf, 'invoice.pdf')
      .expect(200);
    const before = await db('idempotency_keys').where({ idempotency_key: key }).first();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf('DIFF'), 'invoice.pdf');
    const after = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(after.request_fingerprint).toBe(before.request_fingerprint);
    expect(after.response_status).toBe(before.response_status);
  });

  it('returns 409 on every subsequent mismatch call', async () => {
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf('M0'), 'invoice.pdf')
      .expect(200);
    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post('/api/sme/invoice')
        .set('Idempotency-Key', key)
        .attach('invoice', fakePdf(`M${i}`), 'invoice.pdf');
      expect(res.status).toBe(409);
    }
  });
});

// ===========================================================================
// TTL expiry
// ===========================================================================

describe('Multipart Idempotency — TTL expiry', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('default TTL is ~24 h', async () => {
    const before = Date.now();
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf(), 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(expiresMs - before).toBeGreaterThanOrEqual(23.9 * 3600 * 1000);
    expect(expiresMs - before).toBeLessThanOrEqual(24.1 * 3600 * 1000);
  });

  it('honours IDEMPOTENCY_KEY_TTL_HOURS env var', async () => {
    process.env.IDEMPOTENCY_KEY_TTL_HOURS = '1';
    const before = Date.now();
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf(), 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    const expiresMs = parseExpiryMs(row.expires_at);
    expect(expiresMs - before).toBeGreaterThanOrEqual(0.9 * 3600 * 1000);
    expect(expiresMs - before).toBeLessThanOrEqual(1.1 * 3600 * 1000);
  });

  it('treats an expired key as a fresh request (handler re-executes)', async () => {
    const key = validKey();
    const buf = fakePdf('TTL1');
    const r1 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf')
      .expect(200);
    // Expire the row
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const r2 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf')
      .expect(200);
    // Handler re-ran → new uploadId
    expect(r2.body.uploadId).not.toBe(r1.body.uploadId);
  });

  it('expired key + different file: no 409 — fresh request allowed', async () => {
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf('TTL2'), 'invoice.pdf')
      .expect(200);
    await db('idempotency_keys')
      .where({ idempotency_key: key })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', fakePdf('TTL3'), 'invoice.pdf');
    expect(res.status).toBe(200);
    const rows = await db('idempotency_keys').select('*');
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// Orphan in-flight recovery
// ===========================================================================

describe('Multipart Idempotency — Orphan in-flight recovery', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('re-executes when an orphaned in-progress row has exceeded the timeout', async () => {
    // The default ORPHAN_IN_FLIGHT_TIMEOUT_MS is 120 000 ms (2 min).
    // We simulate an orphaned row by back-dating created_at beyond that.
    const key = validKey();
    const buf = fakePdf('ORPHAN');
    const stuckCreatedAt = new Date(Date.now() - 200000).toISOString(); // 200 s ago > 120 s
    await db('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: expectedFingerprint({}, buf),
      response_status: null,
      response_body: null,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      created_at: stuckCreatedAt,
      updated_at: stuckCreatedAt,
    });
    // The orphan timeout has elapsed → middleware clears the row and re-executes
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    expect(res.status).toBe(200);
    expect(res.body.uploadId).toBeDefined();
  });

  it('returns 409 for an in-progress row that is NOT yet orphaned', async () => {
    // Large timeout — row is not considered orphaned
    process.env.IDEMPOTENCY_ORPHAN_TIMEOUT_MS = '300000';
    const key = validKey();
    const buf = fakePdf('INFLIGHT');
    // Insert a fresh in-progress row
    await db('idempotency_keys').insert({
      idempotency_key: key,
      request_fingerprint: expectedFingerprint({}, buf),
      response_status: null,
      response_body: null,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/currently being processed/);
  });
});

// ===========================================================================
// Concurrent duplicate protection
// ===========================================================================

describe('Multipart Idempotency — Concurrent duplicate protection', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('sequential duplicate calls produce exactly one stored row', async () => {
    const key = validKey();
    const buf = fakePdf('SEQ');
    const r1 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    const r2 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.uploadId).toBe(r1.body.uploadId);
    const rows = await db('idempotency_keys').where({ idempotency_key: key }).select('*');
    expect(rows).toHaveLength(1);
  });

  it('parallel duplicate calls never produce 5xx', async () => {
    const key = validKey();
    const buf = fakePdf('PAR');
    const responses = await Promise.all([
      request(app).post('/api/sme/invoice').set('Idempotency-Key', key).attach('invoice', buf, 'invoice.pdf'),
      request(app).post('/api/sme/invoice').set('Idempotency-Key', key).attach('invoice', buf, 'invoice.pdf'),
      request(app).post('/api/sme/invoice').set('Idempotency-Key', key).attach('invoice', buf, 'invoice.pdf'),
    ]);
    for (const r of responses) {
      expect(r.status).toBeLessThan(500);
    }
  });

  it('UNIQUE constraint respected — only one row per key after N parallel calls', async () => {
    const key = validKey();
    const buf = fakePdf('UNQ');
    const N = 5;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post('/api/sme/invoice')
          .set('Idempotency-Key', key)
          .attach('invoice', buf, 'invoice.pdf')
      )
    );
    for (const r of responses) expect(r.status).toBeLessThan(500);
    const rows = await db('idempotency_keys').where({ idempotency_key: key }).select('*');
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// Multiple distinct keys — isolation
// ===========================================================================

describe('Multipart Idempotency — Multiple distinct keys', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('two different keys store independent rows', async () => {
    const k1 = validKey('a');
    const k2 = validKey('b');
    const buf = fakePdf('ISO');
    const r1 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', k1)
      .attach('invoice', buf, 'invoice.pdf');
    const r2 = await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', k2)
      .attach('invoice', buf, 'invoice.pdf');
    expect(r1.body.uploadId).not.toBe(r2.body.uploadId);
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows).toHaveLength(2);
  });

  it('two different keys with different files store separately', async () => {
    const k1 = validKey('c');
    const k2 = validKey('d');
    await request(app).post('/api/sme/invoice').set('Idempotency-Key', k1).attach('invoice', fakePdf('F1'), 'invoice.pdf');
    await request(app).post('/api/sme/invoice').set('Idempotency-Key', k2).attach('invoice', fakePdf('F2'), 'invoice.pdf');
    const count = await db('idempotency_keys').count('* as n');
    expect(count[0].n).toBe(2);
  });
});

// ===========================================================================
// Security — fingerprint never contains raw payload
// ===========================================================================

describe('Multipart Idempotency — Security', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('stores only the SHA-256 fingerprint — no plaintext in DB columns', async () => {
    const sentinel = 'PRIVATE_INVOICE_PAYLOAD_' + crypto.randomBytes(4).toString('hex');
    const buf = Buffer.from(sentinel);
    const key = validKey();
    await request(app)
      .post('/api/sme/invoice')
      .set('Idempotency-Key', key)
      .attach('invoice', buf, 'invoice.pdf');
    const row = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(row.request_fingerprint).not.toContain(sentinel);
    expect(String(row.idempotency_key)).not.toContain(sentinel);
  });

  it('two different files produce distinct fingerprints', async () => {
    const k1 = validKey('sec1');
    const k2 = validKey('sec2');
    await request(app).post('/api/sme/invoice').set('Idempotency-Key', k1).attach('invoice', fakePdf('S1'), 'invoice.pdf');
    await request(app).post('/api/sme/invoice').set('Idempotency-Key', k2).attach('invoice', fakePdf('S2'), 'invoice.pdf');
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows[0].request_fingerprint).not.toBe(rows[1].request_fingerprint);
  });

  it('identical files produce identical fingerprints', async () => {
    const k1 = validKey('id1');
    const k2 = validKey('id2');
    const buf = fakePdf('SAME');
    await request(app).post('/api/sme/invoice').set('Idempotency-Key', k1).attach('invoice', buf, 'invoice.pdf');
    await request(app).post('/api/sme/invoice').set('Idempotency-Key', k2).attach('invoice', buf, 'invoice.pdf');
    const rows = await db('idempotency_keys').select('*').orderBy('id');
    expect(rows[0].request_fingerprint).toBe(rows[1].request_fingerprint);
  });
});
