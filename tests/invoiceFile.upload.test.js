/**
 * @fileoverview Tests for configurable upload size limit and server-side
 * MIME re-validation on the invoice file upload route.
 *
 * Covers:
 *   - validatePdfMagicBytes unit tests
 *   - validateMimeType unit tests
 *   - Config-driven size limit (env override)
 *   - Magic-byte MIME rejection (mislabeled file)
 *   - Valid PDF upload
 *   - Oversized / at-limit files
 *   - Edge cases
 *
 * @see src/routes/invoiceFile.js
 */

'use strict';

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const {
  hasCleanAntivirusResult,
  tenantScopedKeyMatches,
  validatePdfMagicBytes,
  validateMimeType,
  UPLOAD_SIZE_LIMIT: DEFAULT_LIMIT,
} = require('../src/routes/invoiceFile');

const invoiceFileRouter = require('../src/routes/invoiceFile');

// ═══════════════════════════════════════════════════════════════════════════
// Unit: validatePdfMagicBytes
// ═══════════════════════════════════════════════════════════════════════════

describe('validatePdfMagicBytes()', () => {
  it('returns true for buffer starting with %PDF', () => {
    expect(validatePdfMagicBytes(Buffer.from('%PDF-1.4'))).toBe(true);
  });

  it('returns true for minimal valid PDF prefix', () => {
    expect(validatePdfMagicBytes(Buffer.from('%PDF'))).toBe(true);
  });

  it('returns false for non-PDF content', () => {
    expect(validatePdfMagicBytes(Buffer.from('not a pdf'))).toBe(false);
  });

  it('returns false for empty buffer', () => {
    expect(validatePdfMagicBytes(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for buffer shorter than 4 bytes', () => {
    expect(validatePdfMagicBytes(Buffer.from('ABC'))).toBe(false);
  });

  it('returns false for null input', () => {
    expect(validatePdfMagicBytes(null)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(validatePdfMagicBytes(undefined)).toBe(false);
  });

  it('returns false for non-Buffer input (string)', () => {
    expect(validatePdfMagicBytes('%PDF-1.4')).toBe(false);
  });

  it('detects binary non-PDF content', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG magic
    expect(validatePdfMagicBytes(binary)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit: validateMimeType
// ═══════════════════════════════════════════════════════════════════════════

describe('validateMimeType()', () => {
  it('returns valid for PDF content type with PDF magic bytes', () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 content');
    const result = validateMimeType('application/pdf', pdfBuffer);
    expect(result.valid).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it('rejects when content type is not application/pdf', () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 content');
    const result = validateMimeType('text/html', pdfBuffer);
    expect(result.valid).toBe(false);
    expect(result.message).toBe('Content-Type must be application/pdf');
  });

  it('rejects when content type is missing', () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 content');
    const result = validateMimeType(null, pdfBuffer);
    expect(result.valid).toBe(false);
    expect(result.message).toBe('Content-Type must be application/pdf');
  });

  it('rejects when file content lacks PDF magic bytes', () => {
    const nonPdfBuffer = Buffer.from('not a pdf file');
    const result = validateMimeType('application/pdf', nonPdfBuffer);
    expect(result.valid).toBe(false);
    expect(result.message).toContain('does not match declared MIME type');
  });

  it('rejects empty buffer with PDF content type', () => {
    const result = validateMimeType('application/pdf', Buffer.alloc(0));
    expect(result.valid).toBe(false);
    expect(result.message).toContain('does not match declared MIME type');
  });
});

describe('download safety gates', () => {
  it('accepts only keys bound to the authenticated tenant and invoice', () => {
    expect(
      tenantScopedKeyMatches(
        { s3_key: 'tenants/tenant-a/invoices/inv-1/file.pdf' },
        'tenant-a',
        'inv-1'
      )
    ).toBe(true);
    expect(
      tenantScopedKeyMatches(
        { s3_key: 'tenants/tenant-b/invoices/inv-1/file.pdf' },
        'tenant-a',
        'inv-1'
      )
    ).toBe(false);
  });

  it('requires a clean antivirus result before download exposure', () => {
    expect(hasCleanAntivirusResult({ av_status: 'clean' })).toBe(true);
    expect(hasCleanAntivirusResult({ antivirusStatus: 'verified' })).toBe(true);
    expect(hasCleanAntivirusResult({ virus_scan_status: 'pending' })).toBe(false);
    expect(hasCleanAntivirusResult({})).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: POST /api/invoices/:id/file
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/invoices/:id/file — upload route', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/invoices', invoiceFileRouter);
  });

  // ── Valid uploads ──────────────────────────────────────────────────────

  it('uploads a valid PDF (with %PDF magic bytes)', async () => {
    const pdfContent = Buffer.from('%PDF-1.4 valid document content');

    const res = await request(app)
      .post('/api/invoices/inv_upload_001/file')
      .set('Content-Type', 'application/pdf')
      .send(pdfContent);

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toHaveProperty('fileHash');
    expect(res.body.data.fileHash).toHaveLength(64);
    expect(res.body.data.fileSize).toBe(pdfContent.length);
    expect(res.body.data.invoiceId).toBe('inv_upload_001');
    expect(res.body.message).toBe('Invoice file uploaded successfully');
  });

  it('computes correct SHA-256 hash for uploaded PDF', async () => {
    const pdfContent = Buffer.from('%PDF-1.4 hash check');
    const expectedHash = crypto.createHash('sha256').update(pdfContent).digest('hex');

    const res = await request(app)
      .post('/api/invoices/inv_upload_hash/file')
      .set('Content-Type', 'application/pdf')
      .send(pdfContent);

    expect(res.statusCode).toBe(201);
    expect(res.body.data.fileHash).toBe(expectedHash);
  });

  // ── MIME re-validation ─────────────────────────────────────────────────

  it('rejects upload with wrong Content-Type header', async () => {
    const pdfContent = Buffer.from('%PDF-1.4 content');

    const res = await request(app)
      .post('/api/invoices/inv_bad_mime/file')
      .set('Content-Type', 'text/html')
      .send(pdfContent);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toBe('Content-Type must be application/pdf');
  });

  it('rejects mislabeled file — declares PDF but contains non-PDF bytes', async () => {
    const nonPdfContent = Buffer.from('not a pdf document');

    const res = await request(app)
      .post('/api/invoices/inv_mislabeled/file')
      .set('Content-Type', 'application/pdf')
      .send(nonPdfContent);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toContain('does not match declared MIME type');
  });

  it('rejects mislabeled binary file masquerading as PDF', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    const res = await request(app)
      .post('/api/invoices/inv_png_as_pdf/file')
      .set('Content-Type', 'application/pdf')
      .send(pngHeader);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toContain('does not match declared MIME type');
  });

  // ── Empty / missing data ──────────────────────────────────────────────

  it('rejects empty file data', async () => {
    const res = await request(app)
      .post('/api/invoices/inv_empty/file')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.alloc(0));

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toBe('No file data provided');
  });

  // ── Invalid invoice ID ─────────────────────────────────────────────────

  it('rejects invalid invoice ID', async () => {
    const pdfContent = Buffer.from('%PDF-1.4 content');

    const res = await request(app)
      .post('/api/invoices/ /file')
      .set('Content-Type', 'application/pdf')
      .send(pdfContent);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toBe('Invalid invoice ID');
  });

  // ── At-limit file ──────────────────────────────────────────────────────

  it('accepts a file right at the default size limit', async () => {
    const limitBytes = 5 * 1024 * 1024; // 5 MB default
    const pdfContent = Buffer.alloc(limitBytes);
    pdfContent.write('%PDF-1.4');

    const res = await request(app)
      .post('/api/invoices/inv_at_limit/file')
      .set('Content-Type', 'application/pdf')
      .send(pdfContent);

    expect(res.statusCode).toBe(201);
    expect(res.body.data.fileSize).toBe(limitBytes);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Config-driven size limit (env override)
// ═══════════════════════════════════════════════════════════════════════════

describe('config-driven upload size limit', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('UPLOAD_SIZE_LIMIT defaults to 5mb', () => {
    delete process.env.INVOICE_FILE_MAX_SIZE;
    const fresh = require('../src/routes/invoiceFile');
    expect(fresh.UPLOAD_SIZE_LIMIT).toBe('5mb');
  });

  it('UPLOAD_SIZE_LIMIT reads from INVOICE_FILE_MAX_SIZE env var', () => {
    process.env.INVOICE_FILE_MAX_SIZE = '1mb';
    const fresh = require('../src/routes/invoiceFile');
    expect(fresh.UPLOAD_SIZE_LIMIT).toBe('1mb');
  });

  it('UPLOAD_SIZE_LIMIT accepts custom size string from env', () => {
    process.env.INVOICE_FILE_MAX_SIZE = '2kb';
    const fresh = require('../src/routes/invoiceFile');
    expect(fresh.UPLOAD_SIZE_LIMIT).toBe('2kb');
  });

  it('rejects an invalid INVOICE_FILE_MAX_SIZE value when the route loads', () => {
    process.env.INVOICE_FILE_MAX_SIZE = 'no-limit';
    expect(() => require('../src/routes/invoiceFile')).toThrow(/INVOICE_FILE_MAX_SIZE/i);
  });

  it('rejects upload when file exceeds env-configured limit', async () => {
    process.env.INVOICE_FILE_MAX_SIZE = '1kb';
    jest.resetModules();

    const customRouter = require('../src/routes/invoiceFile');
    const app = express();
    app.use('/api/invoices', customRouter);

    const pdfContent = Buffer.alloc(2048);
    pdfContent.write('%PDF-1.4');

    const res = await request(app)
      .post('/api/invoices/inv_oversized/file')
      .set('Content-Type', 'application/pdf')
      .send(pdfContent);

    expect(res.statusCode).toBe(413);
  });

  it('accepts upload when file is within env-configured limit', async () => {
    process.env.INVOICE_FILE_MAX_SIZE = '10kb';
    jest.resetModules();

    const customRouter = require('../src/routes/invoiceFile');
    const app = express();
    app.use('/api/invoices', customRouter);

    const pdfContent = Buffer.alloc(5 * 1024);
    pdfContent.write('%PDF-1.4');

    const res = await request(app)
      .post('/api/invoices/inv_within_limit/file')
      .set('Content-Type', 'application/pdf')
      .send(pdfContent);

    expect(res.statusCode).toBe(201);
  });

  it('rejects upload at exactly the env-configured limit boundary (strictly over rejects)', async () => {
    process.env.INVOICE_FILE_MAX_SIZE = '1kb';
    jest.resetModules();

    const customRouter = require('../src/routes/invoiceFile');
    const app = express();
    app.use('/api/invoices', customRouter);

    // Send 1 byte over the limit
    const pdfContent = Buffer.alloc(1025);
    pdfContent.write('%PDF-1.4');

    const res = await request(app)
      .post('/api/invoices/inv_boundary/file')
      .set('Content-Type', 'application/pdf')
      .send(pdfContent);

    expect(res.statusCode).toBe(413);
  });
});
