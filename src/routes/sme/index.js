/**
 * SME Routes Index
 *
 * Persistence write endpoints:
 *  - POST /api/sme/invoice/presigned-url
 *  - POST /api/sme/invoice
 *
 * Both routes reject unknown fields, wrong types, and out-of-range values with
 * a structured RFC 7807 400 before any storage call runs.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const metricsRoutes = require('./metrics');
const multer = require('multer');
const storageService = require('../../services/storage');
const { extractTenant } = require('../../middleware/tenant');
const idempotencyMiddleware = require('../../middleware/idempotency');
const { optionalMultipartIdempotency } = require('../../middleware/multipartIdempotency');
const { instrumentPersistence } = require('../../middleware/persistenceMetrics');
const { persistenceErrorHandler } = require('../../middleware/persistenceErrorHandler');
const { MAX_FILE_SIZE_BYTES, validatePersistenceBody, presignedUploadBodySchema } = require('../../schemas/persistence');
const { createPersistenceRateLimiter } = require('../../middleware/persistenceRateLimit');
const { createCompressionMiddleware } = require('../../middleware/compression');
const { persistenceErrorHandler } = require('../../middleware/persistenceErrorHandler');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
});

// Initialize persistence rate limiter
const persistenceRateLimiter = createPersistenceRateLimiter();

// Compress large persistence responses above 1 KB threshold.
// Small responses pass through uncompressed to avoid overhead.
router.use(createCompressionMiddleware());

router.use('/', metricsRoutes);

// POST /api/sme/invoice/presigned-url - Request a presigned upload URL
router.post(
  '/invoice/presigned-url',
  express.json(),
  extractTenant,
  idempotencyMiddleware,
  validatePersistenceBody(presignedUploadBodySchema),
  async (req, res, next) => {
    try {
      const { fileName, mimeType, fileSize, invoiceId: bodyInvoiceId } = req.validated;
      const tenantId = req.tenantId;
      const invoiceId = bodyInvoiceId || crypto.randomUUID();

      const result = await storageService.getPresignedUploadUrl({
        tenantId,
        invoiceId,
        fileName,
        mimeType,
        fileSize,
      });

      res.json({
        message: 'Presigned upload URL generated',
        uploadUrl: result.url,
        fileKey: result.key,
        invoiceId,
      });
    } catch (error) {
      return next(error);
    }
  }
);

// POST /api/sme/invoice - Upload PDF invoice
router.post(
  '/invoice',
  persistenceRateLimiter,
  upload.single('invoice'),
  extractTenant,
  optionalMultipartIdempotency,
  instrumentPersistence('sme_invoice_upload', async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Invoice file is required' });
      }

      const tenantId = req.tenantId;
      const invoiceId = (req.validated && req.validated.invoiceId) || crypto.randomUUID();

      const key = await storageService.uploadFile(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        tenantId,
        invoiceId
      );

      const signedUrl = await storageService.getSignedUrl(key);

      res.json({
        message: 'Invoice uploaded successfully',
        fileKey: key,
        signedUrl,
        invoiceId,
      });
    } catch (error) {
      return next(error);
    }
  })
);

// Mount the shared persistence error middleware after all route handlers.
// Inline try/catch blocks have been replaced with next(error) calls so that
// all persistence errors flow through this centralised handler.
router.use(persistenceErrorHandler);

module.exports = router;