'use strict';

/**
 * @fileoverview Error catalog and RFC 7807 problem+json helpers.
 *
 * `ERROR_CATALOG` is the single source of truth for error codes; every code
 * maps to a fixed HTTP status, title, and description. `ApiError` turns one of
 * those entries (optionally with a per-request `detail`) into a throwable that
 * the global error handler renders as `application/problem+json`. `sendProblem`
 * renders directly, for handlers that cannot throw.
 *
 * @module errors
 */

const ERROR_BASE_URI = 'https://liquifact.io/problems';

const ERROR_CATALOG = {
  INTERNAL: {
    title: 'Internal Server Error',
    status: 500,
    description: 'An unexpected error occurred.',
  },
  BAD_REQUEST: {
    title: 'Bad Request',
    status: 400,
    description: 'The request could not be understood.',
  },
  UNAUTHORIZED: {
    title: 'Unauthorized',
    status: 401,
    description: 'Missing or invalid authentication.',
  },
  FORBIDDEN: {
    title: 'Forbidden',
    status: 403,
    description: 'The authenticated caller is not allowed to perform this action.',
  },
  NOT_FOUND: {
    title: 'Not Found',
    status: 404,
    description: 'The requested resource does not exist.',
  },
  CONFLICT: {
    title: 'Conflict',
    status: 409,
    description: 'The request conflicts with the current state of the resource.',
  },
  UNPROCESSABLE: {
    title: 'Unprocessable Entity',
    status: 422,
    description: 'The request was understood but could not be processed.',
  },
  METHOD_NOT_ALLOWED: {
    title: 'Method Not Allowed',
    status: 405,
    description: 'The HTTP method is not supported for this route.',
  },
  INVALID_JSON: {
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
    description: 'The cursor parameter must be a valid opaque pagination cursor (1–100 items per page).',
  },
  INVALID_LIMIT: {
    title: 'Invalid Limit',
    status: 400,
    description: 'The limit parameter must be an integer between 1 and 100.',
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
  DOCUMENT_EXISTS: {
    title: 'Document Already Exists',
    status: 409,
    description: 'A document has already been uploaded for this invoice.',
  },
  DOCUMENT_NOT_FOUND: {
    title: 'Document Not Found',
    status: 404,
    description: 'No document has been uploaded for this invoice.',
  },
  DOCUMENT_EVICTED: {
    title: 'Document Evicted',
    status: 410,
    description: 'The document was evicted from the store to make room for a new entry.',
  },
  UNSAFE_PDF: {
    title: 'Unsafe PDF',
    status: 422,
    description: 'The uploaded PDF contains active content (/JavaScript or /Launch) and was rejected.',
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
    description: 'The requested transition is not allowed from the current invoice state.',
  },
};

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
    const type = `${ERROR_BASE_URI}/${this.code.toLowerCase().replace(/_/g, '-')}`;
    const problem = {
      type,
      title: this.title,
      status: this.status,
      code: this.code,
    };
    if (this.detail) { problem.detail = this.detail; }
    if (this.errors) { problem.errors = this.errors; }
    if (this.extra) { Object.assign(problem, this.extra); }
    if (req && req.id) { problem.instance = req.id; }
    return problem;
  }
}

function badRequest(code, detail, errors) {
  const entry = ERROR_CATALOG[code];
  if (!entry) { throw new Error(`Unknown error code: ${code}`); }
  return new ApiError(entry.status, code, entry.title, { detail, errors });
}

function notFound(code, detail) {
  const entry = ERROR_CATALOG[code];
  if (!entry) { throw new Error(`Unknown error code: ${code}`); }
  return new ApiError(entry.status, code, entry.title, { detail });
}

function conflict(code, detail) {
  const entry = ERROR_CATALOG[code];
  if (!entry) { throw new Error(`Unknown error code: ${code}`); }
  return new ApiError(entry.status, code, entry.title, { detail });
}

function unprocessable(code, detail) {
  const entry = ERROR_CATALOG[code];
  if (!entry) { throw new Error(`Unknown error code: ${code}`); }
  return new ApiError(entry.status, code, entry.title, { detail });
}

function internal(detail) {
  return new ApiError(500, 'INTERNAL', ERROR_CATALOG.INTERNAL.title, { detail });
}

function sendProblem(req, res, code, { status, detail, errors, extra } = {}) {
  const entry = ERROR_CATALOG[code];
  if (!entry) { throw new Error(`Unknown error code: ${code}`); }
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