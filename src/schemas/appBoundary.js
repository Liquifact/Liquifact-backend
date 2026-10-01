'use strict';

/**
 * @fileoverview Validation schemas and middleware for the core app-level routes
 * defined directly in `src/app.js`.
 *
 * Each inline route in `createApp()` (health endpoints, /api info, invoice list/create,
 * escrow read) has its own acceptance criteria for inputs.  This module collects those
 * acceptance criteria in one auditable place so:
 *
 *   - The invariants are machine-checked by Zod rather than living in ad-hoc if-blocks.
 *   - The same structured RFC 7807 error shape is produced on every validation failure.
 *   - Boundary values (min/max lengths, allowed character sets) are documented as named
 *     constants that tests can import and probe directly.
 *
 * Exposes:
 *   - `INVOICE_ID_MAX_LENGTH`   — hard upper bound on the escrow route :invoiceId param.
 *   - `INVOICE_ID_PATTERN`      — allowed character set for the param (anchored regex).
 *   - `escrowParamsSchema`      — Zod object schema for `{ invoiceId }`.
 *   - `validateEscrowParams`    — pure validator → `{ success, data } | { success, fieldErrors }`.
 *   - `validateEscrowParamsMiddleware` — Express middleware version (400 on failure).
 *   - `apiInfoQuerySchema`      — strict empty-query schema for `GET /api`.
 *   - `validateApiInfoQuery`    — Express middleware: 400 if unknown query params present.
 *   - `rejectBodyOnGet`         — re-exported from `./health` for uniform GET-body rejection.
 *
 * @module schemas/appBoundary
 */

const { z } = require('zod');
const { parseValidationErrors, DEFAULT_PROBLEM_TYPE } = require('./validationHelper');

// ── Escrow :invoiceId param ───────────────────────────────────────────────────

/**
 * Maximum number of characters allowed in the escrow route `:invoiceId` path
 * parameter.  128 is consistent with the allowlist used by the indexer and
 * the escrow-read service.
 *
 * @constant {number}
 */
const INVOICE_ID_MAX_LENGTH = 128;

/**
 * Anchored regex for the escrow route `:invoiceId` path parameter.
 *
 * Accepts:
 *   - ASCII letters (a-z, A-Z)
 *   - ASCII digits (0-9)
 *   - Hyphen `-`, underscore `_`, dot `.`, colon `:`
 *
 * Rejects:
 *   - Leading or trailing whitespace (should be stripped before validation)
 *   - Slash `/` (path traversal)
 *   - NULL bytes, control characters, percent-encoded sequences (after URL
 *     decoding by Express), angle brackets, quotes, and any other character
 *     not in the allowlist.
 *
 * The first character must be alphanumeric so IDs beginning with `.` or `-`
 * (relative path components) are never accepted.
 *
 * @constant {RegExp}
 */
const INVOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Zod schema for the escrow route `{ invoiceId }` path-parameter object.
 *
 * Security guarantees enforced at this boundary:
 *   - `.strict()` — no extra keys can sneak through (e.g. `__proto__`).
 *   - `.min(1)` / `.max(INVOICE_ID_MAX_LENGTH)` — bounded length prevents
 *     log-stuffing and oversized database queries.
 *   - `INVOICE_ID_PATTERN` — allowlist rejects control characters, slashes,
 *     HTML metacharacters, and percent-encoded bypass attempts (Express has
 *     already decoded `req.params` before this runs).
 *
 * @type {import('zod').ZodObject}
 */
const escrowParamsSchema = z
  .object({
    invoiceId: z
      .string({ required_error: 'invoiceId is required', invalid_type_error: 'invoiceId must be a string' })
      .min(1, { message: 'invoiceId must not be empty' })
      .max(INVOICE_ID_MAX_LENGTH, {
        message: `invoiceId must not exceed ${INVOICE_ID_MAX_LENGTH} characters`,
      })
      .regex(INVOICE_ID_PATTERN, {
        message:
          'invoiceId contains invalid characters (allowed: a-z A-Z 0-9 . _ - :, must start with alphanumeric)',
      }),
  })
  .strict();

