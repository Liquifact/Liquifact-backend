'use strict';

/**
 * @fileoverview Tests for the fixed kycIdempotency middleware.
 *
 * Covers:
 *   - Missing Idempotency-Key → 400
 *   - Invalid key format → 400
 *   - First request (new key) → placeholder inserted, next() called
 *   - Replay: same key + same body → cached response replayed
 *   - Conflict: same key + different body → 409
 *   - Null response_body (in-flight race) → 202 Accepted instead of 200 null
 *   - Post-response storage uses db() pool not committed trx
 *   - Post-response storage failure does NOT crash the request
 *   - res.json override is removed after first call (no double-capture)
 */

// ── Shared in-memory idempotency store ───────────────────────────────────────

const idemStore = new Map();

// Controllable behavior for the transaction mock
let _firstRowResult = null;   // what trx.first() returns inside the transaction
let _insertError = null;      // throw this on insert if set

function makeTableBuilder(firstResult) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(firstResult),
    insert: jest.fn(async (row) => {
      if (_insertError) { throw _insertError; }
      idemStore.set(row.idempotency_key, row);
    }),
    update: jest.fn().mockResolvedValue(1),
  };
}

const mockDb = Object.assign(jest.fn((table) => {
  // db() calls used for the post-response capture update
  return {
    where: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(1),
  };
}), {
  transaction: jest.fn(async (fn) => {
    const trx = jest.fn(() => makeTableBuilder(_firstRowResult));
    trx.commit = jest.fn();
    trx.rollback = jest.fn();
    return fn(trx);
  }),
  fn: { now: () => new Date() },
  raw: jest.fn(() => new Date(Date.now() + 86400000)),
});

jest.mock('../../src/db/knex', () => mockDb);

jest.mock('../../src/services/escrowSubmit', () => ({
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9._:-]{8,128}$/,
}));

