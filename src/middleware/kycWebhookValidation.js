/**
 * KYC Webhook Validation Helper
 *
 * Extracts the repeated validation preamble from kyc-webhooks handlers into
 * a single, tested helper so every handler enforces the same contract without
 * duplicating checks inline.
 *
 * Exported:
 *   - validateKycWebhookRequest(rawBody, signatureHeader, secret, requestTenantId)
 *   - parseJsonPayload(rawBody)
 *
 * @module middleware/kycWebhookValidation
 */

'use strict';

const { verifySignature } = require('../services/webhooks');
const {
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
} = require('../constants/kycWebhooks');

/**
 * Parse JSON from a raw request body string.
 *
 * @param {string} rawBody - Raw HTTP body string (UTF-8).
 * @returns {object} Parsed JSON payload.
 * @throws {Error} When the body is not valid JSON.
 */
function parseJsonPayload(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (_e) {
    throw new Error(KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD);
  }
}

/**
 * Result object returned by {@link validateKycWebhookRequest}.
 *
 * @typedef {Object} KycWebhookValidationResult
 * @property {boolean}  valid      - `true` when all checks pass.
 * @property {object}   [payload]  - Parsed and validated payload (only when valid=true).
 * @property {object}   [error]    - Error response: { status: number, body: object, errorCode: string }.
 */

/**
 * Validates an incoming KYC webhook request end-to-end before the handler
 * processes it.
 *
 * Checks performed (in order):
 *   1. Secret is configured        → 503 (missing_secret)
 *   2. X-Signature header present  → 401 (missing_signature)
 *   3. Signature is valid          → 401 (invalid_signature)
 *   4. Body is valid JSON          → 400 (invalid_payload)
 *   5. Tenant scope matches        → 403 (tenant_mismatch)
 *                                 or → 400 (missing_tenant_context)
 *   6. smeId is present + string   → 400 (missing_sme_id)
 *   7. status is present + string  → 400 (missing_status)
 *   8. Provider status is known    → 400 (unknown_status)
 *
 * @param {string}  rawBody          - Raw request body as a UTF-8 string.
 * @param {string}  signatureHeader  - Value of the `X-Signature` header (empty string when absent).
 * @param {string|null} secret       - Configured KYC provider secret.
 * @param {string|null} requestTenantId - Tenant ID resolved from the request context.
 * @param {object}  kycService       - Reference to the kycService module (for status normalisation).
 * @returns {KycWebhookValidationResult}
 */
