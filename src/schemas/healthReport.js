'use strict';

/**
 * @fileoverview Zod schemas for health report write endpoint validation.
 *
 * Exposes:
 *  - `healthReportSchema` — strict schema for POST /api/health/reports
 *
 * @module schemas/healthReport
 */

const { z } = require('zod');
const { parseValidationErrors } = require('./invoice');

/** Valid health status values accepted in reports. */
const VALID_HEALTH_STATUSES = ['healthy', 'degraded', 'unhealthy'];

/**
 * Strict Zod schema for a health report POST body.
 *
 * Security:
 *  - `.strict()` rejects unknown keys.
 *  - `serviceName` is bounded to prevent oversized inputs.
 *  - `status` is allowlisted.
 *  - `reportedAt` must be a valid ISO 8601 timestamp when provided.
 *
 * @type {import('zod').ZodObject}
 */
const healthReportSchema = z
  .object({
    /** Name of the service reporting health status (1–255 chars). */
    serviceName: z
      .string({ invalid_type_error: 'serviceName must be a string', required_error: 'serviceName is required' })
      .min(1, { message: 'serviceName must be a non-empty string' })
      .max(255, { message: 'serviceName must not exceed 255 characters' })
      .transform((v) => v.trim()),

    /** Health status of the reporting service. */
    status: z.enum(VALID_HEALTH_STATUSES, {
      errorMap: () => ({
        message: `status must be one of: ${VALID_HEALTH_STATUSES.join(', ')}`,
      }),
    }),

    /** Optional human-readable description (max 1000 chars). */
    message: z
      .string({ invalid_type_error: 'message must be a string' })
      .max(1000, { message: 'message must not exceed 1000 characters' })
      .optional(),

    /** Optional key-value metadata (arbitrary JSON object, max 10 keys). */
    metadata: z
      .record(z.unknown())
      .refine((obj) => Object.keys(obj).length <= 10, {
        message: 'metadata must not exceed 10 keys',
      })
      .optional(),

    /** Optional ISO 8601 timestamp when the health status was observed. */
    reportedAt: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), {
        message: 'reportedAt must be a valid ISO 8601 timestamp',
      })
      .optional(),
  })
  .strict();

module.exports = {
  healthReportSchema,
  parseValidationErrors,
  VALID_HEALTH_STATUSES,
};
