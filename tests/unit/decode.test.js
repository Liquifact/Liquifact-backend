'use strict';

/**
 * @fileoverview Unit tests for src/indexer/decode.js
 *
 * Constructs topic/value inputs that mirror real Soroban RPC event shapes
 * (using ScVal-like objects as the SDK would return them) and asserts that
 * decodeEvent produces the correct typed records.
 */

const {
  decodeEvent,
  EVENT_TYPE_MAP,
  scValToString,
  scValToAmountString,
  scvMapToObject,
} = require('../../src/indexer/decode');

// ---------------------------------------------------------------------------
// Helper builders that mimic nativeToScVal / xdr.ScVal.scvSymbol shapes
// ---------------------------------------------------------------------------

/** Build a symbol ScVal (mirrors xdr.ScVal.scvSymbol) */
function sym(s) {
  return { switch: { name: 'scvSymbol' }, value: s };
}

/** Build an i128 ScVal with hi/lo BigInt pair */
function i128(value) {
  const v = BigInt(value);
  const hi = v >> 64n;
  const lo = v & 0xffffffffffffffffn;
  return { hi, lo };
}

/** Build a ScVal map (array of { key, val } entries) */
function scvMap(pairs) {
  return pairs.map(([k, v]) => ({ key: sym(k), val: v }));
}

