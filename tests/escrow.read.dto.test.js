'use strict';

/**
 * @fileoverview Unit tests for escrow-read DTO schemas and mapping functions.
 *
 * Covers:
 *  - Request param validation (happy path + invalid inputs)
 *  - Response DTO mapping (round-trip: service state → DTO → validated)
 *  - Edge cases: optional fields, nullish values, malformed data
 *  - Attestation DTO mapping
 *  - Token metadata DTO mapping
 *  - Error response DTO validation
 */

const {
  escrowReadParamsSchema,
  escrowStateDtoSchema,
  escrowStateWithAttestationsDtoSchema,
  escrowReadResponseDtoSchema,
  escrowReadWithAttestationsResponseDtoSchema,
  tokenMetadataDtoSchema,
  attestationEntryDtoSchema,
  derivedFieldsDtoSchema,
  ESCROW_STATUSES,
  LEGAL_HOLD_STATUSES,
  LEGAL_HOLD_UNKNOWN_REASONS,
  ESCROW_SOURCES,
  mapToEscrowStateDto,
  mapToEscrowStateWithAttestationsDto,
  mapToEscrowReadResponseDto,
  mapToEscrowReadWithAttestationsResponseDto,
  validateEscrowReadParams,
} = require('../src/schemas/escrowRead');

