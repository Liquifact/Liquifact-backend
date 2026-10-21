'use strict';

const {
  decodeEscrow,
  EscrowDecodeError,
  STATUSES,
  toDecimalString,
} = require('../src/stellar/escrow-decoder');

const ADMIN = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';

/**
 * Builds a raw on-chain shaped record. Amounts/timestamps are BigInt because
 * `scValToNative` returns BigInt for i128/i64 values.
 *
 * @param {object} [overrides] fields to replace
 * @returns {object} raw escrow record
 */
function rawOnChain(overrides = {}) {
  return {
    invoice_id: 'INV_0001',
    admin: ADMIN,
    sme_address: ADMIN,
    amount: 1000000000n,
    funding_target: 1000000000n,
    funded_amount: 0n,
    yield_bps: 800n,
    maturity: 1800132005n,
    status: 0,
    ...overrides,
  };
}

describe('decodeEscrow — typed shape', () => {
  test('returns every EscrowState field with the documented type', () => {
    const state = decodeEscrow(rawOnChain());
    expect(Object.keys(state)).toEqual([
      'invoiceId',
      'admin',
      'smeAddress',
      'amount',
      'fundingTarget',
      'fundedAmount',
      'amountDecimal',
      'fundingTargetDecimal',
      'fundedAmountDecimal',
      'yieldBps',
      'maturity',
      'maturityIso',
      'status',
      'statusCode',
    ]);
    expect(typeof state.invoiceId).toBe('string');
    expect(typeof state.amount).toBe('string');
    expect(typeof state.amountDecimal).toBe('string');
    expect(typeof state.yieldBps).toBe('number');
    expect(typeof state.maturity).toBe('number');
    expect(typeof state.maturityIso).toBe('string');
    expect(typeof state.statusCode).toBe('number');
  });

  test('converts BigInt i128/i64 values into numbers and stroop strings', () => {
    const state = decodeEscrow(rawOnChain());
    expect(state.amount).toBe('1000000000');
    expect(state.amountDecimal).toBe('100.0000000');
    expect(state.fundingTargetDecimal).toBe('100.0000000');
    expect(state.fundedAmountDecimal).toBe('0.0000000');
    expect(state.yieldBps).toBe(800);
    expect(state.maturity).toBe(1800132005);
    expect(state.maturityIso).toBe(new Date(1800132005 * 1000).toISOString());
  });

  test('accepts raw snapshot form (decimal strings and plain numbers)', () => {
    const state = decodeEscrow({
      invoice_id: 'INV_0001',
      admin: ADMIN,
      sme_address: ADMIN,
      amount: '1000000000',
      funding_target: '1000000000',
      funded_amount: '0',
      yield_bps: 800,
      maturity: 1800132005,
      status: 0,
    });
    expect(state.amount).toBe('1000000000');
    expect(state.yieldBps).toBe(800);
    expect(state.status).toBe('open');
  });

  test('accepts camelCase keys and Map payloads', () => {
    const camel = decodeEscrow({
      invoiceId: 'INV_0002',
      admin: ADMIN,
      smeAddress: ADMIN,
      amount: 5n,
      fundingTarget: 10n,
      fundedAmount: 5n,
      yieldBps: 100,
      maturity: 2000000000,
      status: 4,
    });
    expect(camel.invoiceId).toBe('INV_0002');
    expect(camel.status).toBe('cancelled');
    expect(camel.amountDecimal).toBe('0.0000005');

    const mapped = decodeEscrow(
      new Map([
        ['invoice_id', 'INV_0003'],
        ['admin', ADMIN],
        ['sme_address', ADMIN],
        ['amount', 1n],
        ['funding_target', 1n],
        ['funded_amount', 0n],
        ['yield_bps', 0],
        ['maturity', 0],
        ['status', 2],
      ]),
    );
    expect(mapped.invoiceId).toBe('INV_0003');
    expect(mapped.status).toBe('settled');
  });
});

describe('decodeEscrow — status codes', () => {
  const cases = [
    [0, 'open'],
    [1, 'funded'],
    [2, 'settled'],
    [3, 'withdrawn'],
    [4, 'cancelled'],
  ];

  test.each(cases)('status code %i maps to %s', (code, name) => {
    const state = decodeEscrow(rawOnChain({ status: code }));
    expect(state.status).toBe(name);
    expect(state.statusCode).toBe(code);
  });

  test.each([5, 7, 255])('unknown status code %i maps to unknown', (code) => {
    const state = decodeEscrow(rawOnChain({ status: code }));
    expect(state.status).toBe('unknown');
    expect(state.statusCode).toBe(code);
    expect(STATUSES).toContain(state.status);
  });
});

describe('decodeEscrow — malformed payloads throw', () => {
  test('missing required field', () => {
    const broken = rawOnChain();
    delete broken.yield_bps;
    expect(() => decodeEscrow(broken)).toThrow(EscrowDecodeError);
    expect(() => decodeEscrow(broken)).toThrow(/yieldBps/);
  });

  test.each([
    ['yield above range', rawOnChain({ yield_bps: 10001 })],
    ['negative yield', rawOnChain({ yield_bps: -1 })],
    ['non-integer yield', rawOnChain({ yield_bps: 12.5 })],
    ['unsafe maturity', rawOnChain({ maturity: 2n ** 60n })],
    ['negative amount', rawOnChain({ amount: -1n })],
    ['non-numeric amount', rawOnChain({ amount: 'one hundred' })],
    ['non-numeric status', rawOnChain({ status: 'open' })],
  ])('%s is rejected', (_label, payload) => {
    expect(() => decodeEscrow(payload)).toThrow(EscrowDecodeError);
  });

  test('non-map payload is rejected', () => {
    expect(() => decodeEscrow(null)).toThrow(EscrowDecodeError);
    expect(() => decodeEscrow('INV_0001')).toThrow(EscrowDecodeError);
    expect(() => decodeEscrow([{ invoice_id: 'x' }])).toThrow(EscrowDecodeError);
  });

  test('errors carry the ESCROW_DECODE_FAILED code', () => {
    try {
      decodeEscrow({});
      throw new Error('expected decodeEscrow to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EscrowDecodeError);
      expect(err.code).toBe('ESCROW_DECODE_FAILED');
    }
  });
});

describe('toDecimalString', () => {
  test.each([
    ['0', '0.0000000'],
    ['1', '0.0000001'],
    ['1000000000', '100.0000000'],
    ['123456789', '12.3456789'],
    ['999999999999', '99999.9999999'],
  ])('%s -> %s', (input, expected) => {
    expect(toDecimalString(input)).toBe(expected);
  });
});