/** Build a minimal raw RPC event */
function rawEvent(overrides = {}) {
  return {
    id: '100-1',
    type: 'contract',
    ledger: 100,
    ledgerClosedAt: '2024-01-15T12:00:00Z',
    contractId: 'CDUMMY123',
    txHash: 'abcdef0123456789',
    topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
    value: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scValToString
// ---------------------------------------------------------------------------
describe('scValToString', () => {
  test('returns the string for a plain JS string', () => {
    expect(scValToString('hello')).toBe('hello');
  });

  test('extracts value from a symbol ScVal with string .value', () => {
    expect(scValToString(sym('funded'))).toBe('funded');
  });

  test('extracts value from a Buffer .value', () => {
    const buf = { value: Buffer.from('funded') };
    expect(scValToString(buf)).toBe('funded');
  });

  test('returns undefined for null/undefined', () => {
    expect(scValToString(null)).toBeUndefined();
    expect(scValToString(undefined)).toBeUndefined();
  });

  test('falls back to String() for other types', () => {
    expect(scValToString(42)).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// scValToAmountString
// ---------------------------------------------------------------------------
describe('scValToAmountString', () => {
  test('handles plain BigInt', () => {
    expect(scValToAmountString(12345678901234567890n)).toBe('12345678901234567890');
  });

  test('handles i128 hi/lo pair', () => {
    // Build a known i128 value
    const amount = 500_000_000n; // 50 XLM in stroops
    const hi = amount >> 64n;
    const lo = amount & 0xffffffffffffffffn;
    expect(scValToAmountString({ hi, lo })).toBe('500000000');
  });

  test('handles plain number', () => {
    expect(scValToAmountString(42)).toBe('42');
  });

  test('handles string passthrough', () => {
    expect(scValToAmountString('99')).toBe('99');
  });

  test('returns "0" for null/undefined', () => {
    expect(scValToAmountString(null)).toBe('0');
    expect(scValToAmountString(undefined)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// scvMapToObject
// ---------------------------------------------------------------------------
describe('scvMapToObject', () => {
  test('decodes an array of {key, val} entries', () => {
    const map = scvMap([
      ['amount', '1000'],
      ['investor', 'GINVESTOR'],
    ]);
    const result = scvMapToObject(map);
    expect(result).toEqual({ amount: '1000', investor: 'GINVESTOR' });
  });

  test('converts BigInt values to strings', () => {
    const map = scvMap([['amount', 500_000_000n]]);
    const result = scvMapToObject(map);
    expect(result.amount).toBe('500000000');
  });

  test('handles a native JS Map', () => {
    const m = new Map([
      ['field1', 'value1'],
      ['field2', 42],
    ]);
    const result = scvMapToObject(m);
    expect(result).toEqual({ field1: 'value1', field2: 42 });
  });

  test('handles a plain object', () => {
    const result = scvMapToObject({ foo: 'bar', num: 1 });
    expect(result).toEqual({ foo: 'bar', num: 1 });
  });

  test('returns empty object for null/undefined input', () => {
    expect(scvMapToObject(null)).toEqual({});
    expect(scvMapToObject(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — funded
// ---------------------------------------------------------------------------
describe('decodeEvent — funded event', () => {
  test('decodes a funded event with correct type and fields', () => {
    const amount = 500_000_000n;
    const event = rawEvent({
      id: '200-1',
      ledger: 200,
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
      value: scvMap([
        ['investor', 'GINVESTOR123456'],
        ['amount', i128(amount)],
        ['funded_amount', i128(amount)],
        ['status', 'active'],
        ['invoice_id', 'INV-001'],
      ]),
    });

    const decoded = decodeEvent(event);

    expect(decoded.id).toBe('200-1');
    expect(decoded.type).toBe('funded');
    expect(decoded.ledger).toBe(200);
    expect(decoded.txHash).toBe('abcdef0123456789');
    expect(decoded.contractId).toBe('CDUMMY123');
    expect(decoded.invoiceId).toBe('INV-001');
    expect(decoded.data.investor).toBe('GINVESTOR123456');
    // BigInt-safe: amounts must be strings
    expect(typeof decoded.data.amount).toBe('string');
    expect(decoded.data.amount).toBe('500000000');
    expect(decoded.schemaWarning).toBeUndefined();
  });

  test('sets ledgerClosedAt from the raw event', () => {
    const event = rawEvent({
      ledgerClosedAt: '2024-06-01T00:00:00Z',
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
    });
    const decoded = decodeEvent(event);
    expect(decoded.ledgerClosedAt).toBe('2024-06-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — escrow_sd (settled)
// ---------------------------------------------------------------------------
describe('decodeEvent — escrow_sd (settled) event', () => {
  test('decodes settled event to type "settled"', () => {
    const event = rawEvent({
      id: '300-2',
      ledger: 300,
      topic: [sym('LiquifactEscrow'), sym('escrow_sd'), 'v1'],
      value: scvMap([
        ['invoice_id', 'INV-002'],
        ['settled_amount', i128(1_000_000_000n)],
      ]),
    });

    const decoded = decodeEvent(event);

    expect(decoded.type).toBe('settled');
    expect(decoded.invoiceId).toBe('INV-002');
    expect(decoded.data.settled_amount).toBe('1000000000');
    expect(decoded.schemaWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — refunded
// ---------------------------------------------------------------------------
describe('decodeEvent — refunded event', () => {
  test('decodes refunded event to type "refunded"', () => {
    const event = rawEvent({
      id: '400-1',
      ledger: 400,
      topic: [sym('LiquifactEscrow'), sym('refunded'), 'v1'],
      value: scvMap([
        ['invoice_id', 'INV-003'],
        ['investor', 'GINVESTORXYZ'],
        ['refund_amount', i128(250_000_000n)],
      ]),
    });

    const decoded = decodeEvent(event);

    expect(decoded.type).toBe('refunded');
    expect(decoded.invoiceId).toBe('INV-003');
    expect(decoded.data.investor).toBe('GINVESTORXYZ');
    expect(decoded.data.refund_amount).toBe('250000000');
    expect(decoded.schemaWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — unknown event
// ---------------------------------------------------------------------------
describe('decodeEvent — unknown event', () => {
  test('stores unknown type and includes rawTopics', () => {
    const event = rawEvent({
      id: '500-1',
      topic: [sym('LiquifactEscrow'), sym('some_future_event'), sym('extra_topic'), 'v1'],
      value: scvMap([['data', 'raw']]),
    });

    const decoded = decodeEvent(event);

    expect(decoded.type).toBe('unknown');
    expect(Array.isArray(decoded.rawTopics)).toBe(true);
    expect(decoded.rawTopics).toContain('some_future_event');
    expect(decoded.schemaWarning).toBeUndefined();
  });

  test('does not include rawTopics for known event types', () => {
    const event = rawEvent({
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
      value: [],
    });
    const decoded = decodeEvent(event);
    expect(decoded.rawTopics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — schemaWarning for non-v1 version topic
// ---------------------------------------------------------------------------
describe('decodeEvent — schema version warning', () => {
  test('sets schemaWarning: true when trailing topic is not "v1"', () => {
    const event = rawEvent({
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v2'],
      value: [],
    });
    const decoded = decodeEvent(event);
    expect(decoded.schemaWarning).toBe(true);
  });

  test('no schemaWarning when version is exactly "v1"', () => {
    const event = rawEvent({
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
      value: [],
    });
    const decoded = decodeEvent(event);
    expect(decoded.schemaWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — invoiceId derivation
// ---------------------------------------------------------------------------
describe('decodeEvent — invoiceId derivation', () => {
  test('extracts invoiceId from data map field invoice_id', () => {
    const event = rawEvent({
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
      value: scvMap([['invoice_id', 'INV-from-data']]),
    });
    const decoded = decodeEvent(event);
    expect(decoded.invoiceId).toBe('INV-from-data');
  });

  test('extracts invoiceId from data map field invoiceId (camelCase)', () => {
    const event = rawEvent({
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
      value: scvMap([['invoiceId', 'INV-camel']]),
    });
    const decoded = decodeEvent(event);
    expect(decoded.invoiceId).toBe('INV-camel');
  });

  test('invoiceId is null when absent', () => {
    const event = rawEvent({
      topic: [sym('LiquifactEscrow'), sym('funded'), 'v1'],
      value: [],
    });
    const decoded = decodeEvent(event);
    expect(decoded.invoiceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — handles raw topic array (not wrapped in scvSymbol)
// ---------------------------------------------------------------------------
describe('decodeEvent — raw string topics', () => {
  test('handles plain string topics array', () => {
    const event = rawEvent({
      topic: ['LiquifactEscrow', 'funded', 'v1'],
      value: scvMap([['invoice_id', 'INV-raw']]),
    });
    const decoded = decodeEvent(event);
    expect(decoded.type).toBe('funded');
    expect(decoded.invoiceId).toBe('INV-raw');
  });
});

// ---------------------------------------------------------------------------
// EVENT_TYPE_MAP completeness
// ---------------------------------------------------------------------------
describe('EVENT_TYPE_MAP', () => {
  test('maps all documented event name symbols', () => {
    const expected = [
      'funded', 'escrow_sd', 'inv_claim', 'refunded',
      'fund_can', 'legalhld', 'sme_wd', 'maturity', 'fund_tgt',
    ];
    for (const name of expected) {
      expect(EVENT_TYPE_MAP[name]).toBeDefined();
    }
  });
});
