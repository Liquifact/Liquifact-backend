'use strict';

const express = require('express');
const { verifySignature } = require('../services/webhooks');
const kycService = require('../services/kycService');
const logger = require('../logger');
const { kycWebhookSchema, parseValidationErrors } = require('../schemas/kycWebhook');

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
  } catch (_e) {
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

  // ── Strict payload validation (issue #638) ──────────────────────────────
  // Validate the parsed webhook body against the bounded Zod schema.
  // Rejects unknown fields, wrong types, oversized strings, and
  // out-of-range values with a structured application/problem+json 400.
  const validationResult = kycWebhookSchema.safeParse(payload);
  if (!validationResult.success) {
    const fieldErrors = parseValidationErrors(validationResult.error);
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'KYC webhook payload contains invalid or missing fields.',
      instance: req.originalUrl,
      fieldErrors,
    });
  }

  const validated = validationResult.data;
  const smeId = validated.smeId;
  const status = validated.status;
  const providerRecordId = validated.recordId || null;
  const verifiedAt = validated.verifiedAt || null;

  // Zod schema already guarantees smeId and status are non-empty strings,
  // so the manual guards above are no longer needed (issue #638).

  // Reject unsigned payloads that include a status we don't recognise. The
  // signed webhook is the provider's authoritative signal — if it sends a
  // status string outside {@link kycService.PROVIDER_STATUS_MAP} we must not
  // silently normalise it to 'unknown'. Fail-closed (issue #592).
  const normalised = kycService.normalizeProviderStatus(status);
  if (normalised === kycService.KYC_STATUSES.UNKNOWN) {
    logger.warn(
      { smeId, status },
      'KYC webhook received status outside PROVIDER_STATUS_MAP; rejecting (fail-closed)',
    );
    return res.status(400).json({ error: `Unknown provider status: ${status}` });
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
