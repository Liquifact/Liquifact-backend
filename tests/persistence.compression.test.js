'use strict';

/**
 * @fileoverview Tests for gzip/deflate compression on persistence
 * write endpoints (issue #986).
 *
 * Coverage:
 *  - Large response is gzip-compressed when client sends `Accept-Encoding: gzip`
 *  - Large response is deflate-compressed when client sends `Accept-Encoding: deflate`
 *  - Small response (<= threshold) is NOT compressed even with Accept-Encoding: gzip
 *  - `Vary: Accept-Encoding` is always present on persistence routes
 *  - Body round-trips correctly (supertest auto-decompresses gzip transparently)
 *  - `Content-Encoding` header is set on compressed responses
 *  - `Content-Encoding` is absent on uncompressed responses
 *  - Accept-Encoding: identity falls back to no compression
 *  - Unsupported encoding (br) falls back to no compression
 *  - Validation error responses (400) stay uncompressed
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-validation-purposes';

const express = require('express');
const request = require('supertest');
const { createCompressionMiddleware } = require('../src/middleware/compression');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app that mimics a persistence route with the
 * compression middleware mounted.
 */
function buildPersistenceApp({ threshold = 1024, responseBody = null } = {}) {
  const app = express();
  app.use(express.json());

  app.use(createCompressionMiddleware({ threshold }));

  app.post('/api/sme/invoice/presigned-url', (req, res) => {
    // Simulate a validation error response (always small)
    if (req.body && req.body.triggerError) {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Invalid persistence request body',
        status: 400,
        detail: 'Request body contains invalid fields.',
      });
    }

    // Return a response - small or large depending on test
    const body = responseBody || {
      message: 'Presigned upload URL generated',
      uploadUrl: 'https://s3.example.com/upload/test-key',
      fileKey: 'tenants/t/invoices/i/file.pdf',
      invoiceId: 'inv_001',
    };

    return res.json(body);
  });

  return app;
}

/** Returns a large persistence response body that exceeds `threshold` bytes when serialised. */
function largeResponseBody(threshold = 1024) {
  return {
    message: 'Presigned upload URL generated',
    uploadUrl: 'https://s3.example.com/upload/' + 'x'.repeat(threshold),
    fileKey: 'tenants/t/invoices/i/' + 'y'.repeat(threshold),
    invoiceId: 'inv_001',
    _padding: 'z'.repeat(threshold * 2),
  };
}

// ---------------------------------------------------------------------------
// 1. Vary header - always present
// ---------------------------------------------------------------------------

describe('Vary: Accept-Encoding on persistence routes', () => {
  const app = buildPersistenceApp();

  test('is set on a normal (small) response', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
  });

  test('is set on a 400 validation error response', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .send({ triggerError: true });

    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Large response - compressed paths
// ---------------------------------------------------------------------------

describe('Large persistence response - compressed', () => {
  const body = largeResponseBody(1024);
  const app = buildPersistenceApp({ responseBody: body });

  test('gzip: Content-Encoding is set and body round-trips', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    // supertest auto-decompresses gzip, so Content-Encoding is set but
    // res.body is already plain JSON
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.invoiceId).toBe('inv_001');
    expect(res.body.message).toBe('Presigned upload URL generated');
  });

  test('deflate: Content-Encoding is set and body round-trips', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'deflate')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('deflate');
    expect(res.body.invoiceId).toBe('inv_001');
  });

  test('gzip is preferred over deflate when both are offered', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip, deflate')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('Content-Type is application/json on compressed response', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['content-type']).toMatch(/application\/json/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Small response - NOT compressed
// ---------------------------------------------------------------------------

describe('Small persistence response - not compressed', () => {
  const smallBody = {
    message: 'Uploaded',
    invoiceId: 'inv_tiny',
  };
  // Threshold much larger than the payload so it never compresses
  const app = buildPersistenceApp({ responseBody: smallBody, threshold: 100_000 });

  test('no Content-Encoding header even with Accept-Encoding: gzip', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('response is valid JSON', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.body.invoiceId).toBe('inv_tiny');
    expect(res.body.message).toBe('Uploaded');
  });
});

// ---------------------------------------------------------------------------
// 4. Accept-Encoding: identity - no compression
// ---------------------------------------------------------------------------

describe('Accept-Encoding: identity - no compression', () => {
  const body = largeResponseBody(1024);
  const app = buildPersistenceApp({ responseBody: body });

  test('no compression when client explicitly requests identity', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'identity')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.invoiceId).toBe('inv_001');
  });
});

// ---------------------------------------------------------------------------
// 5. Accept-Encoding: br (unsupported) - falls back to no compression
// ---------------------------------------------------------------------------

describe('Unsupported encoding br - no compression', () => {
  const body = largeResponseBody(1024);
  const app = buildPersistenceApp({ responseBody: body });

  test('no Content-Encoding for unsupported br encoding', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'br')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.invoiceId).toBe('inv_001');
  });
});

// ---------------------------------------------------------------------------
// 6. Validation error (400) - plain JSON, no compression
// ---------------------------------------------------------------------------

describe('Validation error response (400) - no compression', () => {
  const app = buildPersistenceApp();

  test('returns 400 JSON error body without Content-Encoding', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ triggerError: true });

    expect(res.status).toBe(400);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.title).toMatch(/Invalid persistence request body/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Threshold boundary
// ---------------------------------------------------------------------------

describe('Threshold boundary', () => {
  test('payload at or below threshold is not compressed', async () => {
    const smallBody = { invoiceId: 'inv_boundary', x: 'tiny' };
    const app = buildPersistenceApp({ responseBody: smallBody, threshold: 100_000 });

    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('payload above threshold is compressed', async () => {
    const body = largeResponseBody(512);
    const app = buildPersistenceApp({ responseBody: body, threshold: 512 });

    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    // supertest auto-decompresses, so Content-Encoding is set but body is plain JSON
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.invoiceId).toBe('inv_001');
  });

  test('custom low threshold compresses even small payloads', async () => {
    const body = { invoiceId: 'inv_threshold', status: 'funded', _pad: 'y'.repeat(200) };
    const app = buildPersistenceApp({ responseBody: body, threshold: 0 });

    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('Accept-Encoding', 'gzip')
      .send({ fileName: 'test.pdf', mimeType: 'application/pdf', fileSize: 50000 });

    expect(res.headers['content-encoding']).toBe('gzip');
  });
});
