'use strict';

/**
 * @fileoverview Shared validation helper for config-related handlers.
 *
 * Exposes a single, tested `createBodyValidator` factory that produces
 * Express middleware for validating request bodies against Zod schemas.
 *
 * All validation failures are rejected with a structured RFC 7807
 * `application/problem+json` 400 response containing machine-readable
 * `fieldErrors` so clients can map errors back to specific form fields.
 *
 * @module schemas/validationHelper
 */

// ── Shared indexer regex constants ───────────────────────────────────────────

/**
 * Regex for invoiceId validation: 1-128 alphanumeric/underscore/hyphen characters.
 */
const INVOICE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Regex for contractId validation: Stellar contract address (C + 55 base32 chars).
 */
const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Regex for transaction hash validation: 64 hexadecimal characters.
 */
const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Flattens a ZodError into a `{ [fieldPath]: firstMessage }` object.
 *
 * @param {import('zod').ZodError} zodError
 * @returns {Record<string, string>}
 */
function parseValidationErrors(zodError) {
  const fieldErrors = {};
  for (const issue of zodError.issues ?? zodError.errors ?? []) {
    const path = issue.path.join('.') || '_root';
    if (!fieldErrors[path]) {
      fieldErrors[path] = issue.message;
    }
  }
  return fieldErrors;
}

/** Default problem type URI for validation errors. */
const DEFAULT_PROBLEM_TYPE = 'https://liquifact.io/problems/validation-error';

/** Default error code for validation failures. */
const DEFAULT_ERROR_CODE = 'VALIDATION_ERROR';

/**
 * Creates Express middleware that validates `req.body` against a Zod schema
 * and maps errors to an RFC 7807 `application/problem+json` response.
 *
 * On success, attaches the parsed (and transformed) value to `req.validated`.
 *
 * @param {import('zod').ZodTypeAny} schema - Zod schema to validate against.
 * @param {object} [options] - Optional configuration.
 * @param {string} [options.problemType] - Custom problem type URI.
 * @param {string} [options.title] - Custom error title.
 * @param {string} [options.code] - Custom error code.
 * @param {string} [options.detail] - Custom detail message.
 * @returns {import('express').RequestHandler}
 */
function createBodyValidator(schema, options = {}) {
  const {
    problemType = DEFAULT_PROBLEM_TYPE,
    title = 'Validation Error',
    code = DEFAULT_ERROR_CODE,
    detail = 'Request body contains invalid or missing fields.',
  } = options;

  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (result.success) {
      req.validated = result.data;
      return next();
    }

    const fieldErrors = parseValidationErrors(result.error);

    return res.status(400).json({
      type: problemType,
      title,
      status: 400,
      detail,
      code,
      fieldErrors,
    });
  };
}

/**
 * Creates Express middleware that validates `req.query` against a Zod schema
 * and maps errors to an RFC 7807 `application/problem+json` response.
 *
 * On success, attaches the parsed value to `req.validatedQuery`.
 *
 * @param {import('zod').ZodTypeAny} schema - Zod schema to validate against.
 * @param {object} [options] - Optional configuration.
 * @param {string} [options.problemType] - Custom problem type URI.
 * @param {string} [options.title] - Custom error title.
 * @param {string} [options.code] - Custom error code.
 * @param {string} [options.detail] - Custom detail message.
 * @returns {import('express').RequestHandler}
 */
function createQueryValidator(schema, options = {}) {
  const {
    problemType = DEFAULT_PROBLEM_TYPE,
    title = 'Validation Error',
    code = DEFAULT_ERROR_CODE,
    detail = 'Query parameters contain invalid values.',
  } = options;

  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (result.success) {
      req.validatedQuery = result.data;
      return next();
    }

    const fieldErrors = parseValidationErrors(result.error);

    return res.status(400).json({
      type: problemType,
      title,
      status: 400,
      detail,
      code,
      fieldErrors,
    });
  };
}

module.exports = {
  createBodyValidator,
  createQueryValidator,
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
  DEFAULT_PROBLEM_TYPE,
  DEFAULT_ERROR_CODE,
};
