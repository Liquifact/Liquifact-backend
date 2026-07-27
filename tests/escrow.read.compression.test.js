'use strict';

/**
 * @fileoverview Tests for gzip/deflate compression on the
 * `GET /api/escrow/:invoiceId` endpoint (issue #961).
 *
 * Coverage:
 *  - Large response is gzip-compressed when client sends `Accept-Encoding: gzip`
 *  - Large response is deflate-compressed when client sends `Accept-Encoding: deflate`
 *  - Small response (≤ threshold) is NOT compressed even with Accept-Encoding: gzip
 *  - No Accept-Encoding header → uncompressed plain JSON
 *  - `Vary: Accept-Encoding` is always present on the escrow route
 *  - Decompressed body round-trips correctly
 *  - `Content-Encoding` header is set on compressed responses
 *  - `Content-Encoding` is absent on uncompressed responses
 *  - 404 still returns plain JSON
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-validation-purposes';

const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const { createCompressionMiddleware } = require('../src/middleware/compression');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app that mimics the escrow-read route with the
 * compression middleware mounted exactly as in app.js.
 */
function buildEscrowApp({ escrowState = null, threshold = 1024 } = {}) {
  const app = express();

  app.get(
    '/api/escrow/:invoiceId',
    createCompressionMiddleware({ threshold }),
    (req, res) => {
      const { invoiceId } = req.params;

      if (invoiceId === 'not-found') {
        return res.status(404).json({
          error: `No escrow contract mapping found for invoice ID '${invoiceId}'`,
        });
      }

      const state = escrowState || {
        invoiceId,
        status: 'funded',
        fundedAmount: '1000000000',
        maturityDate: '2027-01-01T00:00:00.000Z',
        escrowAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM',
      };

      res.set(
        'X-Escrow-Address',
        state.escrowAddress || 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM',
      );
      return res.json({ data: state, message: 'Escrow state read from event projection.' });
    },
  );

  return app;
}

/** Returns a large escrow-state payload that exceeds `threshold` bytes when serialised. */
function largeEscrowState(threshold = 1024) {
  return {
    invoiceId: 'inv_001',
    status: 'funded',
    fundedAmount: '1000000000',
    maturityDate: '2027-01-01T00:00:00.000Z',
    escrowAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM',
    _padding: 'x'.repeat(threshold * 2),
  };
}

/** Decompresses a Buffer synchronously. */
function decompress(buf, encoding) {
  return encoding === 'gzip'
    ? zlib.gunzipSync(buf).toString('utf8')
    : zlib.inflateSync(buf).toString('utf8');
}

/** supertest binary parser — collects raw bytes without decompressing. */
function rawParser(res, callback) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

// ---------------------------------------------------------------------------
// 1. Vary header — always present
// ---------------------------------------------------------------------------

