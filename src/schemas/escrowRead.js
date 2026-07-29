'use strict';

/**
 * @fileoverview Zod schemas and DTO mappers for escrow-read.
 *
 * Contains:
 *  - Admin config schemas (POST / PUT / GET /audit)
 *  - Request param validation schema (`escrowReadParamsSchema`)
 *  - DTO schemas for escrow state, attestations, derived fields, full responses
 *  - Pure mapping functions that convert internal service objects → DTOs
 *  - Constants for valid statuses, sources, and legal-hold values
 *
 * Keeping the mappers pure (no side effects, no I/O) means they can be
 * exhaustively unit-tested in isolation from Express / Knex / Soroban
 * concerns, and gives us a typed boundary for safer refactors.
 *
 * @module schemas/escrowRead
 */

const { z } = require('zod');
const { parseValidationErrors } = require('./invoice');

// ── Shared Primitives ────────────────────────────────────────────────────────

const escrowReadConfigSchema = z.object({
  cacheTtl: z.number({ invalid_type_error: 'cacheTtl must be a number' })
    .int({ message: 'cacheTtl must be an integer' })
    .positive({ message: 'cacheTtl must be a positive number' })
    .max(31536000, { message: 'cacheTtl must not exceed 1 year (31536000 seconds)' }),
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

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * Valid on-chain escrow statuses.
 * @constant {ReadonlyArray<string>}
 */
const ESCROW_STATUSES = Object.freeze([
  'not_found',
  'pending',
  'funded',
  'settled',
  'funded_invoice',
  'settled_invoice',
  'disputed',
  'unknown',
]);

/**
 * Valid legal-hold tri-state values. Issue #424.
 * @constant {ReadonlyArray<string>}
 */
const LEGAL_HOLD_STATUSES = Object.freeze(['held', 'not_held', 'unknown']);

/**
 * Known reasons the legal-hold read may return `unknown`.
 * @constant {ReadonlyArray<string>}
 */
const LEGAL_HOLD_UNKNOWN_REASONS = Object.freeze(['rpc_error', 'adapter_error']);

/**
 * Valid escrow state sources.
 * @constant {ReadonlyArray<string>}
 */
const ESCROW_SOURCES = Object.freeze(['projection', 'rpc_stub', 'live_read', 'adapter', 'cache']);

// ── Request Param Schemas ──────────────────────────────────────────────────────

/**
 * Schema for `GET /api/escrow/:invoiceId` and `GET /v1/escrow/:invoiceId` params.
 *
 * Invoice ID requirements:
 *  - Non-empty string
 *  - Starts with alphanumeric
 *  - Contains only alphanumeric, underscore, hyphen, dot, colon
 *  - Max 128 characters
 */
const escrowReadParamsSchema = z.object({
  invoiceId: z
    .string({ required_error: 'invoiceId is required' })
    .min(1, { message: 'invoiceId must not be empty' })
    .max(128, { message: 'invoiceId must not exceed 128 characters' })
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, {
      message:
        'invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ - . :)',
    }),
}).strict();

/**
 * Validates escrow-read request parameters.
 *
 * @param {unknown} params - Raw request params (e.g. `req.params`).
 * @returns {{ success: true, data: { invoiceId: string } } | { success: false, fieldErrors: Record<string, string> }}
 */
function validateEscrowReadParams(params) {
  const result = escrowReadParamsSchema.safeParse(params);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    fieldErrors: parseValidationErrors(result.error),
  };
}

// ── Token Metadata DTO Schema ──────────────────────────────────────────────────

const tokenMetadataDtoSchema = z
  .object({
    symbol: z.string().optional(),
    name: z.string().optional(),
    decimals: z
      .number()
      .int({ message: 'decimals must be an integer' })
      .min(0, { message: 'decimals must be non-negative' })
      .max(18, { message: 'decimals must not exceed 18' })
      .optional(),
    assetType: z
      .enum(['contract', 'native', 'credit_alphanum4', 'credit_alphanum12'], {
        message: 'assetType must be a valid Stellar asset type',
      })
      .optional(),
  })
  .strict()
  .nullable();

// ── Attestation Entry DTO Schema ───────────────────────────────────────────────

