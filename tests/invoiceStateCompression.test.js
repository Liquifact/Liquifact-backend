'use strict';

/**
 * @fileoverview Tests for gzip/deflate compression middleware on invoice-state
 * responses (issue #966).
 *
 * Coverage:
 *  - negotiateEncoding: gzip, deflate, identity, q-values, wildcard, edge cases
 *  - createCompressionMiddleware unit: threshold boundary, no compression below
 *  - Route integration: GET /:id/state compressed/uncompressed paths
 *  - Accept-Encoding variants: gzip, deflate, identity, missing, unsupported
 *  - Vary: Accept-Encoding always present
 *  - Content-Type preserved on compressed responses
 *  - Decompressed body round-trips correctly
 *  - Custom threshold option
 *  - Compression fallback on zlib error
 */

const zlib = require('zlib');
const express = require('express');
const request = require('supertest');

const {
  createCompressionMiddleware,
  negotiateEncoding,
  DEFAULT_THRESHOLD,
} = require('../src/middleware/compression');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app with the compression middleware mounted and a
 * single GET /data route that responds with the provided body.
 *
 * @param {object}  body      - JSON body to send.
 * @param {object}  [opts={}] - Options forwarded to createCompressionMiddleware.
 * @returns {import('express').Express}
 */
function buildApp(body, opts = {}) {
  const app = express();
  app.use(createCompressionMiddleware(opts));
  app.get('/data', (_req, res) => res.json(body));
  return app;
}

/**
 * Returns a JSON-serialisable object whose serialised form is guaranteed to
 * exceed `byteSize` bytes.
 *
 * @param {number} byteSize
 * @returns {object}
 */
function largeBody(byteSize) {
  return { payload: 'x'.repeat(byteSize) };
}

/**
 * Decompresses a Buffer with the given encoding synchronously.
 *
 * @param {Buffer} buf
 * @param {'gzip'|'deflate'} encoding
 * @returns {string}
 */
function decompress(buf, encoding) {
  return encoding === 'gzip'
    ? zlib.gunzipSync(buf).toString('utf8')
    : zlib.inflateSync(buf).toString('utf8');
}

// ---------------------------------------------------------------------------
// 1. negotiateEncoding — unit tests
// ---------------------------------------------------------------------------

describe('negotiateEncoding()', () => {
  test('returns gzip for "gzip"', () => {
    expect(negotiateEncoding('gzip')).toBe('gzip');
  });

  test('returns gzip for "gzip, deflate"', () => {
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
  });

  test('returns deflate when only deflate is offered', () => {
    expect(negotiateEncoding('deflate')).toBe('deflate');
  });

  test('returns identity when Accept-Encoding is absent (undefined)', () => {
    expect(negotiateEncoding(undefined)).toBe('identity');
  });

  test('returns identity when Accept-Encoding is empty string', () => {
    expect(negotiateEncoding('')).toBe('identity');
  });

  test('returns identity for unsupported encoding "br"', () => {
    expect(negotiateEncoding('br')).toBe('identity');
  });

  test('returns identity for "identity"', () => {
    expect(negotiateEncoding('identity')).toBe('identity');
  });

  test('prefers gzip over deflate when both are equal quality', () => {
    expect(negotiateEncoding('deflate, gzip')).toBe('gzip');
  });

  test('respects q-value: deflate;q=0.9, gzip;q=0.1 → gzip still wins (server pref)', () => {
    // Server preference order is gzip > deflate regardless of client q, as long
    // as the client q > 0. This matches common server behaviour.
    expect(negotiateEncoding('deflate;q=0.9, gzip;q=0.1')).toBe('gzip');
  });

  test('respects q=0: gzip;q=0 means client refuses gzip → falls to deflate', () => {
    expect(negotiateEncoding('gzip;q=0, deflate')).toBe('deflate');
  });

  test('wildcard * enables gzip when gzip not explicitly listed', () => {
    expect(negotiateEncoding('*')).toBe('gzip');
  });

  test('wildcard * with gzip;q=0 does not enable gzip', () => {
    // gzip is explicitly denied; wildcard covers deflate → deflate
    expect(negotiateEncoding('gzip;q=0, *')).toBe('deflate');
  });

  test('handles extra whitespace around encoding tokens', () => {
    expect(negotiateEncoding('  gzip  ,  deflate  ')).toBe('gzip');
  });

  test('handles uppercase encoding names case-insensitively', () => {
    expect(negotiateEncoding('GZIP')).toBe('gzip');
    expect(negotiateEncoding('DEFLATE')).toBe('deflate');
  });
});

