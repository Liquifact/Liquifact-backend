/**
 * KYC Service
 * Manages KYC verification workflows and status persistence.
 *
 * Supports optional external KYC provider integration when env keys are present.
 * Falls back cleanly to an in-memory mock implementation for local/test use.
 *
 * @module services/kycService
 */

const db = require('../db/knex');
const logger = require('../logger');
const { emitKycWebhookForSme } = require('./kycWebhookEmitter');

const KYC_STATUSES = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  EXEMPTED: 'exempted',
};

const PROVIDER_STATUS_MAP = {
  pending: KYC_STATUSES.PENDING,
  in_review: KYC_STATUSES.PENDING,
  reviewing: KYC_STATUSES.PENDING,
  queued: KYC_STATUSES.PENDING,
  submitted: KYC_STATUSES.PENDING,
  verified: KYC_STATUSES.VERIFIED,
  approved: KYC_STATUSES.VERIFIED,
  pass: KYC_STATUSES.VERIFIED,
  success: KYC_STATUSES.VERIFIED,
  rejected: KYC_STATUSES.REJECTED,
  denied: KYC_STATUSES.REJECTED,
  declined: KYC_STATUSES.REJECTED,
  failed: KYC_STATUSES.REJECTED,
  exempted: KYC_STATUSES.EXEMPTED,
  exempt: KYC_STATUSES.EXEMPTED,
  waived: KYC_STATUSES.EXEMPTED,
};

// In-memory store for KYC records (used in test/dev environments)
const mockKycRecords = new Map();

/**
 * Configuration for external KYC provider.
 * Loaded from environment variables.
 *
 * @returns {{enabled: boolean, apiKey: (string|null), baseUrl: (string|null), apiSecret: (string|null)}}
 */
const getKycProviderConfig = () => {
  return {
    enabled: !!(process.env.KYC_PROVIDER_API_KEY && process.env.KYC_PROVIDER_URL),
    apiKey: process.env.KYC_PROVIDER_API_KEY || null,
    baseUrl: process.env.KYC_PROVIDER_URL || null,
    apiSecret: process.env.KYC_PROVIDER_SECRET || null, // optional secondary key used for webhook HMAC verification
  };
};

/**
 * Normalizes provider-specific status values to internal KYC statuses.
 *
 * @param {string} status - External provider status.
 * @returns {string} Normalized KYC status.
 */
function normalizeProviderStatus(status) {
  if (!status || typeof status !== 'string') {
    throw new Error('Missing provider status');
  }

  const normalized = status.trim().toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(PROVIDER_STATUS_MAP, normalized)) {
    throw new Error(`Unknown provider status: ${status}`);
  }

  return PROVIDER_STATUS_MAP[normalized];
}

/**
 * Reads a persisted KYC record from the database.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {Promise<null|Object>} Persisted KYC record, or null when missing.
 */
async function readKycRecord(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const row = await db('kyc_records').where({ sme_id: smeId }).first();
  if (!row) {
    return null;
  }

  return {
    smeId: row.sme_id,
    status: row.status,
    recordId: row.provider_record_id || null,
    verifiedAt: row.verified_at ? row.verified_at.toISOString?.() || row.verified_at : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString?.() || row.updated_at : null,
  };
}

/**
 * Persists a KYC status update to the database.
 *
 * @param {Object} params
 * @param {string} params.smeId
 * @param {string} params.status
 * @param {string|null} [params.providerRecordId]
 * @param {string|null} [params.verifiedAt]
 * @returns {Promise<Object>} Persisted KYC state.
 */
async function persistKycRecord({ smeId, status, providerRecordId = null, verifiedAt = null }) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const normalizedStatus = normalizeProviderStatus(status);
  const updatedAt = new Date();
  const record = {
    sme_id: smeId,
    status: normalizedStatus,
    provider_record_id: providerRecordId || null,
    verified_at: verifiedAt || null,
    updated_at: updatedAt,
  };

  const existing = await db('kyc_records').where({ sme_id: smeId }).first();
  if (existing) {
    await db('kyc_records')
      .where({ sme_id: smeId })
      .update(record);
  } else {
    await db('kyc_records').insert(record);
  }

  const result = {
    smeId,
    status: normalizedStatus,
    recordId: providerRecordId || null,
    verifiedAt: verifiedAt || null,
    updatedAt: updatedAt.toISOString(),
  };

  // Fire-and-forget: emit outbound webhook for the KYC status change.
  // Errors are suppressed inside emitKycWebhookForSme so they can never
  // prevent the KYC record from being persisted.
  emitKycWebhookForSme({
    smeId,
    status: normalizedStatus,
    recordId: providerRecordId || null,
    verifiedAt: verifiedAt || null,
  }).catch((err) => {
    logger.error(
      { smeId, error: err && err.message ? err.message : String(err) },
      'persistKycRecord: unexpected error from webhook emitter (suppressed)'
    );
  });

  return result;
}

/**
 * Verifies KYC status from external provider.
 * Only called if provider is configured and enabled.
 *
 * @param {string} smeId - The SME identifier.
 * @param {Object} _smeData - SME metadata from the authenticated principal.
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string|null}>}
 */