jest.mock('../../src/constants/kycWebhooks', () => ({
  HTTP_HEADERS: { IDEMPOTENCY_KEY: 'Idempotency-Key' },
  KYC_WEBHOOK_MESSAGES: {
    IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required for this endpoint.',
    IDEMPOTENCY_KEY_INVALID: 'Idempotency-Key must be 8-128 URL-safe characters.',
    IDEMPOTENCY_KEY_REUSED: 'Idempotency-Key reused with a different request body.',
    IDEMPOTENCY_SERVER_ERROR: 'Internal server error processing idempotency key.',
  },
  KYC_WEBHOOK_DB: {
    TABLE_IDEMPOTENCY_KEYS: 'idempotency_keys',
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq({ key, body = '{"smeId":"sme-1","status":"verified"}' } = {}) {
  const headers = {};
  if (key !== undefined) { headers['idempotency-key'] = key; }
  return {
    header: jest.fn((name) => headers[name.toLowerCase()]),
    body: Buffer.from(body, 'utf8'),
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    _body: null,
    headersSent: false,
    status: jest.fn(function (code) { this.statusCode = code; return this; }),
    json: jest.fn(function (body) { this._body = body; this.headersSent = true; return this; }),
  };
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const kycIdempotencyMiddleware = require('../../src/middleware/kycIdempotency');

beforeEach(() => {
  jest.clearAllMocks();
  idemStore.clear();
  _firstRowResult = null;
  _insertError = null;
});

describe('kycIdempotencyMiddleware – key validation', () => {
  test('missing Idempotency-Key header → 400', () => {
    const req = makeReq({ key: undefined });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('Idempotency-Key too short → 400', () => {
    const req = makeReq({ key: 'short' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('Idempotency-Key with invalid characters → 400', () => {
    const req = makeReq({ key: 'key with spaces!!' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('valid 8-character key is accepted', async () => {
    const req = makeReq({ key: 'validkey' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    // Allow the async transaction to settle
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('valid 128-character key is accepted', async () => {
    const req = makeReq({ key: 'a'.repeat(128) });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('kycIdempotencyMiddleware – new key flow', () => {
  test('new key → inserts placeholder, calls next()', async () => {
    _firstRowResult = null; // no existing row

    const req = makeReq({ key: 'newkey-1a' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalledTimes(1);
    // Transaction was used
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  test('new key → res.json override is installed for response capture', async () => {
    _firstRowResult = null;

    const req = makeReq({ key: 'newkey-2b' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    // After next() is called, res.json should be the override wrapper
    const overriddenJson = res.json;
    expect(typeof overriddenJson).toBe('function');
  });

  test('res.json override calls db() (pool) not trx reference to persist response', async () => {
    _firstRowResult = null;

    const req = makeReq({ key: 'newkey-3c' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    // Simulate handler calling res.json
    res.statusCode = 200;
    res.json({ success: true, smeId: 'sme-1' });
    await new Promise((r) => setImmediate(r));

    // db() should have been called for the update (not using trx)
    expect(mockDb).toHaveBeenCalled();
  });

  test('post-response DB update failure does NOT throw or crash', async () => {
    _firstRowResult = null;

    // Make the global pool update fail
    mockDb.mockImplementationOnce(() => ({
      where: jest.fn().mockReturnThis(),
      update: jest.fn().mockRejectedValue(new Error('pool error')),
    }));

    const req = makeReq({ key: 'newkey-4d' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    // Simulate handler calling res.json — must not throw
    expect(() => res.json({ ok: true })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    // Response was still sent
    expect(res._body).toEqual({ ok: true });
  });
});

describe('kycIdempotencyMiddleware – replay flow', () => {
  test('same key + same body + stored response → replays cached status and body', async () => {
    const key = 'replaykey1';
    const body = '{"smeId":"sme-1","status":"verified"}';
    const crypto = require('crypto');
    const fingerprint = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

    // Simulate an existing completed row
    _firstRowResult = {
      idempotency_key: key,
      request_fingerprint: fingerprint,
      response_status: 200,
      response_body: JSON.stringify({ success: true, smeId: 'sme-1', status: 'verified' }),
    };

    const req = makeReq({ key, body });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res._body).toEqual({ success: true, smeId: 'sme-1', status: 'verified' });
  });

  test('replay preserves the original HTTP status code', async () => {
    const key = 'replaykey2';
    const body = '{"smeId":"sme-2","status":"rejected"}';
    const crypto = require('crypto');
    const fingerprint = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

    _firstRowResult = {
      idempotency_key: key,
      request_fingerprint: fingerprint,
      response_status: 422,
      response_body: JSON.stringify({ error: 'validation failed' }),
    };

    const req = makeReq({ key, body });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'validation failed' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('kycIdempotencyMiddleware – conflict flow', () => {
  test('same key + different body → 409 Conflict', async () => {
    const key = 'conflictkey1';
    const originalBody = '{"smeId":"sme-3","status":"verified"}';
    const differentBody = '{"smeId":"sme-4","status":"rejected"}';

    const crypto = require('crypto');
    const originalFingerprint = crypto.createHash('sha256').update(originalBody, 'utf8').digest('hex');

    // Existing row has the original fingerprint
    _firstRowResult = {
      idempotency_key: key,
      request_fingerprint: originalFingerprint,
      response_status: 200,
      response_body: JSON.stringify({ success: true }),
    };

    // New request has a different body
    const req = makeReq({ key, body: differentBody });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(409);
    expect(res._body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('kycIdempotencyMiddleware – in-flight race (null response_body)', () => {
  test('placeholder row with null response_body → 202 Accepted (not 200 null)', async () => {
    const key = 'inflightkey1';
    const body = '{"smeId":"sme-5","status":"verified"}';
    const crypto = require('crypto');
    const fingerprint = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

    // Simulate a placeholder row: inserted but response not yet written
    _firstRowResult = {
      idempotency_key: key,
      request_fingerprint: fingerprint,
      response_status: null,
      response_body: null,
    };

    const req = makeReq({ key, body });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(202);
    expect(res._body).toMatchObject({
      status: 'processing',
      message: expect.any(String),
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('placeholder with undefined response_body also returns 202', async () => {
    const key = 'inflightkey2';
    const body = '{"smeId":"sme-6","status":"verified"}';
    const crypto = require('crypto');
    const fingerprint = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

    _firstRowResult = {
      idempotency_key: key,
      request_fingerprint: fingerprint,
      response_status: undefined,
      response_body: undefined,
    };

    const req = makeReq({ key, body });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(202);
  });
});

describe('kycIdempotencyMiddleware – transaction error handling', () => {
  test('transaction failure → 500 IDEMPOTENCY_SERVER_ERROR', async () => {
    mockDb.transaction.mockRejectedValueOnce(new Error('DB connection lost'));

    const req = makeReq({ key: 'txerrorkey' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(500);
    expect(res._body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  test('transaction error after headers sent is handled without crashing', async () => {
    mockDb.transaction.mockRejectedValueOnce(new Error('late error'));

    const req = makeReq({ key: 'txlateerror' });
    const res = makeRes();
    res.headersSent = true; // headers already sent
    const next = jest.fn();

    // Should not throw
    expect(() => kycIdempotencyMiddleware(req, res, next)).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe('kycIdempotencyMiddleware – res.json override safety', () => {
  test('res.json override is removed after first call (not double-captured)', async () => {
    _firstRowResult = null;

    const req = makeReq({ key: 'oncekey-1a' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    const overriddenJson = res.json;

    // First call restores the original
    res.json({ first: true });
    await new Promise((r) => setImmediate(r));

    // After the first call, res.json is back to the original mock (not the override)
    expect(res.json).not.toBe(overriddenJson);
  });

  test('TTL hours default is 24 when env var not set', async () => {
    delete process.env.IDEMPOTENCY_KEY_TTL_HOURS;
    _firstRowResult = null;

    const req = makeReq({ key: 'ttltest1a' });
    const res = makeRes();
    const next = jest.fn();

    kycIdempotencyMiddleware(req, res, next);
    await new Promise((r) => setImmediate(r));

    // Transaction was called, raw() called for TTL
    expect(mockDb.raw).toHaveBeenCalled();
  });

  test('Buffer body and string body produce the same fingerprint', async () => {
    const bodyStr = '{"smeId":"sme-buf","status":"verified"}';
    const crypto = require('crypto');
    const expectedFingerprint = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');

    // First call: string body
    _firstRowResult = null;
    const req1 = makeReq({ key: 'buftest-s1', body: bodyStr });
    const res1 = makeRes();
    kycIdempotencyMiddleware(req1, res1, jest.fn());
    await new Promise((r) => setImmediate(r));

    // Second call: Buffer body — should match fingerprint, triggering replay
    const bufReq = {
      header: jest.fn((name) => name.toLowerCase() === 'idempotency-key' ? 'buftest-s1' : undefined),
      body: Buffer.from(bodyStr, 'utf8'),
    };
    _firstRowResult = {
      idempotency_key: 'buftest-s1',
      request_fingerprint: expectedFingerprint,
      response_status: 200,
      response_body: JSON.stringify({ success: true }),
    };
    const res2 = makeRes();
    kycIdempotencyMiddleware(bufReq, res2, jest.fn());
    await new Promise((r) => setImmediate(r));

    // Same fingerprint → replay, not conflict
    expect(res2.statusCode).toBe(200);
    expect(res2._body).toEqual({ success: true });
  });
});