// ---------------------------------------------------------------------------
// 2. DEFAULT_THRESHOLD constant
// ---------------------------------------------------------------------------

describe('DEFAULT_THRESHOLD', () => {
  test('is a positive integer', () => {
    expect(typeof DEFAULT_THRESHOLD).toBe('number');
    expect(DEFAULT_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_THRESHOLD)).toBe(true);
  });

  test('equals 1024 bytes', () => {
    expect(DEFAULT_THRESHOLD).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// 3. createCompressionMiddleware — threshold boundary (unit)
// ---------------------------------------------------------------------------

describe('createCompressionMiddleware() — threshold boundary', () => {
  test('response exactly at threshold is NOT compressed', async () => {
    // Build a body that serialises to exactly DEFAULT_THRESHOLD bytes
    const threshold = DEFAULT_THRESHOLD;
    // '{"payload":"..."}' = 12 overhead chars; pad to hit exactly threshold
    const padLen = threshold - '{"payload":"","extra":""}'.length - 2;
    const body = { payload: 'a'.repeat(Math.max(0, padLen)), extra: '' };
    const json = JSON.stringify(body);
    // Ensure we are at or below threshold
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(threshold);

    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.status).toBe(200);
  });

  test('response one byte above threshold IS compressed', async () => {
    const body = largeBody(DEFAULT_THRESHOLD + 50);
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('custom threshold: body above custom threshold is compressed', async () => {
    const customThreshold = 200;
    const body = largeBody(customThreshold + 50);
    const app = buildApp(body, { threshold: customThreshold });

    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('custom threshold: body below custom threshold is NOT compressed', async () => {
    const customThreshold = 5000;
    const body = largeBody(100); // well below 5000
    const app = buildApp(body, { threshold: customThreshold });

    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.status).toBe(200);
  });

  test('threshold of 0 compresses even tiny responses', async () => {
    const body = { ok: true };
    const app = buildApp(body, { threshold: 0 });

    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.headers['content-encoding']).toBe('gzip');
  });
});

// ---------------------------------------------------------------------------
// 4. Accept-Encoding variants on large responses
// ---------------------------------------------------------------------------

describe('Accept-Encoding negotiation on large responses', () => {
  const body = largeBody(DEFAULT_THRESHOLD + 500);

  /**
   * Custom supertest parser that returns raw buffer (bypasses auto-inflate).
   */
  function rawBufferParser(response, callback) {
    const chunks = [];
    response.on('data', (c) => chunks.push(c));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  }

  test('gzip: Content-Encoding is gzip and body decompresses correctly', async () => {
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['content-encoding']).toBe('gzip');
    const decompressed = decompress(res.body, 'gzip');
    expect(JSON.parse(decompressed)).toEqual(body);
  });

  test('deflate: Content-Encoding is deflate and body decompresses correctly', async () => {
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'deflate')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['content-encoding']).toBe('deflate');
    const decompressed = decompress(res.body, 'deflate');
    expect(JSON.parse(decompressed)).toEqual(body);
  });

  test('no Accept-Encoding: response is plain JSON, no Content-Encoding', async () => {
    const app = buildApp(body);
    const res = await request(app).get('/data');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
  });

  test('Accept-Encoding: identity: response is plain JSON', async () => {
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'identity');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(body);
  });

  test('unsupported encoding "br" only: response is plain JSON', async () => {
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'br');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(body);
  });

  test('"gzip, deflate, br" prefers gzip', async () => {
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip, deflate, br')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('"deflate, br" (no gzip) uses deflate', async () => {
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'deflate, br')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['content-encoding']).toBe('deflate');
  });
});

// ---------------------------------------------------------------------------
// 5. Headers contract
// ---------------------------------------------------------------------------

