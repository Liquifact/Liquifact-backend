'use strict';

const express = require('express');
const kycWebhookService = require('../services/kycWebhookService');
const asyncHandler = require('../utils/asyncHandler');
const kycWebhookErrorHandler = require('../middleware/kycWebhookErrorHandler');
const { createCompressionMiddleware } = require('../middleware/compression');
const {
  kycWebhookRequestDurationSeconds,
  kycWebhookRequestsTotal,
  kycWebhookErrorsTotal,
  normalizeKycWebhookStatusClass,
  normalizeKycWebhookCause,
} = require('../metrics');
const {
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_METRICS,
} = require('../constants/kycWebhooks');

const router = express.Router();

// Compress kyc-webhooks responses above the default 1 KB threshold.
// Respects Accept-Encoding (gzip preferred over deflate); small responses
// (e.g. the POST ingestion ack) are always sent as plain JSON.
router.use(createCompressionMiddleware());

/**
 * Returns true when the KYC webhook endpoint is enabled.
 * Reads KYC_WEBHOOK_ENABLED at call-time so the flag can be toggled
 * without a process restart.
 *
 * Safe default: disabled — any value other than the exact string "true"
 * leaves the endpoint off.
 *
 * @returns {boolean}
 */
function isKycWebhookEnabled() {
  return process.env.KYC_WEBHOOK_ENABLED === 'true';
}

/**
 * POST /api/kyc/webhook
 * Inbound KYC webhook ingestion endpoint.
 */
router.post(KYC_WEBHOOK_ROUTES.WEBHOOK, asyncHandler(async (req, res) => {
  const startTime = process.hrtime.bigint();
  let statusClass = KYC_WEBHOOK_METRICS.STATUS_CLASS_2XX;
  let cause = KYC_WEBHOOK_METRICS.CAUSE_NONE;

  const finish = (httpStatus, errorCode) => {
    const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
    statusClass = normalizeKycWebhookStatusClass(httpStatus);
    cause = normalizeKycWebhookCause({ status: httpStatus, errorCode });
    kycWebhookRequestDurationSeconds.observe({ status_class: statusClass }, elapsed);
    kycWebhookRequestsTotal.inc({ status_class: statusClass });
    if (cause !== KYC_WEBHOOK_METRICS.CAUSE_NONE) {
      kycWebhookErrorsTotal.inc({ cause });
    }
  };

  res.on('finish', () => {
    finish(res.statusCode, req._kycErrorCode || null);
  });

  const signatureHeader = req.header(HTTP_HEADERS.X_SIGNATURE) || '';
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  const actor = req.user?.sub || req.user?.userId || req.user?.id || (req.apiClient && req.apiClient.clientId ? `api-key:${req.apiClient.clientId}` : 'kyc-provider');

  const result = await kycWebhookService.processWebhookIngestion({
    rawBody,
    signatureHeader,
    requestTenantId: req.tenantId,
    actor,
    ipAddress: req.ip || 'unknown',
    userAgent: req.get('user-agent') || 'unknown',
  });

  return res.status(200).json(result);
}));

/**
 * GET /api/kyc/webhooks/audit
 *
 * Bounded read view of audit trail logs for KYC webhooks.
 * Secrets are automatically redacted via redactValue.
 */
router.get('/webhooks/audit', asyncHandler(async (req, res) => {
  const rawLimit = req.query.limit;
  const rawOffset = req.query.offset;
  const smeId = req.query.smeId || req.query.resourceId || null;
  const action = req.query.action || null;

  const result = await kycWebhookService.getWebhookAuditLogs({
    rawLimit,
    rawOffset,
    smeId,
    action,
  });

  return res.status(200).json(result);
}));

/**
 * GET /api/kyc/webhooks
 *
 * Cursor-paginated listing of KYC records (the kyc-webhooks listing endpoint).
 */
router.get(KYC_WEBHOOK_ROUTES.WEBHOOKS, asyncHandler(async (req, res) => {
  const { cursor, status, limit: rawLimit } = req.query;

  const result = await kycWebhookService.listWebhooks({
    cursor,
    status,
    rawLimit,
  });

  return res.status(200).json(result);
}));

router.use(kycWebhookErrorHandler);

module.exports = router;
module.exports.isKycWebhookEnabled = isKycWebhookEnabled;
