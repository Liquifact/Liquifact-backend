'use strict';

/**
 * @fileoverview Invoice PDF document upload and retrieval routes.
 *
 * POST   /api/invoices/:id/document       — upload a PDF
 * GET    /api/invoices/:id/document       — download the PDF
 * GET    /api/invoices/:id/document/meta  — metadata + attestation hash
 *
 * Error responses use RFC 7807 `application/problem+json` via `sendProblem`.
 *
 * @module routes/invoiceDocument
 */

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const store = require('../data/store');
const { defaultDocumentStore } = require('../data/documentStore');

const { requireRole, assertOwnerOrAdmin } = require('../middleware/auth');
const { auditContext } = require('../audit/middleware');
const { sendProblem } = require('../errors');
const router = express.Router({ mergeParams: true });
router.use(auditContext());

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_DOCUMENT_BYTES = parseInt(process.env.MAX_DOCUMENT_BYTES || '', 10) || 5 * 1024 * 1024; // 5 MiB

/** PDF magic-byte header: %PDF- */
const PDF_MAGIC = Buffer.from('%PDF-');

/** Byte scan strings that indicate active JavaScript / Launch actions */
const UNSAFE_PATTERNS = ['/JavaScript', '/JS', '/Launch'];

// ── Multer setup (memory storage, single file) ─────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
  fileFilter(_req, _file, cb) {
    cb(null, true);
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────

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
    .replace(/[\\/]/g, '')
    .replace(/[^\w.\-\s]/g, '_')
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
  if (buf.length < 5 || !buf.slice(0, 5).equals(PDF_MAGIC)) {
    return { ok: false, reason: 'File does not start with %PDF- magic bytes' };
  }
  const tail = buf.slice(Math.max(0, buf.length - 1024));
  if (!tail.includes('%%EOF')) {
    return { ok: false, reason: 'File does not contain %%EOF trailer in the last 1 KiB' };
  }
  const content = buf.toString('latin1');
  for (const pattern of UNSAFE_PATTERNS) {
    if (content.includes(pattern)) {
      return { ok: false, reason: `Unsafe PDF: contains '${pattern}' action` };
    }
  }
  return { ok: true };
}

// ── Multer error handler helper ────────────────────────────────────────────

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) { return next(); }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendProblem(req, res, 'FILE_TOO_LARGE', {
        detail: `File exceeds the ${MAX_DOCUMENT_BYTES} byte limit.`,
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return sendProblem(req, res, 'UPLOAD_ERROR', {
        detail: 'Only one file field named "file" is accepted.',
      });
    }
    return next(err);
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/invoices/:id/document
 * Upload a PDF document for an invoice.
 * Allows re-uploads (replaces existing document for the same invoice).
 * Returns 410 DOCUMENT_EVICTED when an LRU eviction occurs.
 */
router.post('/', requireRole('sme', 'admin'), (req, res, next) => {
  const { id } = req.params;
  const invoice = store.get(id);
  if (!invoice) {
    return sendProblem(req, res, 'INVOICE_NOT_FOUND');
  }
  const ownership = assertOwnerOrAdmin(req, res, invoice, { action: 'invoice.document.upload' });
  if (ownership !== true) {
    return ownership;
  }
  return next();
}, uploadSingle, (req, res) => {
  const { id } = req.params;
  const invoice = store.get(id);

  if (invoice.status !== 'open') {
    return sendProblem(req, res, 'DOCUMENT_EXISTS', {
      detail: `Invoice is '${invoice.status}'; documents can only be uploaded to open invoices.`,
    });
  }

  if (!req.file) {
    return sendProblem(req, res, 'NO_FILE');
  }

  const buf = req.file.buffer;

  const validation = validatePdf(buf);
  if (!validation.ok) {
    const isUnsafe = validation.reason && validation.reason.startsWith('Unsafe');
    return sendProblem(req, res, isUnsafe ? 'UNSAFE_PDF' : 'UNSUPPORTED_MEDIA_TYPE', {
      detail: validation.reason,
    });
  }

  const sha256Hex = crypto.createHash('sha256').update(buf).digest('hex');

  const evicted = defaultDocumentStore.save(id, {
    sha256Hex,
    sizeBytes: buf.length,
    uploadedAt: new Date().toISOString(),
    originalName: sanitiseName(req.file.originalname),
  }, buf);

  const meta = defaultDocumentStore.getMeta(id);
  invoice.document = meta;

  if (evicted) {
    return sendProblem(req, res, 'DOCUMENT_EVICTED');
  }

  return res.status(201).json({ data: meta });
});

/**
 * Parse an If-None-Match header value and report whether it matches the given ETag.
 */
function etagMatches(header, etag) {
  if (typeof header !== 'string' || header.trim() === '') { return false; }
  if (header.trim() === '*') { return true; }
  const stripWeak = (tag) => tag.trim().replace(/^W\//, '');
  const target = stripWeak(etag);
  return header.split(',').some((candidate) => stripWeak(candidate) === target);
}

/**
 * GET /api/invoices/:id/document
 * Stream the PDF file.
 */
router.get('/', (req, res) => {
  const { id } = req.params;

  const invoice = store.get(id);
  if (!invoice) {
    return sendProblem(req, res, 'INVOICE_NOT_FOUND');
  }

  const meta = defaultDocumentStore.getMeta(id);
  const buf = defaultDocumentStore.getBuffer(id);

  if (!buf || !meta) {
    return sendProblem(req, res, 'DOCUMENT_NOT_FOUND');
  }

  const safeName = sanitiseName(meta.originalName);
  const etag = `"${meta.sha256Hex}"`;

  res.set('ETag', etag);
  res.set('X-Content-Type-Options', 'nosniff');

  if (etagMatches(req.get('If-None-Match'), etag)) {
    return res.status(304).end();
  }

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${safeName}"`);
  res.set('Content-Length', String(buf.length));

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
    return sendProblem(req, res, 'INVOICE_NOT_FOUND');
  }

  const meta = defaultDocumentStore.getMeta(id);
  if (!meta) {
    return sendProblem(req, res, 'DOCUMENT_NOT_FOUND');
  }

  return res.json({
    data: {
      ...meta,
      attestationHash: meta.sha256Hex,
    },
  });
});

module.exports = router;
module.exports.sanitiseName = sanitiseName;
module.exports.validatePdf = validatePdf;