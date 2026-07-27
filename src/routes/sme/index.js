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
const logger = require('../../logger');
const { instrumentPersistence } = require('../../middleware/persistenceMetrics');
const { MAX_FILE_SIZE_BYTES, validatePersistenceBody, presignedUploadBodySchema } = require('../../schemas/persistence');
const { createPersistenceRateLimiter } = require('../../middleware/persistenceRateLimit');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
});

// Initialize persistence rate limiter
const persistenceRateLimiter = createPersistenceRateLimiter();

router.use('/', metricsRoutes);

// POST /api/sme/invoice/presigned-url - Request a presigned upload URL
router.post(
  '/invoice/presigned-url',
  express.json(),
  extractTenant,
  idempotencyMiddleware,
  validatePersistenceBody(presignedUploadBodySchema),
  async (req, res) => {
    const requestLogger = logger.createRequestLogger(req);
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
      if (error.code === 'INVALID_MIME_TYPE' || error.code === 'FILE_TOO_LARGE' || error.code === 'INVALID_TENANT_ID') {
        return res.status(400).json({ error: error.message });
      }
      requestLogger.error({ err: error }, 'Presigned URL error');
      res.status(500).json({ error: 'Failed to generate presigned upload URL' });
    }
  }
);

// POST /api/sme/invoice - Upload PDF invoice
router.post(
  '/invoice',
  persistenceRateLimiter,
  upload.single('invoice'),
  extractTenant,
  instrumentPersistence('sme_invoice_upload', async (req, res) => {
    const requestLogger = logger.createRequestLogger(req);
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
      if (error.code === 'INVALID_MIME_TYPE' || error.code === 'FILE_TOO_LARGE' || error.code === 'INVALID_TENANT_ID') {
        return res.status(400).json({ error: error.message });
      }
      requestLogger.error({ err: error }, 'Upload error');
      res.status(500).json({ error: 'Failed to upload invoice' });
    }
  })
);

module.exports = router;