describe('escrowRead DTO schemas', () => {
  // ── Request Param Validation ───────────────────────────────────────────────

  describe('escrowReadParamsSchema', () => {
    it('accepts a valid invoiceId', () => {
      const result = escrowReadParamsSchema.safeParse({ invoiceId: 'inv_123' });
      expect(result.success).toBe(true);
      expect(result.data.invoiceId).toBe('inv_123');
    });

    it('accepts invoiceId with dots, colons, hyphens, underscores', () => {
      const validIds = [
        'inv-123',
        'inv_123',
        'inv.123',
        'inv:123',
        'INV-001:ABC',
        'a',
        'A1',
      ];
      for (const id of validIds) {
        const result = escrowReadParamsSchema.safeParse({ invoiceId: id });
        expect(result.success).toBe(true);
      }
    });

    it('rejects empty invoiceId', () => {
      const result = escrowReadParamsSchema.safeParse({ invoiceId: '' });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].path).toEqual(['invoiceId']);
    });

    it('rejects invoiceId with spaces', () => {
      const result = escrowReadParamsSchema.safeParse({ invoiceId: 'inv 123' });
      expect(result.success).toBe(false);
    });

    it('rejects invoiceId starting with special char', () => {
      const result = escrowReadParamsSchema.safeParse({ invoiceId: '-inv123' });
      expect(result.success).toBe(false);
    });

    it('rejects invoiceId > 128 chars', () => {
      const longId = 'a'.repeat(129);
      const result = escrowReadParamsSchema.safeParse({ invoiceId: longId });
      expect(result.success).toBe(false);
    });

    it('rejects unknown extra fields (strict)', () => {
      const result = escrowReadParamsSchema.safeParse({ invoiceId: 'inv_123', extra: 'field' });
      expect(result.success).toBe(false);
    });
  });

  describe('validateEscrowReadParams', () => {
    it('returns success with parsed data', () => {
      const result = validateEscrowReadParams({ invoiceId: 'inv_123' });
      expect(result.success).toBe(true);
      expect(result.data.invoiceId).toBe('inv_123');
    });

    it('returns fieldErrors on invalid input', () => {
      const result = validateEscrowReadParams({ invoiceId: '' });
      expect(result.success).toBe(false);
      expect(result.fieldErrors.invoiceId).toBeDefined();
    });
  });

  // ── Token Metadata DTO ──────────────────────────────────────────────────────

  describe('tokenMetadataDtoSchema', () => {
    it('accepts null', () => {
      const result = tokenMetadataDtoSchema.safeParse(null);
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });

    it('accepts full metadata', () => {
      const result = tokenMetadataDtoSchema.safeParse({
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        assetType: 'contract',
      });
      expect(result.success).toBe(true);
    });

    it('accepts partial metadata (all optional)', () => {
      const result = tokenMetadataDtoSchema.safeParse({ symbol: 'XLM' });
      expect(result.success).toBe(true);
    });

    it('rejects unknown fields (strict)', () => {
      const result = tokenMetadataDtoSchema.safeParse({ symbol: 'USDC', unknown: 'field' });
      expect(result.success).toBe(false);
    });

    it('rejects decimals out of range', () => {
      const result = tokenMetadataDtoSchema.safeParse({ decimals: 39 });
      expect(result.success).toBe(false);
    });

    it('rejects invalid assetType', () => {
      const result = tokenMetadataDtoSchema.safeParse({ assetType: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  // ── Attestation Entry DTO ──────────────────────────────────────────────────

  describe('attestationEntryDtoSchema', () => {
    it('accepts valid attestation entry', () => {
      const result = attestationEntryDtoSchema.safeParse({
        index: 0,
        digest: 'deadbeef',
      });
      expect(result.success).toBe(true);
    });

    it('accepts uppercase hex digest', () => {
      const result = attestationEntryDtoSchema.safeParse({
        index: 1,
        digest: 'DEADBEEF',
      });
      expect(result.success).toBe(true);
    });

    it('rejects negative index', () => {
      const result = attestationEntryDtoSchema.safeParse({
        index: -1,
        digest: 'deadbeef',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-hex digest', () => {
      const result = attestationEntryDtoSchema.safeParse({
        index: 0,
        digest: 'zzzzzzzz',
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown fields (strict)', () => {
      const result = attestationEntryDtoSchema.safeParse({
        index: 0,
        digest: 'deadbeef',
        extra: 'field',
      });
      expect(result.success).toBe(false);
    });
  });

  // ── Core Escrow State DTO ──────────────────────────────────────────────────

  describe('escrowStateDtoSchema', () => {
    const minimalState = {
      invoiceId: 'inv_123',
      status: 'funded',
      fundedAmount: 5000,
      legal_hold: false,
      legalHoldStatus: 'not_held',
      funding_token: null,
    };

    it('accepts minimal valid state', () => {
      const result = escrowStateDtoSchema.safeParse(minimalState);
      expect(result.success).toBe(true);
    });

    it('accepts all optional fields when present', () => {
      const fullState = {
        ...minimalState,
        legalHoldReason: 'rpc_error',
        legalHoldErrorCode: 'ETIMEDOUT',
        latest_ledger_sequence: 12345,
        latest_event_type: 'funded',
        latest_event_id: 'evt_1',
        latest_paging_token: 'token_1',
        latest_observed_at: '2024-01-01T00:00:00.000Z',
        fromProjection: true,
        source: 'projection',
        ledgerCloseTime: 1704067200,
      };
      const result = escrowStateDtoSchema.safeParse(fullState);
      expect(result.success).toBe(true);
    });

    it('accepts all valid ESCROW_STATUSES', () => {
      for (const status of ESCROW_STATUSES) {
        const result = escrowStateDtoSchema.safeParse({ ...minimalState, status });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid status', () => {
      const result = escrowStateDtoSchema.safeParse({ ...minimalState, status: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('accepts all valid LEGAL_HOLD_STATUSES', () => {
      for (const status of LEGAL_HOLD_STATUSES) {
        const result = escrowStateDtoSchema.safeParse({ ...minimalState, legalHoldStatus: status });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid legalHoldStatus', () => {
      const result = escrowStateDtoSchema.safeParse({ ...minimalState, legalHoldStatus: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('accepts all valid LEGAL_HOLD_UNKNOWN_REASONS', () => {
      for (const reason of LEGAL_HOLD_UNKNOWN_REASONS) {
        const result = escrowStateDtoSchema.safeParse({
          ...minimalState,
          legalHoldStatus: 'unknown',
          legalHoldReason: reason,
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid legalHoldReason', () => {
      const result = escrowStateDtoSchema.safeParse({
        ...minimalState,
        legalHoldStatus: 'unknown',
        legalHoldReason: 'invalid_reason',
      });
      expect(result.success).toBe(false);
    });

    it('accepts all valid ESCROW_SOURCES', () => {
      for (const source of ESCROW_SOURCES) {
        const result = escrowStateDtoSchema.safeParse({ ...minimalState, source });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid source', () => {
      const result = escrowStateDtoSchema.safeParse({ ...minimalState, source: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('rejects negative fundedAmount', () => {
      const result = escrowStateDtoSchema.safeParse({ ...minimalState, fundedAmount: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects non-finite fundedAmount', () => {
      const result = escrowStateDtoSchema.safeParse({ ...minimalState, fundedAmount: NaN });
      expect(result.success).toBe(false);
    });

    it('rejects unknown fields (strict)', () => {
      const result = escrowStateDtoSchema.safeParse({ ...minimalState, unknown: 'field' });
      expect(result.success).toBe(false);
    });
  });

  // ── Escrow State with Attestations DTO ──────────────────────────────────────

  describe('escrowStateWithAttestationsDtoSchema', () => {
    const baseState = {
      invoiceId: 'inv_123',
      status: 'funded',
      fundedAmount: 5000,
      legal_hold: false,
      legalHoldStatus: 'not_held',
      funding_token: null,
    };

    it('extends base state with attestations array', () => {
      const stateWithAttestations = {
        ...baseState,
        attestations: [
          { index: 0, digest: 'deadbeef' },
          { index: 1, digest: 'cafebabe' },
        ],
      };
      const result = escrowStateWithAttestationsDtoSchema.safeParse(stateWithAttestations);
      expect(result.success).toBe(true);
      expect(result.data.attestations).toHaveLength(2);
    });

    it('defaults attestations to empty array', () => {
      const result = escrowStateWithAttestationsDtoSchema.safeParse(baseState);
      expect(result.success).toBe(true);
      expect(result.data.attestations).toEqual([]);
    });

    it('rejects invalid attestation entry', () => {
      const stateWithAttestations = {
        ...baseState,
        attestations: [{ index: 0, digest: 'not-hex' }],
      };
      const result = escrowStateWithAttestationsDtoSchema.safeParse(stateWithAttestations);
      expect(result.success).toBe(false);
    });
  });

  // ── Derived Fields DTO ──────────────────────────────────────────────────────

  describe('derivedFieldsDtoSchema', () => {
    it('accepts all nullable fields', () => {
      const result = derivedFieldsDtoSchema.safeParse({
        apyPercent: 8.5,
        fundedPercent: 50.0,
        daysToMaturity: 30,
      });
      expect(result.success).toBe(true);
    });

    it('accepts null values', () => {
      const result = derivedFieldsDtoSchema.safeParse({
        apyPercent: null,
        fundedPercent: null,
        daysToMaturity: null,
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-integer daysToMaturity', () => {
      const result = derivedFieldsDtoSchema.safeParse({
        apyPercent: 8.5,
        fundedPercent: 50.0,
        daysToMaturity: 30.5,
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown fields (strict)', () => {
      const result = derivedFieldsDtoSchema.safeParse({
        apyPercent: 8.5,
        fundedPercent: 50.0,
        daysToMaturity: 30,
        extra: 'field',
      });
      expect(result.success).toBe(false);
    });
  });

  // ── Full Escrow Read Response DTO ──────────────────────────────────────────

  describe('escrowReadResponseDtoSchema', () => {
    const minimalResponse = {
      invoiceId: 'inv_123',
      status: 'funded',
      fundedAmount: 5000,
      legal_hold: false,
      legalHoldStatus: 'not_held',
      funding_token: null,
      escrowAddress: 'C_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      apyPercent: null,
      fundedPercent: null,
      daysToMaturity: null,
    };

    it('accepts minimal valid response', () => {
      const result = escrowReadResponseDtoSchema.safeParse(minimalResponse);
      expect(result.success).toBe(true);
    });

    it('accepts full response with all optional fields', () => {
      const fullResponse = {
        ...minimalResponse,
        legalHoldReason: 'rpc_error',
        legalHoldErrorCode: 'ETIMEDOUT',
        latest_ledger_sequence: 12345,
        latest_event_type: 'funded',
        latest_event_id: 'evt_1',
        latest_paging_token: 'token_1',
        latest_observed_at: '2024-01-01T00:00:00.000Z',
        fromProjection: true,
        source: 'projection',
        ledgerCloseTime: 1704067200,
        apyPercent: 8.5,
        fundedPercent: 50.0,
        daysToMaturity: 30,
      };
      const result = escrowReadResponseDtoSchema.safeParse(fullResponse);
      expect(result.success).toBe(true);
    });

    it('rejects invalid escrowAddress format', () => {
      const result = escrowReadResponseDtoSchema.safeParse({
        ...minimalResponse,
        escrowAddress: 'G_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Not a contract address
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown fields (strict)', () => {
      const result = escrowReadResponseDtoSchema.safeParse({
        ...minimalResponse,
        unknown: 'field',
      });
      expect(result.success).toBe(false);
    });
  });

  // ── Full Escrow Read Response with Attestations DTO ────────────────────────

  describe('escrowReadWithAttestationsResponseDtoSchema', () => {
    const minimalResponse = {
      invoiceId: 'inv_123',
      status: 'funded',
      fundedAmount: 5000,
      legal_hold: false,
      legalHoldStatus: 'not_held',
      funding_token: null,
      escrowAddress: 'C_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      apyPercent: null,
      fundedPercent: null,
      daysToMaturity: null,
      attestations: [],
    };

    it('accepts minimal valid response with empty attestations', () => {
      const result = escrowReadWithAttestationsResponseDtoSchema.safeParse(minimalResponse);
      expect(result.success).toBe(true);
    });

    it('accepts response with attestations', () => {
      const fullResponse = {
        ...minimalResponse,
        attestations: [
          { index: 0, digest: 'deadbeef' },
          { index: 1, digest: 'cafebabe' },
        ],
      };
      const result = escrowReadWithAttestationsResponseDtoSchema.safeParse(fullResponse);
      expect(result.success).toBe(true);
    });
  });
});

// ── Mapping Function Tests ───────────────────────────────────────────────────

describe('escrowRead mapping functions', () => {
  const baseInternalState = {
    invoiceId: 'inv_123',
    status: 'funded',
    fundedAmount: 5000,
    legal_hold: false,
    legalHoldStatus: 'not_held',
    latest_ledger_sequence: 12345,
    latest_event_type: 'funded',
    latest_event_id: 'evt_1',
    latest_paging_token: 'token_1',
    latest_observed_at: '2024-01-01T00:00:00.000Z',
    fromProjection: true,
    source: 'projection',
    ledgerCloseTime: 1704067200,
    funding_token: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      assetType: 'contract',
    },
  };

  describe('mapToEscrowStateDto', () => {
    it('maps minimal internal state to DTO', () => {
      const minimalState = {
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 5000,
        legal_hold: false,
        legalHoldStatus: 'not_held',
        funding_token: null,
      };
      const dto = mapToEscrowStateDto(minimalState);
      expect(dto.invoiceId).toBe('inv_123');
      expect(dto.status).toBe('funded');
      expect(dto.fundedAmount).toBe(5000);
      expect(dto.legal_hold).toBe(false);
      expect(dto.legalHoldStatus).toBe('not_held');
      expect(dto.funding_token).toBeNull();
    });

    it('maps all optional fields when present', () => {
      const dto = mapToEscrowStateDto(baseInternalState);
      expect(dto.legalHoldReason).toBeUndefined();
      expect(dto.latest_ledger_sequence).toBe(12345);
      expect(dto.latest_event_type).toBe('funded');
      expect(dto.fromProjection).toBe(true);
      expect(dto.source).toBe('projection');
      expect(dto.ledgerCloseTime).toBe(1704067200);
      expect(dto.funding_token).toEqual({
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        assetType: 'contract',
      });
    });

    it('includes legalHoldReason when present', () => {
      const state = { ...baseInternalState, legalHoldReason: 'rpc_error', legalHoldErrorCode: 'ETIMEDOUT' };
      const dto = mapToEscrowStateDto(state);
      expect(dto.legalHoldReason).toBe('rpc_error');
      expect(dto.legalHoldErrorCode).toBe('ETIMEDOUT');
    });

    it('handles nullish values gracefully', () => {
      const state = {
        ...baseInternalState,
        latest_ledger_sequence: null,
        latest_event_type: null,
        ledgerCloseTime: undefined,
        funding_token: undefined,
      };
      const dto = mapToEscrowStateDto(state);
      expect(dto.latest_ledger_sequence).toBeNull();
      expect(dto.latest_event_type).toBeNull();
      expect(dto.ledgerCloseTime).toBeUndefined();
      expect(dto.funding_token).toBeNull();
    });

    it('coerces fundedAmount to 0 when NaN', () => {
      const state = { ...baseInternalState, fundedAmount: NaN };
      const dto = mapToEscrowStateDto(state);
      expect(dto.fundedAmount).toBe(0);
    });

    it('round-trips through schema validation', () => {
      const dto = mapToEscrowStateDto(baseInternalState);
      const result = require('../src/schemas/escrowRead').escrowStateDtoSchema.safeParse(dto);
      expect(result.success).toBe(true);
    });
  });

  describe('mapToEscrowStateWithAttestationsDto', () => {
    it('maps attestations array', () => {
      const state = {
        ...baseInternalState,
        attestations: [
          { index: 0, digest: 'deadbeef' },
          { index: 1, digest: 'cafebabe' },
        ],
      };
      const dto = mapToEscrowStateWithAttestationsDto(state);
      expect(dto.attestations).toHaveLength(2);
      expect(dto.attestations[0].index).toBe(0);
      expect(dto.attestations[0].digest).toBe('deadbeef');
      expect(dto.attestations[1].digest).toBe('cafebabe');
    });

    it('handles empty attestations', () => {
      const state = { ...baseInternalState, attestations: [] };
      const dto = mapToEscrowStateWithAttestationsDto(state);
      expect(dto.attestations).toEqual([]);
    });

    it('handles missing attestations', () => {
      const dto = mapToEscrowStateWithAttestationsDto(baseInternalState);
      expect(dto.attestations).toEqual([]);
    });

    it('round-trips through schema validation', () => {
      const state = {
        ...baseInternalState,
        attestations: [{ index: 0, digest: 'deadbeef' }],
      };
      const dto = mapToEscrowStateWithAttestationsDto(state);
      const result = require('../src/schemas/escrowRead').escrowStateWithAttestationsDtoSchema.safeParse(dto);
      expect(result.success).toBe(true);
    });
  });

  describe('mapToEscrowReadResponseDto', () => {
    const derived = {
      apyPercent: 8.5,
      fundedPercent: 50.0,
      daysToMaturity: 30,
    };
    // Valid Stellar contract address: C_ + 55 Crockford base32 chars (A-Z, 2-7)
    const escrowAddress = 'C_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    it('maps state + derived + address to response DTO', () => {
      const dto = mapToEscrowReadResponseDto({
        state: baseInternalState,
        derived,
        escrowAddress,
        fromProjection: true,
      });
      expect(dto.escrowAddress).toBe(escrowAddress);
      expect(dto.apyPercent).toBe(8.5);
      expect(dto.fundedPercent).toBe(50.0);
      expect(dto.daysToMaturity).toBe(30);
      expect(dto.fromProjection).toBe(true);
    });

    it('handles null derived fields', () => {
      const dto = mapToEscrowReadResponseDto({
        state: baseInternalState,
        derived: { apyPercent: null, fundedPercent: null, daysToMaturity: null },
        escrowAddress,
      });
      expect(dto.apyPercent).toBeNull();
      expect(dto.fundedPercent).toBeNull();
      expect(dto.daysToMaturity).toBeNull();
    });

    it('round-trips through schema validation', () => {
      const dto = mapToEscrowReadResponseDto({
        state: baseInternalState,
        derived,
        escrowAddress,
      });
      const result = require('../src/schemas/escrowRead').escrowReadResponseDtoSchema.safeParse(dto);
      expect(result.success).toBe(true);
    });
  });

  describe('mapToEscrowReadWithAttestationsResponseDto', () => {
    const derived = { apyPercent: 8.5, fundedPercent: 50.0, daysToMaturity: 30 };
    const escrowAddress = 'C_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    it('maps state with attestations + derived + address to response DTO', () => {
      const state = {
        ...baseInternalState,
        attestations: [{ index: 0, digest: 'deadbeef' }],
      };
      const dto = mapToEscrowReadWithAttestationsResponseDto({
        state,
        derived,
        escrowAddress,
      });
      expect(dto.attestations).toHaveLength(1);
      expect(dto.escrowAddress).toBe(escrowAddress);
    });

    it('round-trips through schema validation', () => {
      const state = {
        ...baseInternalState,
        attestations: [{ index: 0, digest: 'deadbeef' }],
      };
      const dto = mapToEscrowReadWithAttestationsResponseDto({ state, derived, escrowAddress });
      const result = require('../src/schemas/escrowRead').escrowReadWithAttestationsResponseDtoSchema.safeParse(dto);
      expect(result.success).toBe(true);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles legal_hold boolean true correctly', () => {
      const state = { ...baseInternalState, legal_hold: true, legalHoldStatus: 'held' };
      const dto = mapToEscrowStateDto(state);
      expect(dto.legal_hold).toBe(true);
      expect(dto.legalHoldStatus).toBe('held');
    });

    it('handles legal_hold unknown status correctly', () => {
      const state = { ...baseInternalState, legal_hold: true, legalHoldStatus: 'unknown' };
      const dto = mapToEscrowStateDto(state);
      expect(dto.legal_hold).toBe(true);
      expect(dto.legalHoldStatus).toBe('unknown');
    });

    it('handles not_found status with zero fundedAmount', () => {
      const state = {
        ...baseInternalState,
        status: 'not_found',
        fundedAmount: 0,
        latest_ledger_sequence: null,
        latest_event_type: null,
      };
      const dto = mapToEscrowStateDto(state);
      expect(dto.status).toBe('not_found');
      expect(dto.fundedAmount).toBe(0);
    });

    it('handles missing funding_token gracefully', () => {
      const state = { ...baseInternalState, funding_token: undefined };
      const dto = mapToEscrowStateDto(state);
      expect(dto.funding_token).toBeNull();
    });

    it('handles funding_token with missing optional fields', () => {
      const state = { ...baseInternalState, funding_token: { symbol: 'XLM' } };
      const dto = mapToEscrowStateDto(state);
      expect(dto.funding_token).toEqual({
        symbol: 'XLM',
        name: undefined,
        decimals: undefined,
        assetType: undefined,
      });
    });

    it('handles ledgerCloseTime as number and undefined', () => {
      let state = { ...baseInternalState, ledgerCloseTime: 1704067200 };
      let dto = mapToEscrowStateDto(state);
      expect(dto.ledgerCloseTime).toBe(1704067200);

      state = { ...baseInternalState, ledgerCloseTime: undefined };
      dto = mapToEscrowStateDto(state);
      expect(dto.ledgerCloseTime).toBeUndefined();
    });

    it('defaults legalHoldStatus to unknown when missing', () => {
      const state = { ...baseInternalState, legalHoldStatus: undefined };
      const dto = mapToEscrowStateDto(state);
      expect(dto.legalHoldStatus).toBe('unknown');
    });

    it('defaults legalHoldStatus to unknown when null', () => {
      const state = { ...baseInternalState, legalHoldStatus: null };
      const dto = mapToEscrowStateDto(state);
      expect(dto.legalHoldStatus).toBe('unknown');
    });
  });

  describe('mapToEscrowStateWithAttestationsDto edge cases', () => {
    it('handles missing attestations array', () => {
      const dto = mapToEscrowStateWithAttestationsDto(baseInternalState);
      expect(dto.attestations).toEqual([]);
    });

    it('handles attestations with valid hex digest', () => {
      const state = { ...baseInternalState, attestations: [{ index: 0, digest: 'deadbeef' }] };
      const dto = mapToEscrowStateWithAttestationsDto(state);
      expect(dto.attestations[0].digest).toBe('deadbeef');
    });
  });

  describe('mapToEscrowReadWithAttestationsResponseDto edge cases', () => {
    const derived = { apyPercent: 8.5, fundedPercent: 50.0, daysToMaturity: 30 };
    const escrowAddress = 'C_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    it('maps state with attestations + derived + address to response DTO', () => {
      const state = {
        ...baseInternalState,
        attestations: [{ index: 0, digest: 'deadbeef' }],
      };
      const dto = mapToEscrowReadWithAttestationsResponseDto({ state, derived, escrowAddress });
      expect(dto.attestations).toHaveLength(1);
      expect(dto.escrowAddress).toBe(escrowAddress);
      expect(dto.apyPercent).toBe(8.5);
      expect(dto.fundedPercent).toBe(50.0);
      expect(dto.daysToMaturity).toBe(30);
    });

    it('handles null derived fields', () => {
      const state = { ...baseInternalState, attestations: [] };
      const dto = mapToEscrowReadWithAttestationsResponseDto({
        state,
        derived: { apyPercent: null, fundedPercent: null, daysToMaturity: null },
        escrowAddress,
      });
      expect(dto.apyPercent).toBeNull();
      expect(dto.fundedPercent).toBeNull();
      expect(dto.daysToMaturity).toBeNull();
    });

    it('handles undefined derived', () => {
      const state = { ...baseInternalState, attestations: [] };
      const dto = mapToEscrowReadWithAttestationsResponseDto({ state, derived: undefined, escrowAddress });
      expect(dto.apyPercent).toBeNull();
      expect(dto.fundedPercent).toBeNull();
      expect(dto.daysToMaturity).toBeNull();
    });
  });

  describe('validateEscrowReadParams edge cases', () => {
    it('returns fieldErrors when validation fails', () => {
      const result = validateEscrowReadParams({ invoiceId: '' });
      expect(result.success).toBe(false);
      expect(result.fieldErrors.invoiceId).toBeDefined();
    });

    it('returns fieldErrors for invalid invoiceId format', () => {
      const result = validateEscrowReadParams({ invoiceId: 'invalid@id' });
      expect(result.success).toBe(false);
      expect(result.fieldErrors.invoiceId).toBeDefined();
    });

    it('returns fieldErrors for extra fields', () => {
      const result = validateEscrowReadParams({ invoiceId: 'inv_123', extra: 'field' });
      expect(result.success).toBe(false);
      expect(result.fieldErrors._root).toBeDefined();
    });
  });
});