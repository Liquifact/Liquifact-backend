const { CAPITAL_MOVING_STATES } = require('../services/invoiceStateMachine');
const kycService = require('../services/kycService');
const logger = require('../logger');

/**
 * Blocks invoice state transitions that move capital unless the user has KYC.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function kycGatingMiddleware(req, res, next) {
    const targetState = req.body.state || req.body.targetState;
    
    if (CAPITAL_MOVING_STATES.has(targetState)) {
        if (!req.user || !req.user.isKycVerified) {
            return res.status(403).json({ 
                error: 'KYC_REQUIRED', 
                message: 'Action restricted. KYC verification required for capital-moving operations.' 
            });
        }
    }
    next();
}

/**
 * Requires the authenticated JWT principal's SME to be verified or exempted.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {Promise<void>}
 */
async function requireKycForFunding(req, res, next) {
    const smeId = req.user && req.user.smeId;

    if (!smeId) {
        return res.status(400).json({
            error: {
                code: 'MISSING_SME_ID',
                message: 'Authenticated principal is missing smeId.',
                retryable: false,
            },
        });
    }

    try {
        const { status } = await kycService.getKycStatus(smeId);
        if (!kycService.canFundWithKycStatus(status)) {
            return res.status(403).json({
                error: {
                    code: 'KYC_GATE_FAILED',
                    message: `SME KYC status '${status}' does not permit funding operations.`,
                    retryable: false,
                },
            });
        }
        return next();
    } catch (err) {
        return next(err);
    }
}

/**
 * Logs successful access to a KYC-gated endpoint for audit trails.
 * Intended to run immediately after `requireKycForFunding` on gated routes.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function auditKycAccess(req, res, next) {
    const smeId = req.user && req.user.smeId;

    logger.info(
        {
            userId: req.user && (req.user.id || req.user.sub),
            smeId,
            endpoint: req.originalUrl,
            method: req.method,
        },
        'KYC-gated endpoint accessed',
    );

    next();
}

kycGatingMiddleware.requireKycForFunding = requireKycForFunding;
kycGatingMiddleware.auditKycAccess = auditKycAccess;

module.exports = kycGatingMiddleware;
