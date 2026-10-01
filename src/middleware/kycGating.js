const { CAPITAL_MOVING_STATES } = require('../services/invoiceStateMachine');
const kycService = require('../services/kycService');
const logger = require('../logger');
const crypto = require('crypto');

/**
 * Blocks invoice state transitions that move capital unless the user has KYC.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function kycGatingMiddleware(req, res, next) {
    const body = req.body || {};
    const targetState = body.state || body.targetState;

    // Invariant: only a single, well-defined target state may be evaluated.
    // Ambiguous or missing target state must fail closed for capital-moving
    // operations rather than silently allowing the transition.
    if (targetState === undefined || targetState === null || targetState === '') {
        return res.status(400).json({
            error: 'INVALID_TARGET_STATE',
            message: 'A target state is required to evaluate KYC gating.',
        });
    }

    if (typeof targetState !== 'string') {
        return res.status(400).json({
            error: 'INVALID_TARGET_STATE',
            message: 'Target state must be a string.',
        });
    }

    // Invariant: the capital-moving state set must be a Set. If it is not
    // (misconfiguration, wrong export shape), fail closed for safety
    // rather than silently allowing a capital-moving transition.
    const isCapitalMoving =
        CAPITAL_MOVING_STATES instanceof Set
            ? CAPITAL_MOVING_STATES.has(targetState)
            : Array.isArray(CAPITAL_MOVING_STATES)
              ? CAPITAL_MOVING_STATES.includes(targetState)
              : true;

    if (isCapitalMoving) {
        const user = req.user;
        const isVerified = Boolean(user && user.isKycVerified === true);
        if (!isVerified) {
            logger.warn(
                {
                    userId: user && (user.id || user.sub),
                    smeId: user && user.smeId,
                    targetState,
                    endpoint: req.originalUrl,
                    method: req.method,
                },
                'KYC gate rejected capital-moving transition',
            );
            return res.status(403).json({
                error: 'KYC_REQUIRED',
                message: 'Action restricted. KYC verification required for capital-moving operations.',
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

    // Invariant: smeId must be a non-empty string to avoid ambiguous lookups
    // that could match unintended records or bypass the gate.
    if (typeof smeId !== 'string' || smeId.trim() === '') {
        return res.status(400).json({
            error: {
                code: 'INVALID_SME_ID',
                message: 'Authenticated principal has an invalid smeId.',
                retryable: false,
            },
        });
    }

    try {
        const result = await kycService.getKycStatus(smeId);
        const status = result && result.status;

        // Invariant: an unknown or missing status must fail closed. A missing
        // status must never be treated as verified.
        if (typeof status !== 'string' || status === '') {
            logger.error(
                { smeId, endpoint: req.originalUrl, method: req.method },
                'KYC status lookup returned an invalid status',
            );
            return res.status(503).json({
                error: {
                    code: 'KYC_STATUS_UNAVAILABLE',
                    message: 'Unable to determine KYC status. Please retry.',
                    retryable: true,
                },
            });
        }

        // Invariant: the KYC policy function must exist and return a strict
        // boolean. A missing or non-boolean result must fail closed rather
        // than being coerced into an allow decision.
        if (typeof kycService.canFundWithKycStatus !== 'function') {
            logger.error(
                { smeId, endpoint: req.originalUrl, method: req.method },
                'KYC policy function unavailable',
            );
            return res.status(503).json({
                error: {
                    code: 'KYC_STATUS_UNAVAILABLE',
                    message: 'Unable to determine KYC status. Please retry.',
                    retryable: true,
                },
            });
        }

        let canFund;
        try {
            canFund = kycService.canFundWithKycStatus(status);
        } catch (policyErr) {
            logger.error(
                { smeId, endpoint: req.originalUrl, method: req.method, err: policyErr },
                'KYC policy evaluation failed',
            );
            return res.status(503).json({
                error: {
                    code: 'KYC_STATUS_UNAVAILABLE',
                    message: 'Unable to determine KYC status. Please retry.',
                    retryable: true,
                },
            });
        }

        if (canFund !== true) {
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

    // Correlation id lets operators trace a single gated request across logs
    // without exposing sensitive principal data.
    const correlationId =
        (req.headers && (req.headers['x-request-id'] || req.headers['x-correlation-id'])) ||
        crypto.randomUUID();

    if (req.headers && !req.headers['x-request-id']) {
        req.headers['x-request-id'] = correlationId;
    }

    logger.info(
        {
            userId: req.user && (req.user.id || req.user.sub),
            smeId,
            endpoint: req.originalUrl,
            method: req.method,
            correlationId,
        },
        'KYC-gated endpoint accessed',
    );

    next();
}

kycGatingMiddleware.requireKycForFunding = requireKycForFunding;
kycGatingMiddleware.auditKycAccess = auditKycAccess;

module.exports = kycGatingMiddleware;
