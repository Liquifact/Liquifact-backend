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
 * ## Input hardening
 * Every metrics write/read boundary rejects, rather than silently repairs,
 * malformed input:
 *  - unknown fields are rejected on bodies (`.strict()`) and stripped on query
 *    params (`.strip()`);
 *  - all strings are length-bounded (`tenantId`/`userId` ≤ 128, `cursor` ≤ 512);
 *  - all numbers are range-bounded (`limit` 1–100, integers only);
 *  - failures carry a machine-readable `code` plus per-field `fieldCodes` drawn
 *    from `METRICS_VALIDATION_CODES`, so clients never string-match messages.
 *
 * @module schemas/metrics
 */

const { z } = require('zod');
const { createQueryValidator } = require('./validationHelper');
const {
  METRICS_VALIDATION_CODES,
  METRICS_VALIDATION_ERROR_CODE,
  METRICS_VALIDATION_PROBLEM_TYPE,
  codeForIssue,
} = require('../constants/metricsValidationCodes');

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of operations allowed in a single bulk request. */
const MAX_BULK_OPERATIONS = 25;

/** Minimum allowed `limit` query param for paginated GET requests. */
const GET_METRICS_LIMIT_MIN = 1;

/** Maximum allowed `limit` query param for paginated GET requests. */
const GET_METRICS_LIMIT_MAX = 100;

/**
 * Maximum accepted length of the opaque `cursor` query param.
 *
 * Cursors this service issues are far shorter; the bound exists so an
 * arbitrarily long attacker-supplied string is rejected at the boundary
 * instead of being handed to the cursor decoder.
 */
const GET_METRICS_CURSOR_MAX_LENGTH = 512;

/** Maximum accepted length of `tenantId` / `userId` in a bulk operation. */
const BULK_METRICS_ID_MAX_LENGTH = 128;

// ── Request schemas ──────────────────────────────────────────────────────────

/**
 * Query-parameter schema for `GET /api/sme/metrics`.
 *
 * Both `cursor` and `limit` are optional.
 *  - `cursor` — opaque pagination cursor; non-empty and at most
 *    {@link GET_METRICS_CURSOR_MAX_LENGTH} characters when present.
 *  - `limit`  — parsed from the raw query string to an integer that must lie
 *    within 1–100 inclusive. Absent values yield `undefined` (no error).
 *
 * ### Rejected rather than coerced
 * A malformed or out-of-range `limit` is now a hard `400`. Previously
 * `limit=abc` was silently treated as absent and `limit=9999` was silently
 * clamped to 100, which meant a caller could not tell that the value they sent
 * had been discarded. Both now surface a structured error with a machine-
 * readable code so the mistake is visible at the boundary.
 *
 * Unknown query parameters are stripped via `.strip()` (they are ignored, not
 * rejected, because proxies and analytics tooling routinely append their own).
 *
 * @type {z.ZodObject}
 */
