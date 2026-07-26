'use strict';

const express = require('express');
const { verifySignature } = require('../services/webhooks');
const kycService = require('../services/kycService');
const logger = require('../logger');

const router = express.Router();

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
 * Parse JSON from a raw request body.
 *
 * @param {string} rawBody
 * @returns {Object}
 */
function parseJsonPayload(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error('Invalid JSON payload');
  }
}

/**
 * POST /api/kyc/webhook
 *
 * Ingests signed KYC status updates from the external provider.
 * Verifies the webhook signature using the configured provider secret,
 * maps provider-specific statuses to internal KYC statuses, and persists
 * the result to the KYC record store.
 *
 * Disabled by default. Set KYC_WEBHOOK_ENABLED=true to activate.
 * Returns HTTP 503 when disabled so callers can distinguish "not configured"
 * from a transient error.
 */
router.post('/webhook', async (req, res) => {
  if (!isKycWebhookEnabled()) {
    logger.info({ route: '/api/kyc/webhook' }, 'KYC webhook ingestion is disabled (KYC_WEBHOOK_ENABLED != true)');
    return res.status(503).json({ error: 'KYC webhook ingestion is disabled' });
  }

  const config = kycService.getKycProviderConfig();
  const secret = config.apiSecret;
  const signatureHeader = req.header('X-Signature');
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');

  if (!secret) {
    logger.warn({ route: '/api/kyc/webhook' }, 'KYC webhook secret is not configured');
    return res.status(503).json({ error: 'KYC webhook ingestion is not configured' });
  }

  if (!signatureHeader) {
    return res.status(401).json({ error: 'Missing X-Signature header' });
  }

  const verification = verifySignature(secret, rawBody, signatureHeader);
  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'Invalid KYC webhook signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = parseJsonPayload(rawBody);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const smeId = payload.smeId || payload.sme_id;
  const status = payload.status || payload.kycStatus || payload.kyc_status;
  const providerRecordId = payload.recordId || payload.providerRecordId || payload.provider_record_id || null;
  const verifiedAt = payload.verifiedAt || payload.verified_at || null;

  if (!smeId || typeof smeId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid smeId' });
  }

  if (!status || typeof status !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid status' });
  }

  try {
    const record = await kycService.persistKycRecord({
      smeId,
      status,
      providerRecordId,
      verifiedAt,
    });

    logger.info(
      {
        smeId: record.smeId,
        status: record.status,
        providerRecordId: record.recordId,
      },
      'KYC webhook ingested successfully'
    );

    return res.status(200).json({ success: true, smeId: record.smeId, status: record.status });
  } catch (error) {
    logger.error({ smeId, error: error.message }, 'Failed to process KYC webhook');
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
module.exports.isKycWebhookEnabled = isKycWebhookEnabled;
