'use strict';

/**
 * @fileoverview Zod schemas for the SME metrics endpoints.
 *
 * Exposes declarative request/response schemas for every metrics route so
 * that validation is centralised, testable in isolation, and enforced at
 * the route boundary rather than scattered across handler code.
 *
 * ## Request schemas
 * - `getMetricsQuerySchema`      — query-param schema for `GET /api/sme/metrics`
 * - `bulkMetricsSchema`          — body schema for `POST /api/sme/metrics/bulk`
 * - `bulkMetricsOperationSchema` — per-item schema used inside `bulkMetricsSchema`
 *
 * ## Response schemas
 * - `smeMetricsDataSchema`        — aggregated invoice-count shape
 * - `smeMetricsMetaBaseSchema`    — mandatory meta fields
 * - `smeMetricsMetaSchema`        — full meta including optional pagination fields
 * - `smeMetricsApiResponseSchema` — top-level API response envelope
 * - `bulkMetricsResultItemSchema` — per-item shape inside the bulk response
 * - `bulkMetricsResponseSchema`   — full bulk response envelope
 *
 * ## Middleware
 * - `validateGetMetricsQuery` — Express middleware for GET query validation
 * - `validateBulkMetricsBody` — Express middleware for POST bulk body validation
 *
 * ## Response helpers (for tests / contract checks)
 * - `validateSmeMetricsApiResponse` — validate a GET response against the schema
 * - `validateBulkMetricsResponse`   — validate a bulk response against the schema
 *
 * @module schemas/metrics
 */

const { z } = require('zod');
const { createQueryValidator } = require('./validationHelper');

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of operations allowed in a single bulk request. */
const MAX_BULK_OPERATIONS = 25;

/** Minimum allowed `limit` query param for paginated GET requests. */
const GET_METRICS_LIMIT_MIN = 1;

/** Maximum allowed `limit` query param for paginated GET requests. */
const GET_METRICS_LIMIT_MAX = 100;

// ── Request schemas ──────────────────────────────────────────────────────────

/**
 * Query-parameter schema for `GET /api/sme/metrics`.
 *
 * Both `cursor` and `limit` are optional.
 *  - `cursor` — opaque pagination cursor; non-empty when present.
 *  - `limit`  — coerced from raw query string to an integer clamped 1–100.
 *               Non-numeric or absent values yield `undefined` (no error).
 *
 * Unknown query parameters are stripped via `.strip()`.
 *
 * @type {z.ZodObject}
 */
const getMetricsQuerySchema = z
  .object({
    cursor: z
      .string()
      .trim()
      .min(1, { message: 'cursor must not be empty when provided' })
      .optional(),
    limit: z
      .string()
      .optional()
      .transform((val) => {
        if (val === undefined) { return undefined; }
        const parsed = parseInt(val, 10);
        if (isNaN(parsed)) { return undefined; }
        return Math.min(Math.max(parsed, GET_METRICS_LIMIT_MIN), GET_METRICS_LIMIT_MAX);
      })
      .pipe(
        z
          .number()
          .int()
          .min(GET_METRICS_LIMIT_MIN)
          .max(GET_METRICS_LIMIT_MAX)
          .optional()
      ),
  })
  .strip();

/**
 * Single operation within a bulk metrics request.
 *
 * @type {z.ZodObject<{tenantId: z.ZodString, userId: z.ZodString}>}
 */
const bulkMetricsOperationSchema = z
  .object({
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
  })
  .strict();

/**
 * Bulk metrics request body schema.
 *
 * @type {z.ZodObject<{operations: z.ZodArray}>}
 */
const bulkMetricsSchema = z
  .object({
    operations: z
      .array(bulkMetricsOperationSchema, {
        message: `operations must be a non-empty array with at most ${MAX_BULK_OPERATIONS} items`,
      })
      .min(1, { message: 'operations must contain at least one item' })
      .max(MAX_BULK_OPERATIONS, {
        message: `operations must not exceed ${MAX_BULK_OPERATIONS} items`,
      }),
  })
  .strict();

// ── Response schemas ─────────────────────────────────────────────────────────

/**
 * Schema for the aggregated invoice-count block.
 * All four counts are non-negative integers.
 *
 * @type {z.ZodObject}
 */
const smeMetricsDataSchema = z.object({
  open: z.number().int().min(0, { message: 'open must be a non-negative integer' }),
  funded: z.number().int().min(0, { message: 'funded must be a non-negative integer' }),
  settled: z.number().int().min(0, { message: 'settled must be a non-negative integer' }),
  defaulted: z.number().int().min(0, { message: 'defaulted must be a non-negative integer' }),
});