const attestationEntryDtoSchema = z
  .object({
    index: z
      .number()
      .int({ message: 'index must be an integer' })
      .nonnegative({ message: 'index must be non-negative' }),
    digest: z
      .string()
      .regex(/^[0-9a-fA-F]+$/, { message: 'digest must be a hex string' }),
  })
  .strict();

// ── Derived Fields DTO Schema ──────────────────────────────────────────────────

const derivedFieldsDtoSchema = z
  .object({
    apyPercent: z.number().nullable(),
    fundedPercent: z.number().nullable(),
    daysToMaturity: z
      .number()
      .int({ message: 'daysToMaturity must be an integer' })
      .nullable(),
  })
  .strict();

// ── Escrow State DTO Schema ────────────────────────────────────────────────────

const escrowStateDtoSchema = z
  .object({
    invoiceId: z.string(),
    status: z.enum(ESCROW_STATUSES, {
      message: 'status must be a valid escrow status',
    }),
    fundedAmount: z
      .number()
      .nonnegative({ message: 'fundedAmount must be non-negative' }),
    legal_hold: z.boolean(),
    legalHoldStatus: z.enum(LEGAL_HOLD_STATUSES, {
      message: 'legalHoldStatus must be a valid legal-hold status',
    }),
    legalHoldReason: z
      .enum(LEGAL_HOLD_UNKNOWN_REASONS, {
        message: 'legalHoldReason must be a valid unknown reason',
      })
      .optional(),
    legalHoldErrorCode: z.string().optional(),
    latest_ledger_sequence: z.number().int().nullable().optional(),
    latest_event_type: z.string().nullable().optional(),
    latest_event_id: z.string().optional(),
    latest_paging_token: z.string().optional(),
    latest_observed_at: z.string().optional(),
    fromProjection: z.boolean().optional(),
    source: z
      .enum(ESCROW_SOURCES, { message: 'source must be a valid escrow source' })
      .optional(),
    ledgerCloseTime: z.number().int().optional(),
    funding_token: tokenMetadataDtoSchema,
  })
  .strict();

// ── Escrow State with Attestations DTO Schema ──────────────────────────────────

const escrowStateWithAttestationsDtoSchema = escrowStateDtoSchema.extend({
  attestations: z.array(attestationEntryDtoSchema).default([]),
}).strict();

// ── Full Escrow Read Response DTO Schema ───────────────────────────────────────

const escrowReadResponseDtoSchema = escrowStateDtoSchema.extend({
  escrowAddress: z
    .string()
    .min(5, { message: 'escrowAddress must be at least 5 characters' })
    .refine((val) => val.startsWith('C'), {
      message: 'escrowAddress must be a valid Stellar contract address (C-prefixed)',
    }),
  apyPercent: z.number().nullable(),
  fundedPercent: z.number().nullable(),
  daysToMaturity: z.number().int().nullable(),
}).strict();

// ── Full Escrow Read with Attestations Response DTO Schema ─────────────────────

const escrowReadWithAttestationsResponseDtoSchema =
  escrowReadResponseDtoSchema.extend({
    attestations: z.array(attestationEntryDtoSchema).default([]),
  }).strict();

// ── Mapping Functions ──────────────────────────────────────────────────────────

/**
 * Maps internal escrow state to a DTO for API responses.
 *
 * @param {object} state - Internal escrow state object from the service layer.
 * @returns {object} DTO-safe escrow state object.
 */
