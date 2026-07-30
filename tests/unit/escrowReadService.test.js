'use strict';

/**
 * @fileoverview Unit tests for src/services/escrowReadService.js
 *
 * These tests mock all external dependencies (escrowMap, escrowRead,
 * escrowBatchRead, escrowDerived) so the service's orchestration logic
 * is tested in isolation.
 *
 * Coverage:
 *  - getEscrowRead: success, 400 on invalid ID, 404 on unmapped, 500 on
 *    service error, edge cases (empty string, whitespace, special chars)
 *  - getEscrowReadBatch: success, mixed results, all unmapped, empty input,
 *    partial failures
 */

const { resolveEscrowAddress } = require('../../src/config/escrowMap');
const { readEscrowState } = require('../../src/services/escrowRead');
const { batchReadEscrowStates } = require('../../src/services/escrowBatchRead');
const { computeEscrowDerivedFields } = require('../../src/services/escrowDerived');

jest.mock('../../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn(),
}));

jest.mock('../../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
}));

jest.mock('../../src/services/escrowBatchRead', () => ({
  batchReadEscrowStates: jest.fn(),
}));

jest.mock('../../src/services/escrowDerived', () => ({
  computeEscrowDerivedFields: jest.fn(),
}));

const { getEscrowRead, getEscrowReadBatch } = require('../../src/services/escrowReadService');

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockEscrowState(overrides = {}) {
  return {
    invoiceId: 'INV-001',
    status: 'funded',
    fundedAmount: 5000,
    legal_hold: false,
    legalHoldStatus: 'not_held',
    funding_token: null,
    fromProjection: true,
    latest_event_type: 'funded',
    ...overrides,
  };
}

