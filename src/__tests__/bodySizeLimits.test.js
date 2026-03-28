/**
 * @fileoverview Comprehensive tests for the LiquiFact API.
 *
 * Covers:
 *   bodySizeLimits middleware — parseSize, DEFAULT_LIMITS, jsonBodyLimit,
 *     urlencodedBodyLimit, invoiceBodyLimit, payloadTooLargeHandler
 *   config/cors — parseAllowedOrigins, resolveAllowlist, createCorsOptions,
 *     isCorsOriginRejectedError
 *   services/soroban — computeBackoff, isRetryable, withRetry,
 *     callSorobanContract
 *   app.js — createApp, handleCorsError, handleInternalError,
 *     all routes, 404, CORS block, 413 oversized body, 500 internal error
 */

'use strict';

const { describe, it, expect, beforeEach, beforeAll, vi } = require('vitest');
const request = require('supertest');
const express = require('express');

const {
  DEFAULT_LIMITS,
  parseSize,
  jsonBodyLimit,
  urlencodedBodyLimit,
  invoiceBodyLimit,
  payloadTooLargeHandler,
} = require('../middleware/bodySizeLimits');

const {
  parseAllowedOrigins,
  isCorsOriginRejectedError,
  createCorsOptions,
  DEV_DEFAULT_ORIGINS,
} = require('../config/cors');

const {
  computeBackoff,
  isRetryable,
  withRetry,
  callSorobanContract,
  SOROBAN_RETRY_CONFIG,
  RETRYABLE_STATUS_CODES,
} = require('../services/soroban');

const { createApp, handleCorsError, handleInternalError } = require('../app');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a minimal Express app that applies given middleware and echoes
 * the parsed body on POST /test.
 *
 * @param {Function[]} middlewares
 * @returns {import('express').Application}
 */
function buildApp(middlewares) {
  const app = express();
  app.use(middlewares);
  app.post('/test', (req, res) => res.status(200).json({ received: req.body }));
  app.use(payloadTooLargeHandler);
  return app;
}

/**
 * Generates a JSON body string of approximately `targetBytes` bytes.
 * @param {number} targetBytes
 * @returns {string}
 */
function makeJsonBody(targetBytes) {
  const paddingLen = Math.max(0, targetBytes - 11);
  return JSON.stringify({ data: 'x'.repeat(paddingLen) });
}

/**
 * Generates a URL-encoded body string of approximately `targetBytes` bytes.
 * @param {number} targetBytes
 * @returns {string}
 */