async function verifyWithExternalProvider(smeId, _smeData) {
  const config = getKycProviderConfig();

  if (!config.enabled) {
    throw new Error('KYC provider not configured');
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/verify`;

  const payload = {
    smeId,
    timestamp: new Date().toISOString(),
  };

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (config.apiSecret) {
    headers['X-KYC-Secret'] = config.apiSecret;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status}${body ? `: ${body}` : ''}`);
    }

    const data = await response.json();
    const recordId = data.recordId || data.providerRecordId || data.provider_record_id || `kyc_${smeId}_${Date.now()}`;
    const verifiedAt = data.verifiedAt || data.verified_at || null;
    const status = normalizeProviderStatus(data.status || data.kycStatus || data.result || '');

    const persisted = await persistKycRecord({
      smeId,
      status,
      providerRecordId: recordId,
      verifiedAt,
    });

    return {
      status: persisted.status,
      recordId: persisted.recordId,
      verifiedAt: persisted.verifiedAt,
    };
  } catch (error) {
    logger.error({ smeId, error: error.message }, 'External KYC provider call failed');
    throw error;
  }
}

/**
 * Gets KYC status for an SME.
 * Checks external provider if available, falls back to persisted DB record or mock store.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {Promise<{status: string, recordId?: string, verifiedAt?: string}>}
 */
async function getKycStatus(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const config = getKycProviderConfig();

  if (config.enabled) {
    try {
      return await verifyWithExternalProvider(smeId, {});
    } catch (error) {
      logger.warn({ smeId, error: error.message }, 'KYC provider lookup failed, falling back to persisted status');
      const record = await readKycRecord(smeId);
      if (record) {
        return record;
      }
      return { status: KYC_STATUSES.PENDING };
    }
  }

  const record = await readKycRecord(smeId);
  if (record) {
    return record;
  }

  const mockRecord = mockKycRecords.get(smeId);
  if (mockRecord) {
    return {
      status: mockRecord.status,
      recordId: mockRecord.recordId,
      verifiedAt: mockRecord.verifiedAt,
    };
  }

  return { status: KYC_STATUSES.PENDING };
}

/**
 * Marks an SME as KYC verified.
 * Only available in test/development (mock implementation).
 * Production should integrate with real KYC provider.
 *
 * @param {string} smeId - The SME identifier.
 * @param {Object} options - Additional options.
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string}>}
 */
async function verifySmeSafe(smeId, options = {}) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const recordId = options.recordId || `kyc_${smeId}_${Date.now()}`;
  const record = {
    smeId,
    status: KYC_STATUSES.VERIFIED,
    recordId,
    verifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  mockKycRecords.set(smeId, record);

  logger.info({ smeId, recordId }, 'SME marked as KYC verified');

  return {
    status: record.status,
    recordId: record.recordId,
    verifiedAt: record.verifiedAt,
  };
}

/**
 * Rejects KYC for an SME (mock implementation).
 *
 * @param {string} smeId - The SME identifier.
 * @param {string} reason - Reason for rejection.
 * @returns {Promise<{status: string, recordId: string}>}
 */
async function rejectSmeKyc(smeId, reason = 'Manual rejection') {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const recordId = `kyc_${smeId}_${Date.now()}`;
  const record = {
    smeId,
    status: KYC_STATUSES.REJECTED,
    recordId,
    reason,
    rejectedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  mockKycRecords.set(smeId, record);

  logger.warn({ smeId, recordId, reason }, 'SME KYC rejected');

  return {
    status: record.status,
    recordId: record.recordId,
  };
}

/**
 * Exempts an SME from KYC requirements.
 * Typically used for low-risk vendors or when exemption is policy-approved.
 *
 * @param {string} smeId - The SME identifier.
 * @param {string} reason - Reason for exemption.
 * @returns {Promise<{status: string, recordId: string}>}
 */
async function exemptSmeFromKyc(smeId, reason = 'Manual exemption') {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const recordId = `kyc_${smeId}_${Date.now()}`;
  const record = {
    smeId,
    status: KYC_STATUSES.EXEMPTED,
    recordId,
    reason,
    exemptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  mockKycRecords.set(smeId, record);

  logger.info({ smeId, recordId, reason }, 'SME exempted from KYC');

  return {
    status: record.status,
    recordId: record.recordId,
  };
}

/**
 * Checks if an SME can proceed with funding operations.
 * Returns true only for 'verified' or 'exempted' statuses.
 *
 * @param {string} kycStatus - The KYC status string.
 * @returns {boolean} True if KYC status allows funding.
 */
function canFundWithKycStatus(kycStatus) {
  return kycStatus === KYC_STATUSES.VERIFIED || kycStatus === KYC_STATUSES.EXEMPTED;
}

/**
 * Clears the in-memory mock KYC record store.
 * Intended for tests/dev usage.
 *
 * @returns {void}
 */
function resetMockRecords() {
  mockKycRecords.clear();
}

module.exports = {
  KYC_STATUSES,
  getKycStatus,
  verifyWithExternalProvider,
  persistKycRecord,
  readKycRecord,
  verifySmeSafe,
  rejectSmeKyc,
  exemptSmeFromKyc,
  canFundWithKycStatus,
  resetMockRecords,
  getKycProviderConfig,
};
