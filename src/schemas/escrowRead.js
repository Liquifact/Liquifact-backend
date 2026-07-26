'use strict';

/**
 * @fileoverview Zod schemas for escrow-read request/response DTOs.
 *
 * Defines typed boundary contracts for the escrow-read surface:
 *  - Request validation for GET /api/escrow/:invoiceId and GET /v1/escrow/:invoiceId
 *  - Response DTOs that map from internal service shapes to stable API shapes
 *  - Mapping functions for round-trip conversion (service ↔ DTO)
 *
 * No new runtime dependencies; uses existing zod.
 *
 * @module schemas/escrowRead
 */

const { z } = require('zod');

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Valid escrow status values from the on-chain contract.
 * @type {readonly string[]}
 */
const ESCROW_STATUSES = Object.freeze([
  'not_found',
  'pending',
  'funded',
  'settled',
  'expired',
  'disputed',
  'unknown',
]);

/**
 * Legal hold tri-state values.
 * @type {readonly string[]}
 */
const LEGAL_HOLD_STATUSES = Object.freeze(['held', 'not_held', 'unknown']);

/**
 * Legal hold unknown reasons.
 * @type {readonly string[]}
 */
const LEGAL_HOLD_UNKNOWN_REASONS = Object.freeze(['rpc_error', 'adapter_error', 'service_unavailable']);

/**
 * Source of escrow state data.
 * @type {readonly string[]}
 */
const ESCROW_SOURCES = Object.freeze(['projection', 'rpc_stub', 'cache', 'live_read']);

// ── Request DTOs ──────────────────────────────────────────────────────────────

/**
 * Query parameters for escrow read (currently none, but schema exists for future extensibility).
 * @type {import('zod').ZodObject}
 */
const escrowReadQuerySchema = z.object({}).strict();

/**
 * Params schema for :invoiceId path parameter.
 * @type {import('zod').ZodObject}
 */
const escrowReadParamsSchema = z.object({
  invoiceId: z
    .string()
    .min(1, { message: 'invoiceId is required' })
    .max(128, { message: 'invoiceId must not exceed 128 characters' })
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, {
      message: 'invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ - . : )',
    }),
}).strict();

// ── Response DTOs ─────────────────────────────────────────────────────────────

/**
 * Token metadata DTO (display only — never used for on-chain math).
 * @type {import('zod').ZodObject}
 */
const tokenMetadataDtoSchema = z.object({
  symbol: z.string().max(20).optional(),
  name: z.string().max(100).optional(),
  decimals: z.number().int().min(0).max(38).optional(),
  assetType: z.enum(['native', 'asset', 'contract']).optional(),
}).strict().nullable();

/**
 * Attestation entry DTO.
 * @type {import('zod').ZodObject}
 */
const attestationEntryDtoSchema = z.object({
  index: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]+$/i, { message: 'digest must be hex string' }),
}).strict();

/**
 * Core escrow state DTO (shared by both endpoints).
 * @type {import('zod').ZodObject}
 */
const escrowStateDtoSchema = z.object({
  invoiceId: z.string().min(1).max(128),
  status: z.enum(/** @type {[string, ...string[]]} */ (ESCROW_STATUSES)),
  fundedAmount: z.number().finite().nonnegative(),
  legal_hold: z.boolean(),
  legalHoldStatus: z.enum(/** @type {[string, ...string[]]} */ (LEGAL_HOLD_STATUSES)),
  legalHoldReason: z.enum(/** @type {[string, ...string[]]} */ (LEGAL_HOLD_UNKNOWN_REASONS)).optional(),
  legalHoldErrorCode: z.string().optional(),
  latest_ledger_sequence: z.number().int().nullable().optional(),
  latest_event_type: z.string().nullable().optional(),
  latest_event_id: z.string().nullable().optional(),
  latest_paging_token: z.string().nullable().optional(),
  latest_observed_at: z.string().nullable().optional(),
  fromProjection: z.boolean().optional(),
  source: z.enum(/** @type {[string, ...string[]]} */ (ESCROW_SOURCES)).optional(),
  ledgerCloseTime: z.number().int().positive().optional(),
  funding_token: tokenMetadataDtoSchema,
}).strict();

/**
 * Extended escrow state with attestations (for /v1/escrow with attestations).
 * @type {import('zod').ZodObject}
 */
const escrowStateWithAttestationsDtoSchema = escrowStateDtoSchema.extend({
  attestations: z.array(attestationEntryDtoSchema).default([]),
}).strict();

/**
 * Derived display fields DTO.
 * @type {import('zod').ZodObject}
 */
const derivedFieldsDtoSchema = z.object({
  apyPercent: z.number().nullable(),
  fundedPercent: z.number().nullable(),
  daysToMaturity: z.number().int().nullable(),
}).strict();

/**
 * Full escrow read response DTO (what the API returns in `data`).
 * @type {import('zod').ZodObject}
 */
const escrowReadResponseDtoSchema = escrowStateDtoSchema.extend({
  escrowAddress: z.string().regex(/^C_[A-Z2-7]{55}$/, { message: 'escrowAddress must be a valid Stellar contract address' }),
  apyPercent: z.number().nullable(),
  fundedPercent: z.number().nullable(),
  daysToMaturity: z.number().int().nullable(),
}).strict();

/**
 * Full escrow read response with attestations DTO.
 * @type {import('zod').ZodObject}
 */
const escrowReadWithAttestationsResponseDtoSchema = escrowStateWithAttestationsDtoSchema.extend({
  escrowAddress: z.string().regex(/^C_[A-Z2-7]{55}$/, { message: 'escrowAddress must be a valid Stellar contract address' }),
  apyPercent: z.number().nullable(),
  fundedPercent: z.number().nullable(),
  daysToMaturity: z.number().int().nullable(),
}).strict();