function mockDerived(overrides = {}) {
  return {
    apyPercent: 8.5,
    fundedPercent: 50.0,
    daysToMaturity: 30,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('getEscrowRead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a success envelope with DTO for a valid invoice', async () => {
    const state = mockEscrowState();
    const derived = mockDerived();
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    readEscrowState.mockResolvedValue(state);
    computeEscrowDerivedFields.mockReturnValue(derived);

    const result = await getEscrowRead('INV-001');

    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    expect(result.code).toBeNull();
    expect(result.escrowAddress).toBe('C_MOCK_ADDRESS');
    expect(result.invoiceId).toBe('INV-001');
    expect(result.result).toBeDefined();
    expect(result.result.escrowAddress).toBe('C_MOCK_ADDRESS');
    expect(result.result.apyPercent).toBe(8.5);
    expect(result.result.status).toBe('funded');
    expect(result.result.fromProjection).toBe(true);

    expect(computeEscrowDerivedFields).toHaveBeenCalledWith(state, {
      ledgerCloseTime: undefined,
    });
  });

  it('returns 400 for an empty invoiceId', async () => {
    const result = await getEscrowRead('');
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('Invalid invoiceId');
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.result).toBeNull();
  });

  it('returns 400 for an invoiceId with only whitespace', async () => {
    const result = await getEscrowRead('   ');
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('Invalid invoiceId');
    expect(result.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for an invoiceId with invalid characters', async () => {
    const result = await getEscrowRead('inv@lid!');
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('Invalid invoiceId');
    expect(result.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for an invoiceId exceeding 128 characters', async () => {
    const result = await getEscrowRead('a'.repeat(129));
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('Invalid invoiceId');
    expect(result.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when the invoice has no escrow mapping', async () => {
    resolveEscrowAddress.mockReturnValue(null);

    const result = await getEscrowRead('unknown-inv');

    expect(result.statusCode).toBe(404);
    expect(result.error).toContain('No escrow contract mapping found');
    expect(result.code).toBe('NOT_FOUND');
    expect(result.result).toBeNull();
    expect(result.escrowAddress).toBeNull();
  });

  it('returns 500 when readEscrowState throws', async () => {
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    readEscrowState.mockRejectedValue(new Error('Soroban RPC timeout'));

    const result = await getEscrowRead('INV-001');

    expect(result.statusCode).toBe(500);
    expect(result.error).toContain('Soroban RPC timeout');
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.result).toBeNull();
    expect(result.escrowAddress).toBe('C_MOCK_ADDRESS');
  });

  it('preserves HTTP status from thrown error object', async () => {
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    const err = new Error('Invalid invoice');
    err.status = 400;
    err.code = 'INVALID_INVOICE_ID';
    readEscrowState.mockRejectedValue(err);

    const result = await getEscrowRead('INV-001');

    expect(result.statusCode).toBe(400);
    expect(result.code).toBe('INVALID_INVOICE_ID');
  });

  it('strips whitespace from invoiceId before validation', async () => {
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    readEscrowState.mockResolvedValue(mockEscrowState());
    computeEscrowDerivedFields.mockReturnValue(mockDerived());

    const result = await getEscrowRead('  INV-001  ');
    expect(result.statusCode).toBe(200);
    expect(result.invoiceId).toBe('INV-001');
  });

  it('passes readOptions through to readEscrowState', async () => {
    const readOptions = { fundingAsset: 'USDC', dbClient: 'mock' };
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    readEscrowState.mockResolvedValue(mockEscrowState());
    computeEscrowDerivedFields.mockReturnValue(mockDerived());

    await getEscrowRead('INV-001', { readOptions });

    expect(readEscrowState).toHaveBeenCalledWith('INV-001', readOptions);
  });

  it('computes derived with ledgerCloseTime when state has it', async () => {
    const state = mockEscrowState({ ledgerCloseTime: 1704067200 });
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    readEscrowState.mockResolvedValue(state);
    computeEscrowDerivedFields.mockReturnValue(mockDerived());

    await getEscrowRead('INV-001');

    expect(computeEscrowDerivedFields).toHaveBeenCalledWith(state, {
      ledgerCloseTime: 1704067200,
    });
  });

  it('returns fromProjection based on state', async () => {
    const state = mockEscrowState({ fromProjection: false });
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    readEscrowState.mockResolvedValue(state);
    computeEscrowDerivedFields.mockReturnValue(mockDerived());

    const result = await getEscrowRead('INV-001');
    expect(result.result.fromProjection).toBe(false);
  });

  it('returns 500 when readEscrowState returns null', async () => {
    resolveEscrowAddress.mockReturnValue('C_MOCK_ADDRESS');
    readEscrowState.mockResolvedValue(null);

    const result = await getEscrowRead('INV-001');
    expect(result.statusCode).toBe(500);
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.result).toBeNull();
  });
});

