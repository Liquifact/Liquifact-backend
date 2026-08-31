'use strict';

/**
 * Errors owned by the capital-moving funding flow.
 *
 * Funding is deliberately isolated from the generic application error mapper:
 * the endpoint calls an external escrow service and persists a commitment, so
 * its public error contract must not accidentally expose an RPC or database
 * message.  The middleware uses these fields to produce one stable response.
 */
class FundingError extends Error {
  /**
   * Create a safe, typed error for the funding flow.
   *
   * @param {object} params
   * @param {string} params.code - Stable public machine-readable code.
   * @param {number} params.status - HTTP status.
   * @param {string} params.message - Safe client-facing message.
   * @param {unknown[]} [params.details] - Safe validation details.
   * @param {boolean} [params.retryable=false] - Whether retry is appropriate.
   */
  constructor({ code, status, message, details, retryable = false }) {
    super(message);
    this.name = 'FundingError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
    Error.captureStackTrace(this, this.constructor);
  }
}

const FUNDING_ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_SME_ID: 'MISSING_SME_ID',
  KYC_GATE_FAILED: 'KYC_GATE_FAILED',
  ESCROW_NOT_FOUND: 'ESCROW_NOT_FOUND',
  FUNDING_CONFLICT: 'FUNDING_CONFLICT',
  ESCROW_SUBMIT_FAILED: 'ESCROW_SUBMIT_FAILED',
  LEGAL_HOLD_ACTIVE: 'LEGAL_HOLD_ACTIVE',
  LEGAL_HOLD_STATUS_UNAVAILABLE: 'LEGAL_HOLD_STATUS_UNAVAILABLE',
  FUNDING_INTERNAL_ERROR: 'FUNDING_INTERNAL_ERROR',
  // Used when two workers attempt to start the same reconciliation run concurrently.
  RECONCILIATION_CONFLICT: 'RECONCILIATION_CONFLICT',
});

const FUNDING_ERROR_STATUS = Object.freeze({
  [FUNDING_ERROR_CODES.VALIDATION_ERROR]: 400,
  [FUNDING_ERROR_CODES.MISSING_SME_ID]: 400,
  [FUNDING_ERROR_CODES.KYC_GATE_FAILED]: 403,
  [FUNDING_ERROR_CODES.ESCROW_NOT_FOUND]: 404,
  [FUNDING_ERROR_CODES.FUNDING_CONFLICT]: 409,
  [FUNDING_ERROR_CODES.ESCROW_SUBMIT_FAILED]: 502,
  [FUNDING_ERROR_CODES.LEGAL_HOLD_ACTIVE]: 423,
  [FUNDING_ERROR_CODES.LEGAL_HOLD_STATUS_UNAVAILABLE]: 503,
  [FUNDING_ERROR_CODES.FUNDING_INTERNAL_ERROR]: 500,
  [FUNDING_ERROR_CODES.RECONCILIATION_CONFLICT]: 409,
});

const SAFE_FUNDING_CODES = new Set(Object.values(FUNDING_ERROR_CODES));

/**
 * Create a typed funding error while keeping status/code pairs centralized.
 *
 * @param {string} code - Member of FUNDING_ERROR_CODES.
 * @param {string} message - Safe message.
 * @param {object} [options]
 * @param {unknown[]} [options.details]
 * @param {boolean} [options.retryable]
 * @returns {FundingError}
 */
function createFundingError(code, message, options = {}) {
  if (!SAFE_FUNDING_CODES.has(code)) {
    throw new TypeError(`Unknown funding error code: ${code}`);
  }

  return new FundingError({
    code,
    status: FUNDING_ERROR_STATUS[code],
    message,
    details: options.details,
    retryable: options.retryable ?? [502, 503].includes(FUNDING_ERROR_STATUS[code]),
  });
}

/**
 * Convert request validation failures into the public funding error type.
 * @param {string[]} details - Safe field-level validation messages.
 * @returns {FundingError}
 */
function fundingValidationError(details) {
  return createFundingError(
    FUNDING_ERROR_CODES.VALIDATION_ERROR,
    details[0] || 'Funding request is invalid.',
    { details, retryable: false },
  );
}

/**
 * Classify known errors from the funding route. Unknown errors intentionally
 * become a generic 500 so internal messages never cross the API boundary.
 *
 * @param {unknown} error - Thrown value.
 * @param {object} [classes]
 * @param {Function} [classes.escrowNotFoundError]
 * @param {Function} [classes.escrowSubmitError]
 * @param {Function} [classes.commitmentValidationError]
 * @returns {FundingError}
 */
function classifyFundingError(error, classes = {}) {
  if (error instanceof FundingError) {
    return error;
  }

  const isInstance = (key) => {
    const ErrorClass = classes[key];
    return typeof ErrorClass === 'function' && error instanceof ErrorClass;
  };

  if (isInstance('escrowNotFoundError') || error?.name === 'EscrowNotFoundError') {
    return createFundingError(
      FUNDING_ERROR_CODES.ESCROW_NOT_FOUND,
      'The escrow contract for this invoice was not found.',
      { retryable: false },
    );
  }

  if (isInstance('escrowSubmitError') || error?.name === 'EscrowSubmitError') {
    return createFundingError(
      FUNDING_ERROR_CODES.ESCROW_SUBMIT_FAILED,
      'The escrow transaction could not be prepared. Please retry.',
      { retryable: true },
    );
  }

  if (isInstance('commitmentValidationError') || error?.name === 'CommitmentValidationError') {
    return createFundingError(
      FUNDING_ERROR_CODES.VALIDATION_ERROR,
      error.message || 'Funding commitment input is invalid.',
      { details: [error.message], retryable: false },
    );
  }

  if (error && typeof error === 'object') {
    if (SAFE_FUNDING_CODES.has(error.code)) {
      return createFundingError(error.code, error.message || 'Funding request failed.', {
        details: error.details,
        retryable: error.retryable,
      });
    }

    const status = Number(error.status || error.statusCode);
    if (status === 409 || error.code === '23505' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return createFundingError(
        FUNDING_ERROR_CODES.FUNDING_CONFLICT,
        'A funding commitment for this request already exists or conflicts with another request.',
        { retryable: false },
      );
    }

    if (status === 423) {
      return createFundingError(
        FUNDING_ERROR_CODES.LEGAL_HOLD_ACTIVE,
        'Funding is blocked while this invoice is under legal hold.',
        { retryable: false },
      );
    }

    if (status === 503) {
      return createFundingError(
        FUNDING_ERROR_CODES.LEGAL_HOLD_STATUS_UNAVAILABLE,
        'Funding is temporarily unavailable while the invoice hold status is verified.',
        { retryable: true },
      );
    }
  }

  return createFundingError(
    FUNDING_ERROR_CODES.FUNDING_INTERNAL_ERROR,
    'An internal funding error occurred. Please retry later.',
    { retryable: false },
  );
}

module.exports = {
  FundingError,
  FUNDING_ERROR_CODES,
  FUNDING_ERROR_STATUS,
  SAFE_FUNDING_CODES,
  createFundingError,
  fundingValidationError,
  classifyFundingError,
};
