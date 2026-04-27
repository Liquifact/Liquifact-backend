/**
 * KYC Gating Middleware
 * Enforces KYC requirements before allowing access to sensitive endpoints
 * 
 * @module middleware/kycGating
 */

const AppError = require('../errors/AppError');
const kycService = require('../services/kycService');
const logger = require('../logger');

/**
 * Middleware to enforce KYC verification for funding operations
 * 
 * Should be applied to:
 * - POST /api/invest/fund-invoice
 * - POST /api/invoices/:id/fund
 * - Any endpoint that initiates capital transfer
 * 
 * Requirements:
 * - User must be authenticated (req.user must exist)
 * - SME must have KYC status of 'verified' or 'exempted'
 * - Tenant isolation is enforced (via tenant middleware)
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object  
 * @param {Function} next - Express next middleware
 * @throws {AppError} 403 if KYC requirements not met
 */
async function requireKycForFunding(req, res, next) {
  try {
    // 1. Validate authentication
    if (!req.user || !req.user.sub) {
      const error = new AppError({
        type: 'https://liquifact.com/probs/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required for KYC-gated operations.',
        instance: req.originalUrl,
        code: 'UNAUTHORIZED',
      });
      return next(error);
    }

    // 2. Extract SME ID from request
    // Can come from: req.user.smeId, req.body.smeId, or req.params.smeId
    const smeId = req.user.smeId || req.body?.smeId || req.params?.smeId;

    if (!smeId) {
      const error = new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'SME ID is required for funding operations.',
        instance: req.originalUrl,
        code: 'MISSING_SME_ID',
      });
      return next(error);
    }

    // 3. Check KYC status
    const kycRecord = await kycService.getKycStatus(smeId);
    const canFund = kycService.canFundWithKycStatus(kycRecord.status);

    logger.info(
      {
        userId: req.user.sub,
        smeId,
        kycStatus: kycRecord.status,
        canFund,
        requestId: req.id,
      },
      'KYC gate check'
    );

    // 4. Enforce gate
    if (!canFund) {
      const error = new AppError({
        type: 'https://liquifact.com/probs/kyc-required',
        title: 'KYC Verification Required',
        status: 403,
        detail: `SME KYC status '${kycRecord.status}' does not permit funding operations. Status must be 'verified' or 'exempted'.`,
        instance: req.originalUrl,
        code: 'KYC_GATE_FAILED',
        retryable: false,
        retryHint: 'Complete KYC verification and try again.',
      });
      return next(error);
    }

    // 5. Attach KYC info to request for downstream handlers
    req.kyc = {
      status: kycRecord.status,
      recordId: kycRecord.recordId,
      verifiedAt: kycRecord.verifiedAt,
    };

    next();
  } catch (error) {
    logger.error(
      {
        error: error.message,
        stack: error.stack,
        requestId: req.id,
      },
      'KYC gating middleware error'
    );

    const appError = new AppError({
      type: 'https://liquifact.com/probs/internal-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An error occurred while checking KYC status.',
      instance: req.originalUrl,
      code: 'KYC_CHECK_FAILED',
      retryable: true,
    });

    next(appError);
  }
}

/**
 * Optional: Middleware to log KYC checks for audit trails
 * Attach to general routes to track KYC interactions
 */
async function auditKycAccess(req, res, next) {
  // Extract KYC info if available
  if (req.kyc) {
    logger.debug(
      {
        userId: req.user?.sub,
        smeId: req.user?.smeId,
        kycStatus: req.kyc.status,
        endpoint: req.path,
        method: req.method,
        requestId: req.id,
      },
      'KYC-gated endpoint accessed'
    );
  }
  next();
}

module.exports = {
  requireKycForFunding,
  auditKycAccess,
};
