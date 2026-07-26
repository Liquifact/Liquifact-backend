'use strict';

/**
 * @fileoverview Zod schemas for the SME metrics bulk endpoint.
 *
 * Exposes:
 *  - `bulkMetricsSchema` — strict body schema (rejects unknown keys)
 *  - `validateBulkMetricsBody` — Express middleware for body validation
 *
 * @module schemas/metrics
 */

const { z } = require('zod');

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of operations allowed in a single bulk request. */
const MAX_BULK_OPERATIONS = 25;

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Single operation within a bulk metrics request.
 * Each operation specifies a (tenantId, userId) pair to query invoice counts for.
 *
 * @type {z.ZodObject<{tenantId: z.ZodString, userId: z.ZodString}>}
 */
const bulkMetricsOperationSchema = z.object({
  tenantId: z
    .string({ message: 'tenantId is required' })
    .trim()
    .min(1, { message: 'tenantId must not be empty' })
    .max(128, { message: 'tenantId must not exceed 128 characters' }),
  userId: z
    .string({ message: 'userId is required' })
    .trim()
    .min(1, { message: 'userId must not be empty' })
    .max(128, { message: 'userId must not exceed 128 characters' }),
}).strict();

/**
 * Bulk metrics request body schema.
 *
 * Accepts an `operations` array of {@link bulkMetricsOperationSchema} items.
 * Enforces:
 *  - `operations` must be a non-empty array.
 *  - Maximum of {@link MAX_BULK_OPERATIONS} items.
 *  - Each item is validated individually.
 *  - Unknown top-level or per-item keys are rejected.
 *
 * @type {z.ZodObject<{operations: z.ZodArray}>}
 */
const bulkMetricsSchema = z.object({
  operations: z
    .array(bulkMetricsOperationSchema, {
      message: `operations must be a non-empty array with at most ${MAX_BULK_OPERATIONS} items`,
    })
    .min(1, { message: 'operations must contain at least one item' })
    .max(MAX_BULK_OPERATIONS, {
      message: `operations must not exceed ${MAX_BULK_OPERATIONS} items`,
    }),
}).strict();

/**
 * Parses a Zod ZodError into a field-keyed error object.
 *
 * @param {z.ZodError} zodError - The Zod validation error.
 * @returns {Object<string, string[]>} Field path → list of error messages.
 */
function parseValidationErrors(zodError) {
  const fieldErrors = {};
  for (const issue of zodError.issues) {
    const path = issue.path.join('.');
    if (!fieldErrors[path]) {
      fieldErrors[path] = [];
    }
    fieldErrors[path].push(issue.message);
  }
  return fieldErrors;
}

/**
 * Express middleware that validates `req.body` against {@link bulkMetricsSchema}.
 *
 * On success, attaches the parsed (and transformed) value to `req.validated`.
 * On failure, returns a 400 RFC 7807 Problem Details response.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function validateBulkMetricsBody(req, res, next) {
  const result = bulkMetricsSchema.safeParse(req.body);
  if (result.success) {
    req.validated = result.data;
    return next();
  }

  const fieldErrors = parseValidationErrors(result.error);

  return res.status(400).json({
    type: 'https://liquifact.io/problems/validation-error',
    title: 'Validation Error',
    status: 400,
    detail: 'Request body contains invalid or missing fields.',
    fieldErrors,
  });
}

module.exports = {
  bulkMetricsSchema,
  bulkMetricsOperationSchema,
  validateBulkMetricsBody,
  parseValidationErrors,
  MAX_BULK_OPERATIONS,
};
