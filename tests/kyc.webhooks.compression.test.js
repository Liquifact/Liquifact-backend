'use strict';

/**
 * @fileoverview Tests for gzip/deflate compression on the
 * kyc-webhooks endpoints (issue #956).
 *
 * Coverage:
 *  - Large GET /api/kyc/webhooks response is gzip-compressed
 *  - Large GET /api/kyc/webhooks response is deflate-compressed
 *  - Large GET /api/kyc/webhooks/audit response is gzip-compressed
 *  - Small POST /api/kyc/webhook response (ingestion ack) is NOT compressed
 *  - No Accept-Encoding header → uncompressed plain JSON
 *  - Accept-Encoding: identity → no compression
 *  - Accept-Encoding: br (unsupported) → falls back to no compression
 *  - Vary: Accept-Encoding is always present
 *  - Content-Encoding header is set on compressed responses
 *  - Content-Encoding is absent on uncompressed responses
 *  - Decompressed body round-trips correctly
 *  - Threshold boundary: payload at threshold not compressed, above compressed
 *  - gzip is preferred over deflate when both are offered
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-validation-purposes';

const zlib = require('zlib');
const http = require('http');
const express = require('express');
const request = require('supertest');
const { createCompressionMiddleware } = require('../src/middleware/compression');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app that mimics the KYC webhook routes with
 * compression middleware mounted exactly as in kyc.js.
 */
function buildKycApp({ webhooks = [], auditLogs = [], threshold = 1024 } = {}) {
  const app = express();

  app.use(express.json());

  const router = express.Router();

  // Mount compression middleware before routes, matching kyc.js
  router.use(createCompressionMiddleware({ threshold }));

  // POST /api/kyc/webhook — small ingestion ack
  router.post('/webhook', (req, res) => {
    return res.status(200).json({
      success: true,
      smeId: 'sme_123',
      status: 'verified',
    });
  });

  // GET /api/kyc/webhooks — cursor-paginated listing
  router.get('/webhooks', (req, res) => {
    const result = {
      data: webhooks,
      meta: {
        limit: 20,
        hasMore: webhooks.length > 0,
        nextCursor: webhooks.length > 0 ? 'cursor_abc' : null,
      },
    };
    return res.status(200).json(result);
  });

  // GET /api/kyc/webhooks/audit — audit log listing
  router.get('/webhooks/audit', (req, res) => {
    const result = {
      data: auditLogs,
      meta: {
        limit: 20,
        offset: 0,
        count: auditLogs.length,
      },
    };
    return res.status(200).json(result);
  });

  app.use('/api/kyc', router);

  return app;
}

/** Returns a large webhooks listing that exceeds `threshold` bytes when serialised. */
function largeWebhooksList(count = 50) {
  return Array.from({ length: count }, (_, i) => ({
    smeId: `sme_${String(i).padStart(3, '0')}`,
    status: 'verified',
    providerRecordId: `prid_${i}_abcdef1234567890abcdef`,
    verifiedAt: '2026-01-15T10:30:00.000Z',
    updatedAt: '2026-01-15T10:30:00.000Z',
    invoiceId: `inv_${i}_abcdef1234567890abcdef`,
    _padding: 'x'.repeat(50),
  }));
}

/** Returns a large audit logs listing that exceeds `threshold` bytes when serialised. */
function largeAuditLogs(count = 50) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    eventType: 'kyc.status_changed',
    resourceId: `sme_${String(i).padStart(3, '0')}`,
    action: 'update',
    actor: `user_${i}`,
    timestamp: '2026-01-15T10:30:00.000Z',
    details: {
      oldStatus: 'pending',
      newStatus: 'verified',
      _padding: 'y'.repeat(40),
    },
  }));
}

/** Decompresses a Buffer synchronously. */
function decompress(buf, encoding) {
  return encoding === 'gzip'
    ? zlib.gunzipSync(buf).toString('utf8')
    : zlib.inflateSync(buf).toString('utf8');
}

/**
 * Makes a raw HTTP request and returns the response as a Buffer,
 * bypassing supertest's automatic decompression.
 */