describe('getEscrowReadBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns results for all mapped invoices', async () => {
    resolveEscrowAddress.mockImplementation((id) => {
      if (id === 'INV-001') return 'C_ADDR_001';
      if (id === 'INV-002') return 'C_ADDR_002';
      return null;
    });
    batchReadEscrowStates.mockResolvedValue({
      results: [
        mockEscrowState({ invoiceId: 'INV-001' }),
        mockEscrowState({ invoiceId: 'INV-002' }),
      ],
      errors: [],
    });
    computeEscrowDerivedFields
      .mockReturnValueOnce(mockDerived({ apyPercent: 8.0 }))
      .mockReturnValueOnce(mockDerived({ apyPercent: 9.0 }));

    const { results, errors, statusCode } = await getEscrowReadBatch(['INV-001', 'INV-002']);

    expect(statusCode).toBe(200);
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(results[0].result.escrowAddress).toBe('C_ADDR_001');
    expect(results[1].result.escrowAddress).toBe('C_ADDR_002');
    expect(results[0].result.apyPercent).toBe(8.0);
    expect(results[1].result.apyPercent).toBe(9.0);
  });

  it('reports unmapped invoices as per-item errors', async () => {
    resolveEscrowAddress.mockImplementation((id) => {
      if (id === 'INV-001') return 'C_ADDR_001';
      return null;
    });
    batchReadEscrowStates.mockResolvedValue({
      results: [mockEscrowState({ invoiceId: 'INV-001' })],
      errors: [],
    });
    computeEscrowDerivedFields.mockReturnValue(mockDerived());

    const { results, errors, statusCode } = await getEscrowReadBatch(['INV-001', 'INV-002', 'INV-003']);

    expect(statusCode).toBe(200);
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors[0].invoiceId).toBe('INV-002');
    expect(errors[0].error).toContain('No escrow contract mapping found');
    expect(errors[0].code).toBe('NOT_FOUND');
    expect(errors[1].invoiceId).toBe('INV-003');
  });

  it('returns empty results for empty input', async () => {
    const { results, errors, statusCode } = await getEscrowReadBatch([]);
    expect(statusCode).toBe(200);
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('returns empty results for non-array input', async () => {
    const { results, errors } = await getEscrowReadBatch(null);
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('returns empty results when all invoices are unmapped', async () => {
    resolveEscrowAddress.mockReturnValue(null);

    const { results, errors, statusCode } = await getEscrowReadBatch(['INV-001', 'INV-002']);
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(statusCode).toBe(200);
  });

  it('merges batch-read errors with address-resolution errors', async () => {
    resolveEscrowAddress.mockImplementation((id) => {
      if (id === 'INV-001') return 'C_ADDR_001';
      if (id === 'INV-002') return 'C_ADDR_002';
      return null;
    });
    batchReadEscrowStates.mockResolvedValue({
      results: [mockEscrowState({ invoiceId: 'INV-001' })],
      errors: [{ invoiceId: 'INV-002', error: 'On-chain timeout', code: 'ETIMEDOUT' }],
    });
    computeEscrowDerivedFields.mockReturnValue(mockDerived());

    const { results, errors, statusCode } = await getEscrowReadBatch(['INV-001', 'INV-002', 'INV-003']);

    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(2);
    // Address-resolution error
    expect(errors[0].invoiceId).toBe('INV-003');
    expect(errors[0].code).toBe('NOT_FOUND');
    // Batch-read error
    expect(errors[1].invoiceId).toBe('INV-002');
    expect(errors[1].code).toBe('ETIMEDOUT');
  });

  it('strips whitespace from invoice IDs', async () => {
    resolveEscrowAddress.mockImplementation((id) => {
      if (id === 'INV-001') return 'C_ADDR_001';
      return null;
    });
    batchReadEscrowStates.mockResolvedValue({ results: [], errors: [] });

    const { results, errors } = await getEscrowReadBatch(['  INV-001  ', '  INV-002  ']);
    expect(resolveEscrowAddress).toHaveBeenCalledWith('INV-001');
    expect(resolveEscrowAddress).toHaveBeenCalledWith('INV-002');
  });

  it('passes readOptions to batchReadEscrowStates', async () => {
    resolveEscrowAddress.mockReturnValue('C_ADDR');
    batchReadEscrowStates.mockResolvedValue({ results: [], errors: [] });

    await getEscrowReadBatch(['INV-001'], { readOptions: { fundingAsset: 'USDC' } });

    expect(batchReadEscrowStates).toHaveBeenCalledWith(['INV-001'], {
      readOptions: { fundingAsset: 'USDC' },
    });
  });

  it('handles a single valid invoice ID correctly', async () => {
    resolveEscrowAddress.mockReturnValue('C_ADDR_001');
    batchReadEscrowStates.mockResolvedValue({
      results: [mockEscrowState({ invoiceId: 'INV-001' })],
      errors: [],
    });
    computeEscrowDerivedFields.mockReturnValue(mockDerived());

    const { results, errors } = await getEscrowReadBatch(['INV-001']);
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(results[0].result.escrowAddress).toBe('C_ADDR_001');
  });
});