/**
 * Mandatory meta fields always present in a metrics response.
 *
 * @type {z.ZodObject}
 */
const smeMetricsMetaBaseSchema = z.object({
  timestamp: z
    .string()
    .datetime({ message: 'meta.timestamp must be an ISO-8601 datetime string' }),
  version: z.string().min(1, { message: 'meta.version must not be empty' }),
});

/**
 * Full meta schema including optional pagination fields.
 *
 * @type {z.ZodObject}
 */
const smeMetricsMetaSchema = smeMetricsMetaBaseSchema.extend({
  invoices: z.array(z.record(z.unknown())).optional(),
  total: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
});

/**
 * Top-level API response envelope for `GET /api/sme/metrics`.
 *
 * @type {z.ZodObject}
 */
const smeMetricsApiResponseSchema = z.object({
  data: smeMetricsDataSchema,
  meta: smeMetricsMetaSchema,
  error: z.record(z.unknown()).nullable(),
  timestamp: z
    .string()
    .datetime({ message: 'response timestamp must be an ISO-8601 datetime string' }),
});

/**
 * Schema for a single result item inside the bulk metrics response.
 *
 * @type {z.ZodObject}
 */
const bulkMetricsResultItemSchema = z.object({
  tenantId: z.string(),
  userId: z.string(),
  status: z.enum(['success', 'error']),
  data: smeMetricsDataSchema.nullable(),
  error: z.string().nullable(),
});

/**
 * Full response envelope for `POST /api/sme/metrics/bulk`.
 *
 * @type {z.ZodObject}
 */
const bulkMetricsResponseSchema = z.object({
  results: z.array(bulkMetricsResultItemSchema),
  meta: z.object({
    total: z.number().int().min(0),
    succeeded: z.number().int().min(0),
    failed: z.number().int().min(0),
    timestamp: z
      .string()
      .datetime({ message: 'meta.timestamp must be an ISO-8601 datetime string' }),
  }),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses a Zod ZodError into a field-keyed error object.
 *
 * Returns `{ [fieldPath]: string[] }` for backward compatibility with the
 * existing bulk-body middleware contract that tests exercise.
 *
 * @param {z.ZodError} zodError
 * @returns {Object<string, string[]>}
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

// ── Middleware ───────────────────────────────────────────────────────────────

/**
 * Express middleware that validates `req.query` for `GET /api/sme/metrics`.
 *
 * On success, attaches parsed/coerced value to `req.validatedQuery`.
 * On failure, returns a 400 RFC 7807 Problem Details response.
 *
 * @type {import('express').RequestHandler}
 */
const validateGetMetricsQuery = createQueryValidator(getMetricsQuerySchema, {
  title: 'Invalid Query Parameters',
  detail: 'One or more query parameters are invalid.',
});

/**
 * Express middleware that validates `req.body` against `bulkMetricsSchema`.
 *
 * On success, attaches parsed value to `req.validated`.
 * On failure, returns a 400 RFC 7807 Problem Details response.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
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

// ── Response validation helpers ───────────────────────────────────────────────

/**
 * Validates an SME metrics API response against the declared schema.
 *
 * @param {unknown} value
 * @returns {{ success: true, data: object } | { success: false, error: z.ZodError }}
 */
function validateSmeMetricsApiResponse(value) {
  return smeMetricsApiResponseSchema.safeParse(value);
}

/**
 * Validates a bulk metrics response against the declared schema.
 *
 * @param {unknown} value
 * @returns {{ success: true, data: object } | { success: false, error: z.ZodError }}
 */
function validateBulkMetricsResponse(value) {
  return bulkMetricsResponseSchema.safeParse(value);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Request schemas
  getMetricsQuerySchema,
  bulkMetricsSchema,
  bulkMetricsOperationSchema,

  // Response schemas
  smeMetricsDataSchema,
  smeMetricsMetaBaseSchema,
  smeMetricsMetaSchema,
  smeMetricsApiResponseSchema,
  bulkMetricsResultItemSchema,
  bulkMetricsResponseSchema,

  // Middleware
  validateGetMetricsQuery,
  validateBulkMetricsBody,

  // Response validation helpers
  validateSmeMetricsApiResponse,
  validateBulkMetricsResponse,

  // Utilities / constants
  parseValidationErrors,
  MAX_BULK_OPERATIONS,
  GET_METRICS_LIMIT_MIN,
  GET_METRICS_LIMIT_MAX,
};