describe('Vary: Accept-Encoding on escrow-read route', () => {
  const app = buildEscrowApp();

  test('is set on a normal (small) response', async () => {
    const res = await request(app).get('/api/escrow/inv_small');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
  });

  test('is set on a 404 response', async () => {
    const res = await request(app).get('/api/escrow/not-found');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Large response — compressed paths
// ---------------------------------------------------------------------------

describe('Large escrow-read response — compressed', () => {
  const state = largeEscrowState(1024);
  const app = buildEscrowApp({ escrowState: state });

  test('gzip: Content-Encoding is gzip', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('gzip: decompressed body round-trips correctly', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);

    const decompressed = decompress(res.body, 'gzip');
    const parsed = JSON.parse(decompressed);
    expect(parsed.data.invoiceId).toBe('inv_001');
    expect(parsed.data.status).toBe('funded');
  });

  test('deflate: Content-Encoding is deflate', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'deflate')
      .buffer(true)
      .parse(rawParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('deflate');
  });

  test('deflate: decompressed body round-trips correctly', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'deflate')
      .buffer(true)
      .parse(rawParser);

    const decompressed = decompress(res.body, 'deflate');
    const parsed = JSON.parse(decompressed);
    expect(parsed.data.invoiceId).toBe('inv_001');
  });

  test('gzip is preferred over deflate when both are offered', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'gzip, deflate')
      .buffer(true)
      .parse(rawParser);

    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('Content-Type is application/json on compressed response', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);

    expect(res.headers['content-type']).toMatch(/application\/json/i);
  });

  test('X-Escrow-Address header is still present on compressed response', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);

    expect(res.headers['x-escrow-address']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Small response — NOT compressed
// ---------------------------------------------------------------------------

describe('Small escrow-read response — not compressed', () => {
  const smallState = {
    invoiceId: 'inv_tiny',
    status: 'pending',
    escrowAddress: 'GABC',
  };
  // Threshold much larger than the payload so it never compresses
  const app = buildEscrowApp({ escrowState: smallState, threshold: 100_000 });

  test('no Content-Encoding header even with Accept-Encoding: gzip', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_tiny')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('response is valid JSON', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_tiny')
      .set('Accept-Encoding', 'gzip');

    expect(res.body.data.invoiceId).toBe('inv_tiny');
    expect(res.body.data.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 4. No Accept-Encoding header — no compression
// ---------------------------------------------------------------------------

describe('No Accept-Encoding header — no compression', () => {
  const state = largeEscrowState(1024);
  const app = buildEscrowApp({ escrowState: state });

  test('large response is plain JSON when Accept-Encoding is absent', async () => {
    const res = await request(app).get('/api/escrow/inv_001');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.data.invoiceId).toBe('inv_001');
  });
});

// ---------------------------------------------------------------------------
// 5. Accept-Encoding: identity — no compression
// ---------------------------------------------------------------------------

describe('Accept-Encoding: identity — no compression', () => {
  const state = largeEscrowState(1024);
  const app = buildEscrowApp({ escrowState: state });

  test('no compression when client explicitly requests identity', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'identity');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.data.invoiceId).toBe('inv_001');
  });
});

// ---------------------------------------------------------------------------
// 6. Accept-Encoding: br (unsupported) — falls back to no compression
// ---------------------------------------------------------------------------

describe('Unsupported encoding br — no compression', () => {
  const state = largeEscrowState(1024);
  const app = buildEscrowApp({ escrowState: state });

  test('no Content-Encoding for unsupported br encoding', async () => {
    const res = await request(app)
      .get('/api/escrow/inv_001')
      .set('Accept-Encoding', 'br');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.data.invoiceId).toBe('inv_001');
  });
});

// ---------------------------------------------------------------------------
// 7. 404 response — plain JSON
// ---------------------------------------------------------------------------

describe('404 not-found response', () => {
  const app = buildEscrowApp();

  test('returns 404 JSON error body', async () => {
    const res = await request(app)
      .get('/api/escrow/not-found')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not-found/);
  });
});

// ---------------------------------------------------------------------------
// 8. Threshold boundary
// ---------------------------------------------------------------------------

describe('Threshold boundary', () => {
  test('payload at or below threshold is not compressed', async () => {
    const smallState = { invoiceId: 'inv_boundary', x: 'tiny' };
    const app = buildEscrowApp({ escrowState: smallState, threshold: 100_000 });

    const res = await request(app)
      .get('/api/escrow/inv_boundary')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('payload above threshold is compressed', async () => {
    const state = largeEscrowState(512);
    const app = buildEscrowApp({ escrowState: state, threshold: 512 });

    const res = await request(app)
      .get('/api/escrow/inv_boundary')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);

    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('custom low threshold compresses even small payloads', async () => {
    const state = { invoiceId: 'inv_threshold', status: 'funded', _pad: 'y'.repeat(200) };
    const app = buildEscrowApp({ escrowState: state, threshold: 0 });

    const res = await request(app)
      .get('/api/escrow/inv_threshold')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);

    expect(res.headers['content-encoding']).toBe('gzip');
  });
});