/**
 * Pure validator for the escrow `:invoiceId` path parameter.
 *
 * Returns a discriminated-union result so callers can handle both the
 * success and failure branches without exceptions:
 *
 *   - `{ success: true,  data: { invoiceId: string } }`
 *   - `{ success: false, fieldErrors: Record<string, string> }`
 *
 * @param {unknown} params - Raw object to validate (typically `req.params`).
 * @returns {{ success: true, data: { invoiceId: string } } |
 *           { success: false, fieldErrors: Record<string, string> }}
 */
function validateEscrowParams(params) {
  const result = escrowParamsSchema.safeParse(params);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, fieldErrors: parseValidationErrors(result.error) };
}

/**
 * Express middleware that validates `req.params` against `escrowParamsSchema`.
 *
 * Attaches the validated params to `req.validatedParams` on success so the
 * downstream handler uses the schema-transformed value rather than the raw
 * URL string.
 *
 * Returns a structured RFC 7807 `application/problem+json` 400 response on
 * validation failure so clients receive machine-readable field errors and can
 * distinguish invalid-format from not-found.
 *
 * @param {import('express').Request}      req  - Express request.
 * @param {import('express').Response}     res  - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function validateEscrowParamsMiddleware(req, res, next) {
  const validation = validateEscrowParams(req.params);

  if (validation.success) {
    // Attach the schema-validated (and thus safe) params to the request so
    // downstream handlers never touch the raw URL-decoded string directly.
    req.validatedParams = validation.data;
    return next();
  }

  return res.status(400).json({
    type: DEFAULT_PROBLEM_TYPE,
    title: 'Validation Error',
    status: 400,
    detail: 'Path parameter contains invalid or out-of-range values.',
    instance: req.originalUrl,
    code: 'VALIDATION_ERROR',
    fieldErrors: validation.fieldErrors,
  });
}

// ── GET /api info endpoint ────────────────────────────────────────────────────

/**
 * Zod schema for the `GET /api` query parameter object.
 *
 * The info endpoint is a read-only metadata endpoint that accepts no query
 * parameters.  Using `.strict()` here means any unknown key (e.g. `?debug=1`
 * or `?__proto__[x]=1`) is immediately rejected with a 400 that names the
 * offending key, rather than silently passing the unexpected input downstream.
 *
 * @type {import('zod').ZodObject}
 */
const apiInfoQuerySchema = z.object({}).strict();

/**
 * Express middleware that validates `req.query` for the `GET /api` info endpoint.
 *
 * Rejects requests that carry any query parameters (none are defined for this
 * route) with a structured 400 RFC 7807 response.
 *
 * This mirrors the `validateHealthQuery` pattern used on the health endpoints
 * so the whole top-level route surface is uniformly hardened.
 *
 * @param {import('express').Request}      req  - Express request.
 * @param {import('express').Response}     res  - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function validateApiInfoQuery(req, res, next) {
  const result = apiInfoQuerySchema.safeParse(req.query);

  if (!result.success) {
    const fieldErrors = parseValidationErrors(result.error);
    return res.status(400).json({
      type: DEFAULT_PROBLEM_TYPE,
      title: 'Validation Error',
      status: 400,
      detail: 'Query parameters contain invalid or unknown fields.',
      instance: req.originalUrl,
      code: 'VALIDATION_ERROR',
      fieldErrors,
    });
  }

  return next();
}

// ── Re-exports ────────────────────────────────────────────────────────────────

// Re-export the shared GET-body rejection guard so `app.js` only needs one
// import for all boundary middleware.
const { rejectBodyOnGet } = require('./health');

module.exports = {
  // Constants — importable by tests for boundary probing
  INVOICE_ID_MAX_LENGTH,
  INVOICE_ID_PATTERN,

  // Escrow param validation
  escrowParamsSchema,
  validateEscrowParams,
  validateEscrowParamsMiddleware,

  // /api info endpoint validation
  apiInfoQuerySchema,
  validateApiInfoQuery,

  // Shared GET-body guard
  rejectBodyOnGet,
};
