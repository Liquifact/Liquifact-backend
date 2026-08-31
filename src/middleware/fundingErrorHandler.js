'use strict';
const logger = require('../logger');
const { classifyFundingError } = require('../errors/fundingErrors');
const { EscrowNotFoundError } = require('../config/escrowMap');
const { EscrowSubmitError } = require('../services/escrowSubmit');
const { CommitmentValidationError } = require('../services/investorCommitment');
const { ReconciliationConflictError } = require('../errors/reconcilationErrors');

function fundingErrorHandler(error, req, res, next) {
  if (!error) return next();
  const fundingError = classifyFundingError(error, {
    escrowNotFoundError: EscrowNotFoundError,
    escrowSubmitError: EscrowSubmitError,
    commitmentValidationError: CommitmentValidationError,
    reconciliationConflictError: ReconciliationConflictError,
  });
  const requestId = req.id || req.headers?['-xrequest-id'] || 'unknown';
  const logContext = { requestId, code: fundingError.code, status: fundingError.status, method: req.method, url: req.originalUrl };
  if (fundingError.status >= 500) logger.error({ ...logContext, err: error }, 'Funding request failed');
  else logger.warn(logContext, 'Funding request rejected');
  const responseError = { code: fundingError.code, message: fundingError.message, requestId, retryable: fundingError.retryable };
  if (Array.isArray(fundingError.details) && fundingError.details.length > 0) responseError.details = fundingError.details;
  res.status(fundingError.status).json({ error: responseError });
}

module.exports = { fundingErrorHandler };
