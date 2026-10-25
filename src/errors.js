'use strict';

const ERROR_CATALOG = {
  MALFORMED_JSON: {
    title: 'Malformed JSON',
    status: 400,
    description: 'The request body contains invalid JSON syntax.',
  },
  PAYLOAD_TOO_LARGE: {
    title: 'Payload Too Large',
    status: 413,
    description: 'The request body exceeds the maximum allowed size of 100 KB.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    title: 'Unsupported Media Type',
    status: 415,
    description: 'The request Content-Type is not supported. Use application/json.',
  },
  VALIDATION_FAILED: {
    title: 'Validation Failed',
    status: 400,
    description: 'One or more request fields failed validation.',
  },
  INVALID_STATUS_FILTER: {
    title: 'Invalid Status Filter',
    status: 400,
    description: 'The status query parameter must be one of: open, funded, settled, cancelled.',
  },
  INVOICE_NOT_FOUND: {
    title: 'Invoice Not Found',
    status: 404,
    description: 'No invoice exists with the given identifier.',
  },
  INVOICE_NOT_OPEN: {
    title: 'Invoice Not Open',
    status: 409,
    description: 'The operation requires the invoice to be in open status.',
  },
  INVOICE_MATURED: {
    title: 'Invoice Matured',
    status: 409,
    description: 'The invoice has reached or passed its maturity date.',
  },
  EXCEEDS_CAPACITY: {
    title: 'Exceeds Capacity',
    status: 422,
    description: 'The requested amount exceeds the remaining funding capacity of the invoice.',
  },
  INVESTOR_REQUIRED: {
    title: 'Investor Required',
    status: 400,
    description: 'An investor address is required to fund an invoice.',
  },
  INVALID_INVESTOR_ADDRESS: {
    title: 'Invalid Investor Address',
    status: 400,
    description: 'The provided investor address is not a valid Stellar public key.',
  },
  SELF_FUNDING_NOT_ALLOWED: {
    title: 'Self-Funding Not Allowed',
    status: 422,
    description: 'The SME cannot fund their own invoice.',
  },
  INVALID_AMOUNT: {
    title: 'Invalid Amount',
    status: 400,
    description: 'The amount must be a positive decimal string with at most 7 fractional digits.',
  },
  INVALID_AS_OF: {
    title: 'Invalid As-Of Date',
    status: 400,
    description: 'The asOf parameter must be a valid date in YYYY-MM-DD format.',
  },
  INVALID_CURSOR: {
    title: 'Invalid Cursor',
    status: 400,
    description: 'The cursor parameter must be a non-negative integer.',
  },
  INVALID_LIMIT: {
    title: 'Invalid Limit',
    status: 400,
    description: 'The limit parameter must be an integer between 1 and 20.',
  },
  INVALID_DIGEST: {
    title: 'Invalid Digest',
    status: 400,
    description: 'The sha256 field must be a 64-character hexadecimal string.',
  },
  NO_FILE: {
    title: 'No File Provided',
    status: 400,
    description: 'No file was found in the multipart upload.',
  },
  FILE_TOO_LARGE: {
    title: 'File Too Large',
    status: 413,
    description: 'The uploaded file exceeds the maximum size of 5 MiB.',
  },
  UPLOAD_ERROR: {
    title: 'Upload Error',
    status: 400,
    description: 'An error occurred while processing the file upload.',
  },
  ESCROW_LIVE_UNAVAILABLE: {
    title: 'Escrow Live Read Unavailable',
    status: 503,
    description: 'The live escrow read from Soroban RPC failed and strict mode was requested.',
  },
  ESCROW_READ_FAILED: {
    title: 'Escrow Read Failed',
    status: 502,
    description: 'The Soroban RPC read operation failed.',
  },
  FUNDING_EXCEEDS_CAPACITY: {
    title: 'Funding Exceeds Capacity',
    status: 422,
    description: 'The contribution exceeds the remaining funding capacity of the invoice (set allowPartial to cap it).',
  },
  INVALID_STATE_TRANSITION: {
    title: 'Invalid State Transition',
    status: 409,
    description: 'The invoice is not in a status that allows this transition.',
  },
  ROUTE_NOT_FOUND: {
    title: 'Route Not Found',
    status: 404,
    description: 'The requested endpoint does not exist.',
  },
  INTERNAL: {
    title: 'Internal Server Error',
    status: 500,
    description: 'An unexpected error occurred. Please try again later.',
  },
};

const ERROR_BASE_URI = 'https://liquifact-backend.vercel.app/errors/';

class ApiError extends Error {
  constructor(status, code, title, { detail, errors, extra } = {}) {
    super(title);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.errors = errors;
    this.extra = extra;
  }

  toProblem(req) {
    const problem = {
      type: `${ERROR_BASE_URI}${this.code}`,
      title: this.title,
      status: this.status,
      code: this.code,
      instance: req?.originalUrl || '',
    };
    if (this.detail !== undefined) {
      problem.detail = this.detail;
    }
    if (this.errors !== undefined) {
      problem.errors = this.errors;
    }
    if (this.extra !== undefined) {
      Object.assign(problem, this.extra);
    }
    problem.error = this.title;
    return problem;
  }
}

function badRequest(code, detail, errors) {
  const entry = ERROR_CATALOG[code];
  if (!entry) {
    throw new Error(`Unknown error code: ${code}`);
  }
  return new ApiError(entry.status, code, entry.title, { detail, errors });
}

function notFound(code, detail) {
  const entry = ERROR_CATALOG[code];
  if (!entry) {
    throw new Error(`Unknown error code: ${code}`);
  }
  return new ApiError(entry.status, code, entry.title, { detail });
}

function conflict(code, detail) {
  const entry = ERROR_CATALOG[code];
  if (!entry) {
    throw new Error(`Unknown error code: ${code}`);
  }
  return new ApiError(entry.status, code, entry.title, { detail });
}

function unprocessable(code, detail) {
  const entry = ERROR_CATALOG[code];
  if (!entry) {
    throw new Error(`Unknown error code: ${code}`);
  }
  return new ApiError(entry.status, code, entry.title, { detail });
}

function internal(detail) {
  return new ApiError(500, 'INTERNAL', ERROR_CATALOG.INTERNAL.title, { detail });
}

/**
 * Sends an RFC 7807 problem response for a catalog code without throwing
 * (for handlers that must also record the rejection, e.g. in the audit log).
 *
 * @param {import('express').Request} req request
 * @param {import('express').Response} res response
 * @param {string} code catalog code
 * @param {{ status?: number, detail?: string, errors?: object[], extra?: object }} [options] overrides
 * @returns {import('express').Response} the response
 */
function sendProblem(req, res, code, { status, detail, errors, extra } = {}) {
  const entry = ERROR_CATALOG[code];
  if (!entry) {
    throw new Error(`Unknown error code: ${code}`);
  }
  const error = new ApiError(status || entry.status, code, entry.title, { detail, errors, extra });
  return res.status(error.status).type('application/problem+json').json(error.toProblem(req));
}

function getCatalogEntry(code) {
  return ERROR_CATALOG[code] || null;
}

function getAllCatalogEntries() {
  return Object.entries(ERROR_CATALOG).map(([code, entry]) => ({ code, ...entry }));
}

module.exports = {
  ApiError,
  ERROR_CATALOG,
  ERROR_BASE_URI,
  badRequest,
  notFound,
  conflict,
  unprocessable,
  internal,
  sendProblem,
  getCatalogEntry,
  getAllCatalogEntries,
};