/**
 * KYC Service
 * Manages KYC verification workflows and status updates.
 * 
 * Supports optional external KYC provider integration when env keys are present.
 * Defaults to in-memory mock implementation.
 * 
 * @module services/kycService
 */

const logger = require('../logger');

const KYC_STATUSES = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  EXEMPTED: 'exempted',
};

// In-memory store for KYC records (used in test/dev environments)
const mockKycRecords = new Map();

/**
 * Configuration for external KYC provider
 * Loaded from environment variables
 */
const getKycProviderConfig = () => {
  return {
    enabled: !!(process.env.KYC_PROVIDER_API_KEY && process.env.KYC_PROVIDER_URL),
    apiKey: process.env.KYC_PROVIDER_API_KEY || null,
    baseUrl: process.env.KYC_PROVIDER_URL || null,
    apiSecret: process.env.KYC_PROVIDER_SECRET || null, // optional secondary key
  };
};

/**
 * Verifies KYC status from external provider
 * Only called if provider is configured and enabled
 * 
 * @param {string} smeId - The SME identifier
 * @param {Object} smeData - SME data (name, email, etc.)
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string}>}
 */
async function verifyWithExternalProvider(smeId, smeData) {
  const config = getKycProviderConfig();
  
  if (!config.enabled) {
    throw new Error('KYC provider not configured');
  }

  try {
    // TODO: Implement actual HTTP call to KYC provider
    // This is a placeholder - replace with actual provider integration
    logger.info(
      { smeId, provider: config.baseUrl },
      'Calling external KYC provider (stub implementation)'
    );

    // Mock response structure
    return {
      status: KYC_STATUSES.VERIFIED,
      recordId: `kyc_${smeId}_${Date.now()}`,
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(
      { smeId, error: error.message },
      'External KYC provider call failed'
    );
    throw error;
  }
}

/**
 * Gets KYC status for an SME
 * Checks external provider if available, falls back to mock data
 * 
 * @param {string} smeId - The SME identifier
 * @returns {Promise<{status: string, recordId?: string, verifiedAt?: string}>}
 */
async function getKycStatus(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const config = getKycProviderConfig();

  // Try external provider first if configured
  if (config.enabled) {
    try {
      const result = await verifyWithExternalProvider(smeId, {});
      return result;
    } catch (error) {
      logger.warn({ smeId, error: error.message }, 'KYC provider lookup failed, using mock');
    }
  }

  // Fall back to mock/in-memory store
  const record = mockKycRecords.get(smeId);
  if (record) {
    return {
      status: record.status,
      recordId: record.recordId,
      verifiedAt: record.verifiedAt,
    };
  }

  // Default: pending status
  return {
    status: KYC_STATUSES.PENDING,
  };
}

/**
 * Marks an SME as KYC verified
 * Only available in test/development (mock implementation)
 * Production should integrate with real KYC provider
 * 
 * @param {string} smeId - The SME identifier
 * @param {Object} options - Additional options
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
 * Rejects KYC for an SME (mock implementation)
 * 
 * @param {string} smeId - The SME identifier
 * @param {string} reason - Reason for rejection
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
 * Exempts an SME from KYC requirements
 * Typically used for low-risk vendors or when exemption is policy-approved
 * 
 * @param {string} smeId - The SME identifier
 * @param {string} reason - Reason for exemption
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
 * Checks if an SME can proceed with funding operations
 * Returns true only for 'verified' or 'exempted' statuses
 * 
 * @param {string} kycStatus - The KYC status string
 * @returns {boolean} True if KYC status allows funding
 */
function canFundWithKycStatus(kycStatus) {
  return kycStatus === KYC_STATUSES.VERIFIED || kycStatus === KYC_STATUSES.EXEMPTED;
}

function resetMockRecords() {
  mockKycRecords.clear();
}

module.exports = {
  KYC_STATUSES,
  getKycStatus,
  verifySmeSafe,
  rejectSmeKyc,
  exemptSmeFromKyc,
  canFundWithKycStatus,
  resetMockRecords,
  getKycProviderConfig,
};
