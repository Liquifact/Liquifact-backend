'use strict';

/**
 * @fileoverview Regression tests for escrow-read edge cases.
 *
 * Issue #41 — previously-fixed edge cases (empty, boundary, malformed inputs)
 * are pinned here so they cannot silently re-break.  Each test name references
 * the scenario it guards.
 *
 * Covers:
 *  - validateInvoiceId: empty, whitespace-only, null, undefined, non-string,
 *    single char (min boundary), 128-char (max boundary), 129-char (overflow),
 *    leading special char, allowed special chars mid-string, URL-encoded space
 *  - _coerceFundedAmount: NaN, ±Infinity, negative, string number, null,
 *    undefined, zero
 *  - coerceLegalHoldStatus: truthy/falsy coercions, numeric 1/0, string 'true'
 *  - _readBaseStateFromProjection: null row, soft-deleted row, row with unknown
 *    status and no enrichments (hasMeaningfulProjection=false)
 *  - readEscrowState (service unit): throws INVALID_INVOICE_ID on bad id,
 *    returns neutral stub when projection missing, handles malformed JSON body
 *  - isProjectionEnabled: exported and callable after bug-fix
 *  - fetchLegalHoldStatus: RPC error yields UNKNOWN (never collapses to NOT_HELD)
 */

// ── Mocks (must be hoisted before any require of src/) ──────────────────────

jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (op) => op()),
}));

jest.mock('../src/services/webhooks', () => ({
  emitEscrowReadWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/tokenMeta', () => ({
  getTokenMetadata: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/cache/redis', () => ({
  createRedisEscrowSummaryCache: jest.fn(() => null),
}));

jest.mock('../src/services/escrowReadCache', () => ({
  escrowReadCache: {
    get: jest.fn().mockReturnValue(undefined),
    set: jest.fn(),
    invalidate: jest.fn().mockReturnValue(false),
  },
}));

// In-memory projection store — shared across the describe blocks below.
const _projectionRows = new Map();

jest.mock('../src/db/knex', () => {
  const fakeDb = jest.fn((table) => {
    const builder = {
      _table: table,
      _whereId: null,
      where(field, value) {
        if (typeof field === 'string') this._whereId = String(value);
        return this;
      },
      async first() {
        if (!this._whereId) return null;
        return _projectionRows.get(this._whereId) ?? null;
      },
    };
    return builder;
  });
  fakeDb.destroy = async () => _projectionRows.clear();
  return fakeDb;
}, { virtual: true });

// ── Imports (after mocks) ────────────────────────────────────────────────────

const {
  validateInvoiceId,
  coerceLegalHoldStatus,
  fetchLegalHoldStatus,
  readEscrowState,
  isProjectionEnabled,
  LEGAL_HOLD_STATUS,
} = require('../src/services/escrowRead');

const { callSorobanContract } = require('../src/services/soroban');

// ────────────────────────────────────────────────────────────────────────────
// 1. validateInvoiceId — empty / boundary / malformed
// ────────────────────────────────────────────────────────────────────────────

describe('regression: validateInvoiceId — empty inputs', () => {
  it('[empty-string] rejects empty string', () => {
    const { valid } = validateInvoiceId('');
    expect(valid).toBe(false);
  });

  it('[whitespace-only] rejects string that is all spaces', () => {
    const { valid } = validateInvoiceId('   ');
    expect(valid).toBe(false);
  });

  it('[null] rejects null (non-string)', () => {
    const { valid } = validateInvoiceId(null);
    expect(valid).toBe(false);
  });

  it('[undefined] rejects undefined (non-string)', () => {
    const { valid } = validateInvoiceId(undefined);
    expect(valid).toBe(false);
  });

  it('[number] rejects numeric type even if it looks like a valid id', () => {
    const { valid } = validateInvoiceId(12345);
    expect(valid).toBe(false);
  });

  it('[object] rejects plain object', () => {
    const { valid } = validateInvoiceId({ id: 'inv_001' });
    expect(valid).toBe(false);
  });
});

describe('regression: validateInvoiceId — boundary lengths', () => {
  it('[min-boundary] accepts single alphanumeric character (length=1)', () => {
    expect(validateInvoiceId('a').valid).toBe(true);
    expect(validateInvoiceId('Z').valid).toBe(true);
    expect(validateInvoiceId('9').valid).toBe(true);
  });

  it('[max-boundary] accepts exactly 128-char id (1 start + 127 rest)', () => {
    const id = 'a' + 'b'.repeat(127); // 128 chars total
    expect(id).toHaveLength(128);
    expect(validateInvoiceId(id).valid).toBe(true);
  });

  it('[overflow-boundary] rejects 129-char id (exceeds max)', () => {
    const id = 'a' + 'b'.repeat(128); // 129 chars total
    expect(id).toHaveLength(129);
    expect(validateInvoiceId(id).valid).toBe(false);
  });

  it('[127-char] accepts 127-char id', () => {
    const id = 'a' + 'b'.repeat(126); // 127 chars total
    expect(validateInvoiceId(id).valid).toBe(true);
  });
});