const getMetricsQuerySchema = z
  .object({
    cursor: z
      .string({ message: 'cursor must be a string' })
      .trim()
      .min(1, { message: 'cursor must not be empty when provided' })
      .max(GET_METRICS_CURSOR_MAX_LENGTH, {
        message: `cursor must not exceed ${GET_METRICS_CURSOR_MAX_LENGTH} characters`,
      })
      .optional(),
    limit: z
      .string({ message: 'limit must be a string' })
      .optional()
      .transform((val, ctx) => {
        if (val === undefined) { return undefined; }

        const trimmed = val.trim();
        // Reject anything that is not a bare, optionally-signed integer.
        // `parseInt` alone would accept '20abc' and '1e5'; `Number` would
        // accept '0x10' and ' '.
        if (!/^-?\d+$/.test(trimmed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            params: { metricsCode: METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID },
            message: `limit must be an integer between ${GET_METRICS_LIMIT_MIN} and ${GET_METRICS_LIMIT_MAX}`,
          });
          return z.NEVER;
        }

        return Number(trimmed);
      })
      .pipe(
        z
          .number()
          .int({ message: 'limit must be an integer' })
          .min(GET_METRICS_LIMIT_MIN, {
            message: `limit must be at least ${GET_METRICS_LIMIT_MIN}`,
          })
          .max(GET_METRICS_LIMIT_MAX, {
            message: `limit must not exceed ${GET_METRICS_LIMIT_MAX}`,
          })
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
      .max(BULK_METRICS_ID_MAX_LENGTH, {
        message: `tenantId must not exceed ${BULK_METRICS_ID_MAX_LENGTH} characters`,
      }),
    userId: z
      .string({ message: 'userId is required' })
      .trim()
      .min(1, { message: 'userId must not be empty' })
      .max(BULK_METRICS_ID_MAX_LENGTH, {
        message: `userId must not exceed ${BULK_METRICS_ID_MAX_LENGTH} characters`,
      }),
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

/**
 * Maps a Zod `ZodError` to a field-keyed map of machine-readable codes.
 *
 * Mirrors the shape of {@link parseValidationErrors} — same keys, same
 * ordering — but each entry holds stable {@link METRICS_VALIDATION_CODES}
 * members instead of human-readable messages, so clients can branch on the
 * failure kind without string-matching wording that is free to change.
 *
 * Unknown-key issues are additionally expanded so each offending key gets its
 * own entry (Zod reports them as one issue on the parent object, which would
 * otherwise hide *which* field was rejected).
 *
 * @param {z.ZodError} zodError
 * @returns {Object<string, string[]>}
 */
function parseValidationFieldCodes(zodError) {
  const fieldCodes = {};

  const push = (path, code) => {
    if (!fieldCodes[path]) {
      fieldCodes[path] = [];
    }
    if (!fieldCodes[path].includes(code)) {
      fieldCodes[path].push(code);
    }
  };

  for (const issue of zodError.issues) {
    const path = issue.path.join('.');
    push(path, codeForIssue(issue));

    // Surface each unrecognised key individually, e.g. `operations.0.extra`.
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      for (const key of issue.keys) {
        push(path ? `${path}.${key}` : key, METRICS_VALIDATION_CODES.UNKNOWN_FIELD);
      }
    }
  }

  return fieldCodes;
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
  code: METRICS_VALIDATION_ERROR_CODE,
});

/**
 * Express middleware that validates `req.body` against `bulkMetricsSchema`.
 *
 * On success, attaches parsed value to `req.validated`.
 * On failure, returns a 400 RFC 7807 Problem Details response.
 *
 * ### Failure response shape
 *
 * ```json
 * {
 *   "type": "https://liquifact.io/problems/validation-error",
 *   "title": "Validation Error",
 *   "status": 400,
 *   "detail": "Request body contains invalid or missing fields.",
 *   "code": "METRICS_VALIDATION_ERROR",
 *   "fieldErrors": { "operations.0.userId": ["userId is required"] },
 *   "fieldCodes": { "operations.0.userId": ["FIELD_REQUIRED"] }
 * }
 * ```
 *
 * `code` and `fieldCodes` are additive: `type`, `title`, `status`, `detail` and
 * `fieldErrors` keep their previous values and shapes, so existing clients are
 * unaffected.
 *
 * A non-object body (`null`, an array, a bare string — reachable when a client
 * sends `Content-Type: application/json` with a scalar payload) is rejected
 * here rather than propagating an untyped value into the handler.
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
  const fieldCodes = parseValidationFieldCodes(result.error);

  return res.status(400).json({
    type: METRICS_VALIDATION_PROBLEM_TYPE,
    title: 'Validation Error',
    status: 400,
    detail: 'Request body contains invalid or missing fields.',
    code: METRICS_VALIDATION_ERROR_CODE,
    fieldErrors,
    fieldCodes,
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
  parseValidationFieldCodes,
  MAX_BULK_OPERATIONS,
  GET_METRICS_LIMIT_MIN,
  GET_METRICS_LIMIT_MAX,
  GET_METRICS_CURSOR_MAX_LENGTH,
  BULK_METRICS_ID_MAX_LENGTH,

  // Error-code taxonomy (re-exported for convenience)
  METRICS_VALIDATION_CODES,
  METRICS_VALIDATION_ERROR_CODE,
  METRICS_VALIDATION_PROBLEM_TYPE,
};
