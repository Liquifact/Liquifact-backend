'use strict';

/**
 * @fileoverview Zod schemas for API key entry validation.
 *
 * Provides strict schema validation for API key create/update payloads
 * with length bounds, type checks, and unknown field rejection.
 *
 * Exposes:
 *  - `apiKeyCreateSchema`  — strict create schema
 *  - `apiKeyUpdateSchema`  — partial update schema
 *  - `validateApiKeyBody`   — Express middleware factory for request body validation
 *  - `parseValidationErrors` — Zod ZodError → field-keyed object
 *
 * @module schemas/apiKeys
 */

const { z } = require('zod');
const config = require('../config/apiKeys');

// ── Constants (sourced from config for single source of truth) ───────────────

const {
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES_COUNT,
  VALID_SCOPES,
} = config;

const KEY_STATUSES = ['active', 'retiring', 'revoked'];

// ── Shared primitives ────────────────────────────────────────────────────────

/**
 * Validates an API key string: trimmed, non-empty, starts with `lf_`,
 * within length bounds.
 *
 * Transform is applied **first** so that all subsequent `.refine()`
 * checks operate on the already-trimmed value.
 *
 * @type {import('zod').ZodEffects<import('zod').ZodString>}
 */
const keySchema = z
  .string({ invalid_type_error: 'key must be a string', required_error: 'key is required' })
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, { message: 'key must be a non-empty string' })
  .refine((v) => v.length <= MAX_KEY_LENGTH, { message: `key must not exceed ${MAX_KEY_LENGTH} characters` })
  .refine((v) => v.startsWith(API_KEY_PREFIX), {
    message: `key must start with "${API_KEY_PREFIX}"`,
  })
  .refine((v) => v.length >= MIN_KEY_LENGTH, {
    message: `key must be at least ${MIN_KEY_LENGTH} characters long`,
  });

/**
 * Validates a client ID: trimmed, non-empty, within length bounds.
 *
 * @type {import('zod').ZodEffects<import('zod').ZodString>}
 */
const clientIdSchema = z
  .string({ invalid_type_error: 'clientId must be a string', required_error: 'clientId is required' })
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, { message: 'clientId must be a non-empty string' })
  .refine((v) => v.length <= MAX_CLIENT_ID_LENGTH, { message: `clientId must not exceed ${MAX_CLIENT_ID_LENGTH} characters` });

/**
 * Validates the scopes array: non-empty, each scope must be a known value,
 * bounded in count.
 *
 * @type {import('zod').ZodArray<import('zod').ZodString>}
 */
const scopesSchema = z
  .array(
    z.string({ invalid_type_error: 'each scope must be a string' }),
    { invalid_type_error: 'scopes must be an array', required_error: 'scopes is required' }
  )
  .min(1, { message: 'scopes must be a non-empty array' })
  .max(MAX_SCOPES_COUNT, { message: `scopes must not exceed ${MAX_SCOPES_COUNT} entries` })
  .refine(
    (scopes) => scopes.every((s) => VALID_SCOPES.includes(s)),
    { message: `scopes must only contain: ${VALID_SCOPES.join(', ')}` }
  );

// ── Shared lifecycle schemas ──────────────────────────────────────────────────

/**
 * Validates key lifecycle status.
 */
const statusSchema = z.enum(KEY_STATUSES, {
  invalid_type_error: `status must be one of: ${KEY_STATUSES.join(', ')}`,
});

/**
 * Validates ISO 8601 date-time strings for key activation/expiry.
 */
const dateSchema = z
  .string({ invalid_type_error: 'must be a string' })
  .datetime({ offset: true, message: 'must be a valid ISO 8601 date-time' });

// ── Create schema ────────────────────────────────────────────────────────────

/**
 * Zod schema for API key creation payloads.
 *
 * Security guarantees:
 *  - `.strict()` rejects unknown keys.
 *  - String length bounds prevent oversized inputs.
 *  - `key` must start with `lf_` and meet minimum length.
 *  - `scopes` is bounded in count and allowlisted.
 *  - `revoked` must be boolean when present.
 *
 * @type {import('zod').ZodObject}
 */
const apiKeyCreateSchema = z
  .object({
    /** The raw API key string (must start with `lf_`). */
    key: keySchema,

    /** Unique identifier for the service client. */
    clientId: clientIdSchema,

    /** Permissions granted to this key. */
    scopes: scopesSchema,

    /** When `true` the key is rejected at auth time. Optional, defaults to false. */
    revoked: z
      .boolean({ invalid_type_error: 'revoked must be a boolean' })
      .optional(),

    /** Lifecycle status of the key. Optional; defaults to 'active'. */
    status: statusSchema.optional(),

    /** ISO timestamp when the key becomes active. Optional. */
    activatedAt: dateSchema.optional(),

    /** ISO timestamp when the key expires. Optional. */
    expiresAt: dateSchema.optional(),
  })
  .strict();

// ── Update schema ────────────────────────────────────────────────────────────

/**
 * Zod schema for partial API key update payloads.
 * All fields optional; unknown keys still rejected.
 *
 * @type {import('zod').ZodObject}
 */
const apiKeyUpdateSchema = z
  .object({
    key: keySchema.optional(),

    clientId: clientIdSchema.optional(),

    scopes: scopesSchema.optional(),

    revoked: z
      .boolean({ invalid_type_error: 'revoked must be a boolean' })
      .optional(),

    /** Lifecycle status of the key. Optional; defaults to 'active'. */
    status: statusSchema.optional(),

    /** ISO timestamp when the key becomes active. Optional. */
    activatedAt: dateSchema.optional(),

    /** ISO timestamp when the key expires. Optional. */
    expiresAt: dateSchema.optional(),
  })
  .strict();

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

/**
 * Creates Express middleware that validates `req.body` against a Zod schema
 * and maps errors to a structured 400 response with a machine-readable
 * error code.
 *
 * On success, attaches the parsed (and transformed) value to `req.validatedApiKey`.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
function validateApiKeyBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (result.success) {
      req.validatedApiKey = result.data;
      return next();
    }

    const fieldErrors = parseValidationErrors(result.error);

    return res.status(400).json({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Request body contains invalid or missing fields.',
      code: 'API_KEY_VALIDATION_ERROR',
      instance: req.originalUrl,
      fieldErrors,
    });
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  apiKeyCreateSchema,
  apiKeyUpdateSchema,
  validateApiKeyBody,
  parseValidationErrors,
  // Re-export constants from config for convenience
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES_COUNT,
  VALID_SCOPES,
};
