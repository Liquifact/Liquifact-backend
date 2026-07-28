'use strict';

/**
 * @fileoverview Strict Zod schemas for persistence write endpoints.
 *
 * The persistence endpoint family is:
 *  - `POST /api/sme/invoice/presigned-url` — JSON body requesting a presigned upload
 *  - `POST /api/sme/invoice` — multipart direct upload (optional form fields)
 *
 * Security guarantees applied to every schema:
 *  - `.strict()` — unknown keys are rejected (prevents prototype-pollution payloads).
 *  - String length bounds — prevents oversized inputs reaching the store.
 *  - Numeric range checks — ensures fileSize is within the storage service limit.
 *  - Enum allowlists — rejects arbitrary MIME types.
 *
 * Validation failures produce an RFC 7807 `application/problem+json` 400 body
 * with a machine-readable top-level `code` and a `fieldErrors` map.
 *
 * @module schemas/persistence
 */

const { z } = require('zod');
const {
  ALLOWED_MIME_TYPES,
  DEFAULT_MAX_FILE_SIZE,
} = require('../services/storage');
const { parseValidationErrors } = require('./validationHelper');

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum length for a file name (matches storage `_sanitizeFilename` truncate). */
const MAX_FILE_NAME_LENGTH = 255;

/** Maximum length for an optional invoiceId path segment. */
const MAX_INVOICE_ID_LENGTH = 128;

/**
 * Resolved max file size for request validation.
 * Mirrors `StorageService.maxFileSize` / `BODY_LIMIT_INVOICE` parsing so the
 * route rejects oversized declarations before calling the storage service.
 *
 * @type {number}
 */
const MAX_FILE_SIZE_BYTES = (() => {
  const sizeStr = process.env.BODY_LIMIT_INVOICE || '512kb';
  if (typeof sizeStr !== 'string' || sizeStr.trim() === '') {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.floor(value * multipliers[unit]);
})();

/** Machine-readable top-level error code for persistence validation failures. */
const PERSISTENCE_VALIDATION_CODE = 'PERSISTENCE_VALIDATION_FAILED';

/** Problem-details type URI for persistence validation errors. */
const PERSISTENCE_PROBLEM_TYPE = 'https://liquifact.io/problems/validation-error';

// ── Shared field schemas ─────────────────────────────────────────────────────

/**
 * Optional invoiceId: non-empty alphanumeric / `_` / `-`, max 128 chars.
 * Matches `StorageService._validateInvoiceId`.
 */
const invoiceIdSchema = z
  .string({ invalid_type_error: 'invoiceId must be a string' })
  .min(1, { message: 'invoiceId must be a non-empty string' })
  .max(MAX_INVOICE_ID_LENGTH, {
    message: `invoiceId must not exceed ${MAX_INVOICE_ID_LENGTH} characters`,
  })
  .regex(/^[a-zA-Z0-9_-]+$/, {
    message: 'invoiceId must contain only letters, digits, underscores, and hyphens',
  });

// ── Presigned upload body schema ─────────────────────────────────────────────

/**
 * Zod schema for `POST /api/sme/invoice/presigned-url` JSON bodies.
 *
 * Required: `fileName`, `mimeType`, `fileSize`.
 * Optional: `invoiceId`.
 * Unknown keys are rejected.
 *
 * @type {import('zod').ZodObject}
 */
const presignedUploadBodySchema = z
  .object({
    fileName: z
      .string({
        invalid_type_error: 'fileName must be a string',
        required_error: 'fileName is required',
      })
      .min(1, { message: 'fileName must be a non-empty string' })
      .max(MAX_FILE_NAME_LENGTH, {
        message: `fileName must not exceed ${MAX_FILE_NAME_LENGTH} characters`,
      })
      .refine((v) => !v.includes('..') && !v.includes('/') && !v.includes('\\'), {
        message: 'fileName must not contain path separators or traversal sequences',
      }),

    mimeType: z.enum(
      /** @type {[string, ...string[]]} */ (ALLOWED_MIME_TYPES),
      {
        errorMap: () => ({
          message: `mimeType must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`,
        }),
        invalid_type_error: 'mimeType must be a string',
        required_error: 'mimeType is required',
      }
    ),

    fileSize: z
      .number({
        invalid_type_error: 'fileSize must be a number',
        required_error: 'fileSize is required',
      })
      .int({ message: 'fileSize must be an integer' })
      .min(1, { message: 'fileSize must be at least 1' })
      .max(MAX_FILE_SIZE_BYTES, {
        message: `fileSize must be at most ${MAX_FILE_SIZE_BYTES}`,
      }),

    invoiceId: invoiceIdSchema.optional(),
  })
  .strict();

// ── Direct upload form-field schema ──────────────────────────────────────────

/**
 * Zod schema for optional form fields on `POST /api/sme/invoice` (multipart).
 *
 * Only `invoiceId` is accepted. Unknown keys are rejected.
 * The binary file itself is validated separately (presence + storage service).
 *
 * @type {import('zod').ZodObject}
 */
const directUploadBodySchema = z
  .object({
    invoiceId: invoiceIdSchema.optional(),
  })
  .strict();

// ── Response helpers ─────────────────────────────────────────────────────────

/**
 * Builds an RFC 7807 problem+json body for a persistence validation failure.
 *
 * @param {import('express').Request} req
 * @param {Record<string, string>} fieldErrors
 * @param {string} [detail]
 * @returns {object}
 */
function buildPersistenceValidationProblem(
  req,
  fieldErrors,
  detail = 'Request body contains invalid, missing, or unknown fields.'
) {
  return {
    type: PERSISTENCE_PROBLEM_TYPE,
    title: 'Invalid persistence request body',
    status: 400,
    detail,
    instance: req.originalUrl,
    code: PERSISTENCE_VALIDATION_CODE,
    fieldErrors,
  };
}

/**
 * Express middleware that validates `req.body` against a persistence Zod schema
 * and responds with a structured 400 on failure.
 *
 * On success, attaches the parsed value to `req.validated`.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
function validatePersistenceBody(schema) {
  return (req, res, next) => {
    if (req.body === undefined || req.body === null) {
      return res.status(400).json(
        buildPersistenceValidationProblem(req, {
          _root: 'Request body is required',
        }, 'Request body is missing.')
      );
    }

    if (typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json(
        buildPersistenceValidationProblem(req, {
          _root: 'Request body must be a JSON object',
        }, 'Request body must be a plain object.')
      );
    }

    const result = schema.safeParse(req.body);
    if (result.success) {
      req.validated = result.data;
      return next();
    }

    const fieldErrors = parseValidationErrors(result.error);
    return res
      .status(400)
      .type('application/problem+json')
      .json(buildPersistenceValidationProblem(req, fieldErrors));
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  presignedUploadBodySchema,
  directUploadBodySchema,
  validatePersistenceBody,
  buildPersistenceValidationProblem,
  parseValidationErrors,
  MAX_FILE_NAME_LENGTH,
  MAX_INVOICE_ID_LENGTH,
  MAX_FILE_SIZE_BYTES,
  PERSISTENCE_VALIDATION_CODE,
  PERSISTENCE_PROBLEM_TYPE,
  ALLOWED_MIME_TYPES,
};
