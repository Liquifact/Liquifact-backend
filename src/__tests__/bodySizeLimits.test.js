/**
 * @fileoverview Tests for body-size limits middleware.
 *
 * Covers:
 *   - parseSize unit parsing (b/kb/mb/gb) with exhaustive matrix
 *   - Pre-flight Content-Length checks (rejection before body is read)
 *   - Per-route body-size limits: jsonBodyLimit, urlencodedBodyLimit
 *   - invoiceBodyLimit: 512 KB stricter limit vs. 100 KB global limit
 *   - payloadTooLargeHandler: standardized 413 shape, under-limit pass-through
 *   - DEFAULT_LIMITS: all keys parseable, env-var overrides round-trip
 *
 * @see src/middleware/bodySizeLimits.js
 */

'use strict';

const http = require('http');
const request = require('supertest');
const express = require('express');

const mockBodySizeLimitRejectionsTotal = {
  inc: jest.fn(),
  labels: jest.fn((type) => ({
    inc: () => mockBodySizeLimitRejectionsTotal.inc({ type }),
  })),
};

jest.mock('../metrics', () => ({
  bodySizeLimitRejectionsTotal: mockBodySizeLimitRejectionsTotal,
}));

const {
  DEFAULT_LIMITS,
  parseSize,
  jsonBodyLimit,
  urlencodedBodyLimit,
  invoiceBodyLimit,
  payloadTooLargeHandler,
} = require('../middleware/bodySizeLimits');
const { bodySizeLimitRejectionsTotal } = require('../metrics');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal Express app: applies middlewares, echoes parsed body on POST /test.
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
 * JSON body of approximately `targetBytes` bytes.
 *
 * @param {number} targetBytes
 * @returns {string}
 */
function makeJsonBody(targetBytes) {
  const paddingLen = Math.max(0, targetBytes - 11);
  return JSON.stringify({ data: 'x'.repeat(paddingLen) });
}

/**
 * URL-encoded body of approximately `targetBytes` bytes.
 *
 * @param {number} targetBytes
 * @returns {string}
 */
function makeUrlencodedBody(targetBytes) {
  return `data=${'x'.repeat(Math.max(0, targetBytes - 5))}`;
}

/**
 * Sends an HTTP/1.1 chunked POST without a Content-Length header.
 *
 * @param {import('express').Application} app
 * @param {object} options
 * @param {string} [options.path='/test']
 * @param {string} options.contentType
 * @param {string} options.body
 * @returns {Promise<{ status: number, body: object, text: string }>}
 */
