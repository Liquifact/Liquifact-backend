'use strict';

/**
 * @fileoverview Zod schemas for KYC webhook input validation (issue #638).
 *
 * Provides strict, bounded validation for the `POST /api/kyc/webhook` payload.
 * Rejects unknown fields, wrong types, out-of-range values, and oversized
 * strings with a structured RFC 7807 response via {@link parseValidationErrors}.
 *
 * @module schemas/kycWebhook
 */

const { z } = require('zod');

/** SME identifier: 1–128 alphanumeric, underscore, or hyphen characters. */
const SME_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Zod schema for KYC webhook payloads.
 *
 * Security guarantees:
 *  - `.strict()` rejects unknown keys, preventing prototype-polluting payloads.
 *  - String length bounds prevent oversized inputs (DoS / storage DoS).
 *  - `smeId` is enforce-matched against a safe character set (no whitespace,
 *    no control characters).
 *  - `status` is bounded to 50 chars (the longest known status is
 *    `withdrawal_pending_review` at ~26 chars → 50 gives headroom).
 *  - `recordId` is bounded to 255 chars (a UUID or provider identifier).
 *  - `verifiedAt` must be a valid ISO 8601 datetime string when present.
 *
 * @type {import('zod').ZodObject}
 */
const kycWebhookSchema = z
  .object({
    /** SME identifier (1–128 chars, alphanumeric/underscore/hyphen). */
    smeId: z
      .string({ invalid_type_error: 'smeId must be a string', required_error: 'smeId is required' })
      .min(1, { message: 'smeId must not be empty' })
      .max(128, { message: 'smeId must not exceed 128 characters' })
      .regex(SME_ID_REGEX, {
        message: 'smeId must contain only alphanumeric characters, underscores, and hyphens',
      }),

    /** Provider KYC status value (1–50 chars). */
    status: z
      .string({ invalid_type_error: 'status must be a string', required_error: 'status is required' })
      .min(1, { message: 'status must not be empty' })
      .max(50, { message: 'status must not exceed 50 characters' }),

    /** Provider record ID (optional, max 255 chars). */
    recordId: z
      .string({ invalid_type_error: 'recordId must be a string' })
      .max(255, { message: 'recordId must not exceed 255 characters' })
      .optional(),

    /** Verification timestamp from the provider (optional, ISO 8601). */
    verifiedAt: z
      .string({ invalid_type_error: 'verifiedAt must be a string' })
      .datetime({ message: 'verifiedAt must be a valid ISO 8601 date string' })
      .optional(),
  })
  .strict();

/**
 * Flattens a ZodError into a `{ [fieldPath]: firstMessage }` object.
 *
 * Reuses the same shape as {@link module:schemas/invoice#parseValidationErrors}
 * and {@link module:schemas/indexerEvent#parseValidationErrors} so all
 * `application/problem+json` 400 responses share a consistent wire format.
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

module.exports = {
  kycWebhookSchema,
  parseValidationErrors,
  SME_ID_REGEX,
};
