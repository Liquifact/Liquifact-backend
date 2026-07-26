'use strict';

/**
 * @fileoverview Zod schemas for escrow-read configurations/overrides payload validation.
 *
 * Exposes:
 *  - `escrowReadPostSchema`       — strict schema for POST /api/admin/escrow-read
 *  - `escrowReadPutSchema`        — strict schema for PUT /api/admin/escrow-read/:id
 *  - `escrowReadAuditQuerySchema` — strict schema for GET /api/admin/escrow-read/audit
 *  - `escrowReadResponseSchema`   — schema to validate outbound response shapes
 *
 * @module schemas/escrowRead
 */

const { z } = require('zod');
const { parseValidationErrors } = require('./invoice');

// ── Shared Primitives ────────────────────────────────────────────────────────

const escrowReadConfigSchema = z.object({
  cacheTtl: z.number({ invalid_type_error: 'cacheTtl must be a number' })
    .int({ message: 'cacheTtl must be an integer' })
    .positive({ message: 'cacheTtl must be a positive number' }),
}).strict();

const idSchema = z.string({ invalid_type_error: 'id must be a string' })
  .min(1, { message: 'id must be a non-empty string' })
  .max(100, { message: 'id must not exceed 100 characters' })
  .transform((v) => v.trim());

const secretKeySchema = z.string({ invalid_type_error: 'secretKey must be a string' })
  .min(1, { message: 'secretKey must be a non-empty string' })
  .max(256, { message: 'secretKey must not exceed 256 characters' })
  .transform((v) => v.trim());

// ── Request Schemas ──────────────────────────────────────────────────────────

/**
 * Schema for POST /api/admin/escrow-read
 * Requires `id`, `config`, and optionally `secretKey` (Wait, the test provides it. Let's make it optional or required based on the route implementation. In the route, `const { id, config, secretKey } = req.body; newData = { config, secretKey }`. We'll make config and secretKey optional to match standard behavior, or required if needed. The prompt says "reject invalid payloads with structured errors; behaviour otherwise unchanged". Previously there were NO checks on config/secretKey. Let's make them optional but if provided they must match the schema.)
 * Wait, let's make `id` required, and `config`/`secretKey` optional, or matching previous behavior.
 */
const escrowReadPostSchema = z.object({
  id: idSchema,
  config: escrowReadConfigSchema.optional(),
  secretKey: secretKeySchema.optional(),
}).strict();

/**
 * Schema for PUT /api/admin/escrow-read/:id
 * All fields are optional but at least one must be provided.
 */
const escrowReadPutSchema = z.object({
  config: escrowReadConfigSchema.optional(),
  secretKey: secretKeySchema.optional(),
}).strict().refine(data => data.config !== undefined || data.secretKey !== undefined, {
  message: 'At least one field (config or secretKey) must be provided for update',
});

/**
 * Schema for GET /api/admin/escrow-read/audit
 */
const escrowReadAuditQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int({ message: 'limit must be an integer' })
    .min(1, { message: 'limit must be at least 1' })
    .max(500, { message: 'limit must not exceed 500' })
    .default(100),
}).strict();

// ── Response Schemas ─────────────────────────────────────────────────────────

/**
 * Common shape for a single escrow-read item in responses.
 */
const escrowReadItemSchema = z.object({
  id: z.string(),
  config: z.object({
    cacheTtl: z.number().int().positive(),
  }).optional(),
  secretKey: z.string().optional(),
}).strict();

/**
 * Validates outgoing responses from the escrow-read routes.
 */
const escrowReadResponseSchema = z.object({
  data: z.union([
    escrowReadItemSchema,               // Single item (POST, PUT)
    z.array(escrowReadItemSchema),      // List of items (GET /)
    z.array(z.object({                  // List of audit logs (GET /audit)
      id: z.string(),
    }).passthrough()),                  // Audit logs have many fields, we just check they are objects
  ]),
}).passthrough();

module.exports = {
  escrowReadPostSchema,
  escrowReadPutSchema,
  escrowReadAuditQuerySchema,
  escrowReadResponseSchema,
  parseValidationErrors,
};