function validateKycWebhookRequest(rawBody, signatureHeader, secret, requestTenantId, kycService) {
  // 1. Secret / Key configuration check
  const activeKey = typeof secret === 'object' && secret !== null ? secret.current || secret.active || secret.key : secret;
  const retiringKey = typeof secret === 'object' && secret !== null ? secret.retiring || secret.previous || secret.old : null;
  const keyMap = typeof secret === 'object' && secret !== null ? secret.keys || {} : {};

  if (!activeKey && !retiringKey && Object.keys(keyMap).length === 0) {
    return {
      valid: false,
      error: {
        status: 503,
        body: { error: KYC_WEBHOOK_MESSAGES.MISSING_SECRET },
        errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET,
      },
    };
  }

  // 2. X-Signature header must be present
  if (!signatureHeader) {
    return {
      valid: false,
      error: {
        status: 401,
        body: { error: KYC_WEBHOOK_MESSAGES.MISSING_SIGNATURE },
        errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE,
      },
    };
  }

  // 3. Dual-key / key-identifier signature verification
  // Extract optional keyId from header or signature payload (e.g. kid=..., keyId=..., or keyMap)
  let candidateKeys = [];
  let keyId = null;

  if (typeof signatureHeader === 'string') {
    const kidMatch = signatureHeader.match(/(?:^|[,; ])(?:kid|keyid|key_id)=([a-zA-Z0-9_-]+)/i);
    if (kidMatch) {
      keyId = kidMatch[1];
    }
  }

  if (keyId) {
    if (keyMap[keyId]) {
      candidateKeys = [keyMap[keyId]];
    } else if (secret?.currentKeyId === keyId && activeKey) {
      candidateKeys = [activeKey];
    } else if (secret?.retiringKeyId === keyId && retiringKey) {
      candidateKeys = [retiringKey];
    } else {
      return {
        valid: false,
        error: {
          status: 401,
          body: { error: KYC_WEBHOOK_MESSAGES.INVALID_SIGNATURE },
          errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE,
          verificationError: 'Unknown key identifier',
        },
      };
    }
  } else {
    if (activeKey) {candidateKeys.push(activeKey);}
    if (retiringKey) {candidateKeys.push(retiringKey);}
    if (candidateKeys.length === 0) {candidateKeys = Object.values(keyMap);}
  }

  let verification = { valid: false, error: 'Signature mismatch' };
  for (const candidateSecret of candidateKeys) {
    if (!candidateSecret) {continue;}
    verification = verifySignature(candidateSecret, rawBody, signatureHeader);
    if (verification.valid) {
      break;
    }
  }

  if (!verification.valid) {
    return {
      valid: false,
      error: {
        status: 401,
        body: { error: KYC_WEBHOOK_MESSAGES.INVALID_SIGNATURE },
        errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE,
        verificationError: verification.error || null,
      },
    };
  }

  // 4. Body must be valid JSON
  let payload;
  try {
    payload = parseJsonPayload(rawBody);
  } catch (parseError) {
    return {
      valid: false,
      error: {
        status: 400,
        body: { error: parseError.message },
        errorCode: KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      },
    };
  }

  // Extract / normalise fields (supporting enveloped data/payload/record objects)
  let domainData = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      domainData = payload.data;
    } else if (payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)) {
      domainData = payload.payload;
    } else if (payload.record && typeof payload.record === 'object' && !Array.isArray(payload.record)) {
      domainData = payload.record;
    }
  }

  const smeId = domainData?.smeId || domainData?.sme_id || payload?.smeId || payload?.sme_id;
  const status = domainData?.status || domainData?.kycStatus || domainData?.kyc_status || payload?.status || payload?.kycStatus || payload?.kyc_status;
  const providerRecordId = domainData?.recordId || domainData?.providerRecordId || domainData?.provider_record_id || payload?.recordId || payload?.providerRecordId || payload?.provider_record_id || null;
  const verifiedAt = domainData?.verifiedAt || domainData?.verified_at || payload?.verifiedAt || payload?.verified_at || null;
  const payloadTenantId = domainData?.tenantId || domainData?.tenant_id || payload?.tenantId || payload?.tenant_id || null;

  // 5. Tenant scope check
  if (payloadTenantId && requestTenantId && payloadTenantId !== requestTenantId) {
    return {
      valid: false,
      error: {
        status: 403,
        body: { error: KYC_WEBHOOK_MESSAGES.TENANT_MISMATCH },
        errorCode: KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH,
      },
    };
  }

  if (payloadTenantId && !requestTenantId) {
    return {
      valid: false,
      error: {
        status: 400,
        body: { error: KYC_WEBHOOK_MESSAGES.MISSING_TENANT_CONTEXT },
        errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT,
      },
    };
  }

  // 6. smeId must be present and a string
  if (!smeId || typeof smeId !== 'string') {
    return {
      valid: false,
      error: {
        status: 400,
        body: { error: KYC_WEBHOOK_MESSAGES.MISSING_SME_ID },
        errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID,
      },
    };
  }

  // 7. status must be present and a string
  if (!status || typeof status !== 'string') {
    return {
      valid: false,
      error: {
        status: 400,
        body: { error: KYC_WEBHOOK_MESSAGES.MISSING_STATUS },
        errorCode: KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS,
      },
    };
  }

  // 8. Provider status must be recognised (fail-closed, issue #592)
  const normalised = kycService.normalizeProviderStatus(status);
  if (normalised === kycService.KYC_STATUSES.UNKNOWN) {
    return {
      valid: false,
      error: {
        status: 400,
        body: { error: `${KYC_WEBHOOK_MESSAGES.UNKNOWN_STATUS_PREFIX}${status}` },
        errorCode: KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS,
        smeId,
        providerStatus: status,
      },
    };
  }

  // All checks passed
  return {
    valid: true,
    payload: { smeId, status, providerRecordId, verifiedAt, payloadTenantId },
  };
}

module.exports = {
  validateKycWebhookRequest,
  parseJsonPayload,
};