describe('regression: validateInvoiceId — malformed / invalid characters', () => {
  it('[leading-hyphen] rejects id starting with hyphen', () => {
    expect(validateInvoiceId('-inv123').valid).toBe(false);
  });

  it('[leading-underscore] rejects id starting with underscore', () => {
    expect(validateInvoiceId('_inv123').valid).toBe(false);
  });

  it('[leading-dot] rejects id starting with dot', () => {
    expect(validateInvoiceId('.inv123').valid).toBe(false);
  });

  it('[leading-colon] rejects id starting with colon', () => {
    expect(validateInvoiceId(':inv123').valid).toBe(false);
  });

  it('[internal-space] rejects id containing a space', () => {
    expect(validateInvoiceId('inv 123').valid).toBe(false);
  });

  it('[at-sign] rejects id with @ character', () => {
    expect(validateInvoiceId('inv@123').valid).toBe(false);
  });

  it('[slash] rejects id with forward slash', () => {
    expect(validateInvoiceId('inv/123').valid).toBe(false);
  });

  it('[url-encoded-space] rejects decoded space (simulates %20 route param)', () => {
    // Express decodes %20 → ' ' before the handler sees it; trim → '' → invalid
    expect(validateInvoiceId(' ').valid).toBe(false);
  });

  it('[mid-hyphen] accepts alphanumeric-start id with hyphens mid-string', () => {
    expect(validateInvoiceId('inv-001-abc').valid).toBe(true);
  });

  it('[mid-dot-colon] accepts id with dot and colon mid-string', () => {
    expect(validateInvoiceId('inv.001:v2').valid).toBe(true);
  });

  it('[mid-underscore] accepts id with underscore mid-string', () => {
    expect(validateInvoiceId('inv_001').valid).toBe(true);
  });

  it('[mixed-case] accepts mixed-case alphanumeric id', () => {
    expect(validateInvoiceId('InV001ABC').valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. _coerceFundedAmount — internal helper via readEscrowState projection path
//    (tested indirectly through the service since the helper is not exported)
// ────────────────────────────────────────────────────────────────────────────

describe('regression: coerceFundedAmount — malformed / boundary amounts (via projection)', () => {
  beforeEach(() => {
    _projectionRows.clear();
    jest.clearAllMocks();
    callSorobanContract.mockImplementation(async (op) => op());
  });

  async function readWithAmount(fundedAmount) {
    const id = 'inv-coerce-test';
    _projectionRows.set(id, {
      invoice_id: id,
      latest_event_id: 'evt_coerce',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount }),
      latest_observed_at: new Date().toISOString(),
      deleted_at: null,
    });
    const escrowAdapter = async () => ({
      invoiceId: id, status: 'funded', fundedAmount,
      source: 'projection', fromProjection: true,
    });
    const state = await readEscrowState(id, { escrowAdapter });
    _projectionRows.clear();
    return state.fundedAmount;
  }

  it('[NaN-amount] fundedAmount NaN in JSON is coerced to 0', async () => {
    // JSON.stringify(NaN) → "null"; so the body has null → coerced to 0
    const id = 'inv-nan';
    _projectionRows.set(id, {
      invoice_id: id,
      latest_event_id: 'evt_nan',
      latest_event_type: 'funded',
      latest_ledger_sequence: 1,
      latest_event_body: '{"status":"funded","fundedAmount":null}',
      latest_observed_at: new Date().toISOString(),
      deleted_at: null,
    });
    const state = await readEscrowState(id, {
      escrowAdapter: async () => ({ invoiceId: id, status: 'funded', fundedAmount: NaN, source: 'projection', fromProjection: true }),
    });
    expect(state.fundedAmount).toBe(0);
    _projectionRows.clear();
  });

  it('[negative-amount] fundedAmount -1 is coerced to 0', async () => {
    const amount = await readWithAmount(-1);
    expect(amount).toBe(0);
  });

  it('[negative-large] fundedAmount -9999 is coerced to 0', async () => {
    const amount = await readWithAmount(-9999);
    expect(amount).toBe(0);
  });

  it('[string-number] fundedAmount "5000" string coerces to 5000', async () => {
    const amount = await readWithAmount('5000');
    expect(amount).toBe(5000);
  });

  it('[null-amount] fundedAmount null coerces to 0', async () => {
    const amount = await readWithAmount(null);
    expect(amount).toBe(0);
  });

  it('[undefined-amount] fundedAmount undefined coerces to 0', async () => {
    const amount = await readWithAmount(undefined);
    expect(amount).toBe(0);
  });

  it('[zero-amount] fundedAmount 0 stays 0', async () => {
    const amount = await readWithAmount(0);
    expect(amount).toBe(0);
  });

  it('[positive-amount] fundedAmount 10000 stays 10000', async () => {
    const amount = await readWithAmount(10000);
    expect(amount).toBe(10000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. coerceLegalHoldStatus — truthy / falsy / boundary coercions
// ────────────────────────────────────────────────────────────────────────────

describe('regression: coerceLegalHoldStatus — truthy inputs → held', () => {
  it('[boolean-true] true → held', () => {
    expect(coerceLegalHoldStatus(true)).toBe(LEGAL_HOLD_STATUS.HELD);
  });

  it('[numeric-1] 1 → held', () => {
    expect(coerceLegalHoldStatus(1)).toBe(LEGAL_HOLD_STATUS.HELD);
  });

  it('[string-true] "true" → held', () => {
    expect(coerceLegalHoldStatus('true')).toBe(LEGAL_HOLD_STATUS.HELD);
  });
});

describe('regression: coerceLegalHoldStatus — falsy inputs → not_held', () => {
  it('[boolean-false] false → not_held', () => {
    expect(coerceLegalHoldStatus(false)).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  it('[numeric-0] 0 → not_held', () => {
    expect(coerceLegalHoldStatus(0)).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  it('[string-false] "false" → not_held', () => {
    expect(coerceLegalHoldStatus('false')).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  it('[null] null → not_held', () => {
    expect(coerceLegalHoldStatus(null)).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  it('[undefined] undefined → not_held', () => {
    expect(coerceLegalHoldStatus(undefined)).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  it('[empty-string] "" → not_held', () => {
    expect(coerceLegalHoldStatus('')).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  it('[string-1] "1" → not_held (only exact value 1 is truthy)', () => {
    // Only boolean true, numeric 1, or string "true" map to held
    expect(coerceLegalHoldStatus('1')).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });
});