function rawGet(app, path, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const opts = {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {},
      };
      if (acceptEncoding) {
        opts.headers['Accept-Encoding'] = acceptEncoding;
      }
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Vary header — always present
// ---------------------------------------------------------------------------

describe('Vary: Accept-Encoding on kyc-webhooks routes', () => {
  const app = buildKycApp();

  test('is set on GET /api/kyc/webhooks (small response)', async () => {
    const res = await request(app).get('/api/kyc/webhooks');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
  });

  test('is set on GET /api/kyc/webhooks/audit (small response)', async () => {
    const res = await request(app).get('/api/kyc/webhooks/audit');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
  });

  test('is set on POST /api/kyc/webhook (small ack)', async () => {
    const res = await request(app)
      .post('/api/kyc/webhook')
      .send({ smeId: 'sme_1', status: 'verified' });
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Large GET /api/kyc/webhooks — compressed paths
// ---------------------------------------------------------------------------

describe('Large GET /api/kyc/webhooks — compressed', () => {
  const webhooks = largeWebhooksList(50);
  const app = buildKycApp({ webhooks });

  test('gzip: Content-Encoding is gzip', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('gzip: decompressed body round-trips correctly', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip');
    const decompressed = decompress(res.body, 'gzip');
    const parsed = JSON.parse(decompressed);
    expect(parsed.data).toHaveLength(50);
    expect(parsed.data[0].smeId).toBe('sme_000');
    expect(parsed.meta.hasMore).toBe(true);
  });

  test('deflate: Content-Encoding is deflate', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'deflate');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('deflate');
  });

  test('deflate: decompressed body round-trips correctly', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'deflate');
    const decompressed = decompress(res.body, 'deflate');
    const parsed = JSON.parse(decompressed);
    expect(parsed.data).toHaveLength(50);
  });

  test('gzip is preferred over deflate when both are offered', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip, deflate');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('Content-Type is application/json on compressed response', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip');
    expect(res.headers['content-type']).toMatch(/application\/json/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Large GET /api/kyc/webhooks/audit — compressed paths
// ---------------------------------------------------------------------------

describe('Large GET /api/kyc/webhooks/audit — compressed', () => {
  const auditLogs = largeAuditLogs(50);
  const app = buildKycApp({ auditLogs });

  test('gzip: Content-Encoding is gzip', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks/audit', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('gzip: decompressed body round-trips correctly', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks/audit', 'gzip');
    const decompressed = decompress(res.body, 'gzip');
    const parsed = JSON.parse(decompressed);
    expect(parsed.data).toHaveLength(50);
    expect(parsed.data[0].eventType).toBe('kyc.status_changed');
    expect(parsed.meta.count).toBe(50);
  });

  test('deflate: Content-Encoding is deflate', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks/audit', 'deflate');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('deflate');
  });
});

// ---------------------------------------------------------------------------
// 4. Small POST /api/kyc/webhook — NOT compressed
// ---------------------------------------------------------------------------

describe('Small POST /api/kyc/webhook — not compressed', () => {
  const app = buildKycApp();

  test('no Content-Encoding header even with Accept-Encoding: gzip', async () => {
    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Accept-Encoding', 'gzip')
      .send({ smeId: 'sme_1', status: 'verified' });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('response is valid JSON', async () => {
    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Accept-Encoding', 'gzip')
      .send({ smeId: 'sme_1', status: 'verified' });

    expect(res.body.success).toBe(true);
    expect(res.body.smeId).toBe('sme_123');
    expect(res.body.status).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// 5. No Accept-Encoding header — no compression
// ---------------------------------------------------------------------------

describe('No Accept-Encoding header — no compression', () => {
  const webhooks = largeWebhooksList(50);
  const app = buildKycApp({ webhooks });

  test('large response is plain JSON when Accept-Encoding is absent', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', null);

    expect(res.headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(res.body.toString('utf8'));
    expect(parsed.data).toHaveLength(50);
    expect(parsed.data[0].smeId).toBe('sme_000');
  });
});

// ---------------------------------------------------------------------------
// 6. Accept-Encoding: identity — no compression
// ---------------------------------------------------------------------------

describe('Accept-Encoding: identity — no compression', () => {
  const webhooks = largeWebhooksList(50);
  const app = buildKycApp({ webhooks });

  test('no compression when client explicitly requests identity', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'identity');

    expect(res.headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(res.body.toString('utf8'));
    expect(parsed.data).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// 7. Accept-Encoding: br (unsupported) — falls back to no compression
// ---------------------------------------------------------------------------

describe('Unsupported encoding br — no compression', () => {
  const webhooks = largeWebhooksList(50);
  const app = buildKycApp({ webhooks });

  test('no Content-Encoding for unsupported br encoding', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'br');

    expect(res.headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(res.body.toString('utf8'));
    expect(parsed.data).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// 8. Threshold boundary
// ---------------------------------------------------------------------------

describe('Threshold boundary', () => {
  test('payload at or below threshold is not compressed', async () => {
    const smallWebhooks = [{ smeId: 'sme_small', status: 'pending' }];
    const app = buildKycApp({ webhooks: smallWebhooks, threshold: 100_000 });

    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('payload above threshold is compressed', async () => {
    const webhooks = largeWebhooksList(50);
    const app = buildKycApp({ webhooks, threshold: 512 });

    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('custom low threshold compresses even small payloads', async () => {
    const smallWebhooks = [{ smeId: 'sme_tiny', status: 'verified', _pad: 'z'.repeat(100) }];
    const app = buildKycApp({ webhooks: smallWebhooks, threshold: 0 });

    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});

// ---------------------------------------------------------------------------
// 9. Empty data sets — edge cases
// ---------------------------------------------------------------------------

describe('Empty data sets', () => {
  const app = buildKycApp({ webhooks: [], auditLogs: [] });

  test('empty webhooks list is not compressed (small)', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(res.body.toString('utf8'));
    expect(parsed.data).toEqual([]);
    expect(parsed.meta.hasMore).toBe(false);
  });

  test('empty audit logs list is not compressed (small)', async () => {
    const res = await rawGet(app, '/api/kyc/webhooks/audit', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(res.body.toString('utf8'));
    expect(parsed.data).toEqual([]);
    expect(parsed.meta.count).toBe(0);
  });
});