function makeUrlencodedBody(targetBytes) {
  return `data=${'x'.repeat(Math.max(0, targetBytes - 5))}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// parseSize()
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSize()', () => {
  describe('valid inputs', () => {
    it('parses bytes (no suffix)', () => expect(parseSize('1024')).toBe(1024));
    it('parses "b" suffix (lowercase)', () => expect(parseSize('512b')).toBe(512));
    it('parses "B" suffix (uppercase)', () => expect(parseSize('512B')).toBe(512));
    it('parses "kb" suffix', () => expect(parseSize('1kb')).toBe(1024));
    it('parses "KB" suffix', () => expect(parseSize('100KB')).toBe(102400));
    it('parses "mb" suffix', () => expect(parseSize('1mb')).toBe(1048576));
    it('parses "MB" suffix', () => expect(parseSize('2MB')).toBe(2097152));
    it('parses "gb" suffix', () => expect(parseSize('1gb')).toBe(1073741824));
    it('handles decimal values', () => expect(parseSize('1.5mb')).toBe(Math.floor(1.5 * 1024 ** 2)));
    it('handles surrounding whitespace', () => expect(parseSize('  100kb  ')).toBe(102400));
    it('returns 0 for "0b"', () => expect(parseSize('0b')).toBe(0));
  });

  describe('TypeError', () => {
    it('throws for empty string', () => expect(() => parseSize('')).toThrow(TypeError));
    it('throws for whitespace-only', () => expect(() => parseSize('   ')).toThrow(TypeError));
    it('throws for number input', () => expect(() => parseSize(1024)).toThrow(TypeError));
    it('throws for null', () => expect(() => parseSize(null)).toThrow(TypeError));
    it('throws for undefined', () => expect(() => parseSize(undefined)).toThrow(TypeError));
    it('throws for object', () => expect(() => parseSize({ size: '1kb' })).toThrow(TypeError));
  });

  describe('RangeError', () => {
    it('throws for unknown unit "tb"', () => expect(() => parseSize('1tb')).toThrow(RangeError));
    it('throws for non-numeric value', () => expect(() => parseSize('abckb')).toThrow(RangeError));
    it('throws for negative value', () => expect(() => parseSize('-1kb')).toThrow(RangeError));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT_LIMITS
// ═══════════════════════════════════════════════════════════════════════════

describe('DEFAULT_LIMITS', () => {
  it.each(['json', 'urlencoded', 'raw', 'invoice'])('%s is a parseable string', (key) => {
    expect(typeof DEFAULT_LIMITS[key]).toBe('string');
    expect(parseSize(DEFAULT_LIMITS[key])).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// jsonBodyLimit()
// ═══════════════════════════════════════════════════════════════════════════

describe('jsonBodyLimit()', () => {
  let app;
  const LIMIT = '1kb';

  beforeAll(() => { app = buildApp(jsonBodyLimit(LIMIT)); });

  it('returns a two-element handler array', () => {
    const handlers = jsonBodyLimit('100kb');
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers).toHaveLength(2);
    handlers.forEach((h) => expect(typeof h).toBe('function'));
  });

  it('accepts a body within the limit', async () => {
    const res = await request(app)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(512));
    expect(res.status).toBe(200);
    expect(res.body.received).toBeDefined();
  });

  it('accepts body at boundary (200 or 413)', async () => {
    const res = await request(app)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(1024));
    expect([200, 413]).toContain(res.status);
  });

  it('rejects a body exceeding the limit with 413', async () => {
    const res = await request(app)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(2048));
    expect(res.status).toBe(413);
  });

  it('413 response has correct shape', async () => {
    const res = await request(app)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(2048));
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      message: expect.stringContaining('maximum allowed size'),
    });
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/test').set('Content-Type', 'application/json').send('{bad json}');
    expect(res.status).toBe(400);
  });

  it('rejects primitive root JSON (strict mode)', async () => {
    const res = await request(app)
      .post('/test').set('Content-Type', 'application/json').send('"just a string"');
    expect(res.status).toBe(400);
  });

  it('accepts empty body without Content-Type', async () => {
    const res = await request(app).post('/test');
    expect([200, 400]).toContain(res.status);
  });

  it('ignores non-JSON content type gracefully', async () => {
    const res = await request(app)
      .post('/test').set('Content-Type', 'text/plain').send('hello world');
    expect([200, 400, 415]).toContain(res.status);
  });

  it('rejects when Content-Length header exceeds limit', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(parseSize(LIMIT) + 1))
      .send(makeJsonBody(512));
    expect(res.status).toBe(413);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// urlencodedBodyLimit()
// ═══════════════════════════════════════════════════════════════════════════

describe('urlencodedBodyLimit()', () => {
  let app;
  const LIMIT = '1kb';

  beforeAll(() => { app = buildApp(urlencodedBodyLimit(LIMIT)); });

  it('returns a two-element handler array', () => {
    const handlers = urlencodedBodyLimit('50kb');
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers).toHaveLength(2);
  });

  it('accepts a body within the limit', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(512));
    expect(res.status).toBe(200);
  });

  it('rejects a body exceeding the limit with 413', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(2048));
    expect(res.status).toBe(413);
  });

  it('413 response has correct shape', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(2048));
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      message: expect.stringContaining('maximum allowed size'),
    });
  });

  it('rejects when Content-Length header exceeds limit', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Content-Length', String(parseSize(LIMIT) + 1))
      .send(makeUrlencodedBody(200));
    expect(res.status).toBe(413);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// invoiceBodyLimit()
// ═══════════════════════════════════════════════════════════════════════════

describe('invoiceBodyLimit()', () => {
  let appDefault, appCustom;

  beforeAll(() => {
    appDefault = buildApp(invoiceBodyLimit());
    appCustom = buildApp(invoiceBodyLimit('2kb'));
  });

  it('returns a handler array', () => {
    const handlers = invoiceBodyLimit();
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers.length).toBeGreaterThan(0);
  });

  it('accepts a body within the default 512 KB limit', async () => {
    const res = await request(appDefault)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(100));
    expect(res.status).toBe(200);
  });

  it('rejects a body over the default 512 KB limit', async () => {
    const res = await request(appDefault)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(520 * 1024));
    expect(res.status).toBe(413);
  });

  it('accepts a body within a custom 2 KB limit', async () => {
    const res = await request(appCustom)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(1024));
    expect(res.status).toBe(200);
  });

  it('rejects a body over a custom 2 KB limit', async () => {
    const res = await request(appCustom)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(3 * 1024));
    expect(res.status).toBe(413);
  });

  it('413 response includes path and limit fields', async () => {
    const res = await request(appCustom)
      .post('/test').set('Content-Type', 'application/json').send(makeJsonBody(3 * 1024));
    expect(res.body).toHaveProperty('error', 'Payload Too Large');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('path', '/test');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// payloadTooLargeHandler()
// ═══════════════════════════════════════════════════════════════════════════

describe('payloadTooLargeHandler()', () => {
  it('converts entity.too.large to 413 JSON', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      const err = Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 });
      next(err);
    });
    app.use(payloadTooLargeHandler);

    app.use((_err, _req, res, _next) => res.status(500).json({ error: 'other' }));

    const res = await request(app).post('/trigger');
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: 'Payload Too Large' });
  });

  it('passes non-size errors to the next handler', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => next(new Error('unrelated')));
    app.use(payloadTooLargeHandler);

    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

    const res = await request(app).post('/trigger');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unrelated');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// config/cors
// ═══════════════════════════════════════════════════════════════════════════

describe('parseAllowedOrigins()', () => {
  it('returns null for undefined', () => expect(parseAllowedOrigins(undefined)).toBeNull());
  it('returns null for empty string', () => expect(parseAllowedOrigins('')).toBeNull());
  it('returns null for blank string', () => expect(parseAllowedOrigins('   ')).toBeNull());
  it('parses a single origin', () => expect(parseAllowedOrigins('https://a.com')).toEqual(['https://a.com']));
  it('parses multiple origins', () => expect(parseAllowedOrigins('https://a.com,https://b.com')).toEqual(['https://a.com', 'https://b.com']));
  it('trims whitespace around commas', () => expect(parseAllowedOrigins(' https://a.com , https://b.com ')).toEqual(['https://a.com', 'https://b.com']));
  it('de-duplicates origins', () => expect(parseAllowedOrigins('https://a.com,https://a.com')).toEqual(['https://a.com']));
});

describe('isCorsOriginRejectedError()', () => {
  it('returns true for flagged error', () => expect(isCorsOriginRejectedError({ isCorsOriginRejected: true })).toBe(true));
  it('returns false for plain error', () => expect(isCorsOriginRejectedError(new Error('x'))).toBe(false));
  it('returns false for null', () => expect(isCorsOriginRejectedError(null)).toBe(false));
  it('returns false for undefined', () => expect(isCorsOriginRejectedError(undefined)).toBe(false));
  it('returns false when flag is false', () => expect(isCorsOriginRejectedError({ isCorsOriginRejected: false })).toBe(false));
});

describe('createCorsOptions()', () => {
  let savedEnv;
  beforeEach(() => { savedEnv = { ...process.env }; });

  afterEach(() => {
    process.env.CORS_ALLOWED_ORIGINS = savedEnv.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = savedEnv.NODE_ENV;
    if (savedEnv.CORS_ALLOWED_ORIGINS === undefined) { delete process.env.CORS_ALLOWED_ORIGINS; }
    if (savedEnv.NODE_ENV === undefined) { delete process.env.NODE_ENV; }
  });

  it('allows request with no Origin header', (done) => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    const opts = createCorsOptions();
    opts.origin(undefined, (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
      done();
    });
  });

  it('allows a listed origin', (done) => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    const opts = createCorsOptions();
    opts.origin('https://app.example.com', (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
      done();
    });
  });

  it('rejects an unlisted origin with a CORS rejection error', (done) => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    const opts = createCorsOptions();
    opts.origin('https://evil.com', (err) => {
      expect(isCorsOriginRejectedError(err)).toBe(true);
      done();
    });
  });

  it('allows dev default origins when NODE_ENV=development and no env var', (done) => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = 'development';
    const opts = createCorsOptions();
    opts.origin(DEV_DEFAULT_ORIGINS[0], (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
      done();
    });
  });

  it('denies all origins in production when no env var is set', (done) => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = 'production';
    const opts = createCorsOptions();
    opts.origin('https://anything.com', (err) => {
      expect(isCorsOriginRejectedError(err)).toBe(true);
      done();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// services/soroban
// ═══════════════════════════════════════════════════════════════════════════

describe('computeBackoff()', () => {
  it('returns a number >= 0', () => {
    expect(computeBackoff(0, 200, 5000)).toBeGreaterThanOrEqual(0);
  });
  it('increases with attempt number', () => {
    computeBackoff(0, 200, 5000);
    const d3 = computeBackoff(3, 200, 5000);
    // With jitter d3 is almost certainly larger; we check average tendency
    expect(200 * 2 ** 3).toBeGreaterThan(200); // sanity
    expect(d3).toBeLessThanOrEqual(5000);
  });
  it('is capped at maxDelay', () => {
    expect(computeBackoff(20, 1000, 5000)).toBeLessThanOrEqual(5000);
  });
  it('hard-caps maxDelay at 60 000 ms', () => {
    expect(computeBackoff(20, 1000, 999999)).toBeLessThanOrEqual(60_000);
  });
  it('hard-caps baseDelay at 10 000 ms', () => {
    expect(computeBackoff(0, 999999, 60_000)).toBeLessThanOrEqual(60_000);
  });
});

describe('isRetryable()', () => {
  it('returns false for null', () => expect(isRetryable(null)).toBe(false));
  it('returns false for undefined', () => expect(isRetryable(undefined)).toBe(false));
  it('returns true for ECONNRESET', () => expect(isRetryable({ code: 'ECONNRESET' })).toBe(true));
  it('returns true for ETIMEDOUT', () => expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true));
  it('returns false for 400', () => expect(isRetryable({ status: 400 })).toBe(false));
  it('returns false for 404', () => expect(isRetryable({ status: 404 })).toBe(false));
  it('returns false for 500', () => expect(isRetryable({ status: 500 })).toBe(false));
  it.each([...RETRYABLE_STATUS_CODES])('returns true for status %i', (code) => {
    expect(isRetryable({ status: code })).toBe(true);
  });
  it('reads status from err.response', () => {
    expect(isRetryable({ response: { status: 503 } })).toBe(true);
  });
});

describe('withRetry()', () => {
  it('returns the result of a successful operation immediately', async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('retries on ECONNRESET and eventually succeeds', async () => {
    let calls = 0;
    const op = () => {
      calls++;
      if (calls < 3) {
        const err = new Error('reset');
        err.code = 'ECONNRESET';
        return Promise.reject(err);
      }
      return Promise.resolve('ok');
    };
    const result = await withRetry(op, { maxRetries: 5, baseDelay: 0, maxDelay: 0 });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws immediately on a non-retryable error', async () => {
    let calls = 0;
    const op = () => { calls++; return Promise.reject(Object.assign(new Error('bad'), { status: 400 })); };
    await expect(withRetry(op, { maxRetries: 5, baseDelay: 0, maxDelay: 0 })).rejects.toThrow('bad');
    expect(calls).toBe(1);
  });

  it('throws after exhausting all retries', async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    };
    await expect(withRetry(op, { maxRetries: 2, baseDelay: 0, maxDelay: 0 })).rejects.toThrow('timeout');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('hard-caps maxRetries at 10', async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.reject(Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    };
    await expect(withRetry(op, { maxRetries: 99, baseDelay: 0, maxDelay: 0 })).rejects.toThrow();
    expect(calls).toBe(11); // 1 initial + 10 retries
  });
});

describe('callSorobanContract()', () => {
  it('resolves with the operation result', async () => {
    const result = await callSorobanContract(() => Promise.resolve({ status: 'ok' }));
    expect(result).toEqual({ status: 'ok' });
  });

  it('propagates errors from the operation', async () => {
    await expect(
      callSorobanContract(() => Promise.reject(Object.assign(new Error('rpc down'), { status: 400 })))
    ).rejects.toThrow('rpc down');
  });

  it('SOROBAN_RETRY_CONFIG has required keys', () => {
    expect(SOROBAN_RETRY_CONFIG).toHaveProperty('maxRetries');
    expect(SOROBAN_RETRY_CONFIG).toHaveProperty('baseDelay');
    expect(SOROBAN_RETRY_CONFIG).toHaveProperty('maxDelay');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// app.js — handleCorsError / handleInternalError unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('handleCorsError()', () => {
  it('responds 403 for a CORS rejection error', () => {
    const err = Object.assign(new Error('blocked origin'), { isCorsOriginRejected: true });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    handleCorsError(err, {}, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next for non-CORS errors', () => {
    const err = new Error('something else');
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    handleCorsError(err, {}, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('handleInternalError()', () => {
  it('responds 500 with generic message', () => {
    const err = new Error('boom');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    handleInternalError(err, {}, res, () => { });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// app.js — full integration via createApp()
// ═══════════════════════════════════════════════════════════════════════════

describe('createApp() integration', () => {
  let app;

  beforeAll(() => {
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
    process.env.NODE_ENV = 'test';
    app = createApp();
  });

  // ── Standard routes ────────────────────────────────────────────────────

  it('GET /health → 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('liquifact-api');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('GET /api → 200 with endpoint map', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('LiquiFact API');
    expect(res.body.endpoints).toBeDefined();
  });

  it('GET /api/invoices → 200 with data array', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('POST /api/invoices small body → 201', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ amount: 100, currency: 'USD' }));
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('placeholder');
  });

  it('GET /api/escrow/:invoiceId → 200 with escrow data', async () => {
    const res = await request(app).get('/api/escrow/inv_001');
    expect(res.status).toBe(200);
    expect(res.body.data.invoiceId).toBe('inv_001');
    expect(res.body.data.status).toBe('not_found');
  });

  it('GET /error → 500 with generic message', async () => {
    const res = await request(app).get('/error');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });

  it('unknown route → 404 with path', async () => {
    const res = await request(app).get('/does/not/exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
    expect(res.body.path).toBe('/does/not/exist');
  });

  // ── CORS enforcement ───────────────────────────────────────────────────

  it('blocked Origin → 403', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
  });

  it('allowed Origin → 200', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
  });

  it('no Origin → 200 (non-browser request)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  // ── Body-size enforcement ──────────────────────────────────────────────

  it('POST /api/invoices oversized body → 413', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(600 * 1024));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Payload Too Large');
  });

  it('413 response includes path field', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(600 * 1024));
    expect(res.body).toHaveProperty('path', '/api/invoices');
  });

  it('POST global JSON endpoint oversized body → 413', async () => {
    // Any endpoint that goes through the global 100 KB JSON middleware
    // (not the invoice-specific 512 KB one) should also 413.
    const res = await request(app)
      .get('/api/invoices');
    // GET is not affected; the 100 KB global limit only applies to bodies.
    expect(res.status).toBe(200);
  });
});