// ── Error DTOs ────────────────────────────────────────────────────────────────

/**
 * Standard error response DTO.
 * @type {import('zod').ZodObject}
 */
const escrowErrorResponseDtoSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).strict(),
  meta: z.object({
    version: z.string(),
    timestamp: z.string(),
  }).strict(),
}).strict();

// ── Mapping Functions ─────────────────────────────────────────────────────────

/**
 * Maps internal escrow state to core DTO.
 *
 * @param {object} state - Internal state from readEscrowState or getEscrowStateWithProjection
 * @returns {object} Validated DTO
 */
function mapToEscrowStateDto(state) {
  const dto = {
    invoiceId: state.invoiceId,
    status: state.status,
    fundedAmount: Number.isFinite(state.fundedAmount) ? state.fundedAmount : 0,
    legal_hold: state.legal_hold === true,
    legalHoldStatus: state.legalHoldStatus || 'unknown',
    latest_ledger_sequence: state.latest_ledger_sequence != null ? Number(state.latest_ledger_sequence) : null,
    latest_event_type: state.latest_event_type || null,
    latest_event_id: state.latest_event_id || null,
    latest_paging_token: state.latest_paging_token || null,
    latest_observed_at: state.latest_observed_at || null,
    fromProjection: state.fromProjection === true,
    source: state.source || 'rpc_stub',
    ledgerCloseTime: state.ledgerCloseTime != null ? Number(state.ledgerCloseTime) : undefined,
    funding_token: state.funding_token ? {
      symbol: state.funding_token.symbol,
      name: state.funding_token.name,
      decimals: state.funding_token.decimals,
      assetType: state.funding_token.assetType,
    } : null,
  };

  if (state.legalHoldReason) {
    dto.legalHoldReason = state.legalHoldReason;
  }
  if (state.legalHoldErrorCode) {
    dto.legalHoldErrorCode = state.legalHoldErrorCode;
  }

  return escrowStateDtoSchema.parse(dto);
}

/**
 * Maps internal escrow state with attestations to extended DTO.
 *
 * @param {object} state - Internal state from readEscrowStateWithAttestations
 * @returns {object} Validated DTO
 */
function mapToEscrowStateWithAttestationsDto(state) {
  const baseDto = mapToEscrowStateDto(state);
  const dto = {
    ...baseDto,
    attestations: Array.isArray(state.attestations)
      ? state.attestations.map((a) => ({
          index: Number(a.index),
          digest: String(a.digest || ''),
        }))
      : [],
  };
  return escrowStateWithAttestationsDtoSchema.parse(dto);
}

/**
 * Maps internal state + derived fields to full API response DTO.
 *
 * @param {object} options - Options object.
 * @param {object} options.state - Internal state from readEscrowState or getEscrowStateWithProjection
 * @param {object} options.derived - Derived fields from computeEscrowDerivedFields
 * @param {string} options.escrowAddress - Resolved escrow contract address
 * @returns {object} Validated response DTO
 */
function mapToEscrowReadResponseDto({ state, derived, escrowAddress }) {
  const baseDto = mapToEscrowStateDto(state);
  const dto = {
    ...baseDto,
    escrowAddress,
    apyPercent: derived?.apyPercent ?? null,
    fundedPercent: derived?.fundedPercent ?? null,
    daysToMaturity: derived?.daysToMaturity ?? null,
  };
  return escrowReadResponseDtoSchema.parse(dto);
}

/**
 * Maps internal state with attestations + derived fields to full API response DTO.
 *
 * @param {object} options - Options object.
 * @param {object} options.state - Internal state from readEscrowStateWithAttestations
 * @param {object} options.derived - Derived fields from computeEscrowDerivedFields
 * @param {string} options.escrowAddress - Resolved escrow contract address
 * @returns {object} Validated response DTO
 */
function mapToEscrowReadWithAttestationsResponseDto({ state, derived, escrowAddress }) {
  const baseDto = mapToEscrowStateWithAttestationsDto(state);
  const dto = {
    ...baseDto,
    escrowAddress,
    apyPercent: derived?.apyPercent ?? null,
    fundedPercent: derived?.fundedPercent ?? null,
    daysToMaturity: derived?.daysToMaturity ?? null,
  };
  return escrowReadWithAttestationsResponseDtoSchema.parse(dto);
}

/**
 * Validates request params for escrow read endpoints.
 *
 * @param {object} params - Express req.params
 * @returns {{ success: boolean, data?: object, fieldErrors?: Record<string, string> }}
 */
function validateEscrowReadParams(params) {
  const result = escrowReadParamsSchema.safeParse(params);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const fieldErrors = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_root';
    if (!fieldErrors[path]) {
      fieldErrors[path] = issue.message;
    }
  }
  return { success: false, fieldErrors };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Schemas
  escrowReadQuerySchema,
  escrowReadParamsSchema,
  tokenMetadataDtoSchema,
  attestationEntryDtoSchema,
  escrowStateDtoSchema,
  escrowStateWithAttestationsDtoSchema,
  derivedFieldsDtoSchema,
  escrowReadResponseDtoSchema,
  escrowReadWithAttestationsResponseDtoSchema,
  escrowErrorResponseDtoSchema,

  // Constants
  ESCROW_STATUSES,
  LEGAL_HOLD_STATUSES,
  LEGAL_HOLD_UNKNOWN_REASONS,
  ESCROW_SOURCES,

  // Mapping functions
  mapToEscrowStateDto,
  mapToEscrowStateWithAttestationsDto,
  mapToEscrowReadResponseDto,
  mapToEscrowReadWithAttestationsResponseDto,
  validateEscrowReadParams,
};