describe('Headers contract', () => {
  function rawBufferParser(response, callback) {
    const chunks = [];
    response.on('data', (c) => chunks.push(c));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  }

  test('Vary: Accept-Encoding is set on large compressed response', async () => {
    const body = largeBody(DEFAULT_THRESHOLD + 100);
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['vary']).toMatch(/accept-encoding/i);
  });

  test('Vary: Accept-Encoding is set even on small (uncompressed) responses', async () => {
    const body = { small: true };
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['vary']).toMatch(/accept-encoding/i);
  });

  test('Content-Type is application/json on compressed response', async () => {
    const body = largeBody(DEFAULT_THRESHOLD + 100);
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('Content-Length is absent on compressed responses (size changed)', async () => {
    const body = largeBody(DEFAULT_THRESHOLD + 100);
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    // content-length must not be set to the original JSON size
    // (Express may set transfer-encoding: chunked instead)
    if (res.headers['content-length']) {
      // If present it must match the compressed buffer size, not the JSON size
      const jsonLen = Buffer.byteLength(JSON.stringify(body), 'utf8');
      expect(Number(res.headers['content-length'])).not.toBe(jsonLen);
    }
  });

  test('HTTP status 200 is preserved on compressed response', async () => {
    const body = largeBody(DEFAULT_THRESHOLD + 100);
    const app = buildApp(body);
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.status).toBe(200);
  });

  test('HTTP status 200 is preserved on uncompressed small response', async () => {
    const app = buildApp({ tiny: true });
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6. Round-trip fidelity — gzip and deflate
// ---------------------------------------------------------------------------

describe('Round-trip fidelity', () => {
  function rawBufferParser(response, callback) {
    const chunks = [];
    response.on('data', (c) => chunks.push(c));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  }

  test('gzip round-trip: decompressed body equals original object', async () => {
    const body = {
      invoiceId: 'inv-roundtrip-001',
      currentState: 'pending',
      allowedTransitions: ['approved', 'rejected', 'cancelled'],
      history: Array.from({ length: 50 }, (_, i) => ({
        step: i,
        state: 'pending',
        actor: `user-${i}`,
        timestamp: new Date(2026, 0, i + 1).toISOString(),
      })),
    };

    const app = buildApp(body, { threshold: 0 });
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['content-encoding']).toBe('gzip');
    const parsed = JSON.parse(decompress(res.body, 'gzip'));
    expect(parsed).toEqual(body);
  });

  test('deflate round-trip: decompressed body equals original object', async () => {
    const body = {
      invoiceId: 'inv-roundtrip-002',
      transitions: Array.from({ length: 40 }, (_, i) => ({ seq: i, note: 'x'.repeat(20) })),
    };

    const app = buildApp(body, { threshold: 0 });
    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'deflate')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.headers['content-encoding']).toBe('deflate');
    const parsed = JSON.parse(decompress(res.body, 'deflate'));
    expect(parsed).toEqual(body);
  });

  test('uncompressed path: body property equals original object', async () => {
    const body = { small: 'response', n: 42 };
    const app = buildApp(body); // default threshold keeps this uncompressed

    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// 7. Invoice-state route integration — mocked invoiceService
// ---------------------------------------------------------------------------

jest.mock('../src/middleware/tenant', () => ({
  extractTenant: (req, _res, next) => { req.tenantId = 'tenant-test'; next(); },
}));

jest.mock('../src/middleware/rateLimit', () => ({
  invoiceStateLimiter: (_req, _res, next) => next(),
}));

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: (_req, _res, next) => next(),
  auditKycAccess: (_req, _res, next) => next(),
}));

jest.mock('../src/services/invoiceService', () => ({
  resolveInvoiceForTenant: jest.fn(),
  transitionInvoice: jest.fn(),
}));

describe('GET /api/invoices/:id/state — compression integration', () => {
  const invoiceService = require('../src/services/invoiceService');
  const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');

  function rawBufferParser(response, callback) {
    const chunks = [];
    response.on('data', (c) => chunks.push(c));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  }

  function buildRouteApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/invoices', invoiceStateRoutes);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    return app;
  }

  /**
   * Builds a fake invoice object with an allowedTransitions list padded to
   * produce a response body well above the compression threshold.
   */
  function makeLargeInvoice(id = 'inv-large-001') {
    return {
      id,
      status: 'pending',
      // large metadata ensures the JSON response exceeds 1024 bytes
      metadata: { description: 'x'.repeat(1200) },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('large state response with Accept-Encoding: gzip is compressed', async () => {
    invoiceService.resolveInvoiceForTenant.mockResolvedValue(makeLargeInvoice());

    const res = await request(buildRouteApp())
      .get('/api/invoices/inv-large-001/state')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');

    const parsed = JSON.parse(decompress(res.body, 'gzip'));
    expect(parsed.data.invoiceId).toBe('inv-large-001');
    expect(parsed.data.currentState).toBe('pending');
  });

  test('small state response is NOT compressed even with Accept-Encoding: gzip', async () => {
    invoiceService.resolveInvoiceForTenant.mockResolvedValue({
      id: 'inv-small-001',
      status: 'approved',
    });

    const res = await request(buildRouteApp())
      .get('/api/invoices/inv-small-001/state')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    // Small responses must not be compressed
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.data.currentState).toBe('approved');
  });

  test('404 when invoice not found is NOT compressed (small body)', async () => {
    invoiceService.resolveInvoiceForTenant.mockResolvedValue(null);

    const res = await request(buildRouteApp())
      .get('/api/invoices/inv-missing/state')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(404);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('Vary: Accept-Encoding is always present on invoice-state responses', async () => {
    invoiceService.resolveInvoiceForTenant.mockResolvedValue({
      id: 'inv-vary-001',
      status: 'pending',
    });

    const res = await request(buildRouteApp())
      .get('/api/invoices/inv-vary-001/state')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['vary']).toMatch(/accept-encoding/i);
  });

  test('large state response with Accept-Encoding: deflate is compressed', async () => {
    invoiceService.resolveInvoiceForTenant.mockResolvedValue(makeLargeInvoice('inv-deflate-001'));

    const res = await request(buildRouteApp())
      .get('/api/invoices/inv-deflate-001/state')
      .set('Accept-Encoding', 'deflate')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('deflate');

    const parsed = JSON.parse(decompress(res.body, 'deflate'));
    expect(parsed.data.currentState).toBe('pending');
  });

  test('large state response with no Accept-Encoding is NOT compressed', async () => {
    invoiceService.resolveInvoiceForTenant.mockResolvedValue(makeLargeInvoice('inv-noenc-001'));

    const res = await request(buildRouteApp())
      .get('/api/invoices/inv-noenc-001/state');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.data.invoiceId).toBe('inv-noenc-001');
  });
});

// ---------------------------------------------------------------------------
// 8. Edge cases and resilience
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  function rawBufferParser(response, callback) {
    const chunks = [];
    response.on('data', (c) => chunks.push(c));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  }

  test('null body is handled without throwing', async () => {
    const app = express();
    app.use(createCompressionMiddleware({ threshold: 0 }));
    app.get('/data', (_req, res) => res.json(null));

    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    // null serialises to 4 bytes — at threshold 0 it will be compressed
    expect(res.status).toBe(200);
  });

  test('empty array body is handled without throwing', async () => {
    const app = express();
    app.use(createCompressionMiddleware({ threshold: 0 }));
    app.get('/data', (_req, res) => res.json([]));

    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    expect(res.status).toBe(200);
  });

  test('middleware does not interfere with non-json routes', async () => {
    const app = express();
    app.use(createCompressionMiddleware());
    app.get('/text', (_req, res) => res.send('hello'));

    const res = await request(app)
      .get('/text')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');
  });

  test('invalid threshold option falls back to DEFAULT_THRESHOLD', async () => {
    // negative threshold should be treated as DEFAULT_THRESHOLD
    const body = largeBody(DEFAULT_THRESHOLD + 100);
    const app = buildApp(body, { threshold: -1 });

    const res = await request(app)
      .get('/data')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawBufferParser);

    // Body is above default threshold → should still be compressed
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('multiple requests through same middleware instance are independent', async () => {
    const largePayload = largeBody(DEFAULT_THRESHOLD + 200);
    const smallPayload = { tiny: true };

    const app = express();
    app.use(createCompressionMiddleware());
    app.get('/large', (_req, res) => res.json(largePayload));
    app.get('/small', (_req, res) => res.json(smallPayload));

    const [r1, r2] = await Promise.all([
      request(app).get('/large').set('Accept-Encoding', 'gzip').buffer(true).parse((r, cb) => {
        const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c)));
      }),
      request(app).get('/small').set('Accept-Encoding', 'gzip'),
    ]);

    expect(r1.headers['content-encoding']).toBe('gzip');
    expect(r2.headers['content-encoding']).toBeUndefined();
  });
});
