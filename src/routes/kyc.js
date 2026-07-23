'use strict';

const express = require('express');
const { verifySignature } = require('../services/webhooks');
const kycService = require('../services/kycService');
const logger = require('../logger');

const router = express.Router();

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
 * @swagger
 * /api/kyc/webhook:
 *   post:
 *     operationId: ingestKycWebhook
 *     summary: Ingest a signed KYC status update from the external provider
 *     description: |
 *       Receives a signed webhook payload from the configured KYC provider.
 *       The request must carry a valid `X-Signature` HMAC header derived from
 *       the `KYC_PROVIDER_SECRET`. The provider status is mapped to an internal
 *       `KYC_STATUSES` value and persisted.
 *     tags: [KYC]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [smeId, status]
 *             properties:
 *               smeId:
 *                 type: string
 *                 description: SME identifier
 *               status:
 *                 type: string
 *                 description: Provider KYC status value
 *               recordId:
 *                 type: string
 *                 description: Provider record ID (optional)
 *               verifiedAt:
 *                 type: string
 *                 format: date-time
 *                 description: Verification timestamp from the provider (optional)
 *     parameters:
 *       - in: header
 *         name: X-Signature
 *         required: true
 *         schema:
 *           type: string
 *         description: HMAC-SHA256 signature of the raw request body using `KYC_PROVIDER_SECRET`
 *     responses:
 *       200:
 *         description: KYC status update ingested successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 smeId:
 *                   type: string
 *                 status:
 *                   type: string
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         description: Missing or invalid X-Signature header
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       503:
 *         description: KYC webhook ingestion is not configured
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.post('/webhook', async (req, res) => {
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