function mapToEscrowStateDto(state) {
  const fundedAmount =
    typeof state.fundedAmount === 'number' && Number.isFinite(state.fundedAmount)
      ? state.fundedAmount
      : 0;

  const dto = {
    invoiceId: state.invoiceId,
    status: state.status,
    fundedAmount,
    legal_hold: state.legal_hold === true,
    legalHoldStatus: state.legalHoldStatus || 'unknown',
    funding_token: state.funding_token || null,
  };

  if (state.legalHoldReason) {
    dto.legalHoldReason = state.legalHoldReason;
  }
  if (state.legalHoldErrorCode) {
    dto.legalHoldErrorCode = state.legalHoldErrorCode;
  }
  if (state.latest_ledger_sequence !== undefined) {
    dto.latest_ledger_sequence = state.latest_ledger_sequence;
  }
  if (state.latest_event_type !== undefined) {
    dto.latest_event_type = state.latest_event_type;
  }
  if (state.latest_event_id) {
    dto.latest_event_id = state.latest_event_id;
  }
  if (state.latest_paging_token) {
    dto.latest_paging_token = state.latest_paging_token;
  }
  if (state.latest_observed_at) {
    dto.latest_observed_at = state.latest_observed_at;
  }
  if (state.fromProjection !== undefined) {
    dto.fromProjection = state.fromProjection;
  }
  if (state.source) {
    dto.source = state.source;
  }
  if (state.ledgerCloseTime !== undefined) {
    dto.ledgerCloseTime = state.ledgerCloseTime;
  }

  return dto;
}

/**
 * Maps internal escrow state with attestations to a DTO.
 *
 * @param {object} state - Internal escrow state with optional `attestations`.
 * @returns {object} DTO-safe escrow state with attestations.
 */
function mapToEscrowStateWithAttestationsDto(state) {
  return {
    ...mapToEscrowStateDto(state),
    attestations: Array.isArray(state.attestations) ? state.attestations : [],
  };
}

/**
 * Maps internal escrow state + derived fields + address to a full response DTO.
 *
 * @param {object} args
 * @param {object} args.state - Internal escrow state.
 * @param {object} args.derived - Derived fields (apyPercent, fundedPercent, daysToMaturity).
 * @param {string} args.escrowAddress - Resolved escrow contract address.
 * @param {boolean} [args.fromProjection] - Whether the state came from a projection.
 * @returns {object} Full response DTO.
 */
function mapToEscrowReadResponseDto({ state, derived, escrowAddress, fromProjection }) {
  const base = mapToEscrowStateDto(state);

  const derivedSafe = derived && typeof derived === 'object' ? derived : {};
  const apyPercent =
    typeof derivedSafe.apyPercent === 'number' ? derivedSafe.apyPercent : null;
  const fundedPercent =
    typeof derivedSafe.fundedPercent === 'number'
      ? derivedSafe.fundedPercent
      : null;
  const daysToMaturity =
    typeof derivedSafe.daysToMaturity === 'number'
      ? derivedSafe.daysToMaturity
      : null;

  return {
    ...base,
    escrowAddress,
    apyPercent,
    fundedPercent,
    daysToMaturity,
    fromProjection:
      fromProjection !== undefined ? fromProjection : base.fromProjection,
  };
}

/**
 * Maps internal escrow state with attestations + derived fields + address
 * to a full response DTO.
 *
 * @param {object} args
 * @param {object} args.state - Internal escrow state with optional `attestations`.
 * @param {object} [args.derived] - Derived fields.
 * @param {string} args.escrowAddress - Resolved escrow contract address.
 * @returns {object} Full response DTO with attestations.
 */
function mapToEscrowReadWithAttestationsResponseDto({ state, derived, escrowAddress }) {
  return {
    ...mapToEscrowReadResponseDto({ state, derived, escrowAddress }),
    attestations: Array.isArray(state.attestations) ? state.attestations : [],
  };
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  // Admin config schemas
  escrowReadPostSchema,
  escrowReadPutSchema,
  escrowReadAuditQuerySchema,
  escrowReadResponseSchema,
  parseValidationErrors,

  // Constants
  ESCROW_STATUSES,
  LEGAL_HOLD_STATUSES,
  LEGAL_HOLD_UNKNOWN_REASONS,
  ESCROW_SOURCES,

  // Request param schemas
  escrowReadParamsSchema,
  validateEscrowReadParams,

  // DTO schemas
  tokenMetadataDtoSchema,
  attestationEntryDtoSchema,
  derivedFieldsDtoSchema,
  escrowStateDtoSchema,
  escrowStateWithAttestationsDtoSchema,
  escrowReadResponseDtoSchema,
  escrowReadWithAttestationsResponseDtoSchema,

  // Mappers
  mapToEscrowStateDto,
  mapToEscrowStateWithAttestationsDto,
  mapToEscrowReadResponseDto,
  mapToEscrowReadWithAttestationsResponseDto,
};
