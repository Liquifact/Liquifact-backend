/**
 * @fileoverview Attestation append log escrow tests.
 *
 * Covers:
 *  - fetchAttestationAppendLog returns array of {index, digest} with hex digests
 *  - readEscrowStateWithAttestations includes attestations in response
 *  - error handling: non-array response, RPC failures
 *  - input validation for invoiceId
 *
 * All on-chain calls are stubbed via adapter injection.
 */

'use strict';

process.env.NODE_ENV = 'test';

// Mock the logger to avoid dependency issues
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

// Stub the Knex default export with an in-memory store so we can drive the
// projection-first path without a real database. The factory is fully
// self-contained (no external references) so jest's mock-hoisting does not
// trip on TDZ variables.
jest.mock('../src/db/knex', () => {
  const rows = new Map();
  function makeBuilder(table) {
    return {
      _table: table,
      _whereId: null,
      where(field, value) {
        if (typeof field === 'string') {
          this._whereId = String(value);
        }
        return this;
      },
      async first() {
        if (table !== 'escrow_event_projection') return null;
        if (!this._whereId) return null;
        return rows.get(this._whereId) || null;
      },
      async del() { rows.clear(); return 0; },
      async insert(payload) {
        if (table !== 'escrow_event_projection') return 0;
        const entries = Array.isArray(payload) ? payload : [payload];
        entries.forEach((entry) => {
          if (entry && entry.invoice_id) rows.set(entry.invoice_id, entry);
        });
        return entries.length;
      },
    };
  }
  return jest.fn((table) => makeBuilder(table));
}, { virtual: true });

const { readEscrowStateWithAttestations, fetchAttestationAppendLog, validateInvoiceId } = require('../src/services/escrowRead');
// The mocked knex handle (see jest.mock above). Tests use it to seed/clear
// the projection table through the same code path the production read uses.
const db = require('../src/db/knex');

// ── unit: escrowRead attestation service ──────────────────────────────────────

describe('escrowRead attestation service', () => {
  beforeEach(async () => {
    // The mock factory is self-isolating: the in-memory rows map lives inside
    // the factory closure. Clear both the call history and the rows so the
    // projection state does not leak between tests.
    jest.clearAllMocks();
    await db('escrow_event_projection').del();
  });
  describe('fetchAttestationAppendLog', () => {
    it('returns array of attestation entries with hex digests', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: Buffer.from('deadbeef', 'hex') },
        { index: 1, digest: Buffer.from('cafebabe', 'hex') },
      ]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([
        { index: 0, digest: 'deadbeef' },
        { index: 1, digest: 'cafebabe' },
      ]);
      expect(mockAdapter).toHaveBeenCalledWith('inv_123');
    });

    it('handles empty array response', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([]);
    });

    it('handles non-array response by returning empty array', async () => {
      const mockAdapter = jest.fn().mockResolvedValue(null);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([]);
    });

    it('handles RPC failure by returning empty array', async () => {
      const mockAdapter = jest.fn().mockRejectedValue(new Error('RPC error'));

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result).toEqual([]);
    });

    it('converts digest to hex string', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: Buffer.from('0123456789abcdef', 'hex') },
      ]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result[0].digest).toBe('0123456789abcdef');
    });

    it('handles missing digest gracefully', async () => {
      const mockAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: null },
      ]);

      const result = await fetchAttestationAppendLog('inv_123', mockAdapter);

      expect(result[0].digest).toBe('');
    });
  });

  describe('readEscrowStateWithAttestations', () => {
    it('includes attestations in escrow state response', async () => {
      const mockEscrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1000,
      });
      const mockLegalHoldAdapter = jest.fn().mockResolvedValue(false);
      const mockAttestationAdapter = jest.fn().mockResolvedValue([
        { index: 0, digest: 'hexdigest1' },
        { index: 1, digest: 'hexdigest2' },
      ]);

      const result = await readEscrowStateWithAttestations('inv_123', {
        escrowAdapter: mockEscrowAdapter,
        legalHoldAdapter: mockLegalHoldAdapter,
        attestationAdapter: mockAttestationAdapter,
      });

      // Use toMatchObject so additional fields added by `readEscrowStateWithAttestations`
      // (e.g. `funding_token` for token-metadata enrichment, even when null) are tolerated.
      expect(result).toMatchObject({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1000,
        legal_hold: false,
        attestations: [
          { index: 0, digest: 'hexdigest1' },
          { index: 1, digest: 'hexdigest2' },
        ],
      });
      // The enrichments are best-effort and currently optional.
      expect(result.funding_token === null || typeof result.funding_token === 'object').toBe(true);
    });

    it('validates invoiceId', async () => {
      await expect(readEscrowStateWithAttestations('')).rejects.toThrow('invoiceId must not be empty');
      await expect(readEscrowStateWithAttestations('invalid@id')).rejects.toThrow('invoiceId contains invalid characters');
    });

    it('handles attestation adapter failure gracefully', async () => {
      const mockEscrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_123',
        status: 'funded',
        fundedAmount: 1000,
      });
      const mockLegalHoldAdapter = jest.fn().mockResolvedValue(false);
      const mockAttestationAdapter = jest.fn().mockRejectedValue(new Error('RPC error'));

      const result = await readEscrowStateWithAttestations('inv_123', {
        escrowAdapter: mockEscrowAdapter,
        legalHoldAdapter: mockLegalHoldAdapter,
        attestationAdapter: mockAttestationAdapter,
      });

      expect(result.attestations).toEqual([]);
    });

    it('reads base state from the projection when no adapter is injected', async () => {
      await db('escrow_event_projection').del();
      await db('escrow_event_projection').insert({
        invoice_id: 'inv_proj_att',
        latest_event_id: 'evt_p',
        latest_event_type: 'funded',
        latest_ledger_sequence: '42',
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 2500 }),
      });

      const result = await readEscrowStateWithAttestations('inv_proj_att', {
        attestationAdapter: () => Promise.resolve([]),
      });

      expect(result).toMatchObject({
        invoiceId: 'inv_proj_att',
        status: 'funded',
        fundedAmount: 2500,
        attestations: [],
        source: 'projection',
        fromProjection: true,
      });
      expect(result.latest_ledger_sequence).toBe(42);
    });

    it('falls through to the neutral RPC stub when projection is missing', async () => {
      await db('escrow_event_projection').del();
      const result = await readEscrowStateWithAttestations('inv_unknown', {
        attestationAdapter: () => Promise.resolve([]),
      });

      expect(result).toMatchObject({
        invoiceId: 'inv_unknown',
        status: 'not_found',
        fundedAmount: 0,
      });
      // The neutral stub must NOT fabricate funded/settled values.
      expect(result.fundedAmount).toBe(0);
    });
  });

  describe('validateInvoiceId', () => {
    it('accepts valid IDs', () => {
      expect(validateInvoiceId('inv_123').valid).toBe(true);
      expect(validateInvoiceId('INV-ABC-001').valid).toBe(true);
    });

    it('rejects invalid IDs', () => {
      expect(validateInvoiceId('').valid).toBe(false);
      expect(validateInvoiceId('invalid@id').valid).toBe(false);
    });
  });
});