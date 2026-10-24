'use strict';

/**
 * @fileoverview Invoice PDF document upload and retrieval routes.
 *
 * POST   /api/invoices/:id/document       — upload a PDF
 * GET    /api/invoices/:id/document       — download the PDF
 * GET    /api/invoices/:id/document/meta  — metadata + attestation hash
 *
 * @module routes/invoiceDocument
 */

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const store = require('../data/store');
const { defaultDocumentStore } = require('../data/documentStore');

const router = express.Router({ mergeParams: true });

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_DOCUMENT_BYTES = parseInt(process.env.MAX_DOCUMENT_BYTES || '', 10) || 5 * 1024 * 1024; // 5 MiB

/** PDF magic-byte header: %PDF- */
const PDF_MAGIC = Buffer.from('%PDF-');

/** Byte scan strings that indicate active JavaScript / Launch actions */
const UNSAFE_PATTERNS = ['/JavaScript', '/JS', '/Launch'];

// ── Multer setup (memory storage, single file) ───────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
  fileFilter(_req, _file, cb) {
    // Accept any file — we validate by magic bytes, not MIME
    cb(null, true);
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitise an original filename: strip path traversal, keep only safe chars,
 * cap at 120 characters. Returns a fallback if the result is empty.
 *
 * @param {string} name - Raw filename from the client.
 * @returns {string} Safe filename.
 */
function sanitiseName(name) {
  if (typeof name !== 'string') { return 'document.pdf'; }
  const base = name
    .replace(/[\\/]/g, '')          // strip directory separators
    .replace(/[^\w.\-\s]/g, '_')    // replace unsafe chars
    .trim()
    .slice(0, 120);
  return base || 'document.pdf';
}

/**
 * Validate a PDF buffer by magic bytes and trailer.
 *
 * @param {Buffer} buf - File bytes.
 * @returns {{ ok: boolean, reason?: string }}
 */
function validatePdf(buf) {
  // Magic-byte check: must start with %PDF-
  if (buf.length < 5 || !buf.slice(0, 5).equals(PDF_MAGIC)) {
    return { ok: false, reason: 'File does not start with %PDF- magic bytes' };
  }

  // Trailer check: %%EOF must appear within the last 1 KiB
  const tail = buf.slice(Math.max(0, buf.length - 1024));
  if (!tail.includes('%%EOF')) {
    return { ok: false, reason: 'File does not contain %%EOF trailer in the last 1 KiB' };
  }

  // Safety check: reject PDFs containing JavaScript or Launch actions
  const content = buf.toString('latin1'); // raw byte scan
  for (const pattern of UNSAFE_PATTERNS) {
    if (content.includes(pattern)) {
      return { ok: false, reason: `Unsafe PDF: contains '${pattern}' action` };
    }
  }

  return { ok: true };
}

// ── Multer error handler helper ───────────────────────────────────────────────

/**
 * Wrap multer single-file upload and handle its errors.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) { return next(); }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'PAYLOAD_TOO_LARGE',
        detail: `File exceeds the ${MAX_DOCUMENT_BYTES} byte limit.`,
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        detail: 'Only one file field named "file" is accepted.',
      });
    }
    return next(err);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/invoices/:id/document
 * Upload a PDF document for an invoice.
 */
router.post('/', uploadSingle, (req, res) => {
  const { id } = req.params;

  // Invoice must exist
  const invoice = store.get(id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // Invoice must be open
  if (invoice.status !== 'open') {
    return res.status(409).json({
      error: 'CONFLICT',
      detail: `Invoice is '${invoice.status}'; documents can only be uploaded to open invoices.`,
    });
  }

  // Document must not already exist
  if (defaultDocumentStore.has(id)) {
    return res.status(409).json({
      error: 'DOCUMENT_EXISTS',
      detail: 'A document has already been uploaded for this invoice. Replacement is not supported.',
    });
  }

  // File must be present
  if (!req.file) {
    return res.status(400).json({
      error: 'BAD_REQUEST',
      detail: 'No file received. Send a multipart/form-data request with a "file" field.',
    });
  }

  const buf = req.file.buffer;

  // Validate PDF
  const validation = validatePdf(buf);
  if (!validation.ok) {
    const isUnsafe = validation.reason && validation.reason.startsWith('Unsafe');
    return res.status(isUnsafe ? 422 : 415).json({
      error: isUnsafe ? 'UNSAFE_PDF' : 'UNSUPPORTED_MEDIA_TYPE',
      detail: validation.reason,
    });
  }

  // Compute SHA-256
  const sha256Hex = crypto.createHash('sha256').update(buf).digest('hex');

  const meta = {
    sha256Hex,
    sizeBytes: buf.length,
    uploadedAt: new Date().toISOString(),
    originalName: sanitiseName(req.file.originalname),
  };

  // Persist to document store
  defaultDocumentStore.save(id, meta, buf);

  // Attach metadata to the invoice record
  invoice.document = meta;

  return res.status(201).json({ data: meta });
});

/**
 * GET /api/invoices/:id/document
 * Stream the PDF file.
 */
router.get('/', (req, res) => {
  const { id } = req.params;

  const invoice = store.get(id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  const meta = defaultDocumentStore.getMeta(id);
  const buf = defaultDocumentStore.getBuffer(id);

  if (!buf || !meta) {
    return res.status(404).json({ error: 'No document found for this invoice' });
  }

  const safeName = sanitiseName(meta.originalName);

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${safeName}"`);
  res.set('Content-Length', String(buf.length));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('ETag', `"${meta.sha256Hex}"`);

  return res.send(buf);
});

/**
 * GET /api/invoices/:id/document/meta
 * Return document metadata and attestation hash for on-chain binding.
 */
router.get('/meta', (req, res) => {
  const { id } = req.params;

  const invoice = store.get(id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  const meta = defaultDocumentStore.getMeta(id);
  if (!meta) {
    return res.status(404).json({ error: 'No document found for this invoice' });
  }

  return res.json({
    data: {
      ...meta,
      // attestationHash is the same 32-byte SHA-256 digest in hex,
      // ready to pass to bind_primary_attestation_hash(digest: BytesN<32>)
      attestationHash: meta.sha256Hex,
    },
  });
});

module.exports = router;
module.exports.sanitiseName = sanitiseName;
module.exports.validatePdf = validatePdf;