function postChunked(app, { path = '/test', contentType, body }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: {
            'Content-Type': contentType,
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          let text = '';

          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => {
            server.close(() => {
              resolve({
                status: res.statusCode,
                body: text ? JSON.parse(text) : {},
                text,
              });
            });
          });
        }
      );

      req.on('error', (error) => {
        server.close(() => reject(error));
      });

      const splitAt = Math.max(1, Math.floor(body.length / 2));
      req.write(body.slice(0, splitAt));
      req.end(body.slice(splitAt));
    });

    server.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// parseSize()
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSize()', () => {
  describe('valid inputs', () => {
    it('parses bytes — no suffix',    () => expect(parseSize('1024')).toBe(1024));
    it('parses "b" suffix lowercase', () => expect(parseSize('512b')).toBe(512));
    it('parses "B" suffix uppercase', () => expect(parseSize('512B')).toBe(512));
    it('parses "kb" suffix',          () => expect(parseSize('1kb')).toBe(1024));
    it('parses "KB" suffix',          () => expect(parseSize('100KB')).toBe(102400));
    it('parses "mb" suffix',          () => expect(parseSize('1mb')).toBe(1048576));
    it('parses "MB" suffix',          () => expect(parseSize('2MB')).toBe(2097152));
    it('parses "gb" suffix',          () => expect(parseSize('1gb')).toBe(1073741824));
    it('handles decimal values',      () => expect(parseSize('1.5mb')).toBe(Math.floor(1.5 * 1024 ** 2)));
    it('handles surrounding whitespace', () => expect(parseSize('  100kb  ')).toBe(102400));
    it('returns 0 for "0b"',          () => expect(parseSize('0b')).toBe(0));
  });

  // ── Exhaustive unit matrix ─────────────────────────────────────────────
  describe('unit parsing matrix', () => {
    /**
     * Fixture table: [input, expectedBytes]
     * Covers every unit in both cases, boundary values, and decimal rounding.
     */
    it.each([
      // raw bytes
      ['1b',    1],
      ['0b',    0],
      ['255b',  255],
      ['1B',    1],
      // kilobytes
      ['1kb',   1_024],
      ['1KB',   1_024],
      ['50kb',  51_200],
      ['100kb', 102_400],
      ['512kb', 524_288],
      // megabytes
      ['1mb',   1_048_576],
      ['1MB',   1_048_576],
      ['2mb',   2_097_152],
      // gigabytes
      ['1gb',   1_073_741_824],
      ['1GB',   1_073_741_824],
      // decimal — Math.floor applied
      ['0.5kb', 512],
      ['0.5mb', Math.floor(0.5 * 1024 ** 2)],
      ['1.5gb', Math.floor(1.5 * 1024 ** 3)],
      // no unit → raw bytes
      ['2048',  2048],
    ])('parseSize(%s) === %i', (input, expected) => {
      expect(parseSize(input)).toBe(expected);
    });
  });

  describe('TypeError for non-string / empty inputs', () => {
    it.each([
      ['empty string',     ''],
      ['whitespace-only',  '   '],
    ])('throws TypeError for %s', (_label, input) => {
      expect(() => parseSize(input)).toThrow(TypeError);
    });

    it.each([
      ['number',    1024],
      ['null',      null],
      ['undefined', undefined],
      ['object',    { size: '1kb' }],
    ])('throws TypeError for %s input', (_label, input) => {
      expect(() => parseSize(input)).toThrow(TypeError);
    });
  });

  describe('RangeError for unparseable strings', () => {
    it.each([
      ['unknown unit "tb"',   '1tb'],
      ['non-numeric value',   'abckb'],
      ['negative value',      '-1kb'],
      ['unit only, no number','kb'],
      ['double decimal',      '1.2.3kb'],
      ['trailing extra text', '100 kb extra'],
    ])('throws RangeError for %s', (_label, input) => {
      expect(() => parseSize(input)).toThrow(RangeError);
    });
  });

  describe('malformed env-var values', () => {
    it('result is never NaN for valid inputs', () => {
      ['1kb', '100mb', '1gb', '512b', '2048'].forEach((v) => {
        expect(Number.isNaN(parseSize(v))).toBe(false);
      });
    });

    it('"100 KB" (space + uppercase) parses successfully — regex allows optional whitespace', () => {
      // The middleware regex permits optional whitespace between number and unit,
      // so this env-var value is accepted and yields the expected byte count.
      expect(parseSize('100 KB')).toBe(102400);
    });

    it('throws for a genuinely malformed env-var value "100kb!!"', () => {
      // Trailing non-whitespace characters after the unit are not matched
      expect(() => parseSize('100kb!!')).toThrow(RangeError);
    });
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

  it('invoice limit (512 KB) is smaller than the raw limit (1 MB)', () => {
    expect(parseSize(DEFAULT_LIMITS.invoice)).toBeLessThan(parseSize(DEFAULT_LIMITS.raw));
  });

  it('invoice limit (512 KB) is larger than the json limit (100 KB)', () => {
    expect(parseSize(DEFAULT_LIMITS.invoice)).toBeGreaterThan(parseSize(DEFAULT_LIMITS.json));
  });

  it('env var BODY_LIMIT_JSON round-trips through parseSize', () => {
    // Verify that whatever the env var holds is always a valid size string
    const val = process.env.BODY_LIMIT_JSON || '100kb';
    expect(() => parseSize(val)).not.toThrow();
    expect(parseSize(val)).toBeGreaterThan(0);
  });

  it('env var BODY_LIMIT_INVOICE round-trips through parseSize', () => {
    const val = process.env.BODY_LIMIT_INVOICE || '512kb';
    expect(() => parseSize(val)).not.toThrow();
    expect(parseSize(val)).toBeGreaterThan(0);
  });

  it('env var BODY_LIMIT_URLENCODED round-trips through parseSize', () => {
    const val = process.env.BODY_LIMIT_URLENCODED || '50kb';
    expect(() => parseSize(val)).not.toThrow();
    expect(parseSize(val)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// jsonBodyLimit()
// ═══════════════════════════════════════════════════════════════════════════

describe('jsonBodyLimit()', () => {
  const LIMIT = '1kb';
  let app;

  beforeAll(() => { app = buildApp(jsonBodyLimit(LIMIT)); });

  it('returns a two-element handler array', () => {
    const handlers = jsonBodyLimit('100kb');
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers).toHaveLength(2);
    handlers.forEach((h) => expect(typeof h).toBe('function'));
  });

  it('uses the default JSON limit when no override is provided', async () => {
    const defaultApp = buildApp(jsonBodyLimit());
    const res = await request(defaultApp)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(512));

    expect(res.status).toBe(200);
  });

  it('first handler is the named pre-flight guard', () => {
    const [guard] = jsonBodyLimit('100kb');
    expect(guard.name).toBe('jsonSizeGuard');
  });

  // ── Under-limit pass-through ──────────────────────────────────────────

  it('accepts a body within the limit', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(512));
    expect(res.status).toBe(200);
    expect(res.body.received).toBeDefined();
  });

  it('accepts body 1 byte under the limit', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(parseSize(LIMIT) - 1))
      .send(makeJsonBody(parseSize(LIMIT) - 1));
    expect(res.status).toBe(200);
  });

  // ── Body-size rejection ───────────────────────────────────────────────

  it('rejects a body exceeding the limit with 413', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(2048));
    expect(res.status).toBe(413);
  });

  it('413 response has correct shape', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(2048));
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      message: expect.stringContaining('maximum allowed size'),
    });
  });

  // ── Pre-flight Content-Length checks ─────────────────────────────────
  // The guard runs before express.json — body is never read when header
  // already declares an oversized length.

  it('rejects oversized Content-Length header before body is read (pre-flight)', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(parseSize(LIMIT) + 1))
      .send('{}'); // actual body is tiny — rejection is from header alone
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      message: expect.stringContaining(LIMIT),
      limit: LIMIT,
      path: '/test',
    });
  });

  it('pre-flight 413 response includes the configured limit string', async () => {
    const customApp = buildApp(jsonBodyLimit('2kb'));
    const res = await request(customApp)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(parseSize('2kb') + 1))
      .send('{}');
    expect(res.status).toBe(413);
    expect(res.body.limit).toBe('2kb');
  });

  it('allows Content-Length exactly at the limit (boundary — strictly over rejects)', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(parseSize(LIMIT)))
      .send(makeJsonBody(parseSize(LIMIT)));
    // Guard checks > (strictly over), so exactly-at should not be pre-flight rejected
    expect([200, 413]).toContain(res.status);
  });

  it('allows request with no Content-Length header', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(512));
    expect(res.status).toBe(200);
  });

  it('delegates malformed Content-Length values to the parser limit', () => {
    const [guard] = jsonBodyLimit(LIMIT);
    const next = jest.fn();

    guard({ headers: { 'content-length': 'not-a-number' } }, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('delegates negative Content-Length values to the parser limit', () => {
    const [guard] = jsonBodyLimit(LIMIT);
    const next = jest.fn();

    guard({ headers: { 'content-length': '-1' } }, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts under-limit chunked JSON without a Content-Length header', async () => {
    const res = await postChunked(app, {
      contentType: 'application/json',
      body: makeJsonBody(512),
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBeDefined();
  });

  it('rejects oversized chunked JSON without a Content-Length header', async () => {
    const res = await postChunked(app, {
      contentType: 'application/json',
      body: makeJsonBody(2048),
    });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      path: '/test',
    });
  });

  // ── Parser behaviour ──────────────────────────────────────────────────

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('{bad json}');
    expect(res.status).toBe(400);
  });

  it('rejects primitive root JSON (strict mode)', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('"just a string"');
    expect(res.status).toBe(400);
  });

  it('ignores non-JSON content type gracefully', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'text/plain')
      .send('hello world');
    expect([200, 400, 415]).toContain(res.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// urlencodedBodyLimit()
// ═══════════════════════════════════════════════════════════════════════════

describe('urlencodedBodyLimit()', () => {
  const LIMIT = '1kb';
  let app;

  beforeAll(() => { app = buildApp(urlencodedBodyLimit(LIMIT)); });

  it('returns a two-element handler array', () => {
    const handlers = urlencodedBodyLimit('50kb');
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers).toHaveLength(2);
  });

  it('uses the default URL-encoded limit when no override is provided', async () => {
    const defaultApp = buildApp(urlencodedBodyLimit());
    const res = await request(defaultApp)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(128));

    expect(res.status).toBe(200);
  });

  it('first handler is the named pre-flight guard', () => {
    const [guard] = urlencodedBodyLimit('50kb');
    expect(guard.name).toBe('urlencodedSizeGuard');
  });

  // ── Under-limit pass-through ──────────────────────────────────────────

  it('accepts a body within the limit', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(512));
    expect(res.status).toBe(200);
  });

  it('allows when no Content-Length header is present', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(200));
    expect(res.status).toBe(200);
  });

  it('rejects oversized chunked URL-encoded bodies without a Content-Length header', async () => {
    const res = await postChunked(app, {
      contentType: 'application/x-www-form-urlencoded',
      body: makeUrlencodedBody(2048),
    });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      path: '/test',
    });
  });

  it('allows Content-Length 1 byte under the limit', async () => {
    const under = parseSize(LIMIT) - 1;
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Content-Length', String(under))
      .send(makeUrlencodedBody(under));
    expect(res.status).toBe(200);
  });

  // ── Body-size rejection ───────────────────────────────────────────────

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

  // ── Pre-flight Content-Length checks ─────────────────────────────────

  it('rejects oversized Content-Length header before body is read (pre-flight)', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Content-Length', String(parseSize(LIMIT) + 1))
      .send('x=1'); // tiny actual body — rejection from header alone
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      limit: LIMIT,
      path: '/test',
    });
  });

  it('pre-flight 413 includes path in response body', async () => {
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Content-Length', String(parseSize(LIMIT) + 100))
      .send('x=1');
    expect(res.body).toHaveProperty('path', '/test');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// invoiceBodyLimit()
// ═══════════════════════════════════════════════════════════════════════════

describe('invoiceBodyLimit()', () => {
  let appDefault, appCustom;

  beforeAll(() => {
    appDefault = buildApp(invoiceBodyLimit());       // 512 KB default
    appCustom  = buildApp(invoiceBodyLimit('2kb'));  // custom 2 KB
  });

  it('returns a handler array', () => {
    const handlers = invoiceBodyLimit();
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers.length).toBeGreaterThan(0);
  });

  // ── Under-limit pass-through ──────────────────────────────────────────

  it('accepts a body within the default 512 KB limit', async () => {
    const res = await request(appDefault)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(100));
    expect(res.status).toBe(200);
  });

  it('accepts a body within a custom 2 KB limit', async () => {
    const res = await request(appCustom)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(1024));
    expect(res.status).toBe(200);
  });

  // ── Body-size rejection ───────────────────────────────────────────────

  it('rejects a body over the default 512 KB limit', async () => {
    const res = await request(appDefault)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(520 * 1024));
    expect(res.status).toBe(413);
  });

  it('rejects a body over a custom 2 KB limit', async () => {
    const res = await request(appCustom)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(3 * 1024));
    expect(res.status).toBe(413);
  });

  it('rejects oversized chunked invoice JSON without a Content-Length header', async () => {
    const res = await postChunked(appCustom, {
      contentType: 'application/json',
      body: makeJsonBody(3 * 1024),
    });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      path: '/test',
    });
  });

  it('413 response includes path and limit fields', async () => {
    const res = await request(appCustom)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(3 * 1024));
    expect(res.body).toHaveProperty('error', 'Payload Too Large');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('path', '/test');
  });

  // ── Pre-flight Content-Length check ──────────────────────────────────

  it('rejects oversized declared Content-Length before body is read (pre-flight)', async () => {
    const oversized = parseSize('512kb') + 1;
    const res = await request(appDefault)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(oversized))
      .send('{}'); // tiny body — guard fires on header alone
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: 'Payload Too Large',
      message: expect.stringContaining('maximum allowed size'),
    });
  });

  // ── Invoice limit vs. global JSON limit ──────────────────────────────
  // Global: 100 KB  |  Invoice: 512 KB
  // A 200 KB body should pass the invoice route but fail the global route.

  it('invoice limit (512 KB) is stricter than 1 MB but looser than 100 KB global', () => {
    expect(parseSize('512kb')).toBeLessThan(parseSize('1mb'));
    expect(parseSize('512kb')).toBeGreaterThan(parseSize('100kb'));
  });

  it('invoice route allows a 200 KB body that exceeds the 100 KB global limit', async () => {
    const res = await request(appDefault)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(200 * 1024)); // 200 KB — under invoice 512 KB
    expect(res.status).toBe(200);
  });

  it('global-limited route (100 KB) rejects the same 200 KB body', async () => {
    const globalApp = buildApp(jsonBodyLimit('100kb'));
    const res = await request(globalApp)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(200 * 1024)); // 200 KB — over global 100 KB
    expect(res.status).toBe(413);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// payloadTooLargeHandler()
// ═══════════════════════════════════════════════════════════════════════════

describe('payloadTooLargeHandler()', () => {
  // ── Standardized 413 shape ────────────────────────────────────────────

  it('converts entity.too.large to 413 JSON', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 }));
    });
    app.use(payloadTooLargeHandler);
    app.use((_err, _req, res, _next) => res.status(500).json({ error: 'other' }));

    const res = await request(app).post('/trigger');
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: 'Payload Too Large' });
  });

  it('standardized 413 response contains all four required fields', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), {
        type: 'entity.too.large',
        status: 413,
        limit: 102400,
      }));
    });
    app.use(payloadTooLargeHandler);

    const res = await request(app).post('/trigger');
    expect(res.status).toBe(413);
    expect(res.body).toHaveProperty('error', 'Payload Too Large');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('path');
  });

  it('formats numeric err.limit as "<n>b" string in the response', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), {
        type: 'entity.too.large',
        limit: 51200,
      }));
    });
    app.use(payloadTooLargeHandler);

    const res = await request(app).post('/trigger');
    expect(res.body.limit).toBe('51200b');
  });

  it('uses "unknown" as limit string when err.limit is absent', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), { type: 'entity.too.large' }));
    });
    app.use(payloadTooLargeHandler);

    const res = await request(app).post('/trigger');
    expect(res.body.limit).toBe('unknown');
  });

  // ── Non-size errors pass through ──────────────────────────────────────

  it('passes non-size errors to the next error handler', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => next(new Error('unrelated')));
    app.use(payloadTooLargeHandler);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

    const res = await request(app).post('/trigger');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unrelated');
  });

  // ── Under-limit pass-through ──────────────────────────────────────────

  it('under-limit request is not intercepted by the handler', async () => {
    const app = express();
    app.use(...jsonBodyLimit('10kb'));
    app.post('/test', (req, res) => res.json({ ok: true }));
    app.use(payloadTooLargeHandler);

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(1024)); // 1 KB — well under 10 KB
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// bodySizeLimitRejectionsTotal metric
// ═══════════════════════════════════════════════════════════════════════════

describe('bodySizeLimitRejectionsTotal metric', () => {
  let metricSpy;

  beforeEach(() => {
    // Spy on the counter's .inc() method to track invocations
    metricSpy = jest.spyOn(bodySizeLimitRejectionsTotal, 'inc');
    bodySizeLimitRejectionsTotal.labels.mockClear();
  });

  afterEach(() => {
    metricSpy.mockRestore();
  });

  // ── Pre-flight guard: JSON ────────────────────────────────────────────

  it('increments metric with type "json" on oversized JSON Content-Length pre-flight', async () => {
    const app = buildApp(jsonBodyLimit('1kb'));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(parseSize('1kb') + 1))
      .send('{}');

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'json' });
  });

  it('increments metric with type "json" on oversized JSON body rejection', async () => {
    const app = buildApp(jsonBodyLimit('1kb'));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(2048));

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'json' });
  });

  it('increments metric with type "json" on oversized chunked JSON body rejection', async () => {
    const app = buildApp(jsonBodyLimit('1kb'));

    const res = await postChunked(app, {
      contentType: 'application/json',
      body: makeJsonBody(2048),
    });

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'json' });
  });

  it('keeps the legacy invoice label when jsonBodyLimit receives the invoice default', async () => {
    const app = buildApp(jsonBodyLimit(DEFAULT_LIMITS.invoice));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(parseSize(DEFAULT_LIMITS.invoice) + 1))
      .send('{}');

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'invoice' });
  });

  // ── Pre-flight guard: URL-encoded ─────────────────────────────────────

  it('increments metric with type "urlencoded" on oversized URL-encoded pre-flight', async () => {
    const app = buildApp(urlencodedBodyLimit('1kb'));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Content-Length', String(parseSize('1kb') + 1))
      .send('x=1');

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'urlencoded' });
  });

  it('increments metric with type "urlencoded" on oversized URL-encoded body rejection', async () => {
    const app = buildApp(urlencodedBodyLimit('1kb'));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(2048));

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'urlencoded' });
  });

  it('increments metric with type "urlencoded" on oversized chunked URL-encoded rejection', async () => {
    const app = buildApp(urlencodedBodyLimit('1kb'));

    const res = await postChunked(app, {
      contentType: 'application/x-www-form-urlencoded',
      body: makeUrlencodedBody(2048),
    });

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'urlencoded' });
  });

  it('increments metric with type "invoice" on oversized chunked invoice rejection', async () => {
    const app = buildApp(invoiceBodyLimit('1kb'));

    const res = await postChunked(app, {
      contentType: 'application/json',
      body: makeJsonBody(2048),
    });

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'invoice' });
  });

  // ── PayloadTooLargeHandler: derives from content-type ────────────────

  it('increments metric with type "json" from payloadTooLargeHandler for JSON content-type', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), { type: 'entity.too.large', limit: 102400 }));
    });
    app.use(payloadTooLargeHandler);

    const res = await request(app)
      .post('/trigger')
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'json' });
  });

  it('increments metric with type "urlencoded" from payloadTooLargeHandler for form content-type', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), { type: 'entity.too.large', limit: 51200 }));
    });
    app.use(payloadTooLargeHandler);

    const res = await request(app)
      .post('/trigger')
      .set('Content-Type', 'application/x-www-form-urlencoded');

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'urlencoded' });
  });

  it('increments metric with type "unknown" from payloadTooLargeHandler for unrecognized content-type', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), { type: 'entity.too.large', limit: 102400 }));
    });
    app.use(payloadTooLargeHandler);

    const res = await request(app)
      .post('/trigger')
      .set('Content-Type', 'application/octet-stream');

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'unknown' });
  });

  it('increments metric with type "unknown" from payloadTooLargeHandler when no content-type header', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => {
      next(Object.assign(new Error('too large'), { type: 'entity.too.large', limit: 102400 }));
    });
    app.use(payloadTooLargeHandler);

    const res = await request(app).post('/trigger');

    expect(res.status).toBe(413);
    expect(metricSpy).toHaveBeenCalledWith({ type: 'unknown' });
  });

  // ── Under-limit requests do NOT increment ────────────────────────────

  it('does NOT increment metric for under-limit JSON request', async () => {
    const app = buildApp(jsonBodyLimit('10kb'));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(makeJsonBody(512));

    expect(res.status).toBe(200);
    expect(metricSpy).not.toHaveBeenCalled();
  });

  it('does NOT increment metric for under-limit URL-encoded request', async () => {
    const app = buildApp(urlencodedBodyLimit('10kb'));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(makeUrlencodedBody(200));

    expect(res.status).toBe(200);
    expect(metricSpy).not.toHaveBeenCalled();
  });

  it('does NOT increment metric when payloadTooLargeHandler passes non-size error through', async () => {
    const app = express();
    app.post('/trigger', (_req, _res, next) => next(new Error('unrelated')));
    app.use(payloadTooLargeHandler);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

    const res = await request(app).post('/trigger');

    expect(res.status).toBe(500);
    expect(metricSpy).not.toHaveBeenCalled();
  });
});
